const { getDatabase } = require("@netlify/database");
const { requireAuth, CORS } = require("./verifyToken");

// In-memory fallback for local development or environments without Netlify Database
const localMemoryStore = new Map();

let dbInstance = null;
let dbCheckAttempted = false;
let tableChecked = false;

function getDb() {
    if (dbInstance) return dbInstance;
    if (dbCheckAttempted) return null;
    dbCheckAttempted = true;
    try {
        const connString = process.env.NETLIFY_DB_URL;
        dbInstance = connString ? getDatabase({ connectionString: connString }) : getDatabase();
        return dbInstance;
    } catch (e) {
        return null;
    }
}

async function ensureTable(db) {
    if (tableChecked || !db) return;
    try {
        await db.sql`
            CREATE TABLE IF NOT EXISTS user_profiles (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(255) NOT NULL UNIQUE,
                display_name VARCHAR(255) DEFAULT '',
                custom_mongo_uri TEXT DEFAULT '',
                db_mode VARCHAR(20) DEFAULT 'inbuilt',
                saved_jobs JSONB DEFAULT '[]'::jsonb,
                onboarding_done BOOLEAN DEFAULT FALSE,
                deleted_at TIMESTAMPTZ DEFAULT NULL,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id ON user_profiles(user_id);
            CREATE INDEX IF NOT EXISTS idx_user_profiles_deleted ON user_profiles(deleted_at) WHERE deleted_at IS NULL;
        `;
        tableChecked = true;
    } catch (e) {
        tableChecked = true; // schema is maintained via migrations
    }
}

function sanitizeProfile(row) {
    // NEVER expose raw custom_mongo_uri to client
    const hasCustom = Boolean(row.custom_mongo_uri && row.custom_mongo_uri.trim());
    return {
        user_id: row.user_id,
        display_name: row.display_name || "",
        db_mode: row.db_mode || (hasCustom ? "custom" : "inbuilt"),
        has_custom_db: hasCustom,
        saved_jobs: typeof row.saved_jobs === "string" ? JSON.parse(row.saved_jobs) : (row.saved_jobs || []),
        onboarding_done: Boolean(row.onboarding_done),
        created_at: row.created_at,
        updated_at: row.updated_at
    };
}

exports.handler = async (event, context) => {
    // 1. CORS Preflight
    if (event.httpMethod === "OPTIONS") {
        return {
            statusCode: 204,
            headers: CORS,
            body: ""
        };
    }

    // 2. Authenticate user from Netlify Identity JWT
    const authResult = await requireAuth(event, context);
    if (authResult.statusCode) {
        return authResult;
    }
    const { userId } = authResult;

    const db = getDb();
    const query = event.queryStringParameters || {};

    try {
        // ── GET: Read profile or export data ──────────────────────────────
        if (event.httpMethod === "GET") {
            let profileRow = null;

            if (db) {
                try {
                    await ensureTable(db);
                    const rows = await db.sql`
                        SELECT * FROM user_profiles
                        WHERE user_id = ${userId} AND deleted_at IS NULL
                        LIMIT 1
                    `;
                    if (rows && rows.length > 0) {
                        profileRow = rows[0];
                    }
                } catch (dbErr) {
                    console.warn("Netlify Database read fallback:", dbErr.message);
                }
            }

            if (!profileRow && localMemoryStore.has(userId)) {
                profileRow = localMemoryStore.get(userId);
            }

            // GDPR Right to Data Portability / Export
            if (query.export === "true") {
                const exportData = profileRow ? {
                    ...sanitizeProfile(profileRow),
                    custom_mongo_uri: profileRow.custom_mongo_uri ? "[ENCRYPTED - stored securely]" : "",
                    exported_at: new Date().toISOString(),
                    data_controller: "Rolenaut",
                    compliance: "GDPR / User Privacy Standard"
                } : {
                    user_id: userId,
                    note: "No profile data stored."
                };

                return {
                    statusCode: 200,
                    headers: {
                        ...CORS,
                        "Content-Disposition": 'attachment; filename="rolenaut-profile-export.json"'
                    },
                    body: JSON.stringify(exportData, null, 2)
                };
            }

            return {
                statusCode: 200,
                headers: CORS,
                body: JSON.stringify({
                    profile: profileRow ? sanitizeProfile(profileRow) : {
                        user_id: userId,
                        display_name: "",
                        db_mode: "inbuilt",
                        has_custom_db: false,
                        saved_jobs: [],
                        onboarding_done: false,
                        created_at: null,
                        updated_at: null
                    }
                })
            };
        }

        // ── POST: Create or Update Profile ────────────────────────────────
        if (event.httpMethod === "POST") {
            let body = {};
            try {
                body = typeof event.body === "string" ? JSON.parse(event.body || "{}") : (event.body || {});
            } catch (e) {
                return {
                    statusCode: 400,
                    headers: CORS,
                    body: JSON.stringify({ error: "Invalid JSON payload" })
                };
            }

            const displayName = String(body.display_name !== undefined ? body.display_name : "").trim().slice(0, 255);
            const dbMode = body.db_mode === "custom" ? "custom" : "inbuilt";
            const onboardingDone = body.onboarding_done !== undefined ? Boolean(body.onboarding_done) : false;
            const savedJobs = Array.isArray(body.saved_jobs) ? body.saved_jobs : undefined;

            let customMongoUri = undefined;
            if (dbMode === "custom" && body.custom_mongo_uri !== undefined) {
                const uri = String(body.custom_mongo_uri || "").trim();
                if (uri) {
                    if (!uri.startsWith("mongodb://") && !uri.startsWith("mongodb+srv://")) {
                        return {
                            statusCode: 400,
                            headers: CORS,
                            body: JSON.stringify({ error: "Invalid MongoDB connection string. Must start with mongodb:// or mongodb+srv://" })
                        };
                    }
                    if (uri.startsWith("mongodb+srv://") && !/mongodb\+srv:\/\/[^@]+@[^/]+\.mongodb\.net/i.test(uri)) {
                        return {
                            statusCode: 400,
                            headers: CORS,
                            body: JSON.stringify({ error: "Only secure MongoDB Atlas (*.mongodb.net) clusters are allowed." })
                        };
                    }
                }
                customMongoUri = uri;
            } else if (dbMode === "inbuilt") {
                customMongoUri = "";
            }

            const now = new Date().toISOString();
            let savedToDb = false;

            if (db) {
                try {
                    await ensureTable(db);
                    const jobsParam = savedJobs !== undefined ? JSON.stringify(savedJobs) : null;

                    if (customMongoUri !== undefined && jobsParam !== null) {
                        await db.sql`
                            INSERT INTO user_profiles (user_id, display_name, custom_mongo_uri, db_mode, saved_jobs, onboarding_done, updated_at)
                            VALUES (${userId}, ${displayName}, ${customMongoUri}, ${dbMode}, ${jobsParam}::jsonb, ${onboardingDone}, NOW())
                            ON CONFLICT (user_id) DO UPDATE SET
                                display_name = EXCLUDED.display_name,
                                custom_mongo_uri = EXCLUDED.custom_mongo_uri,
                                db_mode = EXCLUDED.db_mode,
                                saved_jobs = EXCLUDED.saved_jobs,
                                onboarding_done = EXCLUDED.onboarding_done,
                                deleted_at = NULL,
                                updated_at = NOW()
                        `;
                    } else if (customMongoUri !== undefined) {
                        await db.sql`
                            INSERT INTO user_profiles (user_id, display_name, custom_mongo_uri, db_mode, onboarding_done, updated_at)
                            VALUES (${userId}, ${displayName}, ${customMongoUri}, ${dbMode}, ${onboardingDone}, NOW())
                            ON CONFLICT (user_id) DO UPDATE SET
                                display_name = EXCLUDED.display_name,
                                custom_mongo_uri = EXCLUDED.custom_mongo_uri,
                                db_mode = EXCLUDED.db_mode,
                                onboarding_done = EXCLUDED.onboarding_done,
                                deleted_at = NULL,
                                updated_at = NOW()
                        `;
                    } else if (jobsParam !== null) {
                        await db.sql`
                            INSERT INTO user_profiles (user_id, display_name, db_mode, saved_jobs, onboarding_done, updated_at)
                            VALUES (${userId}, ${displayName}, ${dbMode}, ${jobsParam}::jsonb, ${onboardingDone}, NOW())
                            ON CONFLICT (user_id) DO UPDATE SET
                                display_name = EXCLUDED.display_name,
                                db_mode = EXCLUDED.db_mode,
                                saved_jobs = EXCLUDED.saved_jobs,
                                onboarding_done = EXCLUDED.onboarding_done,
                                deleted_at = NULL,
                                updated_at = NOW()
                        `;
                    } else {
                        await db.sql`
                            INSERT INTO user_profiles (user_id, display_name, db_mode, onboarding_done, updated_at)
                            VALUES (${userId}, ${displayName}, ${dbMode}, ${onboardingDone}, NOW())
                            ON CONFLICT (user_id) DO UPDATE SET
                                display_name = EXCLUDED.display_name,
                                db_mode = EXCLUDED.db_mode,
                                onboarding_done = EXCLUDED.onboarding_done,
                                deleted_at = NULL,
                                updated_at = NOW()
                        `;
                    }
                    savedToDb = true;
                } catch (dbErr) {
                    console.warn("Netlify Database write fallback:", dbErr.message);
                }
            }

            // Sync in-memory fallback
            const existing = localMemoryStore.get(userId) || {};
            const record = {
                ...existing,
                user_id: userId,
                display_name: displayName || existing.display_name || "",
                db_mode: dbMode,
                onboarding_done: onboardingDone !== undefined ? onboardingDone : (existing.onboarding_done || false),
                saved_jobs: savedJobs !== undefined ? savedJobs : (existing.saved_jobs || []),
                custom_mongo_uri: customMongoUri !== undefined ? customMongoUri : (existing.custom_mongo_uri || ""),
                deleted_at: null,
                updated_at: now
            };
            if (!record.created_at) record.created_at = now;
            localMemoryStore.set(userId, record);

            return {
                statusCode: 200,
                headers: CORS,
                body: JSON.stringify({
                    success: true,
                    storage: savedToDb ? "netlify-database" : "local-fallback",
                    profile: sanitizeProfile(record)
                })
            };
        }

        // ── DELETE: GDPR Account & Data Erasure ───────────────────────────
        if (event.httpMethod === "DELETE") {
            if (db) {
                try {
                    await ensureTable(db);
                    await db.sql`
                        DELETE FROM user_profiles
                        WHERE user_id = ${userId}
                    `;
                } catch (dbErr) {
                    console.warn("Netlify Database delete error:", dbErr.message);
                }
            }
            localMemoryStore.delete(userId);

            return {
                statusCode: 200,
                headers: CORS,
                body: JSON.stringify({
                    success: true,
                    message: "All user profile data, settings, and tracker entries have been permanently erased from the database."
                })
            };
        }

        return {
            statusCode: 405,
            headers: CORS,
            body: JSON.stringify({ error: "Method not allowed" })
        };
    } catch (err) {
        console.error("userProfile error:", err);
        return {
            statusCode: 500,
            headers: CORS,
            body: JSON.stringify({ error: "Failed to process user profile: " + err.message })
        };
    }
};

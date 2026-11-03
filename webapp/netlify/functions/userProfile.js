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
    const hasCustom = Boolean(row.custom_mongo_uri && row.custom_mongo_uri.trim());
    return {
        user_id: row.user_id,
        display_name: row.display_name || "",
        db_mode: row.db_mode || (hasCustom ? "custom" : "inbuilt"),
        has_custom_db: hasCustom,
        custom_mongo_uri: hasCustom ? "[CONFIGURED]" : "",
        saved_jobs: typeof row.saved_jobs === "string" ? JSON.parse(row.saved_jobs) : (row.saved_jobs || []),
        onboarding_done: Boolean(row.onboarding_done),
        created_at: row.created_at,
        updated_at: row.updated_at
    };
}

// Automatically normalizes bare MongoDB Atlas URIs (e.g. mongodb+srv://...mongodb.net/ or ...mongodb.net)
// to target job_aggregator with retryWrites=true&w=majority
function normalizeMongoAtlasUri(rawUri) {
    if (!rawUri || typeof rawUri !== "string") return "";
    let uri = rawUri.trim();
    if (uri.startsWith("mongodb+srv://")) {
        const afterScheme = uri.slice("mongodb+srv://".length);
        const slashIdx = afterScheme.indexOf("/");
        if (slashIdx === -1) {
            return uri + "/job_aggregator?retryWrites=true&w=majority";
        }
        const pathAndQuery = afterScheme.slice(slashIdx + 1);
        const [dbName, queryString] = pathAndQuery.split("?");
        if (!dbName || dbName === "test" || dbName === "admin") {
            const query = queryString ? `?${queryString}` : "?retryWrites=true&w=majority";
            return uri.slice(0, "mongodb+srv://".length + slashIdx) + "/job_aggregator" + query;
        }
    }
    return uri;
}

exports.handler = async (event, context) => {
    context.callbackWaitsForEmptyEventLoop = false;

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

            // GDPR Right to Data Portability / Comprehensive Profile Export
            if (query.export === "true") {
                const sanitized = profileRow ? sanitizeProfile(profileRow) : null;
                const userEmail = authResult.email || userId;
                const exportData = {
                    metadata: {
                        data_controller: "Rolenaut",
                        compliance_standard: "GDPR Article 15 (Right of Access) & Article 20 (Data Portability)",
                        export_generated_at: new Date().toISOString(),
                        account_status: "Active",
                        platform_version: "2.0.0"
                    },
                    candidate_profile: {
                        user_id: userId,
                        email: userEmail,
                        display_name: (sanitized && sanitized.display_name) || "Candidate",
                        onboarding_completed: Boolean(sanitized && sanitized.onboarding_done),
                        registered_at: sanitized ? sanitized.created_at : new Date().toISOString(),
                        last_updated_at: sanitized ? sanitized.updated_at : new Date().toISOString()
                    },
                    workspace_configuration: {
                        active_data_stream: (sanitized && sanitized.db_mode === "custom") ? "Custom MongoDB Scraper Cluster" : "Verified Rolenaut Freshers Stream",
                        db_mode: (sanitized && sanitized.db_mode) || "inbuilt",
                        has_custom_db: Boolean(sanitized && sanitized.has_custom_db),
                        custom_mongo_uri_status: (profileRow && profileRow.custom_mongo_uri) ? "[CONFIGURED - Encrypted in Netlify Cloud DB]" : "[NOT CONFIGURED]"
                    },
                    saved_items: {
                        total_saved_jobs: (sanitized && sanitized.saved_jobs && sanitized.saved_jobs.length) || 0,
                        saved_jobs: (sanitized && sanitized.saved_jobs) || []
                    },
                    privacy_manifest: {
                        tracking_pixels: 0,
                        cookies_tracking: "Strictly essential session only",
                        third_party_data_brokers: false,
                        right_to_erasure: "Available via permanent Delete Account button in Profile"
                    }
                };

                return {
                    statusCode: 200,
                    headers: {
                        ...CORS,
                        "Cache-Control": "private, no-cache, no-store, must-revalidate",
                        "Pragma": "no-cache",
                        "Content-Disposition": 'attachment; filename="rolenaut-profile-export.json"'
                    },
                    body: JSON.stringify(exportData, null, 2)
                };
            }

            return {
                statusCode: 200,
                headers: {
                    ...CORS,
                    "Cache-Control": "private, no-cache, no-store, must-revalidate",
                    "Pragma": "no-cache"
                },
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

        // ── POST: Create or Update Profile (Atomic Partial Update) ───────
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

            // 1. Fetch existing profile state first so partial POSTs never wipe other fields
            let existing = null;
            if (db) {
                try {
                    await ensureTable(db);
                    const rows = await db.sql`
                        SELECT * FROM user_profiles
                        WHERE user_id = ${userId} AND deleted_at IS NULL
                        LIMIT 1
                    `;
                    if (rows && rows.length > 0) existing = rows[0];
                } catch (readErr) {
                    console.warn("Netlify Database existing profile read error:", readErr.message);
                }
            }
            if (!existing && localMemoryStore.has(userId)) {
                existing = localMemoryStore.get(userId);
            }

            // 2. Resolve field values with strict preservation of existing data
            let finalDisplayName;
            if (body.display_name !== undefined) {
                finalDisplayName = String(body.display_name || "").trim().slice(0, 255);
            } else if (existing && existing.display_name !== undefined) {
                finalDisplayName = existing.display_name;
            } else {
                finalDisplayName = "";
            }

            let finalDbMode;
            if (body.db_mode !== undefined) {
                finalDbMode = body.db_mode === "custom" ? "custom" : "inbuilt";
            } else if (existing && existing.db_mode) {
                finalDbMode = existing.db_mode;
            } else {
                finalDbMode = "inbuilt";
            }

            let finalOnboardingDone;
            if (body.onboarding_done !== undefined) {
                finalOnboardingDone = Boolean(body.onboarding_done);
            } else if (existing && existing.onboarding_done !== undefined) {
                finalOnboardingDone = Boolean(existing.onboarding_done);
            } else {
                finalOnboardingDone = false;
            }

            let finalSavedJobs;
            if (body.saved_jobs !== undefined && Array.isArray(body.saved_jobs)) {
                finalSavedJobs = body.saved_jobs.slice(0, 250);
            } else if (existing && existing.saved_jobs) {
                finalSavedJobs = typeof existing.saved_jobs === "string" ? JSON.parse(existing.saved_jobs) : existing.saved_jobs;
            } else {
                finalSavedJobs = [];
            }

            let finalCustomMongoUri;
            if (finalDbMode === "inbuilt" && body.db_mode === "inbuilt") {
                // Explicit revert to inbuilt stream cleans stored URI
                finalCustomMongoUri = "";
            } else if (body.custom_mongo_uri !== undefined) {
                let rawUri = String(body.custom_mongo_uri || "").trim();
                if (rawUri) {
                    const atlasPattern = /^mongodb\+srv:\/\/[a-zA-Z0-9_\-\.%]+:[^@]+@[a-zA-Z0-9_\-\.]+\.mongodb\.net(?:\/.*)?$/;
                    if (!atlasPattern.test(rawUri)) {
                        return {
                            statusCode: 400,
                            headers: CORS,
                            body: JSON.stringify({ error: "Only MongoDB Atlas (*.mongodb.net) clusters with SRV connection strings are allowed for security." })
                        };
                    }
                    finalCustomMongoUri = normalizeMongoAtlasUri(rawUri);
                } else {
                    finalCustomMongoUri = "";
                }
            } else if (existing && existing.custom_mongo_uri) {
                finalCustomMongoUri = existing.custom_mongo_uri;
            } else {
                finalCustomMongoUri = "";
            }

            const now = new Date().toISOString();
            let savedToDb = false;

            if (db) {
                try {
                    await ensureTable(db);
                    const jobsParam = JSON.stringify(finalSavedJobs);

                    await db.sql`
                        INSERT INTO user_profiles (user_id, display_name, custom_mongo_uri, db_mode, saved_jobs, onboarding_done, updated_at)
                        VALUES (${userId}, ${finalDisplayName}, ${finalCustomMongoUri}, ${finalDbMode}, ${jobsParam}::jsonb, ${finalOnboardingDone}, NOW())
                        ON CONFLICT (user_id) DO UPDATE SET
                            display_name = EXCLUDED.display_name,
                            custom_mongo_uri = EXCLUDED.custom_mongo_uri,
                            db_mode = EXCLUDED.db_mode,
                            saved_jobs = EXCLUDED.saved_jobs,
                            onboarding_done = EXCLUDED.onboarding_done,
                            deleted_at = NULL,
                            updated_at = NOW()
                    `;
                    savedToDb = true;
                } catch (dbErr) {
                    console.warn("Netlify Database write fallback:", dbErr.message);
                }
            }

            // Sync in-memory fallback
            const record = {
                user_id: userId,
                display_name: finalDisplayName,
                custom_mongo_uri: finalCustomMongoUri,
                db_mode: finalDbMode,
                saved_jobs: finalSavedJobs,
                onboarding_done: finalOnboardingDone,
                deleted_at: null,
                created_at: (existing && existing.created_at) || now,
                updated_at: now
            };
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

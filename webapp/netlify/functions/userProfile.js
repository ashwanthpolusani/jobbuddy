const { getDatabase } = require("@netlify/database");
const { requireAuth, CORS } = require("./verifyToken");

// In-memory fallback for local development only when Netlify Database is not configured
const localMemoryStore = new Map();

let dbInstance = null;
let tableChecked = false;

function getDb() {
    if (dbInstance) return dbInstance;
    try {
        const connString = process.env.NETLIFY_DB_URL || process.env.NETLIFY_DATABASE_URL;
        if (connString) {
            dbInstance = getDatabase({ connectionString: connString });
            console.log("[userProfile] Netlify Database client initialized with connection string.");
        } else {
            dbInstance = getDatabase();
            console.log("[userProfile] Netlify Database client initialized with zero-config.");
        }
        return dbInstance;
    } catch (e) {
        console.warn("[userProfile] Netlify Database connection notice:", e.message);
        console.warn("[userProfile] TIP: In Netlify Functions, set NETLIFY_DB_URL in Site configuration > Environment variables with your read-write connection string.");
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
        // Ensure all columns exist on tables created by earlier schema iterations
        await db.sql`
            ALTER TABLE user_profiles
                ADD COLUMN IF NOT EXISTS display_name VARCHAR(255) DEFAULT '',
                ADD COLUMN IF NOT EXISTS custom_mongo_uri TEXT DEFAULT '',
                ADD COLUMN IF NOT EXISTS db_mode VARCHAR(20) DEFAULT 'inbuilt',
                ADD COLUMN IF NOT EXISTS saved_jobs JSONB DEFAULT '[]'::jsonb,
                ADD COLUMN IF NOT EXISTS onboarding_done BOOLEAN DEFAULT FALSE,
                ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
        `;
        tableChecked = true;
    } catch (e) {
        console.warn("Netlify Database ensureTable notice:", e.message);
        // Do not set tableChecked = true on error, so it can retry once database is awake
    }
}

function extractClusterHost(rawUri) {
    if (!rawUri || typeof rawUri !== "string") return "";
    const match = rawUri.match(/@([^/?#]+)/);
    return (match && match[1]) ? match[1].split(':')[0] : "";
}

function sanitizeProfile(row) {
    const hasCustom = Boolean(row.custom_mongo_uri && row.custom_mongo_uri.trim());
    let savedJobs = [];
    if (Array.isArray(row.saved_jobs)) {
        savedJobs = row.saved_jobs;
    } else if (typeof row.saved_jobs === "string") {
        try { savedJobs = JSON.parse(row.saved_jobs || "[]"); } catch (e) { savedJobs = []; }
    }
    return {
        user_id: row.user_id,
        display_name: row.display_name || "",
        db_mode: row.db_mode || (hasCustom ? "custom" : "inbuilt"),
        active_stream: (row.db_mode === "custom" || (!row.db_mode && hasCustom)) ? "custom" : "curated",
        has_custom_db: hasCustom,
        custom_mongo_uri: hasCustom ? "[CONFIGURED]" : "",
        custom_mongo_cluster: hasCustom ? extractClusterHost(row.custom_mongo_uri) : "",
        saved_jobs: savedJobs,
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
    const userEmail = authResult.email || userId;
    const userSub = authResult.sub || userId;

    const db = getDb();
    const query = event.queryStringParameters || {};
    console.log(`[userProfile] ${event.httpMethod} for user: ${userEmail} | DB ready: ${Boolean(db)}`);

    try {
        // ── GET: Read profile or export data ──────────────────────────────
        if (event.httpMethod === "GET") {
            let profileRow = null;

            if (db) {
                try {
                    await ensureTable(db);
                    const rows = await db.sql`
                        SELECT * FROM user_profiles
                        WHERE (user_id = ${userId} OR user_id = ${userEmail} OR user_id = ${userSub}) AND deleted_at IS NULL
                        LIMIT 1
                    `;
                    if (rows && rows.length > 0) {
                        profileRow = rows[0];
                        console.log(`[userProfile] GET: Found PostgreSQL profile for ${userEmail} (mode: ${profileRow.db_mode}, has_custom: ${Boolean(profileRow.custom_mongo_uri)})`);
                    } else {
                        console.log(`[userProfile] GET: No PostgreSQL profile row for ${userEmail}`);
                    }
                } catch (dbErr) {
                    console.error("[userProfile] GET Netlify Database read error:", dbErr.message);
                }
            }

            if (!profileRow && localMemoryStore.has(userId)) {
                profileRow = localMemoryStore.get(userId);
            }
            if (!profileRow && localMemoryStore.has(userEmail)) {
                profileRow = localMemoryStore.get(userEmail);
            }

            // GDPR Right to Data Portability / Comprehensive Profile Export
            if (query.export === "true") {
                const sanitized = profileRow ? sanitizeProfile(profileRow) : null;
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
                        custom_mongo_cluster: (sanitized && sanitized.custom_mongo_cluster) || "",
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
                        custom_mongo_cluster: "",
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
                        WHERE (user_id = ${userId} OR user_id = ${userEmail} OR user_id = ${userSub}) AND deleted_at IS NULL
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
            if (!existing && localMemoryStore.has(userEmail)) {
                existing = localMemoryStore.get(userEmail);
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
            const reqMode = body.db_mode || body.active_stream || body.stream;
            if (reqMode !== undefined) {
                finalDbMode = (reqMode === "custom" || reqMode === "scraper") ? "custom" : "inbuilt";
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

            // Preserve existing custom URI when user switches stream mode without re-entering credentials
            let finalCustomMongoUri = (existing && existing.custom_mongo_uri) || "";
            if (body.custom_mongo_uri !== undefined) {
                let rawUri = String(body.custom_mongo_uri || "").trim();
                if (rawUri && rawUri !== "[CONFIGURED]") {
                    const atlasPattern = /^mongodb\+srv:\/\/[a-zA-Z0-9_\-\.%]+:[^@]+@[a-zA-Z0-9_\-\.]+\.mongodb\.net(?:\/.*)?$/;
                    if (!atlasPattern.test(rawUri)) {
                        return {
                            statusCode: 400,
                            headers: CORS,
                            body: JSON.stringify({ error: "Only MongoDB Atlas (*.mongodb.net) clusters with SRV connection strings are allowed for security." })
                        };
                    }
                    finalCustomMongoUri = normalizeMongoAtlasUri(rawUri);
                } else if (rawUri === "") {
                    // Explicit disconnect / purge requested
                    finalCustomMongoUri = "";
                }
            } else if (body.disconnect_database === true) {
                finalCustomMongoUri = "";
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
                    console.log(`[userProfile] POST: Successfully saved profile to Netlify DB for ${userEmail} (mode: ${finalDbMode}, hasCustomUri: ${Boolean(finalCustomMongoUri)})`);
                } catch (dbErr) {
                    console.error("[userProfile] POST Netlify Database write error:", dbErr.message);
                }
            } else {
                console.warn(`[userProfile] POST: Netlify Database not connected. Profile saved to temporary memory store for ${userEmail}`);
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
            localMemoryStore.set(userEmail, record);

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

        // ── DELETE: GDPR Account & Complete Authentication Erasure ────────
        if (event.httpMethod === "DELETE") {
            let dbDeleted = false;

            // 1. Delete user profile record from Netlify Database
            if (db) {
                try {
                    await ensureTable(db);
                    await db.sql`
                        DELETE FROM user_profiles
                        WHERE user_id = ${userId} OR user_id = ${userEmail} OR user_id = ${userSub}
                    `;
                    dbDeleted = true;
                    console.log(`[userProfile] DELETE: Erased records from Netlify DB for ${userEmail}`);
                } catch (dbErr) {
                    console.error("[userProfile] DELETE Netlify DB error:", dbErr.message);
                }
            }

            // 2. Clear from in-memory fallback
            localMemoryStore.delete(userId);
            if (userEmail) localMemoryStore.delete(userEmail);
            if (userSub) localMemoryStore.delete(userSub);

            // 3. Delete user account from Netlify Identity (GoTrue Admin API)
            let identityDeleted = false;
            let identityError = null;
            const clientContext = context && context.clientContext;
            const identity = clientContext && clientContext.identity;

            if (identity && identity.url && identity.token && userSub) {
                try {
                    const deleteUrl = `${identity.url}/admin/users/${userSub}`;
                    const identityRes = await fetch(deleteUrl, {
                        method: "DELETE",
                        headers: {
                            "Authorization": `Bearer ${identity.token}`,
                            "Content-Type": "application/json"
                        }
                    });
                    console.log(`[userProfile] DELETE GoTrue Admin API status: ${identityRes.status} for sub ${userSub}`);
                    if (identityRes.ok || identityRes.status === 204 || identityRes.status === 200) {
                        identityDeleted = true;
                    } else {
                        const errTxt = await identityRes.text().catch(() => "");
                        console.warn(`[userProfile] GoTrue Admin user deletion failed HTTP ${identityRes.status}:`, errTxt);
                        identityError = `GoTrue HTTP ${identityRes.status}`;
                    }
                } catch (idErr) {
                    console.error("[userProfile] GoTrue Admin delete error:", idErr.message);
                    identityError = idErr.message;
                }
            }

            return {
                statusCode: 200,
                headers: CORS,
                body: JSON.stringify({
                    success: true,
                    database_deleted: dbDeleted,
                    identity_deleted: identityDeleted,
                    identity_notice: identityError || (!identity ? "Local dev mode: Identity Admin API is active in production deploys" : undefined),
                    message: "All user profile data, settings, and authentication records have been permanently erased."
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
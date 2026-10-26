const { getDatabase } = require("@netlify/database");

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
        // Netlify Database unconfigured in local non-CLI dev or missing NETLIFY_DB_URL
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
                custom_mongo_uri TEXT DEFAULT '',
                saved_jobs JSONB DEFAULT '[]'::jsonb,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `;
        tableChecked = true;
    } catch (e) {
        // Schema is maintained via netlify/database/migrations/
    }
}

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-user-id, x-user-email",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Content-Type": "application/json"
};

exports.handler = async (event, context) => {
    // 1. Handle CORS Preflight
    if (event.httpMethod === "OPTIONS") {
        return {
            statusCode: 204,
            headers: CORS_HEADERS,
            body: ""
        };
    }

    const headers = event.headers || {};
    const query = event.queryStringParameters || {};

    // Identify user by header or query parameter
    const userId = (headers["x-user-id"] || query.userId || headers["x-user-email"] || query.email || "").toLowerCase().trim();

    if (!userId) {
        return {
            statusCode: 400,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: "Missing user identification (x-user-id or email required)" })
        };
    }

    const db = getDb();

    try {
        if (event.httpMethod === "GET") {
            let profileData = null;

            if (db) {
                try {
                    await ensureTable(db);
                    const rows = await db.sql`
                        SELECT user_id, custom_mongo_uri, saved_jobs, updated_at
                        FROM user_profiles
                        WHERE user_id = ${userId}
                        LIMIT 1
                    `;
                    if (rows && rows.length > 0) {
                        const row = rows[0];
                        profileData = {
                            user_id: row.user_id,
                            custom_mongo_uri: row.custom_mongo_uri || "",
                            saved_jobs: typeof row.saved_jobs === "string" ? JSON.parse(row.saved_jobs) : (row.saved_jobs || []),
                            updated_at: row.updated_at
                        };
                    }
                } catch (dbErr) {
                    console.warn("Netlify Database read fallback:", dbErr.message);
                }
            }

            if (!profileData && localMemoryStore.has(userId)) {
                profileData = localMemoryStore.get(userId);
            }

            return {
                statusCode: 200,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    profile: profileData || {
                        user_id: userId,
                        custom_mongo_uri: "",
                        saved_jobs: [],
                        updated_at: null
                    }
                })
            };
        }

        if (event.httpMethod === "POST") {
            let body = {};
            try {
                body = typeof event.body === "string" ? JSON.parse(event.body || "{}") : (event.body || {});
            } catch (e) {
                return {
                    statusCode: 400,
                    headers: CORS_HEADERS,
                    body: JSON.stringify({ error: "Invalid JSON payload" })
                };
            }

            const customMongoUri = (body.custom_mongo_uri || "").trim();
            const savedJobs = Array.isArray(body.saved_jobs) ? body.saved_jobs : [];

            // Validate Mongo URI if provided
            if (customMongoUri && !customMongoUri.startsWith("mongodb://") && !customMongoUri.startsWith("mongodb+srv://")) {
                return {
                    statusCode: 400,
                    headers: CORS_HEADERS,
                    body: JSON.stringify({ error: "Invalid MongoDB connection string. Must start with mongodb:// or mongodb+srv://" })
                };
            }

            const record = {
                user_id: userId,
                custom_mongo_uri: customMongoUri,
                saved_jobs: savedJobs,
                updated_at: new Date().toISOString()
            };

            let savedToDb = false;
            if (db) {
                try {
                    await ensureTable(db);
                    const savedJobsJson = JSON.stringify(savedJobs);
                    await db.sql`
                        INSERT INTO user_profiles (user_id, custom_mongo_uri, saved_jobs, updated_at)
                        VALUES (${userId}, ${customMongoUri}, ${savedJobsJson}::jsonb, NOW())
                        ON CONFLICT (user_id)
                        DO UPDATE SET
                            custom_mongo_uri = EXCLUDED.custom_mongo_uri,
                            saved_jobs = EXCLUDED.saved_jobs,
                            updated_at = NOW()
                    `;
                    savedToDb = true;
                } catch (dbErr) {
                    console.warn("Netlify Database write fallback:", dbErr.message);
                }
            }

            // Keep local fallback updated
            localMemoryStore.set(userId, record);

            return {
                statusCode: 200,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    success: true,
                    storage: savedToDb ? "netlify-database" : "local-fallback",
                    message: "User profile updated successfully in Netlify Database",
                    profile: record
                })
            };
        }

        if (event.httpMethod === "DELETE") {
            if (db) {
                try {
                    await ensureTable(db);
                    await db.sql`DELETE FROM user_profiles WHERE user_id = ${userId}`;
                } catch (dbErr) {
                    console.warn("Netlify Database delete error:", dbErr.message);
                }
            }
            localMemoryStore.delete(userId);

            return {
                statusCode: 200,
                headers: CORS_HEADERS,
                body: JSON.stringify({ success: true, message: "Profile reset successfully" })
            };
        }

        return {
            statusCode: 405,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: "Method not allowed" })
        };
    } catch (err) {
        console.error("userProfile error:", err);
        return {
            statusCode: 500,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: "Failed to process user profile: " + err.message })
        };
    }
};

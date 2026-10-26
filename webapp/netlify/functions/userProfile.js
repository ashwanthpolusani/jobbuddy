const { getStore } = require("@netlify/blobs");

// In-memory fallback for local development or non-Netlify environments
const localMemoryStore = new Map();

function getBlobStore() {
    try {
        return getStore("user-profiles");
    } catch (e) {
        // Fallback for local testing or unconfigured environments
        return null;
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
    const userId = headers["x-user-id"] || query.userId || headers["x-user-email"] || query.email || "";

    if (!userId) {
        return {
            statusCode: 400,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: "Missing user identification (x-user-id or email required)" })
        };
    }

    const key = `user_${userId.toLowerCase().trim()}`;
    const store = getBlobStore();

    try {
        if (event.httpMethod === "GET") {
            let data = null;
            if (store) {
                try {
                    data = await store.get(key, { type: "json" });
                } catch (err) {
                    console.warn("Blobs get error, using fallback:", err.message);
                }
            }
            if (!data && localMemoryStore.has(key)) {
                data = localMemoryStore.get(key);
            }

            return {
                statusCode: 200,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    profile: data || {
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
                body = JSON.parse(event.body || "{}");
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
                    body: JSON.stringify({ error: "Invalid MongoDB connection string" })
                };
            }

            const record = {
                user_id: userId,
                custom_mongo_uri: customMongoUri,
                saved_jobs: savedJobs,
                updated_at: new Date().toISOString()
            };

            if (store) {
                try {
                    await store.setJSON(key, record);
                } catch (err) {
                    console.warn("Blobs set error, saving to local fallback:", err.message);
                    localMemoryStore.set(key, record);
                }
            } else {
                localMemoryStore.set(key, record);
            }

            return {
                statusCode: 200,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    success: true,
                    message: "User profile updated successfully in Netlify cloud database",
                    profile: record
                })
            };
        }

        if (event.httpMethod === "DELETE") {
            if (store) {
                try {
                    await store.delete(key);
                } catch (e) {}
            }
            localMemoryStore.delete(key);

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

const { MongoClient } = require("mongodb");
const { getDatabase } = require("@netlify/database");
const { verifyToken, CORS } = require("./verifyToken");

const cachedClients = new Map();
const MAX_CACHED_CLIENTS = 6;

async function connectToDatabase(uri) {
    if (cachedClients.has(uri)) return cachedClients.get(uri);
    if (cachedClients.size >= MAX_CACHED_CLIENTS) {
        const defaultUri = process.env.MONGODB_URI;
        for (const [key, client] of cachedClients.entries()) {
            if (key !== defaultUri) {
                client.close().catch(() => {});
                cachedClients.delete(key);
                break;
            }
        }
    }
    const client = new MongoClient(uri, { maxPoolSize: 3, serverSelectionTimeoutMS: 5000 });
    await client.connect();
    cachedClients.set(uri, client);
    return client;
}

let netlifyDb = null;
async function getUserMongoUri(userId) {
    if (!userId) return null;
    if (!netlifyDb) {
        try { netlifyDb = getDatabase(); } catch (e) { return null; }
    }
    try {
        const rows = await netlifyDb.sql`
            SELECT custom_mongo_uri, db_mode FROM user_profiles
            WHERE user_id = ${userId} AND deleted_at IS NULL LIMIT 1
        `;
        if (rows && rows.length > 0 && rows[0].db_mode === "custom") {
            return rows[0].custom_mongo_uri || null;
        }
    } catch (e) {}
    return null;
}

function buildDefaultSchema() {
    return {
        role_title: "Fresher & Early Career Tech Roles",
        target_level: "fresher",
        primary_country: "India",
        categories: ["software_engineering", "data_ml", "devops_cloud", "cybersecurity", "product_design", "other"],
        category_labels: {
            software_engineering: "Software Eng",
            data_ml: "Data / AI",
            devops_cloud: "DevOps / Cloud",
            cybersecurity: "Security",
            product_design: "Product & Design",
            other: "Other Roles"
        },
        locations: [
            { id: "all", label: "All Locations" },
            { id: "remote", label: "Remote" },
            { id: "india", label: "India Tech Hubs" },
            { id: "overseas", label: "Overseas / Visa" }
        ],
        experience_levels: [
            { value: "all", label: "All Matches" },
            { value: "SAFE", label: "🟢 0-1 YOE Confirmed" },
            { value: "POSSIBLE", label: "🟡 Possible Match" }
        ],
        isCustomDb: false,
        source: "default_fallback"
    };
}

exports.handler = async (event, context) => {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 204, headers: CORS, body: "" };
    }

    let userId = null;
    try {
        const authUser = await verifyToken(event, context);
        if (authUser && authUser.userId) {
            userId = authUser.userId;
        }
    } catch (e) {
        // Auth is optional for schema discovery; unauthenticated guests browse the default stream
    }

    try {
        let mongoUri = process.env.MONGODB_URI;
        let isCustomDb = false;

        if (userId) {
            const customUri = await getUserMongoUri(userId);
            if (customUri && customUri.trim()) {
                mongoUri = customUri.trim();
                isCustomDb = true;
            }
        }

        // Direct encrypted header override fallback if passed
        const headerCustom = (event.headers || {})["x-mongo-uri"] || (event.headers || {})["X-Mongo-Uri"];
        if (!isCustomDb && headerCustom && headerCustom.trim()) {
            mongoUri = headerCustom.trim();
            isCustomDb = true;
        }

        if (!mongoUri) {
            return {
                statusCode: 200,
                headers: { ...CORS, "Cache-Control": "public, max-age=300" },
                body: JSON.stringify(buildDefaultSchema())
            };
        }

        const client = await connectToDatabase(mongoUri);
        let db;
        try {
            const rawDb = client.db();
            db = (!rawDb || !rawDb.databaseName || rawDb.databaseName === "test") ? client.db("job_aggregator") : rawDb;
        } catch (e) {
            db = client.db("job_aggregator");
        }

        const metaDoc = await db.collection("meta").findOne({ _id: "active_profile" }).catch(() => null);
        const jobsCol = db.collection("jobs");

        // Categories from metaDoc or auto-discovered from jobs collection
        let categories = [];
        if (metaDoc && Array.isArray(metaDoc.enabled_categories) && metaDoc.enabled_categories.length > 0) {
            categories = metaDoc.enabled_categories.filter(Boolean).map(c => c.toLowerCase().trim());
        } else {
            categories = (await jobsCol.distinct("category").catch(() => [])).filter(Boolean).map(c => c.toLowerCase().trim());
        }

        // Put "other" at the end
        categories = categories.filter(c => c !== "other").sort();
        if (categories.length === 0 || metaDoc?.enabled_categories?.includes("other")) {
            categories.push("other");
        }

        // Location pills
        const locationPills = [{ id: "all", label: "All Locations" }];
        if (metaDoc && Array.isArray(metaDoc.allowed_cities)) {
            const specificCities = metaDoc.allowed_cities.filter(c =>
                c && !["all india", "anywhere in india", "india", "remote", "remote only"].includes(c.toLowerCase().trim())
            );
            specificCities.forEach(city => {
                locationPills.push({ id: city.toLowerCase().trim(), label: city.trim() });
            });
        }
        locationPills.push(
            { id: "remote", label: "Remote" },
            { id: "india", label: "India Tech Hubs" },
            { id: "overseas", label: "Overseas / Visa" }
        );

        const categoryLabels = {
            software_engineering: "Software Eng",
            data_ml: "Data / AI",
            devops_cloud: "DevOps / Cloud",
            cybersecurity: "Security",
            product_design: "Product & Design",
            human_resources: "HR & People",
            marketing_sales: "Marketing & Sales",
            finance_legal: "Finance & Legal",
            operations: "Operations",
            other: "Other Roles"
        };

        const schema = {
            role_title: metaDoc?.role_title || "Fresher & Early Career Tech Roles",
            target_level: metaDoc?.target_level || "fresher",
            primary_country: metaDoc?.primary_country || "India",
            categories,
            category_labels: categoryLabels,
            locations: locationPills,
            experience_levels: [
                { value: "all", label: "All Matches" },
                { value: "SAFE", label: "🟢 0-1 YOE Confirmed" },
                { value: "POSSIBLE", label: "🟡 Possible Match" }
            ],
            allow_remote: metaDoc?.allow_remote !== false,
            accept_visa: metaDoc?.accept_visa !== false,
            isCustomDb,
            source: metaDoc ? "meta_collection" : "auto_discovered"
        };

        return {
            statusCode: 200,
            headers: {
                ...CORS,
                "Cache-Control": isCustomDb ? "private, max-age=60" : "public, max-age=180, s-maxage=180, stale-while-revalidate=360",
                "Vary": "Authorization, x-mongo-uri"
            },
            body: JSON.stringify(schema)
        };
    } catch (err) {
        console.error("schemaDiscover error:", err.message);
        return {
            statusCode: 200,
            headers: CORS,
            body: JSON.stringify(buildDefaultSchema())
        };
    }
};

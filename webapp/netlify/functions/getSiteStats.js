const { MongoClient } = require("mongodb");

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const uri = process.env.MONGODB_URI;

// Bounded connection pool cache (resets on disconnect)
let cachedClient = null;

async function connectToDatabase() {
    if (!uri) throw new Error("MONGODB_URI environment variable is not defined");
    if (cachedClient) {
        try {
            // Ping to verify connection is still alive
            await cachedClient.db().command({ ping: 1 });
            return cachedClient;
        } catch (e) {
            try { cachedClient.close().catch(() => {}); } catch (err) {}
            cachedClient = null;
        }
    }
    const client = new MongoClient(uri, {
        maxPoolSize: 4,
        serverSelectionTimeoutMS: 5000
    });
    await client.connect();
    cachedClient = client;
    return client;
}

exports.handler = async (event, context) => {
    context.callbackWaitsForEmptyEventLoop = false;

    if (event.httpMethod === "OPTIONS") {
        return {
            statusCode: 204,
            headers: {
                "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
                "Access-Control-Allow-Headers": "Content-Type, Authorization",
                "Access-Control-Allow-Methods": "GET, OPTIONS"
            },
            body: ""
        };
    }

    try {
        if (!uri) {
            return {
                statusCode: 200,
                headers: {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
                    "Cache-Control": "public, max-age=60"
                },
                body: JSON.stringify({
                    summary: { total_sites_tracked: 0, productive_sites: 0, always_failing: 0, always_no_jobs: 0 },
                    sites: []
                })
            };
        }

        const client = await connectToDatabase();
        const db = client.db("job_aggregator");

        // Aggregate site_stats per URL
        const pipeline = [
            { $sort: { run_date: -1 } },
            {
                $group: {
                    _id: "$url",
                    runs: { $sum: 1 },
                    successful_fetches: { $sum: { $cond: ["$fetch_success", 1, 0] } },
                    total_quality_jobs: { $sum: "$quality_jobs_saved" },
                    total_jobs_seen:    { $sum: "$jobs_seen" },
                    avg_fetch_time_ms:  { $avg: "$fetch_time_ms" },
                    last_run:           { $first: "$run_date" },
                    last_error:         { $first: "$error" },
                    last_ats_name:      { $first: "$ats_name" },
                    company_name:       { $first: "$company_name" },
                    last_ats_replacement: { $first: "$ats_replacement_url" },
                    direct_apply_total: { $sum: "$link_types.direct_apply" },
                    filtered_list_total:{ $sum: "$link_types.filtered_list" },
                }
            },
            {
                $addFields: {
                    success_rate: {
                        $cond: [
                            { $gt: ["$runs", 0] },
                            { $divide: ["$successful_fetches", "$runs"] },
                            0
                        ]
                    },
                    jobs_per_run: {
                        $cond: [
                            { $gt: ["$successful_fetches", 0] },
                            { $divide: ["$total_quality_jobs", "$successful_fetches"] },
                            0
                        ]
                    }
                }
            },
            { $sort: { total_quality_jobs: -1 } },
            { $limit: 300 }
        ];

        const stats = await db.collection("site_stats").aggregate(pipeline).toArray();

        // Compute summary
        const summary = {
            total_sites_tracked: stats.length,
            always_failing: stats.filter(s => s.success_rate === 0 && s.runs >= 2).length,
            always_no_jobs: stats.filter(s => s.success_rate > 0 && s.total_quality_jobs === 0 && s.runs >= 2).length,
            productive_sites: stats.filter(s => s.total_quality_jobs > 0).length,
        };

        return {
            statusCode: 200,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
                "Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=600"
            },
            body: JSON.stringify({ summary, sites: stats }),
        };
    } catch (error) {
        console.error("getSiteStats MongoDB error:", error.message);
        return {
            statusCode: 500,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": ALLOWED_ORIGIN
            },
            body: JSON.stringify({
                summary: { total_sites_tracked: 0, productive_sites: 0, always_failing: 0, always_no_jobs: 0 },
                sites: [],
                error: error.message
            })
        };
    }
};

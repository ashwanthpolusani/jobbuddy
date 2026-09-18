const { MongoClient } = require("mongodb");

const uri = process.env.MONGODB_URI;
let cachedClient = null;

async function connectToDatabase() {
    if (cachedClient) return cachedClient;
    if (!uri) throw new Error("MONGODB_URI environment variable is not defined");
    const client = new MongoClient(uri);
    await client.connect();
    cachedClient = client;
    return client;
}

exports.handler = async (event, context) => {
    context.callbackWaitsForEmptyEventLoop = false;

    try {
        const client = await connectToDatabase();
        const db = client.db("job_aggregator");

        // Aggregate site_stats: per URL, get last 10 runs
        const pipeline = [
            { $sort: { run_date: -1 } },
            {
                $group: {
                    _id: "$url",
                    runs: { $sum: 1 },
                    successful_fetches: { $sum: { $cond: ["$fetch_success", 1, 0] } },
                    total_quality_jobs: { $sum: "$quality_jobs_saved" },
                    total_raw_jobs:     { $sum: "$raw_jobs_extracted" },
                    avg_fetch_time_ms:  { $avg: "$fetch_time_ms" },
                    avg_quality:        { $avg: "$avg_quality" },
                    last_run:           { $first: "$run_date" },
                    last_error:         { $first: "$error" },
                    direct_apply_total: { $sum: "$link_types.direct_apply" },
                    filtered_list_total:{ $sum: "$link_types.filtered_list" },
                    homepage_total:     { $sum: "$link_types.career_homepage" },
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
            { $sort: { total_quality_jobs: -1 } }
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
                "Access-Control-Allow-Origin": "*",
            },
            body: JSON.stringify({ summary, sites: stats }),
        };
    } catch (error) {
        console.error("getSiteStats error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Failed fetching site stats" }),
        };
    }
};

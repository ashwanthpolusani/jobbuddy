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

    const params = event.queryStringParameters || {};
    const category   = params.category   || null;
    const link_type  = params.link_type  || null;
    const min_quality = parseInt(params.min_quality ?? "3", 10);
    const limit      = Math.min(parseInt(params.limit ?? "100", 10), 200);
    const skip       = Math.max(parseInt(params.skip  ?? "0",   10), 0);

    try {
        const client = await connectToDatabase();
        const collection = client.db("job_aggregator").collection("jobs");

        // Build dynamic filter
        const filter = {};
        if (category)  filter.category  = category;
        if (link_type) filter.link_type = link_type;

        // For new schema docs, apply quality filter.
        // For old docs without quality field, always include them.
        if (min_quality > 0) {
            filter.$or = [
                { quality: { $gte: min_quality } },
                { quality: { $exists: false } }   // backwards compat
            ];
        }

        // Only fetch jobs that are still live (seen in the last 7 days)
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        filter.scraped_at = { $gte: sevenDaysAgo };

        const jobs = await collection
            .find(filter)
            .sort({ scraped_at: -1, _id: -1 })
            .skip(skip)
            .limit(limit)
            .toArray();

        return {
            statusCode: 200,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
                // Cache at CDN edge for 5 min, allow stale for 10 min while revalidating
                "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
            },
            body: JSON.stringify(jobs),
        };
    } catch (error) {
        console.error("getJobs error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Failed fetching jobs from database" }),
        };
    }
};

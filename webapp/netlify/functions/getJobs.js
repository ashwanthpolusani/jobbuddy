const { MongoClient } = require("mongodb");

const uri = process.env.MONGODB_URI;
let cachedClient = null;

async function connectToDatabase() {
    if (cachedClient) return cachedClient;
    if (!uri) throw new Error("MONGODB_URI environment variable is not defined");
    
    // Using default MongoClient timeouts (30s) so Atlas M0 has time to wake up from pause.
    const client = new MongoClient(uri);
    await client.connect();
    cachedClient = client;
    return client;
}

exports.handler = async (event, context) => {
    // Allows Netlify to freeze the process and reuse the db connection
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

        const filter = {};
        if (category)  filter.category  = category;
        if (link_type) filter.link_type = link_type;

        if (min_quality > 0) {
            filter.$or = [
                { quality: { $gte: min_quality } },
                { quality: { $exists: false } }
            ];
        }

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
                "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
            },
            body: JSON.stringify(jobs),
        };
    } catch (error) {
        console.error("getJobs error:", error);
        return {
            statusCode: 500,
            headers: { "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({ error: "Failed fetching jobs from database" }),
        };
    }
};

// This runs on Netlify's AWS Lambda infrastructure
const { MongoClient } = require("mongodb");

// MONGODB_URI needs to be set in Netlify Environment Variables settings
const uri = process.env.MONGODB_URI;

// Cached connection variable to prevent reconnecting on every function invocation
let cachedClient = null;

async function connectToDatabase() {
    if (cachedClient) {
        return cachedClient;
    }
    
    if (!uri) {
        throw new Error("MONGODB_URI environment variable is not defined");
    }

    const client = new MongoClient(uri, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
    });

    await client.connect();
    cachedClient = client;
    return client;
}

exports.handler = async (event, context) => {
    // Allows Netlify to freeze the process and reuse the DB connection
    context.callbackWaitsForEmptyEventLoop = false;

    try {
        const client = await connectToDatabase();
        const db = client.db("job_aggregator");
        const collection = db.collection("jobs");
        
        // Fetch the 50 most recent jobs
        const jobs = await collection.find({ is_match: true })
            .sort({ _id: -1 }) // Assuming newer insertions have higher ObjectIDs
            .limit(50)
            .toArray();

        return {
            statusCode: 200,
            headers: {
                "Content-Type": "application/json",
                // Allow CORS if testing locally from a different port
                "Access-Control-Allow-Origin": "*",
            },
            body: JSON.stringify(jobs),
        };
    } catch (error) {
        console.error("Database connection error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Failed fetching jobs from database" }),
        };
    }
};

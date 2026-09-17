const express = require('express');
const { MongoClient } = require('mongodb');
const path = require('path');
require('dotenv').config();

const app = express();
const port = 8888;
const uri = process.env.MONGODB_URI;

let cachedClient = null;

async function connectToDatabase() {
    if (cachedClient) return cachedClient;
    const client = new MongoClient(uri);
    await client.connect();
    cachedClient = client;
    return client;
}

// Serve static HTML files
app.use(express.static(path.join(__dirname)));

// API Route that matches the Netlify function path
app.get('/.netlify/functions/getJobs', async (req, res) => {
    try {
        const client = await connectToDatabase();
        const db = client.db("job_aggregator");
        const jobs = await db.collection("jobs").find({ is_match: true }).sort({ _id: -1 }).limit(50).toArray();
        res.json(jobs);
    } catch (error) {
        console.error("Database Error:", error);
        res.status(500).json({ error: "Failed fetching jobs" });
    }
});

app.listen(port, () => {
    console.log(`Server is running perfectly at http://localhost:${port}`);
});

const express = require('express');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config({ path: path.join(__dirname, '..', 'scraper', '.env') });

const getJobsHandler = require('./netlify/functions/getJobs').handler;
const getSiteStatsHandler = require('./netlify/functions/getSiteStats').handler;

const app = express();
const PORT = process.env.PORT || 8888;

app.use(express.static(__dirname));

app.get('/.netlify/functions/getJobs', async (req, res) => {
    const event = { queryStringParameters: req.query, headers: req.headers };
    const context = { callbackWaitsForEmptyEventLoop: false };
    const result = await getJobsHandler(event, context);
    res.status(result.statusCode).set(result.headers || {}).send(result.body);
});

app.get('/.netlify/functions/getSiteStats', async (req, res) => {
    const event = { queryStringParameters: req.query, headers: req.headers };
    const context = { callbackWaitsForEmptyEventLoop: false };
    const result = await getSiteStatsHandler(event, context);
    res.status(result.statusCode).set(result.headers || {}).send(result.body);
});

// SPA fallback for programmatic SEO routes
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`JobBuddy local dev server running at http://localhost:${PORT}`);
});

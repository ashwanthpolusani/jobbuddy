const express = require('express');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config({ path: path.join(__dirname, '..', 'scraper', '.env') });

const getJobsHandler = require('./netlify/functions/getJobs').handler;
const getSiteStatsHandler = require('./netlify/functions/getSiteStats').handler;
const userProfileHandler = require('./netlify/functions/userProfile').handler;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname, { extensions: ['html'] }));

// Explicit static publisher routes (matching Netlify _redirects)
app.get('/scraper-guide', (req, res) => res.sendFile(path.join(__dirname, 'scraper-guide.html')));
app.get('/interview-prep', (req, res) => res.sendFile(path.join(__dirname, 'interview-prep.html')));
app.get('/resume-guide', (req, res) => res.sendFile(path.join(__dirname, 'resume-guide.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'terms.html')));
app.get('/portals', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.all('/.netlify/functions/getJobs', async (req, res) => {
    const event = {
        httpMethod: req.method,
        queryStringParameters: req.query,
        headers: req.headers,
        body: req.body ? JSON.stringify(req.body) : null
    };
    const context = { callbackWaitsForEmptyEventLoop: false };
    const result = await getJobsHandler(event, context);
    res.status(result.statusCode).set(result.headers || {}).send(result.body);
});

app.all('/.netlify/functions/getSiteStats', async (req, res) => {
    const event = {
        httpMethod: req.method,
        queryStringParameters: req.query,
        headers: req.headers
    };
    const context = { callbackWaitsForEmptyEventLoop: false };
    const result = await getSiteStatsHandler(event, context);
    res.status(result.statusCode).set(result.headers || {}).send(result.body);
});

app.all('/.netlify/functions/userProfile', async (req, res) => {
    const event = {
        httpMethod: req.method,
        queryStringParameters: req.query,
        headers: req.headers,
        body: req.body ? JSON.stringify(req.body) : null
    };
    const context = { callbackWaitsForEmptyEventLoop: false };
    const result = await userProfileHandler(event, context);
    res.status(result.statusCode).set(result.headers || {}).send(result.body);
});

// SPA fallback for programmatic SEO search filters
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`JobBuddy local dev server running at http://localhost:${PORT}`);
});


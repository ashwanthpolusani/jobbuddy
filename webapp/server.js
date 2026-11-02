const express = require('express');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '.env') });

const getJobsHandler = require('./netlify/functions/getJobs').handler;
const getSiteStatsHandler = require('./netlify/functions/getSiteStats').handler;
const userProfileHandler = require('./netlify/functions/userProfile').handler;
const schemaDiscoverHandler = require('./netlify/functions/schemaDiscover').handler;

const app = express();
const PORT = process.env.PORT || 3000;

// Security Headers Middleware
app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    next();
});

app.use(express.json());
app.use(express.static(__dirname, { extensions: ['html'], dotfiles: 'allow' }));

// Explicit static publisher routes (matching Netlify _redirects)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use('/jobs', (req, res) => res.sendFile(path.join(__dirname, 'jobs.html')));
app.get('/landing', (req, res) => res.redirect(301, '/'));
app.get('/about', (req, res) => res.sendFile(path.join(__dirname, 'about.html')));
app.get('/onboarding', (req, res) => res.sendFile(path.join(__dirname, 'onboarding.html')));
app.get('/profile', (req, res) => res.sendFile(path.join(__dirname, 'profile.html')));
app.get('/scraper-guide', (req, res) => res.sendFile(path.join(__dirname, 'scraper-guide.html')));
app.get('/interview-prep', (req, res) => res.sendFile(path.join(__dirname, 'interview-prep.html')));
app.get('/resume-guide', (req, res) => res.sendFile(path.join(__dirname, 'resume-guide.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'terms.html')));
app.get('/portals', (req, res) => res.redirect(301, '/jobs'));
app.get('/custom-scraper', (req, res) => res.redirect(301, '/jobs'));
app.get('/tracker', (req, res) => res.redirect(301, '/jobs'));

const callNetlifyHandler = (handler) => async (req, res) => {
    try {
        const event = {
            httpMethod: req.method,
            queryStringParameters: req.query,
            headers: req.headers,
            body: req.body ? JSON.stringify(req.body) : null
        };
        const context = { callbackWaitsForEmptyEventLoop: false };
        const result = await handler(event, context);
        res.status(result.statusCode).set(result.headers || {}).send(result.body);
    } catch (e) {
        console.error('Handler error:', e);
        res.status(500).json({ error: e.message });
    }
};

app.all('/.netlify/functions/getJobs', callNetlifyHandler(getJobsHandler));
app.all('/api/jobs', callNetlifyHandler(getJobsHandler));

app.all('/.netlify/functions/getSiteStats', callNetlifyHandler(getSiteStatsHandler));
app.all('/api/site-stats', callNetlifyHandler(getSiteStatsHandler));

app.all('/.netlify/functions/userProfile', callNetlifyHandler(userProfileHandler));
app.all('/api/user-profile', callNetlifyHandler(userProfileHandler));

app.all('/.netlify/functions/schemaDiscover', callNetlifyHandler(schemaDiscoverHandler));
app.all('/api/schema-discover', callNetlifyHandler(schemaDiscoverHandler));

// 404 Fallback: Any route under /jobs serves the live jobs feed; any unknown external route redirects cleanly to /
app.use((req, res) => {
    if (req.path && req.path.startsWith('/jobs')) {
        res.sendFile(path.join(__dirname, 'jobs.html'));
    } else {
        res.redirect(302, '/');
    }
});

app.listen(PORT, () => {
    console.log(`Rolenaut local dev server running at http://localhost:${PORT}`);
});

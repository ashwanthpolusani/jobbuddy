const { MongoClient } = require("mongodb");
const fs = require("fs");
const path = require("path");
const { getDatabase } = require("@netlify/database");
const { verifyToken } = require("./verifyToken");

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

let netlifyDbInstance = null;
async function resolveUserCustomUri(event, context) {
    try {
        const authUser = await verifyToken(event, context);
        if (!authUser || !authUser.userId) return null;
        if (!netlifyDbInstance) {
            try { netlifyDbInstance = getDatabase(); } catch (e) { return null; }
        }
        const rows = await netlifyDbInstance.sql`
            SELECT custom_mongo_uri, db_mode FROM user_profiles
            WHERE user_id = ${authUser.userId} AND deleted_at IS NULL LIMIT 1
        `;
        if (rows && rows.length > 0 && rows[0].db_mode === "custom") {
            return rows[0].custom_mongo_uri || null;
        }
    } catch (e) {}
    return null;
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Bounded connection pool cache keyed by URI (Max 6 clients to prevent memory leaks)
const MAX_CACHED_CLIENTS = 6;
const cachedClients = new Map();

async function connectToDatabase(customUri) {
    const uri = (customUri && customUri.trim()) || process.env.MONGODB_URI;
    if (!uri) throw new Error("No MongoDB connection URI provided");

    if (cachedClients.has(uri)) {
        return cachedClients.get(uri);
    }

    if (cachedClients.size >= MAX_CACHED_CLIENTS) {
        // Evict oldest non-default client
        for (const [key, clientToClose] of cachedClients.entries()) {
            if (key !== process.env.MONGODB_URI) {
                clientToClose.close().catch(() => {});
                cachedClients.delete(key);
                break;
            }
        }
    }

    const client = new MongoClient(uri, {
        maxPoolSize: 5,
        serverSelectionTimeoutMS: 6000
    });
    await client.connect();
    cachedClients.set(uri, client);
    return client;
}

function buildQueryFilter({ category, link_type, verdict, location, search }) {
    const clauses = [];

    // 1. Link Type partition: direct apply vs portals (classified by scraper)
    if (link_type === 'direct_apply') {
        clauses.push({ link_type: 'direct_apply' });

        // Verdict (experience gate only applies to individual direct apply vacancies)
        if (verdict && verdict !== "all") {
            clauses.push({ experience_verdict: verdict });
        } else {
            // Never serve rejected or blocked jobs
            clauses.push({ experience_verdict: { $nin: ['REJECTED', 'BLOCKED'] } });
        }

        // Functional Category filter (direct indexed lookup; classified by scraper at ingestion)
        if (category && category !== "all") {
            clauses.push({ category: category });
        }

        // Location filter (applies to individual job openings)
        if (location && location !== "all") {
            const locKey = location.toLowerCase().trim();
            const INDIA_REGEX = 'india|hyderabad|hyd|bangalore|bengaluru|mumbai|delhi|new delhi|gurugram|gurgaon|pune|chennai|noida|kolkata|ahmedabad|jaipur|kochi|coimbatore|navi mumbai|thane|lucknow|chandigarh|indore';
            const REMOTE_REGEX = 'remote|work from home|wfh|anywhere|distributed|worldwide|global remote';
            const OVERSEAS_REGEX = 'us|usa|united states|uk|united kingdom|london|singapore|germany|berlin|amsterdam|netherlands|canada|vancouver|toronto|tokyo|japan|australia|sydney|melbourne|dublin|ireland|switzerland|bangkok|thailand|france|paris|spain|barcelona|madrid|poland|warsaw|austria|vienna|sweden|stockholm|brazil|mexico|worldwide|global|apac|emea|latam';

            if (locKey === 'remote') {
                clauses.push({ location: { $regex: REMOTE_REGEX, $options: 'i' } });
            } else if (locKey === 'india') {
                clauses.push({ location: { $regex: INDIA_REGEX, $options: 'i' } });
            } else if (locKey === 'global' || locKey === 'overseas') {
                clauses.push({
                    location: { $exists: true, $nin: ['', null] },
                    $or: [
                        { location: { $regex: OVERSEAS_REGEX, $options: 'i' } },
                        {
                            $and: [
                                { location: { $not: { $regex: INDIA_REGEX, $options: 'i' } } },
                                { location: { $not: { $regex: '^(\\s*remote\\s*|\\s*work from home\\s*)$', $options: 'i' } } }
                            ]
                        }
                    ]
                });
            } else {
                // Dynamically match user custom location / city (e.g. 'hyderabad', 'pune', 'bengaluru')
                clauses.push({ location: { $regex: escapeRegex(location.trim()), $options: 'i' } });
            }
        }
    } else if (link_type === 'filtered_list') {
        // Company Career Pages
        clauses.push({ link_type: { $in: ['filtered_list', 'career_homepage'] } });
    }

    // Search query across title, company, location, and requirements/skills (applies to BOTH)
    if (search && search.trim()) {
        const q = escapeRegex(search.trim());
        const searchRegex = { $regex: q, $options: "i" };
        clauses.push({
            $or: [
                { title: searchRegex },
                { company_name: searchRegex },
                { location: searchRegex },
                { core_requirements: searchRegex }
            ]
        });
    }

    if (clauses.length === 0) return {};
    if (clauses.length === 1) return clauses[0];
    return { $and: clauses };
}

function getLocalJobsFallback({ category, link_type, verdict, location, search, page, limit }) {
    let localJobs = [];
    const possiblePaths = [
        path.join(__dirname, '..', '..', 'data', 'jobs.json'),
        path.join(__dirname, '..', 'data', 'jobs.json')
    ];
    for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
            try {
                localJobs = JSON.parse(fs.readFileSync(p, 'utf8'));
                break;
            } catch (e) {}
        }
    }

    let filtered = localJobs;
    if (link_type === 'direct_apply') {
        filtered = filtered.filter(j => (j.link_type || 'direct_apply') === 'direct_apply');
        if (verdict && verdict !== 'all') {
            filtered = filtered.filter(j => j.experience_verdict === verdict);
        } else {
            filtered = filtered.filter(j => !['REJECTED', 'BLOCKED'].includes(j.experience_verdict));
        }
        if (category && category !== 'all') {
            filtered = filtered.filter(j => j.category === category);
        }
        if (location && location !== 'all') {
            const locKey = location.toLowerCase().trim();
            filtered = filtered.filter(j => (j.location || '').toLowerCase().includes(locKey));
        }
    } else if (link_type === 'filtered_list') {
        filtered = filtered.filter(j => ['filtered_list', 'career_homepage'].includes(j.link_type));
    }

    if (search && search.trim()) {
        const q = search.trim().toLowerCase();
        filtered = filtered.filter(j =>
            (j.title && j.title.toLowerCase().includes(q)) ||
            (j.company_name && j.company_name.toLowerCase().includes(q)) ||
            (j.location && j.location.toLowerCase().includes(q)) ||
            (j.core_requirements && j.core_requirements.toLowerCase().includes(q))
        );
    }

    const total = filtered.length;
    const skip = (page - 1) * limit;
    const paginated = filtered.slice(skip, skip + limit);
    const directCount = localJobs.filter(j => (j.link_type || 'direct_apply') === 'direct_apply').length;
    const portalCount = localJobs.filter(j => j.link_type === 'filtered_list').length;
    const distinctCats = [...new Set(localJobs.map(j => j.category).filter(Boolean))];

    return {
        jobs: paginated.map(j => ({
            _id: j._id?.$oid || j._id || j.job_id,
            title: j.title || 'Untitled',
            company_name: j.company_name || '',
            location: j.location || '',
            category: j.category || 'other',
            link: j.link || '#',
            link_type: j.link_type || 'direct_apply',
            experience_verdict: j.experience_verdict || 'SAFE',
            core_requirements: j.core_requirements || '',
            content: j.content || '',
            ats_name: j.ats_name || 'Direct',
            scraped_at: j.scraped_at || new Date().toISOString(),
            first_seen: j.first_seen || j.scraped_at || new Date().toISOString()
        })),
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        directCount,
        portalCount,
        meta: {
            profile: {
                role_title: "Fresher & Early Career",
                target_level: "fresher",
                allowed_cities: ["All India"]
            },
            categories: distinctCats,
            locations: [
                { id: "all", label: "All Locations" },
                { id: "remote", label: "Remote" },
                { id: "india", label: "India Tech Hubs" },
                { id: "overseas", label: "Overseas / Visa" }
            ],
            isOfflineFallback: true,
            isCustomDb: false
        }
    };
}

exports.handler = async (event, context) => {
    // Allows Netlify to freeze process and reuse DB connection
    context.callbackWaitsForEmptyEventLoop = false;

    // Handle CORS Preflight
    if (event.httpMethod === "OPTIONS") {
        return {
            statusCode: 204,
            headers: {
                "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
                "Access-Control-Allow-Headers": "Content-Type, Authorization, x-mongo-uri, X-Mongo-Uri",
                "Access-Control-Allow-Methods": "GET, OPTIONS"
            },
            body: ""
        };
    }

    const params = event.queryStringParameters || {};
    const headers = event.headers || {};
    
    // Resolve custom MongoDB URI:
    // 1. First check header 'x-mongo-uri'
    // 2. Otherwise if user is logged in with JWT, check user's profile in Netlify DB
    let customUri = (headers['x-mongo-uri'] || headers['X-Mongo-Uri'] || "").trim();
    if (!customUri) {
        const userDbUri = await resolveUserCustomUri(event, context);
        if (userDbUri) customUri = userDbUri.trim();
    }

    // SSRF / Host validation: validate customUri if provided
    if (customUri) {
        if (!customUri.startsWith("mongodb://") && !customUri.startsWith("mongodb+srv://")) {
            return {
                statusCode: 400,
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": ALLOWED_ORIGIN },
                body: JSON.stringify({ error: "Invalid MongoDB connection string format." })
            };
        }
        if (customUri.startsWith("mongodb+srv://") && !/mongodb\+srv:\/\/[^@]+@[^/]+\.mongodb\.net/i.test(customUri)) {
            return {
                statusCode: 400,
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": ALLOWED_ORIGIN },
                body: JSON.stringify({ error: "Only MongoDB Atlas (*.mongodb.net) clusters are allowed for security." })
            };
        }
    }

    const category   = params.category   || null;
    const link_type  = params.link_type  || "direct_apply"; // Default to direct apply
    const page       = Math.max(parseInt(params.page ?? "1", 10), 1);
    const limit      = Math.min(Math.max(parseInt(params.limit ?? "25", 10), 1), 100);
    const verdict    = params.verdict    || null;
    const location   = params.location   || "all";
    const search     = params.search     || "";

    // Connect to either custom user cluster or inbuilt curated MongoDB Atlas cluster
    const activeUri = (customUri && customUri.trim()) || process.env.MONGODB_URI || "";

    if (!activeUri) {
        // Seamless fallback to local curated jobs
        const fallback = getLocalJobsFallback({ category, link_type, verdict, location, search, page, limit });
        return {
            statusCode: 200,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
                "Cache-Control": "public, max-age=60"
            },
            body: JSON.stringify(fallback)
        };
    }

    try {
        const client = await connectToDatabase(activeUri);
        // Automatically inherit database from custom connection string if specified, or fallback to job_aggregator
        let db;
        try {
            const rawDb = client.db();
            if (!rawDb || !rawDb.databaseName || rawDb.databaseName === 'test') {
                db = client.db("job_aggregator");
            } else {
                db = rawDb;
            }
        } catch (e) {
            db = client.db("job_aggregator");
        }

        const collection = db.collection("jobs");

        const filter = buildQueryFilter({ category, link_type, verdict, location, search });

        // Build disjoint filters for live tab counts under current filters
        const directFilter = buildQueryFilter({ category, link_type: 'direct_apply', verdict, location, search });
        const portalFilter = buildQueryFilter({ category: 'all', link_type: 'filtered_list', verdict: 'all', location: 'all', search });

        const projection = {
            _id: 1,
            title: 1,
            company_name: 1,
            location: 1,
            category: 1,
            link: 1,
            link_type: 1,
            experience_verdict: 1,
            core_requirements: 1,
            ats_name: 1,
            content: 1,
            verdict_reason: 1,
            scraped_at: 1,
            first_seen: 1
        };

        const skip = (page - 1) * limit;

        // Disjoint count optimization: avoid redundant count query for active link_type
        const countOtherPromise = link_type === 'direct_apply'
            ? collection.countDocuments(portalFilter)
            : collection.countDocuments(directFilter);

        // Fetch distinct categories and metadata in parallel for dynamic frontend rendering
        const metaPromise = db.collection("meta").findOne({ _id: "active_profile" }).catch(() => null);
        const distinctCatsPromise = collection.distinct("category").catch(() => []);

        // Run queries in parallel for lowest latency
        const [total, rawJobs, otherCount, metaDoc, distinctCats] = await Promise.all([
            collection.countDocuments(filter),
            collection.find(filter, { projection })
                .sort({ scraped_at: -1, _id: -1 })
                .skip(skip)
                .limit(limit)
                .toArray(),
            countOtherPromise,
            metaPromise,
            distinctCatsPromise
        ]);

        const directCount = link_type === 'direct_apply' ? total : otherCount;
        const portalCount = link_type === 'direct_apply' ? otherCount : total;

        // Failsafe Category Resolution: combine configured categories with distinct categories from DB
        const catSet = new Set();
        if (metaDoc && Array.isArray(metaDoc.enabled_categories)) {
            metaDoc.enabled_categories.forEach(c => c && catSet.add(c.toLowerCase().trim()));
        }
        distinctCats.forEach(c => c && catSet.add(c.toLowerCase().trim()));

        let dynamicCategories = Array.from(catSet).filter(c => c !== "other");
        dynamicCategories.sort();
        if (catSet.has("other") || dynamicCategories.length === 0) {
            dynamicCategories.push("other");
        }

        // Failsafe Location Pills Resolution:
        const locPills = [{ id: "all", label: "All Locations" }];
        if (metaDoc && Array.isArray(metaDoc.allowed_cities)) {
            const specificCities = metaDoc.allowed_cities.filter(
                c => c && !["all india", "anywhere in india", "india", "remote", "remote only"].includes(c.toLowerCase().trim())
            );
            specificCities.forEach(city => {
                locPills.push({ id: city.toLowerCase().trim(), label: city.trim() });
            });
        }
        locPills.push({ id: "remote", label: "Remote" });
        locPills.push({ id: "india", label: "India Tech Hubs" });
        locPills.push({ id: "overseas", label: "Overseas / Visa" });

        // Map to clean response objects with sanitized requirements text
        const seenLinks = new Set();
        const jobs = [];
        for (const j of rawJobs) {
            const linkKey = (j.link && j.link !== '#') ? j.link.trim().toLowerCase() : j._id.toString();
            if (!seenLinks.has(linkKey)) {
                seenLinks.add(linkKey);

                // Sanitize scraper bot artifacts / cookie blocker text from core_requirements
                let cleanReqs = (j.core_requirements || "").trim();
                if (
                    cleanReqs.toLowerCase().includes("javascript to run") ||
                    cleanReqs.toLowerCase().includes("enable javascript") ||
                    cleanReqs.toLowerCase().includes("corporate website and landing page") ||
                    cleanReqs.toLowerCase().includes("not a specific job description")
                ) {
                    cleanReqs = "";
                }

                jobs.push({
                    _id: j._id,
                    title: j.title || 'Untitled',
                    company_name: j.company_name || '',
                    location: j.location || '',
                    category: j.category || 'other',
                    link: j.link || '#',
                    link_type: j.link_type || 'direct_apply',
                    experience_verdict: j.experience_verdict || null,
                    core_requirements: cleanReqs,
                    ats_name: j.ats_name || 'Direct',
                    content: j.content || '',
                    verdict_reason: j.verdict_reason || '',
                    scraped_at: j.scraped_at || null,
                    first_seen: j.first_seen || j.scraped_at || null
                });
            }
        }

        return {
            statusCode: 200,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
                "Vary": "Accept-Encoding, x-mongo-uri, Authorization",
                "Cache-Control": customUri ? "no-store" : "public, max-age=180, s-maxage=180, stale-while-revalidate=360",
            },
            body: JSON.stringify({
                jobs,
                total,
                page,
                limit,
                totalPages: Math.max(1, Math.ceil(total / limit)),
                directCount,
                portalCount,
                meta: {
                    profile: metaDoc || {
                        role_title: "Tech Professional",
                        target_level: "fresher",
                        allowed_cities: ["All India"]
                    },
                    categories: dynamicCategories,
                    locations: locPills,
                    isCustomDb: Boolean(customUri)
                }
            }),
        };
    } catch (error) {
        console.error("getJobs error, switching to fallback:", error.message);
        // Fall back gracefully to local offline dataset so the UI remains 100% operational
        const fallback = getLocalJobsFallback({ category, link_type, verdict, location, search, page, limit });
        return {
            statusCode: 200,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": ALLOWED_ORIGIN
            },
            body: JSON.stringify(fallback)
        };
    }
};

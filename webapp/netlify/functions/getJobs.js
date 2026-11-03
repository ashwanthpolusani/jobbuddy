const { MongoClient } = require("mongodb");
const { getDatabase } = require("@netlify/database");
const { verifyToken } = require("./verifyToken");

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

let netlifyDbInstance = null;
function getNetlifyDb() {
    if (netlifyDbInstance) return netlifyDbInstance;
    try {
        const connString = process.env.NETLIFY_DB_URL;
        netlifyDbInstance = connString ? getDatabase({ connectionString: connString }) : getDatabase();
        return netlifyDbInstance;
    } catch (e) {
        return null;
    }
}

async function resolveUserCustomUri(event, context) {
    try {
        const authUser = await verifyToken(event, context);
        if (!authUser || !authUser.userId) return null;
        const db = getNetlifyDb();
        if (!db) return null;

        const dbPromise = db.sql`
            SELECT custom_mongo_uri, db_mode FROM user_profiles
            WHERE (user_id = ${authUser.userId} OR user_id = ${authUser.email}) AND deleted_at IS NULL LIMIT 1
        `;
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Netlify DB timeout")), 1500)
        );
        const rows = await Promise.race([dbPromise, timeoutPromise]);
        if (rows && rows.length > 0 && rows[0].custom_mongo_uri && rows[0].db_mode === "custom") {
            return rows[0].custom_mongo_uri;
        }
    } catch (e) {}
    return null;
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Automatically normalizes bare MongoDB Atlas URIs (e.g. mongodb+srv://...mongodb.net/ or ...mongodb.net)
// to target job_aggregator with retryWrites=true&w=majority
function normalizeMongoAtlasUri(rawUri) {
    if (!rawUri || typeof rawUri !== "string") return "";
    let uri = rawUri.trim();
    if (uri.startsWith("mongodb+srv://")) {
        const afterScheme = uri.slice("mongodb+srv://".length);
        const slashIdx = afterScheme.indexOf("/");
        if (slashIdx === -1) {
            return uri + "/job_aggregator?retryWrites=true&w=majority";
        }
        const pathAndQuery = afterScheme.slice(slashIdx + 1);
        const [dbName, queryString] = pathAndQuery.split("?");
        if (!dbName || dbName === "test" || dbName === "admin") {
            const query = queryString ? `?${queryString}` : "?retryWrites=true&w=majority";
            return uri.slice(0, "mongodb+srv://".length + slashIdx) + "/job_aggregator" + query;
        }
    }
    return uri;
}

// Bounded connection pool cache keyed by URI (Max 6 clients to prevent memory leaks)
const MAX_CACHED_CLIENTS = 6;
const cachedClients = new Map();

// In-memory cache for dynamic categories keyed by active database URI to eliminate cross-cluster cache poisoning
const cachedCategoriesMap = new Map();
const CATEGORIES_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function connectToDatabase(customUri) {
    let uri = (customUri && customUri.trim()) || process.env.MONGODB_URI;
    if (!uri) throw new Error("No MongoDB connection URI provided");
    uri = normalizeMongoAtlasUri(uri);

    if (cachedClients.has(uri)) {
        const existingClient = cachedClients.get(uri);
        try {
            // Fast ping with 1.5s timeout to ensure socket did not drop during warm lambda pause
            await existingClient.db("admin").command({ ping: 1 }, { maxTimeMS: 1500 });
            return existingClient;
        } catch (pingErr) {
            console.warn("Cached client socket stale; reconnecting:", pingErr.message);
            cachedClients.delete(uri);
            existingClient.close().catch(() => {});
        }
    }

    if (cachedClients.size >= MAX_CACHED_CLIENTS) {
        // Evict oldest non-default client
        const defaultUri = process.env.MONGODB_URI ? normalizeMongoAtlasUri(process.env.MONGODB_URI) : "";
        for (const [key, clientToClose] of cachedClients.entries()) {
            if (key !== defaultUri) {
                clientToClose.close().catch(() => {});
                cachedClients.delete(key);
                break;
            }
        }
    }

    const client = new MongoClient(uri, {
        maxPoolSize: 10,
        minPoolSize: 0,
        serverSelectionTimeoutMS: 3000,
        connectTimeoutMS: 3000,
        socketTimeoutMS: 5000,
        maxIdleTimeMS: 15000
    });
    await client.connect();
    cachedClients.set(uri, client);
    return client;
}

function buildQueryFilter({ category, link_type, verdict, location, search }, isCustom = false) {
    const clauses = [];

    // 1. Link Type partition: direct apply vs portals (classified by scraper)
    if (link_type === 'direct_apply') {
        if (isCustom) {
            // Custom scrapers may lack link_type field. Include all non-portal jobs
            clauses.push({
                $or: [
                    { link_type: 'direct_apply' },
                    { link_type: { $exists: false } },
                    { link_type: null },
                    { link_type: '' },
                    { link_type: { $nin: ['filtered_list', 'career_homepage'] } }
                ]
            });
        } else {
            clauses.push({ link_type: 'direct_apply' });
        }

        // Verdict (experience gate only applies to individual direct apply vacancies)
        if (verdict && verdict !== "all") {
            clauses.push({ experience_verdict: verdict });
        } else if (!isCustom) {
            // Never serve rejected or blocked jobs on curated stream
            clauses.push({ experience_verdict: { $nin: ['REJECTED', 'BLOCKED'] } });
        }

        // Functional Category filter
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
        const q = escapeRegex(search.trim().slice(0, 100));
        const searchRegex = { $regex: q, $options: "i" };
        clauses.push({
            $or: [
                { title: searchRegex },
                { job_title: searchRegex },
                { position: searchRegex },
                { company_name: searchRegex },
                { company: searchRegex },
                { location: searchRegex },
                { core_requirements: searchRegex },
                { requirements: searchRegex },
                { description: searchRegex }
            ]
        });
    }

    if (clauses.length === 0) return {};
    if (clauses.length === 1) return clauses[0];
    return { $and: clauses };
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
    const requestedStream = (params.stream || params.active_stream || "").toLowerCase().trim();

    // Resolve custom MongoDB URI:
    // If client requested 'curated' / 'inbuilt', bypass custom URI resolution
    let customUri = "";
    if (requestedStream !== "curated" && requestedStream !== "inbuilt" && requestedStream !== "fresher") {
        const rawHeader = (headers['x-mongo-uri'] || headers['X-Mongo-Uri'] || params.custom_mongo_uri || "").trim();
        if (rawHeader && rawHeader !== "[CONFIGURED]" && rawHeader.startsWith("mongodb+srv://")) {
            customUri = rawHeader;
        }
        if (!customUri) {
            const userDbUri = await resolveUserCustomUri(event, context);
            if (userDbUri && userDbUri !== "[CONFIGURED]" && userDbUri.startsWith("mongodb+srv://")) {
                customUri = userDbUri.trim();
            }
        }
    }
    if (customUri) {
        customUri = normalizeMongoAtlasUri(customUri);
    }

    // SSRF / Host validation: validate customUri if provided (Strict Atlas SRV only)
    if (customUri) {
        const atlasPattern = /^mongodb\+srv:\/\/[a-zA-Z0-9_\-\.%]+:[^@]+@[a-zA-Z0-9_\-\.]+\.mongodb\.net(?:\/.*)?$/;
        if (!atlasPattern.test(customUri)) {
            return {
                statusCode: 400,
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": ALLOWED_ORIGIN },
                body: JSON.stringify({ error: "Only MongoDB Atlas (*.mongodb.net) clusters with SRV connection strings are allowed for security." })
            };
        }
    }

    const isCustomDb = Boolean(customUri);
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
        return {
            statusCode: 503,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
            },
            body: JSON.stringify({
                error: "MongoDB connection is not configured. Please ensure MONGODB_URI is set.",
                jobs: [],
                total: 0,
                totalPages: 1,
                directCount: 0,
                portalCount: 0
            })
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

        let collection = db.collection("jobs");
        if (isCustomDb) {
            try {
                const collections = await db.listCollections().toArray();
                const colNames = collections.map(c => c.name);
                if (!colNames.includes("jobs")) {
                    const alt = colNames.find(n => ["job_postings", "postings", "all_jobs", "scraped_jobs", "vacancies"].includes(n.toLowerCase()));
                    if (alt) {
                        collection = db.collection(alt);
                    } else {
                        const nonSys = colNames.filter(n => !n.startsWith("system."));
                        if (nonSys.length === 1) collection = db.collection(nonSys[0]);
                    }
                }
            } catch (colErr) {
                collection = db.collection("jobs");
            }
        }

        const filter = buildQueryFilter({ category, link_type, verdict, location, search }, isCustomDb);

        // Build disjoint filters for live tab counts under current filters
        const directFilter = buildQueryFilter({ category, link_type: 'direct_apply', verdict, location, search }, isCustomDb);
        const portalFilter = buildQueryFilter({ category: 'all', link_type: 'filtered_list', verdict: 'all', location: 'all', search }, isCustomDb);

        const projection = isCustomDb ? {} : {
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
            verdict_reason: 1,
            scraped_at: 1,
            first_seen: 1
        };

        const skip = (page - 1) * limit;

        // Disjoint count optimization: avoid redundant count query for active link_type
        const countOtherPromise = (link_type === 'direct_apply'
            ? collection.countDocuments(portalFilter, { maxTimeMS: 2500 })
            : collection.countDocuments(directFilter, { maxTimeMS: 2500 })
        ).catch(err => {
            console.warn("Secondary tab count timed out:", err.message);
            return 0;
        });

        // Fetch distinct categories and metadata in parallel for dynamic frontend rendering
        const metaPromise = db.collection("meta").findOne({ _id: "active_profile" }, { maxTimeMS: 2000 }).catch(() => null);

        const now = Date.now();
        const cachedCatEntry = cachedCategoriesMap.get(activeUri);
        const shouldFetchCats = !cachedCatEntry || (now - cachedCatEntry.timestamp > CATEGORIES_CACHE_TTL);
        const distinctCatsPromise = shouldFetchCats
            ? collection.distinct("category", {}, { maxTimeMS: 2000 }).catch(() => [])
            : Promise.resolve(cachedCatEntry.categories);

        // Run queries in parallel for lowest latency
        const [total, rawJobs, otherCount, metaDoc, distinctCats] = await Promise.all([
            collection.countDocuments(filter, { maxTimeMS: 3000 }),
            collection.find(filter, { projection })
                .sort({ scraped_at: -1, created_at: -1, _id: -1 })
                .skip(skip)
                .limit(limit)
                .maxTimeMS(3000)
                .toArray(),
            countOtherPromise,
            metaPromise,
            distinctCatsPromise
        ]);

        if (distinctCats && distinctCats.length > 0) {
            if (cachedCategoriesMap.size >= 10) {
                const oldestKey = cachedCategoriesMap.keys().next().value;
                if (oldestKey) cachedCategoriesMap.delete(oldestKey);
            }
            cachedCategoriesMap.set(activeUri, {
                categories: distinctCats,
                timestamp: now
            });
        }

        const directCount = link_type === 'direct_apply' ? total : otherCount;
        const portalCount = link_type === 'direct_apply' ? otherCount : total;

        // Failsafe Category Resolution: combine configured categories with distinct categories from DB
        const catSet = new Set();
        if (metaDoc && Array.isArray(metaDoc.enabled_categories)) {
            metaDoc.enabled_categories.forEach(c => c && catSet.add(c.toLowerCase().trim()));
        }
        if (Array.isArray(distinctCats)) {
            distinctCats.forEach(c => c && catSet.add(c.toLowerCase().trim()));
        }

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
            const rawLink = j.link || j.url || j.apply_url || j.job_url || j.apply_link || '#';
            const linkKey = (rawLink && rawLink !== '#') ? String(rawLink).trim().toLowerCase() : j._id.toString();
            if (!seenLinks.has(linkKey)) {
                seenLinks.add(linkKey);

                // Safe extraction of requirements text (handles string or array)
                let cleanReqs = "";
                if (typeof j.core_requirements === "string") {
                    cleanReqs = j.core_requirements.trim();
                } else if (Array.isArray(j.core_requirements)) {
                    cleanReqs = j.core_requirements.filter(Boolean).join(" • ");
                } else if (typeof j.requirements === "string") {
                    cleanReqs = j.requirements.trim();
                } else if (Array.isArray(j.requirements)) {
                    cleanReqs = j.requirements.filter(Boolean).join(" • ");
                } else if (typeof j.description === "string") {
                    cleanReqs = j.description.trim().slice(0, 300);
                } else if (Array.isArray(j.skills)) {
                    cleanReqs = j.skills.filter(Boolean).join(" • ");
                }

                if (
                    cleanReqs.toLowerCase().includes("javascript to run") ||
                    cleanReqs.toLowerCase().includes("enable javascript") ||
                    cleanReqs.toLowerCase().includes("corporate website and landing page") ||
                    cleanReqs.toLowerCase().includes("not a specific job description")
                ) {
                    cleanReqs = "";
                }

                const title = j.title || j.job_title || j.position || j.role || 'Untitled';
                const comp = j.company_name || j.company || j.companyName || '';
                const loc = typeof j.location === 'string'
                    ? j.location
                    : (Array.isArray(j.location) ? j.location.join(', ') : (j.location?.city || j.city || ''));

                jobs.push({
                    _id: j._id,
                    title,
                    company_name: comp,
                    location: loc,
                    category: j.category || (Array.isArray(j.categories) ? j.categories[0] : 'other'),
                    link: rawLink,
                    link_type: j.link_type || 'direct_apply',
                    experience_verdict: j.experience_verdict || null,
                    core_requirements: cleanReqs,
                    ats_name: j.ats_name || j.source || 'Direct',
                    verdict_reason: j.verdict_reason || '',
                    scraped_at: j.scraped_at || j.created_at || j.posted_at || null,
                    first_seen: j.first_seen || j.scraped_at || j.created_at || null
                });
            }
        }

        return {
            statusCode: 200,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
                "Vary": "Accept-Encoding, x-mongo-uri, Authorization",
                "Cache-Control": isCustomDb ? "private, no-cache, no-store, must-revalidate" : "public, max-age=180, s-maxage=180, stale-while-revalidate=360",
                "Netlify-CDN-Cache-Control": isCustomDb ? "no-store" : "public, durable, max-age=180, stale-while-revalidate=360",
                "Pragma": isCustomDb ? "no-cache" : "public"
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
                    isCustomDb: isCustomDb
                }
            }),
        };
    } catch (error) {
        console.error("getJobs MongoDB query error:", error.message);
        // Evict dead client so warm lambda containers reconnect instead of poisoning future requests with 503
        if (activeUri && cachedClients.has(activeUri)) {
            const deadClient = cachedClients.get(activeUri);
            cachedClients.delete(activeUri);
            deadClient?.close().catch(() => {});
        }
        return {
            statusCode: 503,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": ALLOWED_ORIGIN
            },
            body: JSON.stringify({
                error: "MongoDB service is temporarily unavailable. Please retry shortly.",
                jobs: [],
                total: 0,
                totalPages: 1,
                directCount: 0,
                portalCount: 0,
                details: error.message
            })
        };
    }
};

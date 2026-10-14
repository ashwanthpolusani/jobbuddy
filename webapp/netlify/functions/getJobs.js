const { MongoClient } = require("mongodb");

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let cachedClient = null;

async function connectToDatabase() {
    if (cachedClient) return cachedClient;
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error("MONGODB_URI environment variable is not defined");
    
    const client = new MongoClient(uri, {
        maxPoolSize: 5,
        serverSelectionTimeoutMS: 5000
    });
    await client.connect();
    cachedClient = client;
    return client;
}

function buildQueryFilter({ category, link_type, verdict, location, search }) {
    const clauses = [];

    // 1. Link Type partition: direct apply vs portals
    if (link_type === 'direct_apply') {
        clauses.push({ link_type: { $nin: ['filtered_list', 'career_homepage'] } });
        // Double safeguard: programs and cohorts belong in fresher portals, not direct apply
        clauses.push({
            title: { $not: { $regex: "\\b(?:program|cohort|talent network|emerging talent|university interns|campus recruitment|fresher portal|career opportunities|entry-level careers|early talent)\\b", $options: "i" } }
        });

        // Verdict (experience gate only applies to individual direct apply vacancies)
        if (verdict && verdict !== "all") {
            clauses.push({ experience_verdict: verdict });
        } else {
            // Never serve rejected or blocked jobs
            clauses.push({ experience_verdict: { $nin: ['REJECTED', 'BLOCKED'] } });
        }

        // Functional Category filter (applies to individual job openings)
        if (category && category !== "all") {
            if (category === "software_engineering") {
                clauses.push({
                    $or: [
                        { category: "software_engineering" },
                        { title: { $regex: "\\b(?:software|engineer|developer|frontend|backend|fullstack|web|android|ios|sde|coding|programmer|swe|java|python|qa|tester)\\b", $options: "i" } }
                    ]
                });
            } else if (category === "data_ml") {
                clauses.push({
                    $or: [
                        { category: "data_ml" },
                        { title: { $regex: "\\b(?:data|ml|ai|machine learning|analytics|analyst|deep learning|nlp)\\b", $options: "i" } }
                    ]
                });
            } else if (category === "devops_cloud") {
                clauses.push({
                    $or: [
                        { category: "devops_cloud" },
                        { title: { $regex: "\\b(?:devops|cloud|sre|infrastructure|platform|aws|azure)\\b", $options: "i" } }
                    ]
                });
            } else if (category === "cybersecurity") {
                clauses.push({
                    $or: [
                        { category: "cybersecurity" },
                        { title: { $regex: "\\b(?:security|cyber|infosec|vulnerability|soc)\\b", $options: "i" } }
                    ]
                });
            } else if (category === "product_design") {
                clauses.push({
                    $or: [
                        { category: "product_design" },
                        { title: { $regex: "\\b(?:product|design|ux|ui|graphic|game design)\\b", $options: "i" } }
                    ]
                });
            } else if (category === "it_support") {
                clauses.push({
                    $or: [
                        { category: "it_support" },
                        { title: { $regex: "\\b(?:support|customer experience|it|tech support|operations)\\b", $options: "i" } }
                    ]
                });
            } else {
                clauses.push({ category: category });
            }
        }

        // Location filter (applies to individual job openings)
        if (location && location !== "all") {
            const INDIA_REGEX = 'india|hyderabad|hyd|bangalore|bengaluru|mumbai|delhi|new delhi|gurugram|gurgaon|pune|chennai|noida|kolkata|ahmedabad|jaipur|kochi|coimbatore|navi mumbai|thane|lucknow|chandigarh|indore';
            const REMOTE_REGEX = 'remote|work from home|wfh|anywhere|distributed|worldwide|global remote';
            const OVERSEAS_REGEX = 'us|usa|united states|uk|united kingdom|london|singapore|germany|berlin|amsterdam|netherlands|canada|vancouver|toronto|tokyo|japan|australia|sydney|melbourne|dublin|ireland|switzerland|bangkok|thailand|france|paris|spain|barcelona|madrid|poland|warsaw|austria|vienna|sweden|stockholm|brazil|mexico|worldwide|global|apac|emea|latam';

            if (location === 'remote') {
                clauses.push({ location: { $regex: REMOTE_REGEX, $options: 'i' } });
            } else if (location === 'india') {
                clauses.push({ location: { $regex: INDIA_REGEX, $options: 'i' } });
            } else if (location === 'global') {
                clauses.push({
                    $or: [
                        { location: { $regex: OVERSEAS_REGEX, $options: 'i' } },
                        { location: { $not: { $regex: INDIA_REGEX, $options: 'i' } } }
                    ]
                });
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

exports.handler = async (event, context) => {
    // Allows Netlify to freeze process and reuse DB connection
    context.callbackWaitsForEmptyEventLoop = false;

    const params = event.queryStringParameters || {};
    const category   = params.category   || null;
    const link_type  = params.link_type  || "direct_apply"; // Default to direct apply
    const page       = Math.max(parseInt(params.page ?? "1", 10), 1);
    const limit      = Math.min(Math.max(parseInt(params.limit ?? "25", 10), 1), 100);
    const verdict    = params.verdict    || null;
    const location   = params.location   || "all";
    const search     = params.search     || "";

    try {
        const client = await connectToDatabase();
        const collection = client.db("job_aggregator").collection("jobs");

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
            scraped_at: 1,
            first_seen: 1
        };

        const skip = (page - 1) * limit;

        // Disjoint count optimization: avoid redundant count query for active link_type
        const countOtherPromise = link_type === 'direct_apply'
            ? collection.countDocuments(portalFilter)
            : collection.countDocuments(directFilter);

        // Run queries in parallel for lowest latency
        const [total, rawJobs, otherCount] = await Promise.all([
            collection.countDocuments(filter),
            collection.find(filter, { projection })
                .sort({ scraped_at: -1, _id: -1 })
                .skip(skip)
                .limit(limit)
                .toArray(),
            countOtherPromise
        ]);

        const directCount = link_type === 'direct_apply' ? total : otherCount;
        const portalCount = link_type === 'direct_apply' ? otherCount : total;

        // Map to clean response objects (canonical schema)
        const jobs = rawJobs.map(j => ({
            _id: j._id,
            title: j.title || 'Untitled',
            company_name: j.company_name || '',
            location: j.location || '',
            category: j.category || 'other',
            link: j.link || '#',
            link_type: j.link_type || 'direct_apply',
            experience_verdict: j.experience_verdict || null,
            core_requirements: j.core_requirements || '',
            scraped_at: j.scraped_at || null,
            first_seen: j.first_seen || j.scraped_at || null
        }));

        return {
            statusCode: 200,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "public, s-maxage=180, stale-while-revalidate=360",
            },
            body: JSON.stringify({
                jobs,
                total,
                page,
                limit,
                totalPages: Math.max(1, Math.ceil(total / limit)),
                directCount,
                portalCount
            }),
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

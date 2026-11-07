// Sliding window rate limiter per edge isolate
const ipWindows = new Map();
const WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS = 75; // 75 requests per minute per IP

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Mongo-Uri, x-mongo-uri",
    "Access-Control-Max-Age": "86400"
};

function isRateLimited(ip) {
    const now = Date.now();
    const entry = ipWindows.get(ip) || [];

    // Filter timestamps within the current sliding window
    const recent = entry.filter(ts => now - ts < WINDOW_MS);

    if (recent.length >= MAX_REQUESTS) {
        ipWindows.set(ip, recent);
        return true;
    }

    recent.push(now);
    ipWindows.set(ip, recent);

    // Prune stale IPs periodically to prevent isolate memory leaks
    if (ipWindows.size > 1000) {
        for (const [key, timestamps] of ipWindows.entries()) {
            if (timestamps.length === 0 || now - timestamps[timestamps.length - 1] > WINDOW_MS) {
                ipWindows.delete(key);
            }
        }
    }

    return false;
}

export default async (request, context) => {
    try {
        // 1. Never block or rate-limit CORS preflight requests
        if (request.method === "OPTIONS") {
            return context.next();
        }

        // 2. Strict User-Agent filtering for automated scripts/bots
        const ua = (request.headers.get("user-agent") || "").toLowerCase();
        if (
            ua.includes("curl") ||
            ua.includes("python-requests") ||
            ua.includes("go-http-client") ||
            ua.includes("wget")
        ) {
            return new Response(
                JSON.stringify({
                    error: "Automated direct script access denied. Use web application.",
                    status: 403
                }),
                {
                    status: 403,
                    headers: {
                        "Content-Type": "application/json",
                        ...CORS_HEADERS
                    }
                }
            );
        }

        // 3. Sliding window IP rate limit check
        const ip = context.ip || "unknown";

        if (ip !== "unknown" && isRateLimited(ip)) {
            const resetSeconds = Math.ceil(WINDOW_MS / 1000);
            return new Response(
                JSON.stringify({
                    error: "Too Many Requests. Rate limit exceeded. Please wait a minute before retrying.",
                    status: 429
                }),
                {
                    status: 429,
                    headers: {
                        "Content-Type": "application/json",
                        "Retry-After": String(resetSeconds),
                        "X-RateLimit-Limit": String(MAX_REQUESTS),
                        "X-RateLimit-Remaining": "0",
                        "X-RateLimit-Reset": String(Math.ceil((Date.now() + WINDOW_MS) / 1000)),
                        ...CORS_HEADERS
                    }
                }
            );
        }

        return context.next();
    } catch (edgeErr) {
        // Fail-open: Edge function errors must NEVER crash or hang the website
        console.error("rate-limiter edge error (failing open):", edgeErr);
        return context.next();
    }
};

// Route strictly to API endpoints; fail-open with onError: "bypass"
export const config = {
    path: ["/api/*", "/.netlify/functions/*"],
    excludedPath: [
        "/*.*",
        "/favicon.*",
        "/jobs",
        "/about",
        "/onboarding",
        "/profile",
        "/privacy",
        "/terms",
        "/interview-prep",
        "/resume-guide",
        "/scraper-guide",
        "/"
    ],
    onError: "bypass"
};

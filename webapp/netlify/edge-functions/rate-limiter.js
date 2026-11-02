// Sliding window rate limiter per edge isolate
const ipWindows = new Map();
const WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS = 75; // 75 requests per minute per IP

function isRateLimited(ip) {
    const now = Date.now();
    const entry = ipWindows.get(ip) || [];
    
    // Filter timestamps within the current window
    const recent = entry.filter(ts => now - ts < WINDOW_MS);
    
    if (recent.length >= MAX_REQUESTS) {
        ipWindows.set(ip, recent);
        return true;
    }
    
    recent.push(now);
    ipWindows.set(ip, recent);
    
    // Prune stale IPs periodically to prevent memory leaks in isolates
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
    // Check user-agent
    const ua = request.headers.get("user-agent") || "";
    if (ua.includes("curl") || ua.includes("python-requests") || ua.includes("Go-http-client") || ua.includes("Wget")) {
        return new Response(JSON.stringify({ error: "Automated direct script access denied. Use web application." }), {
            status: 403,
            headers: { "Content-Type": "application/json" }
        });
    }

    const ip = context.ip || "unknown";

    if (ip !== "unknown" && isRateLimited(ip)) {
        return new Response(JSON.stringify({ 
            error: "Too Many Requests. Rate limit exceeded. Please wait a minute before retrying." 
        }), {
            status: 429,
            headers: { 
                "Content-Type": "application/json",
                "Retry-After": "60"
            }
        });
    }

    return context.next();
};

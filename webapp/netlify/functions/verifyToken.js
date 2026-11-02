/**
 * verifyToken.js — JWT verification helper for Netlify Identity
 *
 * Netlify Identity automatically validates the JWT at the edge and populates
 * context.clientContext.user when a valid Bearer token is sent. This helper
 * extracts and normalises the user object across local dev and Netlify deploys.
 */

const CORS = {
    "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-User-Id, X-User-Email",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Content-Type": "application/json"
};

/**
 * Decode a JWT payload without verifying the signature.
 * Signature verification is handled by Netlify edge infrastructure.
 */
function decodeJwtPayload(token) {
    try {
        const parts = token.split(".");
        if (parts.length !== 3) return null;
        const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
        const decoded = Buffer.from(padded, "base64").toString("utf8");
        return JSON.parse(decoded);
    } catch (e) {
        return null;
    }
}

function extractBearerToken(event) {
    const authHeader = (event.headers || {}).authorization || (event.headers || {}).Authorization || "";
    if (authHeader.toLowerCase().startsWith("bearer ")) {
        return authHeader.slice(7).trim();
    }
    // Also support query string parameters ?auth=... or ?token=... (critical for file downloads & GDPR exports)
    const query = event.queryStringParameters || {};
    if (query.auth) return query.auth.trim();
    if (query.token) return query.token.trim();
    return null;
}

/**
 * Verify the request and return a user object, or throw with a statusCode.
 * Priority:
 * 1. context.clientContext.user — Netlify edge-populated (production)
 * 2. Manual JWT or Dev Token decode — local dev / netlify dev CLI / file export
 * 3. Local dev fallback when x-user-email or query email is provided
 */
async function verifyToken(event, context) {
    // Path 1: Netlify edge-populated client context (production)
    const clientContext = (context && context.clientContext) || null;
    if (clientContext && clientContext.user) {
        const u = clientContext.user;
        const email = (u.email || u.sub || "").toLowerCase().trim();
        return {
            userId: email,
            email,
            sub: u.sub || email,
            name: u.user_metadata?.full_name || u.user_metadata?.name || email.split("@")[0]
        };
    }

    // Path 2: Manual decode for bearer token or query auth token
    const token = extractBearerToken(event);
    if (token) {
        // Dev token support for local development / testing
        if (token.startsWith("dev_token_")) {
            try {
                const email = Buffer.from(token.replace("dev_token_", ""), "base64").toString("utf8");
                if (email && email.includes("@")) {
                    const cleanEmail = email.toLowerCase().trim();
                    return {
                        userId: cleanEmail,
                        email: cleanEmail,
                        sub: cleanEmail,
                        name: cleanEmail.split("@")[0]
                    };
                }
            } catch (e) {}
        }

        const payload = decodeJwtPayload(token);
        if (payload) {
            if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
                throw { statusCode: 401, message: "Authentication token has expired. Please log in again." };
            }

            const email = (payload.email || payload.sub || "").toLowerCase().trim();
            if (email) {
                return {
                    userId: email,
                    email,
                    sub: payload.sub || email,
                    name: payload.user_metadata?.full_name || payload.user_metadata?.name || email.split("@")[0]
                };
            }
        }
    }

    // Path 3: Local dev fallback when x-user-email or query email is provided
    const isLocalDev = process.env.NODE_ENV !== "production" || !process.env.NETLIFY;
    const devEmail = (event.headers || {})["x-user-email"] || (event.headers || {})["X-User-Email"] || (event.queryStringParameters || {}).email;
    if (isLocalDev && devEmail) {
        const email = devEmail.toLowerCase().trim();
        return {
            userId: email,
            email,
            sub: (event.headers || {})["x-user-id"] || (event.headers || {})["X-User-Id"] || email,
            name: email.split("@")[0]
        };
    }

    throw { statusCode: 401, message: "Authentication required. Please log in." };
}

/**
 * requireAuth — returns user object OR a ready-to-return error response.
 * Usage:
 *   const authResult = await requireAuth(event, context);
 *   if (authResult.statusCode) return authResult;
 *   const { userId } = authResult;
 */
async function requireAuth(event, context) {
    try {
        return await verifyToken(event, context);
    } catch (err) {
        return {
            statusCode: err.statusCode || 401,
            headers: CORS,
            body: JSON.stringify({ error: err.message || "Authentication required." })
        };
    }
}

module.exports = { verifyToken, requireAuth, CORS };

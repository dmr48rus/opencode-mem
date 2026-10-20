const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0:0:0:0:0:0:0:1"]);
import { resolveClientScope } from "./client-keys.js";
function unauthorized() {
    return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
    });
}
export function isLoopbackHost(host) {
    return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}
export function assertWebServerNetworkAuth(host, apiToken, basicAuthEnabled = false) {
    if (!isLoopbackHost(host) && !apiToken && !basicAuthEnabled) {
        throw new Error(`webServerHost "${host}" exposes the API on the network. Set webServerApiToken in opencode-mem.jsonc, or bind to 127.0.0.1.`);
    }
}
export function presentedApiToken(req) {
    const header = req.headers.get("authorization");
    const bearer = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    const alt = req.headers.get("x-opencode-mem-token")?.trim();
    return bearer || alt || null;
}
export function isMasterToken(req, apiToken) {
    if (!apiToken)
        return false;
    const token = presentedApiToken(req);
    return token === apiToken;
}
/**
 * Authorize an API request.
 *
 * The master token is the administrator's and keeps full access. A client key
 * carries a scope: a read-only key may read, and is refused anything that
 * changes the store - including the MCP endpoint, whose tools can write.
 */
export function authorizeApiRequest(req, apiToken) {
    if (!apiToken)
        return null;
    const token = presentedApiToken(req);
    if (!token)
        return unauthorized();
    if (token === apiToken)
        return null;
    const scope = resolveClientScope(token);
    if (scope === null)
        return unauthorized();
    if (scope === "read" && req.method !== "GET" && req.method !== "HEAD") {
        return new Response(JSON.stringify({ success: false, error: "This key is read-only" }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
        });
    }
    return null;
}

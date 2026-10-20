import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { join, dirname, extname, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./logger.js";
import { corsPreflightResponse, disallowedCorsResponse, isAllowedBrowserOrigin } from "./cors.js";
import { assertWebServerNetworkAuth, authorizeApiRequest, isMasterToken } from "./web-api-auth.js";
import { issueClientKey, listClientKeys, revokeClientKey } from "./client-keys.js";
import { getOrCreateAuthToken, isAuthorizedApiRequest } from "./auth-token.js";
import { WebAuth } from "./web-auth.js";
import { NODE_HTTP_IDLE_TIMEOUT_MS } from "./request-timeouts.js";
import { checkMcpHost, handleMcpJsonRpc } from "./mcp-endpoint.js";
import { handleListTags, handleListMemories, handleAddMemory, handleDeleteMemory, handleBulkDelete, handleUpdateMemory, handleSearch, handleSnapshot, handleMarkDuplicates, handleTransferProfileIdentity, handleRunReindex, handleRunSweep, handleRememberByProject, handleStats, handlePinMemory, handleUnpinMemory, handleRunCleanup, handleRunDeduplication, handleDetectMigration, handleRunMigration, handleDetectTagMigration, handleRunTagMigrationBatch, handleGetTagMigrationProgress, handleDeletePrompt, handleBulkDeletePrompts, handleGetUserProfile, handlePutUserProfile, handleGetProfileChangelog, handleGetProfileSnapshot, handleRefreshProfile, handleAICleanup, handleApplyCleanup, handleUpdateProfileItem, handleListSkills, handleGetSkill, handleCreateSkill, handleUpdateSkill, handleDeleteSkill, handleSkillsCatalogIndex, handleSkillsCatalogFile, } from "./api-handlers.js";
const isBun = typeof globalThis.Bun !== "undefined";
const MIN_FAILED_TAKEOVERS = 3;
export function attachNodeDisconnectHandlers(req, res, onDisconnect) {
    let disconnected = false;
    const disconnectOnce = () => {
        if (disconnected || res.writableEnded)
            return;
        disconnected = true;
        onDisconnect();
    };
    req.on("aborted", disconnectOnce);
    req.on("close", () => {
        if (req.aborted || !req.complete)
            disconnectOnce();
    });
    req.socket.on("error", disconnectOnce);
    req.socket.on("close", disconnectOnce);
    res.on("close", disconnectOnce);
}
function serveFetch(opts) {
    if (isBun) {
        const bunHandle = globalThis.Bun.serve({
            port: opts.port,
            hostname: opts.hostname,
            fetch: opts.fetch,
        });
        return { stop: () => bunHandle.stop() };
    }
    // Node path: wrap node:http around the fetch-style handler. The adapter
    // converts IncomingMessage → Web Request and Web Response → ServerResponse.
    // Bodies stream both directions via the WHATWG Streams ↔ Node Streams
    // helpers that ship with Node 18+.
    const server = createServer(async (req, res) => {
        let destroyed = false;
        const abortController = new AbortController();
        const cleanup = () => {
            if (destroyed)
                return;
            destroyed = true;
            abortController.abort();
            if (!res.writableEnded)
                res.destroy();
            if (!req.socket.destroyed)
                req.socket.destroy();
        };
        attachNodeDisconnectHandlers(req, res, cleanup);
        try {
            const url = `http://${opts.hostname}:${opts.port}${req.url ?? "/"}`;
            const method = req.method ?? "GET";
            const hasBody = method !== "GET" && method !== "HEAD";
            const webReq = new Request(url, {
                method,
                headers: req.headers,
                body: hasBody ? Readable.toWeb(req) : undefined,
                signal: abortController.signal,
                ...(hasBody ? { duplex: "half" } : {}),
            });
            const webRes = await opts.fetch(webReq);
            if (destroyed)
                return;
            res.statusCode = webRes.status;
            webRes.headers.forEach((value, name) => res.setHeader(name, value));
            res.setHeader("Connection", "close");
            if (webRes.body) {
                const src = Readable.fromWeb(webRes.body);
                res.on("close", () => {
                    if (!src.destroyed)
                        src.destroy();
                });
                src.pipe(res);
            }
            else {
                res.end();
            }
        }
        catch (error) {
            if (!res.headersSent) {
                res.statusCode = 500;
                res.setHeader("Content-Type", "text/plain");
            }
            if (!res.writableEnded) {
                res.end(`Internal Server Error: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    });
    // Surface EADDRINUSE synchronously so callers can detect the
    // already-running-instance case the same way they do under Bun.
    let listenError;
    server.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
            listenError = err;
        }
    });
    // exclusive: false disables SO_EXCLUSIVEADDRUSE on Windows, allowing
    // rebind after a crashed predecessor left orphaned sockets behind.
    server.listen({ port: opts.port, host: opts.hostname, reuseAddr: true, exclusive: false });
    server.unref();
    server.timeout = NODE_HTTP_IDLE_TIMEOUT_MS;
    server.keepAliveTimeout = 10000;
    server.headersTimeout = 11000;
    if (listenError) {
        throw listenError;
    }
    return {
        stop: () => {
            server.closeAllConnections();
            server.close();
        },
    };
}
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
/**
 * Port fallback policy for the takeover loop. A port that fails to bind AND
 * answers no HTTP is treated as orphaned Windows kernel residue; after
 * `minFailedTakeovers` consecutive failed takeovers the web server moves to
 * `currentPort + 1`, bounded by `maxFallbackPort`.
 */
export function nextFallbackPort(currentPort, failedTakeovers, maxFallbackPort, minFailedTakeovers = MIN_FAILED_TAKEOVERS) {
    if (failedTakeovers < minFailedTakeovers || currentPort >= maxFallbackPort) {
        return currentPort;
    }
    return currentPort + 1;
}
export class WebServer {
    server = null;
    config;
    isOwner = false;
    startPromise = null;
    healthCheckInterval = null;
    onTakeoverCallback = null;
    onPortsExhaustedCallback = null;
    portsExhaustedNotified = false;
    takeoverFailures = 0;
    maxFallbackPort;
    constructor(config) {
        this.config = config;
        this.maxFallbackPort = config.port + 10;
    }
    setOnTakeoverCallback(callback) {
        this.onTakeoverCallback = callback;
    }
    setOnPortsExhaustedCallback(callback) {
        this.onPortsExhaustedCallback = callback;
    }
    async start() {
        if (this.startPromise) {
            return this.startPromise;
        }
        this.startPromise = this._start();
        return this.startPromise;
    }
    async _start() {
        if (!this.config.enabled) {
            return;
        }
        assertWebServerNetworkAuth(this.config.host, this.config.apiToken, this.config.auth?.isEnabled() ?? false);
        try {
            this.server = serveFetch({
                port: this.config.port,
                hostname: this.config.host,
                fetch: this.handleRequest.bind(this),
            });
            this.isOwner = true;
        }
        catch (error) {
            const errorMsg = String(error);
            if (errorMsg.includes("EADDRINUSE") ||
                errorMsg.includes("address already in use") ||
                /Failed to start server.*Is port \d+ in use/.test(errorMsg)) {
                this.isOwner = false;
                this.server = null;
                this.startHealthCheckLoop();
            }
            else {
                this.isOwner = false;
                this.server = null;
                log("Web server failed to start", { error: errorMsg });
                throw error;
            }
        }
    }
    startHealthCheckLoop() {
        if (this.healthCheckInterval) {
            return;
        }
        this.healthCheckInterval = setInterval(async () => {
            const isAvailable = await this.checkServerAvailable();
            if (!isAvailable) {
                this.stopHealthCheckLoop();
                await this.attemptTakeover();
            }
        }, 5000);
    }
    stopHealthCheckLoop() {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }
    }
    async attemptTakeover() {
        // prevent thundering herd: multiple non-owners racing to bind port
        const jitterMs = 500 + Math.random() * 1000;
        await new Promise((resolve) => setTimeout(resolve, jitterMs));
        if (await this.checkServerAvailable()) {
            // The original owner recovered. Reset the failure counter so a stale
            // count can't advance the port on the next, unrelated failure.
            this.takeoverFailures = 0;
            this.startHealthCheckLoop();
            return;
        }
        // Windows can leave an orphaned LISTEN socket in the TCP table after a
        // crash: the port refuses to bind (EADDRINUSE) yet nothing answers HTTP,
        // so repeated takeovers fail forever. After a few consecutive failures,
        // fall back to a free neighbor port instead of looping.
        this.takeoverFailures += 1;
        const nextPort = nextFallbackPort(this.config.port, this.takeoverFailures, this.maxFallbackPort);
        if (nextPort !== this.config.port) {
            this.takeoverFailures = 0;
            log("Web server port held by a non-responsive process; falling back to next port", {
                previousPort: this.config.port,
                newPort: nextPort,
            });
            this.config.port = nextPort;
        }
        else if (this.config.port >= this.maxFallbackPort &&
            this.takeoverFailures >= MIN_FAILED_TAKEOVERS) {
            // Every candidate port is held by a non-responsive process. Stop the
            // health loop instead of retrying every five seconds forever.
            this.stopHealthCheckLoop();
            this.notifyPortsExhausted();
            return;
        }
        try {
            // Reset startPromise so _start() can run again
            this.startPromise = null;
            await this._start();
        }
        catch {
            this.startHealthCheckLoop();
            return;
        }
        if (this.isOwner) {
            this.takeoverFailures = 0;
            log("Web server takeover successful", { port: this.config.port });
            if (this.onTakeoverCallback) {
                try {
                    await this.onTakeoverCallback();
                }
                catch (error) {
                    log("Takeover callback error", { error: String(error) });
                }
            }
        }
    }
    notifyPortsExhausted() {
        if (this.portsExhaustedNotified)
            return;
        this.portsExhaustedNotified = true;
        log("Web server unavailable: every candidate port is held by a non-responsive process", {
            port: this.config.port,
            maxFallbackPort: this.maxFallbackPort,
        });
        try {
            this.onPortsExhaustedCallback?.();
        }
        catch (error) {
            log("Ports exhausted callback error", { error: String(error) });
        }
    }
    async stop() {
        this.stopHealthCheckLoop();
        if (!this.isOwner || !this.server) {
            return;
        }
        this.server.stop();
        this.server = null;
        this.isOwner = false;
    }
    isRunning() {
        return this.server !== null;
    }
    isServerOwner() {
        return this.isOwner;
    }
    getUrl() {
        return `http://${this.config.host}:${this.config.port}`;
    }
    async checkServerAvailable() {
        try {
            const headers = this.config.apiToken
                ? { Authorization: `Bearer ${this.config.apiToken}` }
                : undefined;
            const endpoint = this.config.apiToken ? "/api/stats" : "/api/health";
            const response = await fetch(`${this.getUrl()}${endpoint}`, {
                method: "GET",
                headers,
                signal: AbortSignal.timeout(2000),
            });
            if (!response.ok)
                return false;
            // Fallback spans 10 neighbor ports; any 2xx from an unrelated local
            // service must not be mistaken for an opencode-mem owner. Require the
            // response to carry our API envelope.
            const body = (await response.json());
            if (endpoint === "/api/health") {
                return body.success === true && body.status === "ok";
            }
            return body.success === true;
        }
        catch {
            return false;
        }
    }
    // --- HTTP request handling ---
    async runMcpTool(name, args) {
        const asText = (value) => ({
            content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
        });
        const failed = (message) => ({
            content: [{ type: "text", text: message }],
            isError: true,
        });
        switch (name) {
            case "memory_search": {
                const query = String(args.query ?? "").trim();
                if (!query)
                    return failed("query is required");
                const limit = Math.max(1, Math.min(25, Number(args.limit) || 8));
                return asText(await handleSearch(query, undefined, 1, limit));
            }
            case "memory_snapshot": {
                return asText(await handleSnapshot(Number(args.limit) || 10));
            }
            case "memory_profile": {
                const userId = args.userId ? String(args.userId) : undefined;
                return asText(await handleGetUserProfile(userId));
            }
            case "memory_remember": {
                return asText(await handleRememberByProject({
                    content: String(args.content ?? ""),
                    tags: Array.isArray(args.tags) ? args.tags.map((tag) => String(tag)) : [],
                    project: args.project ? String(args.project) : "",
                }));
            }
            case "memory_forget": {
                const id = String(args.id ?? "").trim();
                if (!id)
                    return failed("id is required");
                return asText(await handleDeleteMemory(id));
            }
            default:
                return failed(`unknown tool ${name}`);
        }
    }
    async handleRequest(req) {
        const url = new URL(req.url);
        const path = url.pathname;
        const method = req.method;
        const origin = req.headers.get("Origin");
        const auth = this.config.auth;
        const corsOptions = { httpAuthEnabled: auth?.isEnabled() ?? false };
        if (!isAllowedBrowserOrigin(origin, corsOptions)) {
            return disallowedCorsResponse();
        }
        if (method === "OPTIONS") {
            return corsPreflightResponse(req, corsOptions);
        }
        if (auth?.isEnabled()) {
            const authCheck = auth.check(req, path);
            if (!authCheck.ok && authCheck.response)
                return authCheck.response;
        }
        if (path.startsWith("/api/") && path !== "/api/health" && !isAuthorizedApiRequest(req)) {
            const configuredTokenFailure = this.config.apiToken
                ? authorizeApiRequest(req, this.config.apiToken)
                : null;
            if (!this.config.apiToken || configuredTokenFailure) {
                return (configuredTokenFailure ??
                    this.jsonResponse({ success: false, error: "Unauthorized" }, 401));
            }
        }
        try {
            if (path === "/api/health" && method === "GET") {
                return this.jsonResponse({
                    success: true,
                    status: "ok",
                    authEnabled: auth?.isEnabled() ?? false,
                });
            }
            // MCP over HTTP: a client needs a URL and a token, nothing else - no
            // Python, no build, no local store. That is what makes the memory
            // reachable from a harness on another machine.
            if (path === "/mcp" && method === "POST") {
                if (!isAuthorizedApiRequest(req)) {
                    const configuredTokenFailure = this.config.apiToken
                        ? authorizeApiRequest(req, this.config.apiToken)
                        : null;
                    if (!this.config.apiToken || configuredTokenFailure) {
                        return (configuredTokenFailure ??
                            this.jsonResponse({ success: false, error: "Unauthorized" }, 401));
                    }
                }
                const hostFailure = checkMcpHost(req.headers.get("host"));
                if (hostFailure) {
                    return this.jsonResponse({ success: false, error: hostFailure }, 403);
                }
                let body;
                try {
                    body = await req.json();
                }
                catch {
                    return this.jsonResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
                }
                const { status, payload } = await handleMcpJsonRpc(body, (name, args) => this.runMcpTool(name, args));
                if (payload === null)
                    return new Response(null, { status });
                return new Response(JSON.stringify(payload), {
                    status,
                    headers: { "content-type": "application/json" },
                });
            }
            if (path === "/" || path === "/index.html") {
                return this.serveStaticFile("index.html", "text/html");
            }
            if (path === "/favicon.ico") {
                return this.serveStaticFile("favicon.ico", "image/x-icon");
            }
            // Vite production assets (hashed JS/CSS/fonts) and other static files.
            if (method === "GET" && !path.startsWith("/api/")) {
                const relative = path.replace(/^\/+/, "");
                if (relative && !relative.includes("..")) {
                    const staticResponse = this.serveStaticFile(relative, this.contentTypeFor(relative));
                    if (staticResponse.status !== 404) {
                        return staticResponse;
                    }
                }
            }
            if (path === "/api/tags" && method === "GET") {
                const result = await handleListTags();
                return this.jsonResponse(result);
            }
            if (path === "/api/memories" && method === "GET") {
                const tags = url.searchParams.getAll("tag").filter(Boolean);
                const tag = tags.length === 0 ? undefined : tags.length === 1 ? tags[0] : tags;
                const page = parseInt(url.searchParams.get("page") || "1");
                const pageSize = parseInt(url.searchParams.get("pageSize") || "20");
                const includePrompts = url.searchParams.get("includePrompts") !== "false";
                const result = await handleListMemories(tag, page, pageSize, includePrompts);
                return this.jsonResponse(result);
            }
            if (path === "/api/memories" && method === "POST") {
                const body = (await req.json());
                const result = await handleAddMemory(body);
                return this.jsonResponse(result);
            }
            if (path.startsWith("/api/memories/") && method === "DELETE") {
                const parts = path.split("/");
                const id = parts[3];
                if (!id || id === "bulk-delete") {
                    return this.jsonResponse({ success: false, error: "Invalid ID" });
                }
                const cascade = url.searchParams.get("cascade") === "true";
                const result = await handleDeleteMemory(id, cascade);
                return this.jsonResponse(result);
            }
            if (path.startsWith("/api/memories/") && method === "PUT") {
                const id = path.split("/").pop();
                if (!id) {
                    return this.jsonResponse({ success: false, error: "Invalid ID" });
                }
                const body = (await req.json());
                const result = await handleUpdateMemory(id, body);
                return this.jsonResponse(result);
            }
            if (path === "/api/memories/bulk-delete" && method === "POST") {
                const body = (await req.json());
                const cascade = body.cascade !== false;
                const result = await handleBulkDelete(body.ids || [], cascade);
                return this.jsonResponse(result);
            }
            if (path === "/api/search" && method === "GET") {
                const query = url.searchParams.get("q");
                const tags = url.searchParams.getAll("tag").filter(Boolean);
                const tag = tags.length === 0 ? undefined : tags.length === 1 ? tags[0] : tags;
                const page = parseInt(url.searchParams.get("page") || "1");
                const pageSize = parseInt(url.searchParams.get("pageSize") || "20");
                if (!query) {
                    return this.jsonResponse({ success: false, error: "query parameter required" });
                }
                const result = await handleSearch(query, tag, page, pageSize);
                return this.jsonResponse(result);
            }
            if (path === "/api/stats" && method === "GET") {
                // With an API token, probe authenticated /api/stats?probe=1 so that
                // ownership is proven cheaply: the auth already ran, and walking the
                // shards or scanning the logs does not belong in a liveness check.
                const probe = url.searchParams.get("probe") === "1";
                const result = await handleStats({ probe });
                return this.jsonResponse(result);
            }
            if (path.match(/^\/api\/memories\/[^/]+\/pin$/) && method === "POST") {
                const id = path.split("/")[3];
                if (!id) {
                    return this.jsonResponse({ success: false, error: "Invalid ID" });
                }
                const result = await handlePinMemory(id);
                return this.jsonResponse(result);
            }
            if (path.match(/^\/api\/memories\/[^/]+\/unpin$/) && method === "POST") {
                const id = path.split("/")[3];
                if (!id) {
                    return this.jsonResponse({ success: false, error: "Invalid ID" });
                }
                const result = await handleUnpinMemory(id);
                return this.jsonResponse(result);
            }
            if (path === "/api/cleanup" && method === "POST") {
                const result = await handleRunCleanup();
                return this.jsonResponse(result);
            }
            // Per-client keys: issued and revoked by the master token only. A key
            // that is issued for one machine can be revoked without touching the
            // others, and a read-only key cannot change the store.
            if (path === "/api/keys" && method === "GET") {
                if (!isMasterToken(req, this.config.apiToken)) {
                    return new Response(JSON.stringify({ success: false, error: "Master token required" }), {
                        status: 403,
                        headers: { "Content-Type": "application/json" },
                    });
                }
                return this.jsonResponse({ success: true, data: listClientKeys() });
            }
            if (path === "/api/keys" && method === "POST") {
                if (!isMasterToken(req, this.config.apiToken)) {
                    return new Response(JSON.stringify({ success: false, error: "Master token required" }), {
                        status: 403,
                        headers: { "Content-Type": "application/json" },
                    });
                }
                const body = (await req.json().catch(() => ({})));
                const label = String(body.label || "client").slice(0, 80);
                const issued = issueClientKey({
                    label,
                    clientId: String(body.clientId || label).slice(0, 120),
                    scope: body.scope === "read" ? "read" : "write",
                });
                // The plaintext is in this answer and nowhere else: only its hash is
                // stored, so a lost key is replaced, not recovered.
                return this.jsonResponse({ success: true, data: issued });
            }
            if (path.startsWith("/api/keys/") && method === "DELETE") {
                if (!isMasterToken(req, this.config.apiToken)) {
                    return new Response(JSON.stringify({ success: false, error: "Master token required" }), {
                        status: 403,
                        headers: { "Content-Type": "application/json" },
                    });
                }
                const id = path.slice("/api/keys/".length);
                const revoked = revokeClientKey(id);
                return this.jsonResponse({ success: revoked, data: { id, revoked } });
            }
            // The shadow index: fill it in steps and switch it on or off without a
            // deploy - the mode is stored with the data.
            if (path === "/api/reindex" && method === "POST") {
                const body = (await req.json().catch(() => ({})));
                const result = await handleRunReindex({
                    limit: body.limit,
                    batchSize: body.batchSize,
                    mode: body.mode,
                });
                return this.jsonResponse(result);
            }
            // The sweep is a dry run unless the caller says otherwise: forgetting is
            // not something a request should do by accident.
            if (path === "/api/sweep" && method === "POST") {
                const body = (await req.json().catch(() => ({})));
                const result = await handleRunSweep({
                    dryRun: body.dryRun !== false,
                    episodicDays: body.episodicDays,
                    proceduralDays: body.proceduralDays,
                    limit: body.limit,
                    restore: body.restore === true,
                });
                return this.jsonResponse(result);
            }
            if (path === "/api/deduplicate" && method === "POST") {
                const result = await handleRunDeduplication();
                return this.jsonResponse(result);
            }
            // The soft pass: mark the duplicates, keep the originals. A dry run is
            // the default - the report says what would be marked.
            if (path === "/api/deduplicate/mark" && method === "POST") {
                const body = (await req.json().catch(() => ({})));
                const result = await handleMarkDuplicates({
                    dryRun: body?.dryRun,
                    coldDays: body?.coldDays,
                    limit: body?.limit,
                });
                return this.jsonResponse(result);
            }
            if (path === "/api/migration/detect" && method === "GET") {
                const result = await handleDetectMigration();
                return this.jsonResponse(result);
            }
            if (path === "/api/migration/tags/detect" && method === "GET") {
                const result = await handleDetectTagMigration();
                return this.jsonResponse(result);
            }
            if (path === "/api/migration/tags/run-batch" && method === "POST") {
                const body = (await req.json());
                const batchSize = body?.batchSize || 5;
                const result = await handleRunTagMigrationBatch(batchSize);
                return this.jsonResponse(result);
            }
            if (path === "/api/migration/tags/progress" && method === "GET") {
                const result = await handleGetTagMigrationProgress();
                return this.jsonResponse(result);
            }
            if (path === "/api/migration/run" && method === "POST") {
                const body = (await req.json());
                const strategy = body.strategy || "fresh-start";
                if (strategy !== "fresh-start" && strategy !== "re-embed") {
                    return this.jsonResponse({ success: false, error: "Invalid strategy" });
                }
                const result = await handleRunMigration(strategy);
                return this.jsonResponse(result);
            }
            if (path.startsWith("/api/prompts/") && method === "DELETE") {
                const parts = path.split("/");
                const id = parts[3];
                if (!id || id === "bulk-delete") {
                    return this.jsonResponse({ success: false, error: "Invalid ID" });
                }
                const cascade = url.searchParams.get("cascade") === "true";
                const result = await handleDeletePrompt(id, cascade);
                return this.jsonResponse(result);
            }
            if (path === "/api/prompts/bulk-delete" && method === "POST") {
                const body = (await req.json());
                const cascade = body.cascade !== false;
                const result = await handleBulkDeletePrompts(body.ids || [], cascade);
                return this.jsonResponse(result);
            }
            // Moving a profile to another identity: the master token only. The
            // identity belongs to the person, not to the machine, and a client key
            // may not take over somebody else's profile.
            if (path === "/api/user-profile/transfer" && method === "POST") {
                if (!isMasterToken(req, this.config.apiToken)) {
                    return new Response(JSON.stringify({ success: false, error: "Master token required" }), {
                        status: 403,
                        headers: { "Content-Type": "application/json" },
                    });
                }
                const body = (await req.json().catch(() => ({})));
                const result = await handleTransferProfileIdentity({
                    fromUserId: body.fromUserId,
                    toUserId: body.toUserId,
                });
                return this.jsonResponse(result);
            }
            if (path === "/api/user-profile" && method === "GET") {
                const userId = url.searchParams.get("userId") || undefined;
                // raw=1 is for a machine that reads, merges and writes the profile back.
                // The default view strips the embeddings for display, and uploading that
                // stripped copy would silently blind the merge to similarity.
                const raw = url.searchParams.get("raw") === "1";
                const result = await handleGetUserProfile(userId, raw);
                return this.jsonResponse(result);
            }
            // The counterpart of the GET above. It exists because a client with remote
            // storage keeps no profile of its own: the profile is learned where the
            // model runs and stored where the memories are, so the server needs a way
            // to accept one.
            if (path === "/api/user-profile" && method === "PUT") {
                const body = (await req.json());
                const result = await handlePutUserProfile(body);
                return this.jsonResponse(result);
            }
            if (path === "/api/user-profile/changelog" && method === "GET") {
                const profileId = url.searchParams.get("profileId");
                const limit = parseInt(url.searchParams.get("limit") || "5");
                if (!profileId) {
                    return this.jsonResponse({ success: false, error: "profileId parameter required" });
                }
                const result = await handleGetProfileChangelog(profileId, limit);
                return this.jsonResponse(result);
            }
            if (path === "/api/user-profile/snapshot" && method === "GET") {
                const changelogId = url.searchParams.get("chlogId");
                if (!changelogId) {
                    return this.jsonResponse({ success: false, error: "changelogId parameter required" });
                }
                const result = await handleGetProfileSnapshot(changelogId);
                return this.jsonResponse(result);
            }
            if (path === "/api/user-profile/refresh" && method === "POST") {
                const body = (await req.json().catch(() => ({})));
                const userId = body.userId || undefined;
                const result = await handleRefreshProfile(userId);
                return this.jsonResponse(result);
            }
            if (path === "/api/user-profile/ai-cleanup" && method === "POST") {
                const body = (await req.json().catch(() => ({})));
                const userId = body.userId || undefined;
                const includeIds = Array.isArray(body.includeIds)
                    ? body.includeIds
                    : undefined;
                const profileVersion = typeof body.profileVersion === "number" ? body.profileVersion : undefined;
                const result = await handleAICleanup(userId, includeIds, profileVersion);
                return this.jsonResponse(result);
            }
            if (path === "/api/user-profile/ai-cleanup/apply" && method === "POST") {
                const body = (await req.json().catch(() => ({})));
                const userId = body.userId || undefined;
                const result = await handleApplyCleanup(userId, body);
                return this.jsonResponse(result);
            }
            if (path === "/api/user-profile/item" && method === "PATCH") {
                const body = (await req.json().catch(() => ({})));
                const result = await handleUpdateProfileItem(body);
                return this.jsonResponse(result);
            }
            if (path === "/api/skills" && method === "GET") {
                const containerTag = url.searchParams.get("tag") || undefined;
                const enabledOnly = url.searchParams.get("enabledOnly") === "true";
                const result = await handleListSkills({ containerTag, enabledOnly });
                return this.jsonResponse(result);
            }
            if (path === "/api/skills" && method === "POST") {
                const body = (await req.json().catch(() => ({})));
                const result = await handleCreateSkill(body);
                return this.jsonResponse(result, result.success ? 200 : 400);
            }
            if (path.startsWith("/api/skills/") && method === "GET") {
                const id = decodeURIComponent(path.slice("/api/skills/".length));
                if (!id || id.includes("/")) {
                    return this.jsonResponse({ success: false, error: "Invalid skill id" }, 400);
                }
                const result = await handleGetSkill(id);
                return this.jsonResponse(result, result.success ? 200 : 404);
            }
            if (path.startsWith("/api/skills/") && method === "PUT") {
                const id = decodeURIComponent(path.slice("/api/skills/".length));
                if (!id || id.includes("/")) {
                    return this.jsonResponse({ success: false, error: "Invalid skill id" }, 400);
                }
                const body = (await req.json().catch(() => ({})));
                const result = await handleUpdateSkill(id, body);
                return this.jsonResponse(result, result.success ? 200 : 400);
            }
            if (path.startsWith("/api/skills/") && method === "DELETE") {
                const id = decodeURIComponent(path.slice("/api/skills/".length));
                if (!id || id.includes("/")) {
                    return this.jsonResponse({ success: false, error: "Invalid skill id" }, 400);
                }
                const result = await handleDeleteSkill(id);
                return this.jsonResponse(result, result.success ? 200 : 404);
            }
            // OpenCode HTTP skill catalog (public path; prefer loopback / network auth).
            if (path === "/skills/index.json" && method === "GET") {
                const result = await handleSkillsCatalogIndex();
                if (!result.success || !result.data) {
                    return this.jsonResponse(result, 500);
                }
                return new Response(JSON.stringify(result.data), {
                    status: 200,
                    headers: { "Content-Type": "application/json; charset=utf-8" },
                });
            }
            // OpenCode catalog layout: /skills/{id}/{id}.md
            if (path.startsWith("/skills/") && path.endsWith(".md") && method === "GET") {
                const rest = path.slice("/skills/".length);
                const parts = rest.split("/").filter(Boolean);
                if (parts.length !== 2) {
                    return new Response("Not Found", { status: 404 });
                }
                const id = decodeURIComponent(parts[0]);
                const filename = decodeURIComponent(parts[1]);
                if (!id || filename !== `${id}.md`) {
                    return new Response("Not Found", { status: 404 });
                }
                const result = await handleSkillsCatalogFile(id);
                if (!result.success || !result.data?.markdown) {
                    return new Response("Not Found", { status: 404 });
                }
                return new Response(result.data.markdown, {
                    status: 200,
                    headers: { "Content-Type": "text/markdown; charset=utf-8" },
                });
            }
            // SPA fallback for client routes (e.g. /profile) — serve the app shell.
            if (method === "GET" && !path.startsWith("/api/") && !extname(path)) {
                return this.serveStaticFile("index.html", "text/html");
            }
            return new Response("Not Found", { status: 404 });
        }
        catch (error) {
            return this.jsonResponse({
                success: false,
                error: String(error),
            }, 500);
        }
    }
    contentTypeFor(filename) {
        switch (extname(filename).toLowerCase()) {
            case ".html":
                return "text/html";
            case ".js":
            case ".mjs":
                return "application/javascript";
            case ".css":
                return "text/css";
            case ".ico":
                return "image/x-icon";
            case ".svg":
                return "image/svg+xml";
            case ".png":
                return "image/png";
            case ".jpg":
            case ".jpeg":
                return "image/jpeg";
            case ".woff":
                return "font/woff";
            case ".woff2":
                return "font/woff2";
            case ".ttf":
                return "font/ttf";
            case ".json":
                return "application/json";
            case ".map":
                return "application/json";
            default:
                return "application/octet-stream";
        }
    }
    serveStaticFile(filename, contentType) {
        try {
            const webDir = [
                join(__dirname, "..", "web"),
                join(__dirname, "..", "..", "dist", "web"),
            ].find((candidate) => existsSync(candidate));
            if (!webDir) {
                return new Response("File not found", { status: 404 });
            }
            const filePath = normalize(join(webDir, filename));
            const normalizedWebDir = normalize(webDir);
            if (filePath !== normalizedWebDir && !filePath.startsWith(`${normalizedWebDir}${sep}`)) {
                return new Response("File not found", { status: 404 });
            }
            if (!existsSync(filePath)) {
                return new Response("File not found", { status: 404 });
            }
            const cacheControl = filename.startsWith("assets/") || contentType.startsWith("font/")
                ? "public, max-age=31536000, immutable"
                : contentType.startsWith("image/")
                    ? "public, max-age=86400"
                    : "no-cache";
            if (contentType.startsWith("image/") ||
                contentType.startsWith("font/") ||
                contentType === "application/octet-stream") {
                const content = readFileSync(filePath);
                return new Response(content, {
                    headers: {
                        "Content-Type": contentType,
                        "Cache-Control": cacheControl,
                    },
                });
            }
            let content = readFileSync(filePath, "utf-8");
            if (filename === "index.html" || filename.endsWith("/index.html")) {
                const token = getOrCreateAuthToken();
                content = content.replace("</head>", `<script>window.__OPENCODE_MEM_TOKEN__=${JSON.stringify(token)};</script></head>`);
            }
            return new Response(content, {
                headers: {
                    "Content-Type": contentType,
                    "Cache-Control": cacheControl,
                },
            });
        }
        catch {
            return new Response("File not found", { status: 404 });
        }
    }
    jsonResponse(data, status = 200) {
        return new Response(JSON.stringify(data), {
            status,
            headers: {
                "Content-Type": "application/json",
            },
        });
    }
}
export async function startWebServer(config) {
    const server = new WebServer(config);
    await server.start();
    return server;
}

/**
 * Structured output via the opencode HTTP server.
 *
 * Replaces the older auth.json/OAuth-juggling flow. Instead of forging
 * requests to provider HTTP endpoints ourselves, we delegate to the
 * running opencode server: it already owns the user's auth (any provider,
 * including github-copilot personal/business), token refresh, and provider
 * routing.
 *
 * Per call we create a transient session, prompt it with a JSON schema,
 * then delete the session so it does not pollute the user's TUI session
 * list.
 *
 * Internal capture sessions are least-privilege (issue #189): ordinary
 * agent tools are denied, only StructuredOutput is allowed, a dedicated
 * agent caps steps, and a hard timeout fails closed.
 *
 * The primary transport is the authenticated v2 SDK client initialized from
 * the plugin host's client configuration. A raw fetch fallback remains for
 * older SDK builds that do not expose the v2 session methods.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { diagnosticUrl, readJson, responseStatus, } from "./opencode-diagnostics.js";
import { INTERNAL_CAPTURE_SESSION_TITLE, trackInternalCaptureSession, untrackInternalCaptureSession, } from "./internal-capture-sessions.js";
import { createLazyV2Client } from "./opencode-sdk-client.js";
import { log } from "../logger.js";
/** Dedicated agent registered via the plugin config hook (step-capped). */
export const STRUCTURED_OUTPUT_AGENT = "opencode-mem-structured";
/** Hard ceiling for a single internal structured-output prompt. */
export const STRUCTURED_OUTPUT_TIMEOUT_MS = 90_000;
/**
 * Soft agent step budget. OpenCode only injects a last-step warning for
 * `format: json_schema` and can keep looping when forced tool calls fail
 * (seen with opencode-claude-auth in #278). We also abort client-side after
 * this many `step-start` parts.
 */
export const STRUCTURED_OUTPUT_MAX_STEPS = 2;
/** Cap OpenCode schema retries so a bad provider cannot spin forever. */
export const STRUCTURED_OUTPUT_DEFAULT_RETRY_COUNT = 1;
let _structuredOutputTimeoutOverrideMs;
// Configured timeout (CONFIG.opencodeTimeoutMs), injected by the plugin init
// instead of importing config.js here: the provider module is bundled into a
// single-file lazy loader whose import graph must stay free of config side
// effects (config creation banner, DATA_DIR mkdir) for subprocess gates.
let _structuredOutputConfiguredMs;
/**
 * Whether a rejected structured-output call may be retried through a real
 * session. Injected by the plugin init from
 * CONFIG.opencodeRealSessionFallback; default off so behaviour matches
 * upstream unless the operator asks for it.
 */
let _realSessionFallback = false;
/**
 * Test helper: override the structured-output prompt timeout. Pass undefined
 * to reset to the configured value.
 */
export function setStructuredOutputTimeoutMsForTests(ms) {
    _structuredOutputTimeoutOverrideMs = ms;
}
/**
 * Inject the configured structured-output timeout (CONFIG.opencodeTimeoutMs,
 * already normalized/clamped in config.ts). Called once by the plugin init.
 */
export function setStructuredOutputTimeoutConfig(ms) {
    _structuredOutputConfiguredMs = ms;
}
/**
 * Injected by the plugin init (from CONFIG.opencodeRealSessionFallback).
 * When enabled, a structured-output call that the configured transport
 * rejects is retried through a real, session-scoped opencode session — the
 * only shape free-tier providers accept.
 */
export function setStructuredOutputRealSessionFallback(enabled) {
    _realSessionFallback = enabled;
}
/**
 * Effective structured-output prompt timeout: the test override wins, then
 * the configured value, then the hard-coded default.
 */
function effectiveStructuredOutputTimeoutMs() {
    return (_structuredOutputTimeoutOverrideMs ??
        _structuredOutputConfiguredMs ??
        STRUCTURED_OUTPUT_TIMEOUT_MS);
}
export const STRUCTURED_OUTPUT_PERMISSIONS = [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "StructuredOutput", pattern: "*", action: "allow" },
];
export const STRUCTURED_OUTPUT_TOOLS = {
    "*": false,
    StructuredOutput: true,
};
export const STRUCTURED_OUTPUT_METADATA = {
    "opencode-mem": {
        internal: true,
        purpose: "structured-output",
    },
};
const _internalSessions = new Set();
const _structuredStepCounts = new Map();
const _structuredStepAbortErrors = new Map();
let _connectedProviders = new Set();
let _v2Client;
let _v2BaseUrl;
let _hostFetch;
let _useSdkTransport = false;
// Registered by the plugin init so a gate miss can force one provider-directory
// refresh before failing (late host provider registration).
let _connectedProvidersRefresher;
export function setHostFetch(customFetch) {
    _hostFetch = customFetch;
}
export function resetHostFetch() {
    _hostFetch = undefined;
}
export function setConnectedProviders(providers) {
    _connectedProviders = new Set(providers);
}
export function isProviderConnected(providerName) {
    return _connectedProviders.has(providerName);
}
/** Register (or clear) the refresh callback used by ensureProviderConnected. */
export function setConnectedProvidersRefresher(refresher) {
    _connectedProvidersRefresher = refresher;
}
/** Clear the refresh callback only if it is still the one being disposed. */
export function clearConnectedProvidersRefresher(refresher) {
    if (_connectedProvidersRefresher === refresher)
        _connectedProvidersRefresher = undefined;
}
/**
 * Refresh-on-miss for the connectivity gate: when a provider id is missing
 * from the snapshot and a refresher is registered, await one refresh and
 * re-check. Returns the re-checked connectivity; never refreshes twice for
 * the same call and never throws (refresh errors are logged by the refresher).
 */
export async function ensureProviderConnected(providerName) {
    if (_connectedProviders.has(providerName))
        return true;
    const refresher = _connectedProvidersRefresher;
    if (!refresher)
        return false;
    try {
        await refresher();
    }
    catch {
        // The refresher logs; a failed refresh keeps the previous set.
    }
    return _connectedProviders.has(providerName);
}
export function setV2Client(client) {
    _v2Client = client;
    // Native v2 adapters pass a session-capable client without a server URL.
    // Enable the SDK transport path so structured output does not require createV2Client.
    if (hasV2SessionClient(client)) {
        _useSdkTransport = true;
    }
}
export function getV2Client() {
    return _v2Client;
}
export function createV2Client(serverUrl, transport) {
    const baseUrl = typeof serverUrl === "string" ? serverUrl : serverUrl.toString();
    const activeTransport = transport ?? (_hostFetch ? { fetch: _hostFetch } : undefined);
    _v2BaseUrl = baseUrl;
    _useSdkTransport = Boolean(activeTransport?.fetch || activeTransport?.headers);
    return createLazyV2Client(baseUrl, activeTransport);
}
/** True while an internal structured-output session is live (create → delete). */
export function isInternalStructuredSession(sessionID) {
    return _internalSessions.has(sessionID);
}
/** Test helper: clear tracked internal session IDs. */
export function resetInternalStructuredSessions() {
    _internalSessions.clear();
    _structuredStepCounts.clear();
    _structuredStepAbortErrors.clear();
}
function markInternalSession(sessionID) {
    _internalSessions.add(sessionID);
    _structuredStepCounts.set(sessionID, 0);
    _structuredStepAbortErrors.delete(sessionID);
}
function unmarkInternalSession(sessionID) {
    _internalSessions.delete(sessionID);
    _structuredStepCounts.delete(sessionID);
}
/**
 * Record a `step-start` on an internal structured-output session.
 * Returns whether the client should abort (step budget exceeded).
 */
export function noteStructuredOutputStep(sessionID) {
    if (!_internalSessions.has(sessionID)) {
        return { tracked: false, steps: 0, shouldAbort: false };
    }
    const steps = (_structuredStepCounts.get(sessionID) ?? 0) + 1;
    _structuredStepCounts.set(sessionID, steps);
    if (steps <= STRUCTURED_OUTPUT_MAX_STEPS) {
        return { tracked: true, steps, shouldAbort: false };
    }
    _structuredStepAbortErrors.set(sessionID, new Error(`opencode-mem: structured-output aborted after ${steps} steps ` +
        `(agent maxSteps=${STRUCTURED_OUTPUT_MAX_STEPS} may be ignored while format:json_schema forces tool calls; ` +
        `try a model that supports OpenCode structured output, or configure memoryModel + memoryApiUrl fallback — ` +
        `opencode-claude-auth loops are a common trigger)`));
    return { tracked: true, steps, shouldAbort: true };
}
/** Consume a step-budget abort error if the prompt failed after we aborted. */
export function takeStructuredOutputStepAbortError(sessionID) {
    const error = _structuredStepAbortErrors.get(sessionID);
    _structuredStepAbortErrors.delete(sessionID);
    return error;
}
function structuredOutputTimeoutError(timeoutMs) {
    return new Error(`opencode-mem: structured-output timed out after ${timeoutMs}ms ` +
        `(provider may be looping on forced StructuredOutput; ` +
        `try a known json_schema-capable model or memoryModel + memoryApiUrl fallback)`);
}
function preferStepAbortError(sessionID, error) {
    const stepError = takeStructuredOutputStepAbortError(sessionID);
    if (stepError)
        throw stepError;
    throw error;
}
function sessionCreateBody() {
    return {
        title: INTERNAL_CAPTURE_SESSION_TITLE,
        permission: STRUCTURED_OUTPUT_PERMISSIONS,
        metadata: STRUCTURED_OUTPUT_METADATA,
    };
}
function sessionPromptFields(args) {
    return {
        model: { providerID: args.providerID, modelID: args.modelID },
        // The V1 session prompt body carries the reasoning variant as a sibling
        // of `model` (SessionPromptData.body.variant), not inside model.
        ...(args.variant ? { variant: args.variant } : {}),
        agent: STRUCTURED_OUTPUT_AGENT,
        system: args.systemPrompt,
        parts: [{ type: "text", text: args.userPrompt }],
        tools: STRUCTURED_OUTPUT_TOOLS,
        // `noReply` suppresses assistant generation in current OpenCode builds,
        // which also suppresses `info.structured_output`; structured capture needs
        // the assistant run even though the temporary session is deleted afterward.
        format: {
            type: "json_schema",
            schema: args.jsonSchema,
            // Bound schema retries so Claude-auth / incompatible providers fail
            // closed instead of spinning until the 90s timeout (#278).
            retryCount: args.retryCount ?? STRUCTURED_OUTPUT_DEFAULT_RETRY_COUNT,
        },
    };
}
/** Tools-off prompt body: plain text JSON (no format:json_schema / forced tools). */
function sessionTextJsonPromptFields(args) {
    const schemaText = JSON.stringify(args.jsonSchema, null, 2);
    return {
        model: { providerID: args.providerID, modelID: args.modelID },
        ...(args.variant ? { variant: args.variant } : {}),
        agent: STRUCTURED_OUTPUT_AGENT,
        system: `${args.systemPrompt}\n\n` +
            `Respond with ONLY a single JSON value that validates against this JSON Schema. ` +
            `No markdown fences, no commentary.\n\nJSON Schema:\n${schemaText}`,
        parts: [{ type: "text", text: args.userPrompt }],
        tools: { "*": false },
        noReply: false,
    };
}
/**
 * Claude / opencode-claude-auth registers as provider `anthropic`. Forced
 * `format: json_schema` often loops; prefer auth-preserving text JSON (#278).
 */
export function shouldUseOpencodeTextJson(providerID) {
    const id = providerID.trim().toLowerCase();
    return id === "anthropic" || id.startsWith("anthropic/");
}
function extractAssistantText(parts) {
    return parts
        .filter((part) => typeof part === "object" &&
        part !== null &&
        part.type === "text" &&
        typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
        .trim();
}
function parseJsonFromAssistantText(rawText) {
    const fenced = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = (fenced?.[1] ?? rawText).trim();
    const match = candidate.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!match) {
        throw new Error("opencode-mem: text-json fallback response did not contain valid JSON " +
            "(opencode-claude-auth / anthropic path)");
    }
    try {
        return JSON.parse(match[0]);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`opencode-mem: text-json fallback JSON parse failed: ${message}`, {
            cause: error,
        });
    }
}
/**
 * Resolve `opencodeModel: "inherit"` to a concrete provider/model.
 *
 * Prefer an explicit prompt-recorded model (auto-capture path). Otherwise fall
 * back to OpenCode's recent model list so profile-learning / conflict / dedup
 * paths don't send the literal model id "inherit" (ProviderModelNotFoundError).
 */
export function resolveOpencodeModelRef(opts) {
    if (opts.modelID !== "inherit") {
        return { providerID: opts.providerID, modelID: opts.modelID };
    }
    if (opts.prompt?.providerId && opts.prompt?.modelId) {
        return { providerID: opts.prompt.providerId, modelID: opts.prompt.modelId };
    }
    const recent = readRecentOpencodeModel(opts.providerID);
    if (recent)
        return recent;
    throw new Error("opencode-mem: opencodeModel is 'inherit' but no session model was recorded and no recent OpenCode model is available");
}
function readRecentOpencodeModel(preferredProvider) {
    try {
        // OpenCode state path mirrors `opencode debug paths` → state.
        const stateDir = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
        const modelPath = join(stateDir, "opencode", "model.json");
        if (!existsSync(modelPath))
            return undefined;
        const raw = JSON.parse(readFileSync(modelPath, "utf8"));
        const recent = Array.isArray(raw.recent) ? raw.recent : [];
        const match = (preferredProvider
            ? recent.find((r) => r.providerID === preferredProvider && r.modelID)
            : undefined) ?? recent.find((r) => r.providerID && r.modelID);
        if (!match?.providerID || !match.modelID)
            return undefined;
        return { providerID: match.providerID, modelID: match.modelID };
    }
    catch {
        return undefined;
    }
}
/**
 * Generate one structured completion via opencode's HTTP API.
 *
 * Prefer `format: json_schema` (forced StructuredOutput). For Anthropic /
 * opencode-claude-auth (`providerID` anthropic), use auth-preserving text JSON
 * instead — forced tools commonly loop until timeout (#278).
 *
 * Throws on: session.create failure, prompt failure, AssistantMessage.error,
 * missing structured/text JSON, timeout, or final Zod validation failure.
 */
export async function generateStructuredOutput(opts) {
    const resolved = resolveOpencodeModelRef({
        providerID: opts.providerID,
        modelID: opts.modelID,
    });
    const { client, systemPrompt, userPrompt, schema, directory, retryCount, variant } = opts;
    const { providerID, modelID } = resolved;
    const jsonSchema = schema.toJSONSchema?.() ?? (await import("zod")).z.toJSONSchema(schema);
    const args = {
        providerID,
        modelID,
        variant,
        systemPrompt,
        userPrompt,
        directory,
        retryCount,
        jsonSchema,
        schema,
    };
    const useTextJson = shouldUseOpencodeTextJson(providerID);
    const viaConfiguredTransport = async () => {
        if (_useSdkTransport && hasV2SessionClient(client)) {
            return useTextJson
                ? generateTextJsonViaSdkClient(client, args)
                : generateViaSdkClient(client, args);
        }
        const baseUrl = _v2BaseUrl;
        if (!baseUrl) {
            throw new Error("opencode-mem: v2 server base URL not initialized; call createV2Client(serverUrl) first");
        }
        const base = stripTrailingSlash(baseUrl);
        return useTextJson
            ? generateTextJsonViaFetch(base, args)
            : generateJsonSchemaViaFetch(base, args);
    };
    try {
        return await viaConfiguredTransport();
    }
    catch (error) {
        // Free-tier providers (OpenCode Zen with `apiKey: "public"`) reject
        // sessionless generate calls, so the transports above fail for them. A
        // real, session-scoped generate is accepted instead.
        //
        // Opt-in, and a FALLBACK rather than a preemptor. Both matter:
        // - opt-in, because a process spawned by the host inherits
        //   OPENCODE_PORT/OPENCODE_SERVER_PASSWORD, so an always-on fallback
        //   would hijack every structured-output call in tests and in the CLI and
        //   replace working transports with a live HTTP round-trip;
        // - fallback, because a working transport must never be bypassed, and
        //   because upstream regression tests assert that a failed call makes no
        //   further requests.
        if (_realSessionFallback && shouldTryRealSession(error)) {
            try {
                const realSession = await tryGenerateViaRealSession(args);
                if (realSession !== undefined) {
                    return realSession;
                }
                log("real-session fallback skipped", {
                    reason: "no local server config (OPENCODE_PORT + OPENCODE_SERVER_PASSWORD)",
                });
            }
            catch (fallbackError) {
                // The fallback failed too. The ORIGINAL error is still what gets
                // reported - it names the real cause - but a silent catch made
                // "the fallback ran and failed" indistinguishable from "the fallback
                // never ran", which is how a missing OPENCODE_PORT went unnoticed.
                log("real-session fallback failed", {
                    error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
                });
            }
        }
        throw error;
    }
}
function hasV2SessionClient(client) {
    const session = client.session;
    if (typeof session !== "object" || session === null)
        return false;
    const candidate = session;
    return (typeof candidate.create === "function" &&
        typeof candidate.prompt === "function" &&
        typeof candidate.delete === "function");
}
async function generateJsonSchemaViaFetch(base, args) {
    const sessionID = await createSession(base, args.directory);
    markInternalSession(sessionID);
    try {
        const info = await withStructuredOutputTimeout(() => promptSession(base, {
            sessionID,
            directory: args.directory,
            providerID: args.providerID,
            modelID: args.modelID,
            variant: args.variant,
            systemPrompt: args.systemPrompt,
            userPrompt: args.userPrompt,
            jsonSchema: args.jsonSchema,
            retryCount: args.retryCount,
        }), () => abortSession(base, sessionID, args.directory));
        if (info.error) {
            throw new Error(`opencode-mem: opencode reported ${info.error.name}: ${formatAssistantError(info.error)}`);
        }
        const structuredOutput = info.structured_output ?? info.structured;
        if (structuredOutput === undefined || structuredOutput === null) {
            throw new Error("opencode-mem: opencode returned no structured output (info.structured_output/info.structured were empty)");
        }
        return args.schema.parse(structuredOutput);
    }
    catch (error) {
        preferStepAbortError(sessionID, error);
        throw error;
    }
    finally {
        unmarkInternalSession(sessionID);
        try {
            await deleteSession(base, sessionID, args.directory);
        }
        catch {
            // intentionally swallowed
        }
        finally {
            untrackInternalCaptureSession(sessionID);
        }
    }
}
async function generateTextJsonViaFetch(base, args) {
    const sessionID = await createSession(base, args.directory);
    markInternalSession(sessionID);
    try {
        const data = await withStructuredOutputTimeout(() => promptSessionRaw(base, {
            sessionID,
            directory: args.directory,
            body: sessionTextJsonPromptFields(args),
        }), () => abortSession(base, sessionID, args.directory));
        if (!data.info) {
            throw new Error("opencode-mem: prompt response missing `info`");
        }
        if (data.info.error) {
            throw new Error(`opencode-mem: opencode reported ${data.info.error.name}: ${formatAssistantError(data.info.error)}`);
        }
        const rawText = extractAssistantText(Array.isArray(data.parts) ? data.parts : []);
        return args.schema.parse(parseJsonFromAssistantText(rawText));
    }
    catch (error) {
        preferStepAbortError(sessionID, error);
        throw error;
    }
    finally {
        unmarkInternalSession(sessionID);
        try {
            await deleteSession(base, sessionID, args.directory);
        }
        catch {
            // intentionally swallowed
        }
        finally {
            untrackInternalCaptureSession(sessionID);
        }
    }
}
async function generateViaSdkClient(client, args) {
    const createdResponse = await client.session.create({
        ...sessionCreateBody(),
        ...(args.directory ? { directory: args.directory } : {}),
    });
    const created = readSdkData(createdResponse, "POST /session");
    if (!created.id) {
        throw new Error("opencode-mem: session.create returned no session id; cannot generate structured output");
    }
    const sessionID = created.id;
    trackInternalCaptureSession(sessionID);
    markInternalSession(sessionID);
    try {
        const promptResponse = await withStructuredOutputTimeout(() => client.session.prompt({
            sessionID,
            ...(args.directory ? { directory: args.directory } : {}),
            ...sessionPromptFields(args),
        }), () => client.session.abort?.({
            sessionID,
            ...(args.directory ? { directory: args.directory } : {}),
        }));
        const data = readSdkData(promptResponse, "POST /session/{id}/message");
        if (!data.info) {
            throw new Error("opencode-mem: prompt response missing `info`");
        }
        if (data.info.error) {
            throw new Error(`opencode-mem: opencode reported ${data.info.error.name}: ${formatAssistantError(data.info.error)}`);
        }
        const structuredOutput = data.info.structured_output ?? data.info.structured;
        if (structuredOutput === undefined || structuredOutput === null) {
            throw new Error("opencode-mem: opencode returned no structured output (info.structured_output/info.structured were empty)");
        }
        return args.schema.parse(structuredOutput);
    }
    catch (error) {
        preferStepAbortError(sessionID, error);
        throw error;
    }
    finally {
        unmarkInternalSession(sessionID);
        try {
            await client.session.delete({
                sessionID,
                ...(args.directory ? { directory: args.directory } : {}),
            });
        }
        catch {
            // Best-effort cleanup for the transient capture session.
        }
        finally {
            untrackInternalCaptureSession(sessionID);
        }
    }
}
async function generateTextJsonViaSdkClient(client, args) {
    const createdResponse = await client.session.create({
        ...sessionCreateBody(),
        ...(args.directory ? { directory: args.directory } : {}),
    });
    const created = readSdkData(createdResponse, "POST /session");
    if (!created.id) {
        throw new Error("opencode-mem: session.create returned no session id; cannot generate structured output");
    }
    const sessionID = created.id;
    trackInternalCaptureSession(sessionID);
    markInternalSession(sessionID);
    try {
        const promptResponse = await withStructuredOutputTimeout(() => client.session.prompt({
            sessionID,
            ...(args.directory ? { directory: args.directory } : {}),
            ...sessionTextJsonPromptFields(args),
        }), () => client.session.abort?.({
            sessionID,
            ...(args.directory ? { directory: args.directory } : {}),
        }));
        const data = readSdkData(promptResponse, "POST /session/{id}/message");
        if (!data.info) {
            throw new Error("opencode-mem: prompt response missing `info`");
        }
        if (data.info.error) {
            throw new Error(`opencode-mem: opencode reported ${data.info.error.name}: ${formatAssistantError(data.info.error)}`);
        }
        const rawText = extractAssistantText(Array.isArray(data.parts) ? data.parts : []);
        return args.schema.parse(parseJsonFromAssistantText(rawText));
    }
    catch (error) {
        preferStepAbortError(sessionID, error);
        throw error;
    }
    finally {
        unmarkInternalSession(sessionID);
        try {
            await client.session.delete({
                sessionID,
                ...(args.directory ? { directory: args.directory } : {}),
            });
        }
        catch {
            // Best-effort cleanup for the transient capture session.
        }
        finally {
            untrackInternalCaptureSession(sessionID);
        }
    }
}
async function withStructuredOutputTimeout(run, onTimeout) {
    let timer;
    const timeoutMs = effectiveStructuredOutputTimeoutMs();
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(structuredOutputTimeoutError(timeoutMs));
        }, timeoutMs);
    });
    try {
        return await Promise.race([run(), timeoutPromise]);
    }
    catch (error) {
        if (error instanceof Error && error.message.includes("structured-output timed out after")) {
            try {
                await onTimeout();
            }
            catch {
                // best-effort abort
            }
        }
        throw error;
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
function readSdkData(response, label) {
    const result = response;
    if (result?.error !== undefined) {
        const status = result.response ? ` (${responseStatus(result.response)})` : "";
        const responseUrl = result.response?.url || result.request?.url;
        const url = responseUrl ? diagnosticUrl(responseUrl) : "the authenticated client";
        throw new Error(`opencode-mem: opencode ${label} failed at ${url}${status}: <redacted response body>`);
    }
    if (result?.data === undefined) {
        throw new Error(`opencode-mem: opencode ${label} returned no response data`);
    }
    return result.data;
}
function stripTrailingSlash(url) {
    return url.endsWith("/") ? url.slice(0, -1) : url;
}
/**
 * Credentials for the local opencode server, taken from the environment the
 * host process exports. Returns undefined when the plugin is not running inside
 * an opencode host (tests, CLI) so callers can fall back.
 */
function readLocalServerConfig() {
    const port = process.env.OPENCODE_PORT;
    const password = process.env.OPENCODE_SERVER_PASSWORD;
    if (!port || !password)
        return undefined;
    return { base: `http://127.0.0.1:${port}`, password };
}
async function localServerFetch(config, method, path, body) {
    // The password only ever travels in the Authorization header, never in the
    // URL: URLs end up in logs and traces.
    const res = await fetch(`${config.base}${path}`, {
        method,
        headers: {
            "content-type": "application/json",
            Authorization: `Basic ${Buffer.from(`opencode:${config.password}`).toString("base64")}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data;
    try {
        data = text ? JSON.parse(text) : undefined;
    }
    catch {
        data = text;
    }
    if (!res.ok) {
        const detail = typeof data === "string" ? data.slice(0, 200) : JSON.stringify(data ?? {}).slice(0, 200);
        throw new Error(`opencode-mem: ${method} ${path} failed (HTTP ${res.status}): ${detail}`);
    }
    return data;
}
function candidateStart(text) {
    const brace = text.indexOf("{");
    const bracket = text.indexOf("[");
    if (brace === -1)
        return bracket;
    if (bracket === -1)
        return brace;
    return Math.min(brace, bracket);
}
/**
 * Extract a JSON value from model text: bare JSON, a ```json fence, or JSON
 * embedded in prose (first balanced object/array, skipping braces in strings).
 */
export function extractJsonPayload(raw) {
    if (raw && typeof raw === "object")
        return raw;
    if (typeof raw !== "string")
        return undefined;
    const text = raw.trim();
    if (!text)
        return undefined;
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidates = [];
    if (fence?.[1])
        candidates.push(fence[1].trim());
    candidates.push(text);
    for (const candidate of candidates) {
        try {
            return JSON.parse(candidate);
        }
        catch {
            // not bare JSON; fall through to the balanced scan
        }
    }
    const start = candidateStart(text);
    if (start === -1)
        return undefined;
    const open = text[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === "\\") {
            escaped = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            continue;
        }
        if (inString)
            continue;
        if (ch === open)
            depth++;
        else if (ch === close) {
            depth--;
            if (depth === 0) {
                try {
                    return JSON.parse(text.slice(start, i + 1));
                }
                catch {
                    return undefined;
                }
            }
        }
    }
    return undefined;
}
/**
 * Structured output through a real, session-scoped opencode session.
 *
 * Free-tier providers (OpenCode Zen with `apiKey: "public"`) reject sessionless
 * generate calls, which is what both the plugin Generate API and the
 * sessionless `/api/experimental/generate` route use. A session-scoped generate
 * is accepted, so retry there when the normal transport was refused.
 *
 * Returns undefined when the local server is not reachable, so the caller keeps
 * the original error. Throws when the server answered but the result did not
 * satisfy the schema.
 */
async function tryGenerateViaRealSession(args) {
    const config = readLocalServerConfig();
    if (!config)
        return undefined;
    const { providerID, modelID, systemPrompt, userPrompt, jsonSchema, schema } = args;
    const created = await localServerFetch(config, "POST", "/api/session", {
        title: INTERNAL_CAPTURE_SESSION_TITLE,
    });
    const sessionID = created?.data?.id ??
        created?.id ??
        undefined;
    if (!sessionID) {
        throw new Error("opencode-mem: session create returned no id for real-session structured output");
    }
    markInternalSession(sessionID);
    trackInternalCaptureSession(sessionID);
    try {
        // Pin the model: the free tier exposes models only to session-scoped calls,
        // and the session default may be a different (paid) model.
        await localServerFetch(config, "POST", `/api/session/${sessionID}/model`, {
            model: { id: modelID, providerID },
        });
        const prompt = [
            systemPrompt,
            "",
            "Respond with a single JSON value that validates against this JSON Schema.",
            "Return raw JSON only: no prose, no markdown fences, no commentary.",
            "",
            "JSON Schema:",
            JSON.stringify(jsonSchema),
            "",
            "Task:",
            userPrompt,
        ].join("\n");
        // The session-scoped generate route occasionally answers with an empty body
        // (a transient provider hiccup rather than a schema problem), so retry
        // before giving up. Each attempt re-uses the same session; a fresh one is
        // not needed because nothing was committed.
        const attempts = Math.max(1, Math.min(4, (args.retryCount ?? 1) + 1));
        let lastText;
        for (let attempt = 1; attempt <= attempts; attempt++) {
            const generated = await localServerFetch(config, "POST", `/api/session/${sessionID}/generate`, { prompt });
            const text = generated?.data?.text ??
                generated?.text;
            lastText = text;
            const payload = extractJsonPayload(text);
            if (payload !== undefined) {
                return schema.parse(payload);
            }
            if (attempt < attempts) {
                await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
            }
        }
        throw new Error(`opencode-mem: real-session generate returned no JSON after ${attempts} attempt(s) ` +
            `(got: ${String(lastText).slice(0, 200)})`);
    }
    finally {
        unmarkInternalSession(sessionID);
        try {
            await localServerFetch(config, "DELETE", `/api/session/${sessionID}`);
        }
        catch {
            // intentionally swallowed: cleanup is cosmetic
        }
        finally {
            untrackInternalCaptureSession(sessionID);
        }
    }
}
/**
 * Whether a failed structured-output call is worth retrying through a real
 * session.
 *
 * Only a provider refusal qualifies. Excluded:
 * - timeout, step-budget abort, schema mismatch: these fail identically
 *   through any transport, and retrying costs a live HTTP round-trip to the
 *   host while hiding the real cause behind the fallback's error;
 * - connectivity errors (ECONNREFUSED and friends): the fallback talks to the
 *   same host, so if the host is unreachable the second attempt cannot
 *   succeed either.
 */
function shouldTryRealSession(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/structured-output timed out/.test(message))
        return false;
    if (/structured-output aborted after/.test(message))
        return false;
    if (/returned no structured output/.test(message))
        return false;
    if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|socket hang up|fetch failed/i.test(message)) {
        return false;
    }
    return true;
}
function buildQuery(directory) {
    if (!directory)
        return "";
    return `?directory=${encodeURIComponent(directory)}`;
}
async function fetchJson(endpoint, init) {
    let res;
    try {
        res = await activeFetch()(new Request(endpoint.url, init));
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`opencode-mem: failed to fetch ${endpoint.label} at ${diagnosticUrl(endpoint.url)}: ${message}`, { cause: error });
    }
    return readJson(res, endpoint);
}
async function createSession(base, directory) {
    const url = `${base}/session${buildQuery(directory)}`;
    const body = await fetchJson({ label: "POST /session", url }, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sessionCreateBody()),
    });
    if (!body.id) {
        throw new Error("opencode-mem: session.create returned no session id; cannot generate structured output");
    }
    trackInternalCaptureSession(body.id);
    return body.id;
}
function formatAssistantError(error) {
    if (!error.data)
        return error.name;
    const details = safeAssistantErrorDetails(error.data);
    if (!error.data.message)
        return details;
    return details ? `${error.data.message}; ${details}` : error.data.message;
}
function safeAssistantErrorDetails(data) {
    const safeFields = {};
    for (const key of ["statusCode", "providerID", "modelID"]) {
        const value = data[key];
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
            safeFields[key] = value;
        }
    }
    const entries = Object.entries(safeFields);
    if (entries.length === 0)
        return "";
    return `details=${JSON.stringify(Object.fromEntries(entries))}`;
}
async function promptSession(base, args) {
    const data = await promptSessionRaw(base, {
        sessionID: args.sessionID,
        directory: args.directory,
        body: sessionPromptFields(args),
    });
    if (!data.info) {
        throw new Error("opencode-mem: prompt response missing `info`");
    }
    return data.info;
}
async function promptSessionRaw(base, args) {
    const url = `${base}/session/${encodeURIComponent(args.sessionID)}/message${buildQuery(args.directory)}`;
    return fetchJson({ label: "POST /session/{id}/message", url }, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args.body),
    });
}
async function abortSession(base, sessionID, directory) {
    const url = `${base}/session/${encodeURIComponent(sessionID)}/abort${buildQuery(directory)}`;
    try {
        await activeFetch()(new Request(url, { method: "POST" }));
    }
    catch {
        // best-effort
    }
}
async function deleteSession(base, sessionID, directory) {
    const url = `${base}/session/${encodeURIComponent(sessionID)}${buildQuery(directory)}`;
    let res;
    try {
        res = await activeFetch()(new Request(url, { method: "DELETE" }));
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`opencode-mem: failed to fetch DELETE /session/{id} at ${diagnosticUrl(url)}: ${message}`, { cause: error });
    }
    // DELETE /session/:id returns boolean. We only care that it ran; failures
    // are swallowed at the call site.
    if (!res.ok) {
        throw new Error(`opencode-mem: opencode DELETE /session/{id} failed at ${diagnosticUrl(url)} (${responseStatus(res)})`);
    }
}
function activeFetch() {
    return _hostFetch ?? globalThis.fetch;
}

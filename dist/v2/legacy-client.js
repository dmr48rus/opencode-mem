import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
function textFromParts(parts = []) {
    return parts
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n");
}
/**
 * Best-effort structured-output recovery for the v2 Generate API, which has
 * no json_schema enforcement: try the raw text as JSON, then a fenced
 * ```json block, then balanced top-level {...} objects (ignoring braces
 * inside strings). When several objects parse, prefer the last one (models
 * often emit a stub/example before the final answer). Returns undefined when
 * nothing parses — callers treat that as "no structured output".
 */
function parseJson(text) {
    const trimmed = text.trim();
    // Direct JSON.
    try {
        return JSON.parse(trimmed);
    }
    catch {
        // fall through to recovery
    }
    // Fenced ```json block.
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
    if (fenced) {
        try {
            return JSON.parse(fenced);
        }
        catch {
            // fall through to the balanced-object scan
        }
    }
    // Scan every balanced top-level object; keep the last one that parses.
    const candidate = fenced ?? trimmed;
    let lastParsed;
    let searchFrom = 0;
    while (searchFrom < candidate.length) {
        const start = candidate.indexOf("{", searchFrom);
        if (start < 0)
            break;
        let depth = 0;
        let inString = false;
        let escaped = false;
        let found = false;
        for (let i = start; i < candidate.length; i++) {
            const ch = candidate[i];
            if (inString) {
                if (escaped)
                    escaped = false;
                else if (ch === "\\")
                    escaped = true;
                else if (ch === '"')
                    inString = false;
                continue;
            }
            if (ch === '"')
                inString = true;
            else if (ch === "{")
                depth++;
            else if (ch === "}") {
                depth--;
                if (depth === 0) {
                    found = true;
                    try {
                        lastParsed = JSON.parse(candidate.slice(start, i + 1));
                    }
                    catch {
                        // Unparseable balanced span: keep scanning for a later object.
                    }
                    searchFrom = i + 1;
                    break;
                }
            }
        }
        if (!found)
            break;
    }
    return lastParsed;
}
function legacyMessage(message, sessionID) {
    if (message.type === "user" || message.type === "synthetic" || message.type === "system") {
        return {
            info: { id: message.id, sessionID, role: "user", agent: message.agent },
            parts: [
                {
                    id: `${message.id}-text`,
                    sessionID,
                    messageID: message.id,
                    type: "text",
                    text: message.text ?? "",
                    synthetic: message.type !== "user",
                },
            ],
        };
    }
    if (message.type === "assistant") {
        return {
            info: {
                id: message.id,
                sessionID,
                role: "assistant",
                agent: message.agent,
                mode: message.agent,
            },
            parts: (message.content ?? []).map((part, index) => ({
                id: part.id ?? `${message.id}-${index}`,
                sessionID,
                messageID: message.id,
                ...part,
            })),
        };
    }
    if (message.type === "compaction") {
        return {
            info: {
                id: message.id,
                sessionID,
                role: "assistant",
                summary: true,
                mode: "compaction",
            },
            parts: [],
        };
    }
    return {
        info: { id: message.id ?? randomUUID(), sessionID, role: "assistant" },
        parts: [],
    };
}
function sessionIDFrom(input) {
    return input?.sessionID ?? input?.path?.id;
}
function bodyFrom(input) {
    return input?.body ?? input ?? {};
}
function schemaPrompt(body) {
    const sections = [body.system, textFromParts(body.parts)];
    if (body.format?.type === "json_schema" && body.format.schema) {
        sections.push([
            "Return only one JSON object matching this JSON Schema.",
            "Do not wrap the JSON in Markdown.",
            // The v2 Generate API exposes no tools; models that follow a tool
            // instruction from the system prompt would stall on a preamble and
            // never answer. State the constraint explicitly.
            "No tools are available in this request. Do not attempt to call any tool; your entire reply must be only the JSON object.",
            JSON.stringify(body.format.schema),
        ].join("\n"));
    }
    return sections.filter(Boolean).join("\n\n");
}
function toastPayloadFrom(input) {
    const body = bodyFrom(input);
    const message = typeof body.message === "string" ? body.message : "";
    if (!message)
        return null;
    const payload = { message };
    if (typeof body.title === "string" && body.title)
        payload.title = body.title;
    if (body.variant === "info" ||
        body.variant === "success" ||
        body.variant === "warning" ||
        body.variant === "error") {
        payload.variant = body.variant;
    }
    if (typeof body.duration === "number" && Number.isFinite(body.duration)) {
        payload.duration = body.duration;
    }
    if (typeof body.sessionID === "string" && body.sessionID) {
        payload.sessionID = body.sessionID;
    }
    return payload;
}
function toastFallback(input) {
    const body = bodyFrom(input);
    const message = [body.title, body.message].filter(Boolean).join(": ");
    if (message) {
        const method = body.variant === "error" ? "error" : body.variant === "warning" ? "warn" : "info";
        console[method](`[opencode-mem] ${message}`);
    }
    return { data: false };
}
async function showToastViaRpc(toastRpc, input) {
    if (!toastRpc)
        return toastFallback(input);
    const payload = toastPayloadFrom(input);
    if (!payload)
        return toastFallback(input);
    try {
        await toastRpc.events.emit("toast", payload);
        return { data: true };
    }
    catch {
        return toastFallback(input);
    }
}
/**
 * Adapts the released OpenCode v2 plugin context to the V1 client shape used
 * by the shared opencode-mem implementation.
 */
export function createLegacyClient(ctx, toastRpc) {
    const generatedSessions = new Set();
    const client = {
        app: { log: async () => ({ data: true }) },
        provider: {
            list: async () => {
                // Provider connectivity must come from the real provider directory
                // (ctx.provider.list(), ProviderInfo.activation), never from
                // model.list: model ids carry the broker's providerID (e.g. every
                // proxied model reports 'opencode'), which hides the actual enabled
                // providers (e.g. 'newapi') and makes isProviderConnected deny a
                // live provider. Disabled providers are excluded; auto/enabled pass;
                // ids dedup. Errors propagate to the caller (the plugin init path
                // already catches and logs) — an error must not be turned into a
                // fabricated "no providers connected" result.
                const providers = await ctx.provider.list();
                const connected = [
                    ...new Set(providers.data
                        .filter((provider) => provider.activation === "auto" || provider.activation === "enabled")
                        .map((provider) => provider.id)),
                ];
                return { data: { connected } };
            },
        },
        tui: {
            showToast: async (input) => showToastViaRpc(toastRpc, input),
            appendPrompt: async () => ({ data: false }),
            submitPrompt: async () => ({ data: false }),
        },
        session: {
            get: async (input) => {
                const sessionID = sessionIDFrom(input);
                if (!sessionID)
                    throw new Error("session id required");
                return { data: await ctx.session.get({ sessionID }) };
            },
            messages: async (input) => {
                const sessionID = sessionIDFrom(input);
                if (!sessionID)
                    throw new Error("session id required");
                return {
                    data: (await ctx.session.context({ sessionID })).map((message) => legacyMessage(message, sessionID)),
                };
            },
            create: async () => {
                // OpenCode v2's plugin Generate API is intentionally sessionless.
                // Keep a synthetic id so the existing structured-output lifecycle can
                // retain its create/prompt/delete contract without polluting history.
                const id = randomUUID();
                generatedSessions.add(id);
                return { data: { id } };
            },
            prompt: async (input) => {
                const sessionID = sessionIDFrom(input);
                if (!sessionID)
                    throw new Error("session id required");
                const body = bodyFrom(input);
                if (generatedSessions.has(sessionID)) {
                    const model = body.model?.providerID && body.model?.modelID
                        ? {
                            providerID: body.model.providerID,
                            id: body.model.modelID,
                            // V1 prompt bodies carry the variant as a sibling of `model`
                            // (SessionPromptData.body.variant); the V2 Generate API
                            // takes it inside the model object.
                            ...(typeof body.variant === "string" && body.variant
                                ? { variant: body.variant }
                                : {}),
                        }
                        : undefined;
                    const generated = await ctx.generate.text({
                        prompt: schemaPrompt(body),
                        ...(model ? { model } : {}),
                    });
                    const text = generated?.text ?? "";
                    const structured = body.format?.type === "json_schema" ? parseJson(text) : undefined;
                    return {
                        data: {
                            info: {
                                id: randomUUID(),
                                role: "assistant",
                                structured_output: structured,
                                structured,
                            },
                            parts: [{ type: "text", text }],
                        },
                    };
                }
                const text = textFromParts(body.parts);
                if (body.noReply) {
                    const data = await ctx.session.synthetic({
                        sessionID,
                        text,
                        description: "memory context",
                        metadata: body.parts?.[0]?.metadata,
                    });
                    return { data, response: new Response(null, { status: 200 }) };
                }
                const data = await ctx.session.prompt({
                    sessionID,
                    text,
                    delivery: "queue",
                    metadata: body.parts?.[0]?.metadata,
                });
                return { data, response: new Response(null, { status: 200 }) };
            },
            abort: async (input) => {
                const sessionID = sessionIDFrom(input);
                if (sessionID && generatedSessions.has(sessionID)) {
                    generatedSessions.delete(sessionID);
                    return { data: true };
                }
                if (sessionID) {
                    const result = await ctx.session.interrupt({ sessionID });
                    return { data: result.interrupted };
                }
                return { data: false };
            },
            delete: async (input) => {
                const sessionID = sessionIDFrom(input);
                if (sessionID)
                    generatedSessions.delete(sessionID);
                return { data: true };
            },
        },
    };
    return client;
}
export function legacyToolResult(value) {
    if (typeof value === "string")
        return { content: value };
    if (value && typeof value === "object" && typeof value.output === "string") {
        return { content: value.output, metadata: value.metadata };
    }
    return { content: JSON.stringify(value ?? null) };
}
// opencode v2 no longer publishes `session.idle`, which is what
// opencode-mem builds auto-capture and profile learning on. The
// `/api/event` stream emits `session.execution.{succeeded,failed,interrupted}`
// with `data.sessionID`; forwarding them under the legacy name is enough.
const LEGACY_EVENT_ALIASES = {
    "session.compaction.ended": "session.compacted",
    "session.execution.succeeded": "session.idle",
    "session.execution.failed": "session.idle",
    "session.execution.interrupted": "session.idle",
};
export function toLegacyEvent(raw) {
    const envelope = raw?.payload ?? raw;
    const source = envelope?.type === "sync" && envelope.syncEvent ? envelope.syncEvent : envelope;
    const rawType = typeof source?.type === "string" ? source.type.replace(/\.1$/, "") : source?.type;
    const type = typeof rawType === "string" ? (LEGACY_EVENT_ALIASES[rawType] ?? rawType) : rawType;
    const data = source?.data ?? {};
    if (source && typeof source === "object" && "properties" in source) {
        return { type, properties: source.properties };
    }
    if (type === "session.created" || type === "session.updated") {
        return { type, properties: { info: data.session ?? data.info ?? data } };
    }
    return { type, properties: data };
}
export async function eventBelongsToLocation(ctx, raw) {
    const directory = raw?.location?.directory ??
        raw?.directory ??
        raw?.payload?.location?.directory ??
        raw?.payload?.directory ??
        raw?.data?.info?.directory;
    if (typeof directory === "string") {
        return resolve(directory) === resolve(ctx.location.directory);
    }
    const data = raw?.data ?? raw?.payload?.data ?? raw?.properties;
    const sessionID = data?.sessionID ?? data?.session?.id ?? data?.info?.id;
    if (sessionID) {
        try {
            const session = await ctx.session.get({ sessionID });
            const sessionDirectory = session?.location?.directory ?? session?.directory ?? session?.data?.directory;
            return (typeof sessionDirectory === "string" &&
                resolve(sessionDirectory) === resolve(ctx.location.directory));
        }
        catch {
            return false;
        }
    }
    // Provider/model inventory updates are process-scoped ephemeral events with
    // optional location. When the host omits location (and there is no session),
    // still forward them so connectivity snapshots can refresh on late registration.
    const envelope = raw?.payload ?? raw;
    const source = envelope?.type === "sync" && envelope.syncEvent ? envelope.syncEvent : envelope;
    const rawType = typeof source?.type === "string" ? source.type.replace(/\.1$/, "") : undefined;
    return rawType === "provider.updated" || rawType === "model.updated";
}

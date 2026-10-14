import type { Plugin } from "@opencode-ai/plugin";
import { INTERNAL_CAPTURE_SESSION_TITLE, isInternalCaptureSessionTitle } from "./services/ai/internal-capture-sessions.js";
export { INTERNAL_CAPTURE_SESSION_TITLE, isInternalCaptureSessionTitle };
export declare function isStructuredSummaryPromptMessage(userMessage: string): boolean;
/**
 * Resolve the session's active agent so compaction memory injection does not
 * reset OpenCode to the stock "general-purpose" fallback (issue #236).
 *
 * Preference order:
 * 1. session.get().agent (v2 hosts)
 * 2. Latest non-compaction user message agent
 * 3. Latest non-compaction / non-summary assistant mode (v1) or agent (v2)
 */
export declare function resolveSessionAgent(client: unknown, sessionID: string): Promise<string | undefined>;
/**
 * Resolve the session's current model (the server-side `session.model`, written by the most
 * recent real user message and left untouched by compaction). Compaction memory injection must
 * pass it explicitly: OpenCode resolves `input.model ?? agent.model ?? session.model`, so when the
 * active agent declares its own model the injected message would otherwise switch the session to
 * that agent's default model and variant.
 */
export declare function resolveSessionModel(client: unknown, sessionID: string): Promise<{
    model: {
        providerID: string;
        modelID: string;
    };
    variant?: string;
} | undefined>;
/** Least-privilege agent used only by internal structured-output sessions (issue #189). */
export declare function applyStructuredOutputAgentConfig(cfg: {
    agent?: Record<string, unknown>;
}): void;
/**
 * Force-disable thinking on structured-output chat.params after OpenCode merges
 * model/agent/variant options. A user reasoning variant merges last and can
 * otherwise re-enable thinking (#253).
 */
export declare function applyStructuredOutputChatParams(input: {
    agent?: unknown;
}, output: {
    options?: Record<string, unknown>;
} | undefined): void;
export declare function configureOpencodeHostTransport(ctx: {
    readonly client: unknown;
    readonly serverUrl?: string | URL;
}): Promise<void>;
export declare const OpenCodeMemPlugin: Plugin;
//# sourceMappingURL=index.d.ts.map
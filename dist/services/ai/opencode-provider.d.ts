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
import type { z } from "zod";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { type HostTransport } from "./opencode-sdk-client.js";
/** Dedicated agent registered via the plugin config hook (step-capped). */
export declare const STRUCTURED_OUTPUT_AGENT = "opencode-mem-structured";
/** Hard ceiling for a single internal structured-output prompt. */
export declare const STRUCTURED_OUTPUT_TIMEOUT_MS = 90000;
/**
 * Soft agent step budget. OpenCode only injects a last-step warning for
 * `format: json_schema` and can keep looping when forced tool calls fail
 * (seen with opencode-claude-auth in #278). We also abort client-side after
 * this many `step-start` parts.
 */
export declare const STRUCTURED_OUTPUT_MAX_STEPS = 2;
/** Cap OpenCode schema retries so a bad provider cannot spin forever. */
export declare const STRUCTURED_OUTPUT_DEFAULT_RETRY_COUNT = 1;
/**
 * Test helper: override the structured-output prompt timeout. Pass undefined
 * to reset to the configured value.
 */
export declare function setStructuredOutputTimeoutMsForTests(ms: number | undefined): void;
/**
 * Inject the configured structured-output timeout (CONFIG.opencodeTimeoutMs,
 * already normalized/clamped in config.ts). Called once by the plugin init.
 */
export declare function setStructuredOutputTimeoutConfig(ms: number): void;
/**
 * Injected by the plugin init (from CONFIG.opencodeRealSessionFallback).
 * When enabled, a structured-output call that the configured transport
 * rejects is retried through a real, session-scoped opencode session — the
 * only shape free-tier providers accept.
 */
export declare function setStructuredOutputRealSessionFallback(enabled: boolean): void;
export declare const STRUCTURED_OUTPUT_PERMISSIONS: ({
    permission: string;
    pattern: string;
    action: "deny";
} | {
    permission: string;
    pattern: string;
    action: "allow";
})[];
export declare const STRUCTURED_OUTPUT_TOOLS: Record<string, boolean>;
export declare const STRUCTURED_OUTPUT_METADATA: {
    "opencode-mem": {
        internal: boolean;
        purpose: string;
    };
};
export declare function setHostFetch(customFetch: typeof fetch): void;
export declare function resetHostFetch(): void;
export declare function setConnectedProviders(providers: string[]): void;
export declare function isProviderConnected(providerName: string): boolean;
/** Register (or clear) the refresh callback used by ensureProviderConnected. */
export declare function setConnectedProvidersRefresher(refresher?: () => Promise<void>): void;
/** Clear the refresh callback only if it is still the one being disposed. */
export declare function clearConnectedProvidersRefresher(refresher: () => Promise<void>): void;
/**
 * Refresh-on-miss for the connectivity gate: when a provider id is missing
 * from the snapshot and a refresher is registered, await one refresh and
 * re-check. Returns the re-checked connectivity; never refreshes twice for
 * the same call and never throws (refresh errors are logged by the refresher).
 */
export declare function ensureProviderConnected(providerName: string): Promise<boolean>;
export declare function setV2Client(client: OpencodeClient): void;
export declare function getV2Client(): OpencodeClient | undefined;
export declare function createV2Client(serverUrl: URL | string, transport?: HostTransport): OpencodeClient;
/** True while an internal structured-output session is live (create → delete). */
export declare function isInternalStructuredSession(sessionID: string): boolean;
/** Test helper: clear tracked internal session IDs. */
export declare function resetInternalStructuredSessions(): void;
/**
 * Record a `step-start` on an internal structured-output session.
 * Returns whether the client should abort (step budget exceeded).
 */
export declare function noteStructuredOutputStep(sessionID: string): {
    tracked: boolean;
    steps: number;
    shouldAbort: boolean;
};
/** Consume a step-budget abort error if the prompt failed after we aborted. */
export declare function takeStructuredOutputStepAbortError(sessionID: string): Error | undefined;
/**
 * Claude / opencode-claude-auth registers as provider `anthropic`. Forced
 * `format: json_schema` often loops; prefer auth-preserving text JSON (#278).
 */
export declare function shouldUseOpencodeTextJson(providerID: string): boolean;
export interface StructuredOutputOptions<T> {
    client: OpencodeClient;
    providerID: string;
    modelID: string;
    /** Optional reasoning variant forwarded to the session prompt / Generate API. */
    variant?: string;
    systemPrompt: string;
    userPrompt: string;
    schema: z.ZodType<T>;
    directory?: string;
    retryCount?: number;
}
/**
 * Resolve `opencodeModel: "inherit"` to a concrete provider/model.
 *
 * Prefer an explicit prompt-recorded model (auto-capture path). Otherwise fall
 * back to OpenCode's recent model list so profile-learning / conflict / dedup
 * paths don't send the literal model id "inherit" (ProviderModelNotFoundError).
 */
export declare function resolveOpencodeModelRef(opts: {
    providerID: string;
    modelID: string;
    prompt?: {
        providerId?: string | null;
        modelId?: string | null;
    };
}): {
    providerID: string;
    modelID: string;
};
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
export declare function generateStructuredOutput<T>(opts: StructuredOutputOptions<T>): Promise<T>;
/**
 * Extract a JSON value from model text: bare JSON, a ```json fence, or JSON
 * embedded in prose (first balanced object/array, skipping braces in strings).
 */
export declare function extractJsonPayload(raw: unknown): unknown;
//# sourceMappingURL=opencode-provider.d.ts.map
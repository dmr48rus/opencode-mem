import type { PluginInput } from "@opencode-ai/plugin";
interface ToolCallInfo {
    name: string;
    input: string;
}
export interface PerformAutoCaptureOptions {
    /**
     * Skip this job if it has not started yet once the signal aborts (e.g. the
     * plugin is disposing). In-flight captures are NOT cancelled: model
     * requests were never cancellable and keep their original semantics.
     */
    signal?: AbortSignal;
}
export declare function performAutoCapture(ctx: PluginInput, sessionID: string, directory: string, options?: PerformAutoCaptureOptions): Promise<void>;
/**
 * Wait until every capture job that has already been enqueued finishes.
 * Used by plugin dispose so `memoryClient.close()` does not race an
 * in-flight capture that was intentionally left uncancellable.
 */
export declare function awaitCaptureDrain(): Promise<void>;
export declare function getAutoCaptureMarkdownBudget(totalRequestBytes?: number): number;
export declare function buildBoundedSummaryPrompt(context: string, systemPrompt: string, schema: unknown, totalRequestBytes?: number): string;
/** Build auto-capture markdown context, capped to autoCaptureMaxContextBytes (UTF-8). */
export declare function buildMarkdownContext(userPrompt: string, textResponses: string[], toolCalls: ToolCallInfo[], latestMemory: string | null, maxContextBytes?: number): string;
export {};
//# sourceMappingURL=auto-capture.d.ts.map
export interface ToolCallResult {
    success: boolean;
    data?: any;
    error?: string;
    iterations?: number;
}
export interface ProviderConfig {
    model: string;
    apiUrl: string;
    apiKey?: string;
    maxIterations?: number;
    iterationTimeout?: number;
    maxTokens?: number;
    memoryTemperature?: number | false;
    extraParams?: Record<string, unknown>;
    /**
     * Force the model to emit a tool call instead of free text. Defaults to true
     * on chat-completion providers: prompts already demand a tool call, and
     * `tool_choice: "auto"` lets some models answer in prose, which silently
     * drops the structured result (see tag migration). Set to false to opt out
     * for providers that reject `tool_choice: "required"`.
     */
    forceToolChoice?: boolean;
}
export declare function applySafeExtraParams(requestBody: Record<string, any>, extraParams: Record<string, unknown>): void;
export declare abstract class BaseAIProvider {
    protected config: ProviderConfig;
    constructor(config: ProviderConfig);
    abstract executeToolCall(systemPrompt: string, userPrompt: string, toolSchema: any, sessionId: string): Promise<ToolCallResult>;
    abstract getProviderName(): string;
    abstract supportsSession(): boolean;
}
//# sourceMappingURL=base-provider.d.ts.map
import { isPlaceholderApiKey } from "./services/ai/api-key-placeholder.js";
interface OpenCodeMemConfig {
    storagePath?: string;
    userEmailOverride?: string;
    userNameOverride?: string;
    memory?: {
        defaultScope?: "project" | "all-projects";
    };
    embeddingModel?: string;
    embeddingDimensions?: number;
    embeddingApiUrl?: string;
    embeddingApiKey?: string;
    /** Opt-in Nomic task prefixes (`search_document:` / `search_query:`). Default false. */
    embeddingUseTaskPrefixes?: boolean;
    /**
     * Local transformers.js pooling strategy. Default `"mean"`.
     * Model presets (bge-m3 → cls, Qwen3-Embedding → last_token) apply when unset.
     */
    embeddingPooling?: "mean" | "cls" | "last_token";
    /**
     * Prefix applied to query-task embeddings. When unset, model presets or
     * `embeddingUseTaskPrefixes` (Nomic) may supply one. Explicit `""` disables.
     */
    embeddingQueryPrefix?: string;
    /**
     * Prefix applied to document-task embeddings. Same resolution rules as
     * `embeddingQueryPrefix`.
     */
    embeddingDocumentPrefix?: string;
    /**
     * A second embedding model, written to a parallel ("shadow") column.
     *
     * The model in charge keeps serving the store while the shadow index is
     * filled, so switching models never leaves the store unreadable. Measured
     * 20.10.2026 on the live corpus: a multilingual model takes the semantic
     * slice from 16/28 to 21/28 (offline, together with the lexical channel),
     * while the current English-only model adds nothing over that channel.
     */
    embeddingShadowModel?: string;
    /** Vector width of the shadow model. Default: the model's own preset. */
    embeddingShadowDimensions?: number;
    /** Prefix for query-task embeddings of the shadow model. */
    embeddingShadowQueryPrefix?: string;
    /** Prefix for document-task embeddings of the shadow model. */
    embeddingShadowDocumentPrefix?: string;
    /**
     * dtype of the shadow model's ONNX file (e.g. `"q8"`).
     *
     * The model's own declaration can name a dtype whose file the repository
     * does not have (embeddinggemma-2 declares `bfloat16`, and ships no such
     * file), so the shadow states it explicitly.
     */
    embeddingShadowDtype?: string;
    /**
     * Optional dtype for the local ONNX pipeline (e.g. `"q8"`, `"fp32"`).
     * When set, passed to `pipeline({ dtype })` and outranks auto-detection.
     */
    embeddingDtype?: string;
    similarityThreshold?: number;
    maxMemories?: number;
    maxProfileItems?: number;
    injectProfile?: boolean;
    containerTagPrefix?: string;
    autoCaptureEnabled?: boolean;
    autoCaptureMaxIterations?: number;
    autoCaptureIterationTimeout?: number;
    autoCaptureMaxRetries?: number;
    autoCaptureMaxContextBytes?: number;
    autoCaptureLanguage?: string;
    memoryProvider?: "atlas-cloud" | "openai-chat" | "openai-responses" | "anthropic" | "minimax" | "orcarouter";
    memoryModel?: string;
    memoryApiUrl?: string;
    memoryApiKey?: string;
    memoryTemperature?: number | false;
    /**
     * Force chat-completion providers to send `tool_choice: "required"`.
     * Defaults to true when unset. Set to false for models that reject forced
     * tool choice (e.g. some thinking/reasoning modes).
     */
    forceToolChoice?: boolean;
    memoryExtraParams?: Record<string, unknown>;
    opencodeProvider?: string;
    opencodeModel?: string;
    /**
     * Optional reasoning variant for internal LLM calls that use
     * opencodeProvider/opencodeModel (e.g. "xhigh"). Applied whenever set,
     * including with opencodeModel "inherit", so background work can pin a
     * cheaper/faster/higher variant than the interactive session default.
     */
    opencodeVariant?: string;
    /**
     * Timeout in milliseconds for the plugin's internal structured-output LLM
     * calls (auto-capture summaries, profile learning). Profile cleanup keeps
     * its own longer timeout. Clamped to 10000..600000; non-number/non-finite
     * values (and non-numeric strings) fall back to the 90000 default. Numeric
     * strings like "180000" are coerced.
     */
    opencodeTimeoutMs?: number;
    /**
     * Retry a structured-output call through a real, session-scoped opencode
     * session when the configured transport rejects it.
     *
     * Free-tier providers (OpenCode Zen with `apiKey: "public"`) reject the
     * sessionless generate calls that both the plugin Generate API and
     * `/api/experimental/generate` use, which breaks auto-capture summaries and
     * profile learning. A session-scoped generate is accepted. Needs the host to
     * export OPENCODE_PORT and OPENCODE_SERVER_PASSWORD; without them the
     * fallback is a no-op.
     */
    opencodeRealSessionFallback?: boolean;
    aiSessionRetentionDays?: number;
    webServerEnabled?: boolean;
    webServerPort?: number;
    webServerHost?: string;
    webServerAuthPassword?: string;
    webServerAuthUsername?: string;
    webServerApiToken?: string;
    remoteStorage?: {
        enabled?: boolean;
        baseUrl?: string;
        apiToken?: string;
        timeoutMs?: number;
    };
    maxVectorsPerShard?: number;
    autoCleanupEnabled?: boolean;
    autoCleanupRetentionDays?: number;
    deduplicationEnabled?: boolean;
    deduplicationSimilarityThreshold?: number;
    userProfileAnalysisInterval?: number;
    userProfileMaxContextBytes?: number;
    userProfileDisplayPreferences?: number;
    userProfileDisplayPatterns?: number;
    userProfileDisplayWorkflows?: number;
    userProfileStaleDays?: number;
    userProfileInjectPreferences?: number;
    userProfileInjectPatterns?: number;
    userProfileInjectWorkflows?: number;
    userProfileConfidenceDecayDays?: number;
    userProfileChangelogRetentionCount?: number;
    userProfileEmbeddingThresholdSameCat?: number;
    userProfileEmbeddingThresholdSameCatWeak?: number;
    userProfileEmbeddingThresholdCrossCat?: number;
    userProfileEmbeddingThresholdCrossCatWeak?: number;
    userProfileCentroidDriftThreshold?: number;
    userProfileEmbeddingMinDescriptionLength?: number;
    userProfileMinEvidenceForRetention?: number;
    userProfileAutoCleanupEnabled?: boolean;
    userProfileAutoCleanupInterval?: number;
    userProfileValidationEnabled?: boolean;
    showAutoCaptureToasts?: boolean;
    showUserProfileToasts?: boolean;
    showErrorToasts?: boolean;
    /**
     * Hex encryption key for local DB at rest (32 or 64 hex chars), or a secret
     * ref (`env://`, `file://`). Prefer file:// / env:// — never commit keys.
     * When `databaseEncryptionEnabled` is true and this is unset, the plugin
     * auto-creates `~/.config/opencode/opencode-mem-db.key` (chmod 600).
     */
    databaseEncryptionKey?: string;
    /** Opt-in local DB encryption at rest (AES-256-GCM by default). */
    databaseEncryptionEnabled?: boolean;
    /** Cipher for @tursodatabase/database encryption (default aes256gcm). */
    databaseEncryptionCipher?: "aes128gcm" | "aes256gcm" | "aegis256" | "aegis256x2" | "aegis128l" | "aegis128x2" | "aegis128x4";
    /** Automatically clear OpenCode's cached plugin install when a newer npm latest is available. */
    autoUpdate?: boolean;
    compaction?: {
        enabled?: boolean;
        memoryLimit?: number;
    };
    chatMessage?: {
        enabled?: boolean;
        maxMemories?: number;
        excludeCurrentSession?: boolean;
        maxAgeDays?: number;
        injectOn?: "first" | "always";
        filterInjectedPrompts?: boolean;
        injectionMarkers?: string[];
        /**
         * Capture "user" prompts from orchestrator child sessions (sessions with
         * a parentID, e.g. OpenCode task/subagent). Default false: those prompts
         * are written by the parent agent, not the human, and would train
         * auto-capture / profile learning on the orchestrator's style.
         */
        captureChildSessions?: boolean;
    };
}
export type EmbeddingPooling = "mean" | "cls" | "last_token";
export type EmbeddingModelPreset = {
    pooling: EmbeddingPooling;
    /**
     * When present (including `""`), used as the default query/document prefix
     * when the corresponding config key is unset. Omitting both keeps Nomic
     * opt-in via `embeddingUseTaskPrefixes` (nomic models).
     */
    queryPrefix?: string;
    documentPrefix?: string;
};
/**
 * Known local embedding model presets (substring match on `embeddingModel`).
 * Explicit config keys always win over these defaults.
 */
export declare function getEmbeddingModelPreset(model: string): EmbeddingModelPreset | undefined;
export declare function normalizeEmbeddingPooling(value: unknown): EmbeddingPooling;
/** Dtypes accepted by transformers.js `pipeline({ dtype })`. */
export declare const LOCAL_ONNX_DTYPES: readonly ["auto", "fp32", "fp16", "q8", "int8", "uint8", "q4", "bnb4", "q4f16", "q2", "q2f16", "q1", "q1f16"];
export type LocalOnnxDtype = (typeof LOCAL_ONNX_DTYPES)[number];
export declare function normalizeEmbeddingDtype(value: unknown): LocalOnnxDtype | undefined;
export declare function normalizeAutoCaptureMaxContextBytes(value: number): number;
export declare function normalizeAutoCleanupRetentionDays(value: number): number;
export declare const OPENCODE_TIMEOUT_MS_MIN = 10000;
export declare const OPENCODE_TIMEOUT_MS_MAX = 600000;
export declare const OPENCODE_TIMEOUT_MS_DEFAULT = 90000;
/**
 * Structured-output prompt timeout: non-number/non-finite values fall back to
 * the default (numeric strings are coerced first), otherwise the value is
 * clamped to [OPENCODE_TIMEOUT_MS_MIN, OPENCODE_TIMEOUT_MS_MAX].
 */
export declare function normalizeOpencodeTimeoutMs(value: unknown): number;
/**
 * Margin added to the configured structured-output timeout for the outer
 * safety-net races around generateStructuredOutput calls: the inner, more
 * informative provider timeout always fires first.
 */
export declare const OPENCODE_TIMEOUT_OUTER_MARGIN_MS = 30000;
/**
 * Outer safety-net timeout wrapping one structured-output call, derived from
 * the configured timeout plus a fixed margin.
 */
export declare function outerStructuredOutputTimeoutMs(configured: number | undefined): number;
/**
 * User-supplied markers extend the built-in set rather than replacing it, so
 * adding one marker cannot silently disable protection against all the others.
 */
export declare function normalizeInjectionMarkers(value: string[] | undefined): string[];
declare function buildConfig(fileConfig: OpenCodeMemConfig): {
    storagePath: string;
    userEmailOverride: string | undefined;
    userNameOverride: string | undefined;
    embeddingModel: string;
    embeddingDimensions: number;
    embeddingUseTaskPrefixes: boolean;
    embeddingPooling: EmbeddingPooling;
    embeddingQueryPrefix: string | undefined;
    embeddingDocumentPrefix: string | undefined;
    embeddingShadowModel: string | undefined;
    embeddingShadowDimensions: number | undefined;
    embeddingShadowQueryPrefix: string | undefined;
    embeddingShadowDocumentPrefix: string | undefined;
    embeddingShadowDtype: string | undefined;
    embeddingDtype: "auto" | "fp32" | "fp16" | "q8" | "int8" | "uint8" | "q4" | "bnb4" | "q4f16" | "q2" | "q2f16" | "q1" | "q1f16" | undefined;
    embeddingApiUrl: string | undefined;
    embeddingApiKey: string | undefined;
    similarityThreshold: number;
    maxMemories: number;
    maxProfileItems: number;
    injectProfile: boolean;
    containerTagPrefix: string;
    autoCaptureEnabled: boolean;
    autoCaptureMaxIterations: number;
    autoCaptureIterationTimeout: number;
    autoCaptureMaxRetries: number;
    autoCaptureMaxContextBytes: number;
    autoCaptureLanguage: string | undefined;
    memoryProvider: "atlas-cloud" | "openai-chat" | "openai-responses" | "anthropic" | "minimax" | "orcarouter";
    memoryModel: string | undefined;
    memoryApiUrl: string | undefined;
    memoryApiKey: string | undefined;
    memoryTemperature: number | false | undefined;
    forceToolChoice: boolean | undefined;
    memoryExtraParams: Record<string, unknown> | undefined;
    opencodeProvider: string | undefined;
    opencodeModel: string | undefined;
    opencodeVariant: string | undefined;
    opencodeTimeoutMs: number;
    opencodeRealSessionFallback: boolean;
    autoCaptureProviderStatus: AutoCaptureProviderStatus;
    aiSessionRetentionDays: number;
    webServerEnabled: boolean;
    webServerPort: number;
    webServerHost: string;
    webServerAuthPassword: string | undefined;
    webServerAuthUsername: string | undefined;
    webServerApiToken: string | undefined;
    maxVectorsPerShard: number;
    autoCleanupEnabled: boolean;
    autoCleanupRetentionDays: number;
    deduplicationEnabled: boolean;
    deduplicationSimilarityThreshold: number;
    userProfileAnalysisInterval: number;
    userProfileMaxContextBytes: number;
    userProfileDisplayPreferences: number;
    userProfileDisplayPatterns: number;
    userProfileDisplayWorkflows: number;
    userProfileInjectPreferences: number;
    userProfileInjectPatterns: number;
    userProfileInjectWorkflows: number;
    userProfileConfidenceDecayDays: number;
    userProfileChangelogRetentionCount: number;
    userProfileEmbeddingThresholdSameCat: number;
    userProfileEmbeddingThresholdSameCatWeak: number;
    userProfileEmbeddingThresholdCrossCat: number;
    userProfileEmbeddingThresholdCrossCatWeak: number;
    userProfileCentroidDriftThreshold: number;
    userProfileEmbeddingMinDescriptionLength: number;
    userProfileMinEvidenceForRetention: number;
    userProfileAutoCleanupEnabled: boolean;
    userProfileAutoCleanupInterval: number;
    userProfileValidationEnabled: boolean;
    userProfileStaleDays: number;
    showAutoCaptureToasts: boolean;
    showUserProfileToasts: boolean;
    showErrorToasts: boolean;
    databaseEncryptionEnabled: boolean;
    databaseEncryptionKey: string | undefined;
    databaseEncryptionCipher: "aes128gcm" | "aes256gcm" | "aegis256" | "aegis256x2" | "aegis128l" | "aegis128x2" | "aegis128x4";
    autoUpdate: boolean;
    memory: {
        defaultScope: "project" | "all-projects" | undefined;
    };
    remoteStorage: {
        enabled: boolean;
        baseUrl: string;
        apiToken: string | undefined;
        timeoutMs: number;
    };
    compaction: {
        enabled: boolean | undefined;
        memoryLimit: number | undefined;
    };
    chatMessage: {
        enabled: boolean | undefined;
        maxMemories: number | undefined;
        excludeCurrentSession: boolean | undefined;
        maxAgeDays: number | undefined;
        injectOn: "first" | "always";
        filterInjectedPrompts: boolean | undefined;
        injectionMarkers: string[];
        captureChildSessions: boolean | undefined;
    };
};
export declare let CONFIG: {
    storagePath: string;
    userEmailOverride: string | undefined;
    userNameOverride: string | undefined;
    embeddingModel: string;
    embeddingDimensions: number;
    embeddingUseTaskPrefixes: boolean;
    embeddingPooling: EmbeddingPooling;
    embeddingQueryPrefix: string | undefined;
    embeddingDocumentPrefix: string | undefined;
    embeddingShadowModel: string | undefined;
    embeddingShadowDimensions: number | undefined;
    embeddingShadowQueryPrefix: string | undefined;
    embeddingShadowDocumentPrefix: string | undefined;
    embeddingShadowDtype: string | undefined;
    embeddingDtype: "auto" | "fp32" | "fp16" | "q8" | "int8" | "uint8" | "q4" | "bnb4" | "q4f16" | "q2" | "q2f16" | "q1" | "q1f16" | undefined;
    embeddingApiUrl: string | undefined;
    embeddingApiKey: string | undefined;
    similarityThreshold: number;
    maxMemories: number;
    maxProfileItems: number;
    injectProfile: boolean;
    containerTagPrefix: string;
    autoCaptureEnabled: boolean;
    autoCaptureMaxIterations: number;
    autoCaptureIterationTimeout: number;
    autoCaptureMaxRetries: number;
    autoCaptureMaxContextBytes: number;
    autoCaptureLanguage: string | undefined;
    memoryProvider: "atlas-cloud" | "openai-chat" | "openai-responses" | "anthropic" | "minimax" | "orcarouter";
    memoryModel: string | undefined;
    memoryApiUrl: string | undefined;
    memoryApiKey: string | undefined;
    memoryTemperature: number | false | undefined;
    forceToolChoice: boolean | undefined;
    memoryExtraParams: Record<string, unknown> | undefined;
    opencodeProvider: string | undefined;
    opencodeModel: string | undefined;
    opencodeVariant: string | undefined;
    opencodeTimeoutMs: number;
    opencodeRealSessionFallback: boolean;
    autoCaptureProviderStatus: AutoCaptureProviderStatus;
    aiSessionRetentionDays: number;
    webServerEnabled: boolean;
    webServerPort: number;
    webServerHost: string;
    webServerAuthPassword: string | undefined;
    webServerAuthUsername: string | undefined;
    webServerApiToken: string | undefined;
    maxVectorsPerShard: number;
    autoCleanupEnabled: boolean;
    autoCleanupRetentionDays: number;
    deduplicationEnabled: boolean;
    deduplicationSimilarityThreshold: number;
    userProfileAnalysisInterval: number;
    userProfileMaxContextBytes: number;
    userProfileDisplayPreferences: number;
    userProfileDisplayPatterns: number;
    userProfileDisplayWorkflows: number;
    userProfileInjectPreferences: number;
    userProfileInjectPatterns: number;
    userProfileInjectWorkflows: number;
    userProfileConfidenceDecayDays: number;
    userProfileChangelogRetentionCount: number;
    userProfileEmbeddingThresholdSameCat: number;
    userProfileEmbeddingThresholdSameCatWeak: number;
    userProfileEmbeddingThresholdCrossCat: number;
    userProfileEmbeddingThresholdCrossCatWeak: number;
    userProfileCentroidDriftThreshold: number;
    userProfileEmbeddingMinDescriptionLength: number;
    userProfileMinEvidenceForRetention: number;
    userProfileAutoCleanupEnabled: boolean;
    userProfileAutoCleanupInterval: number;
    userProfileValidationEnabled: boolean;
    userProfileStaleDays: number;
    showAutoCaptureToasts: boolean;
    showUserProfileToasts: boolean;
    showErrorToasts: boolean;
    databaseEncryptionEnabled: boolean;
    databaseEncryptionKey: string | undefined;
    databaseEncryptionCipher: "aes128gcm" | "aes256gcm" | "aegis256" | "aegis256x2" | "aegis128l" | "aegis128x2" | "aegis128x4";
    autoUpdate: boolean;
    memory: {
        defaultScope: "project" | "all-projects" | undefined;
    };
    remoteStorage: {
        enabled: boolean;
        baseUrl: string;
        apiToken: string | undefined;
        timeoutMs: number;
    };
    compaction: {
        enabled: boolean | undefined;
        memoryLimit: number | undefined;
    };
    chatMessage: {
        enabled: boolean | undefined;
        maxMemories: number | undefined;
        excludeCurrentSession: boolean | undefined;
        maxAgeDays: number | undefined;
        injectOn: "first" | "always";
        filterInjectedPrompts: boolean | undefined;
        injectionMarkers: string[];
        captureChildSessions: boolean | undefined;
    };
};
type RuntimeConfig = ReturnType<typeof buildConfig>;
interface AutoCaptureProviderRuntimeConfig {
    opencodeProvider?: string;
    opencodeModel?: string;
    memoryProvider?: string;
    memoryModel?: string;
    memoryApiUrl?: string;
    memoryApiKey?: string;
}
export type AutoCaptureProviderStatus = {
    ready: true;
    mode: "opencode" | "manual";
    issues: [];
} | {
    ready: false;
    issues: string[];
};
export { isPlaceholderApiKey };
export declare function getAutoCaptureProviderStatus(config: AutoCaptureProviderRuntimeConfig): AutoCaptureProviderStatus;
export declare function hasAutoCaptureProviderConfig(config?: RuntimeConfig): boolean;
export declare function initConfig(directory: string): void;
export declare function isConfigured(): boolean;
//# sourceMappingURL=config.d.ts.map
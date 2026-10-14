import { isPlaceholderApiKey } from "./api-key-placeholder.js";
export function buildMemoryProviderConfig(config, overrides = {}) {
    const memoryModel = config.memoryModel;
    const memoryApiUrl = config.memoryApiUrl;
    const memoryApiKey = config.memoryApiKey;
    const issues = [];
    // Preset providers fill endpoint/model themselves, so memoryModel /
    // memoryApiUrl are optional there. An API key is always required.
    const isPresetProvider = config.memoryProvider === "orcarouter" || config.memoryProvider === "atlas-cloud";
    if (!memoryModel && !isPresetProvider)
        issues.push("missing memoryModel");
    if (!memoryApiUrl && !isPresetProvider)
        issues.push("missing memoryApiUrl");
    if (!memoryApiKey)
        issues.push("missing memoryApiKey");
    if (isPlaceholderApiKey(memoryApiKey))
        issues.push("replace the placeholder memoryApiKey value");
    if (issues.length > 0) {
        throw new Error(`External API not configured for memory provider: ${issues.join("; ")}`);
    }
    return {
        model: memoryModel || "",
        apiUrl: memoryApiUrl || "",
        apiKey: memoryApiKey || "",
        memoryTemperature: config.memoryTemperature,
        forceToolChoice: config.forceToolChoice,
        extraParams: config.memoryExtraParams,
        maxIterations: overrides.maxIterations ?? config.autoCaptureMaxIterations,
        iterationTimeout: overrides.iterationTimeout ?? config.autoCaptureIterationTimeout,
    };
}

import { OpenCodeMemPlugin } from "../index.js";
import { CONFIG } from "../config.js";
import { loadOpencodeProvider } from "../services/ai/opencode-provider-loader.js";
import { registerV2Adapter } from "./adapter.js";
import { createLegacyClient } from "./legacy-client.js";
import { MemToast } from "./toast-rpc.js";
import { log } from "../services/logger.js";
const OpenCodeMemPluginV2 = {
    id: "opencode-mem",
    async setup(ctx) {
        // Which entry the host loads is not observable from the outside: this one
        // wraps the same plugin as dist/plugin.js, so both emit the same startup
        // lines. Without this marker there is no way to tell "the v2 entry never
        // loaded" from "it loaded and found no ctx.skill".
        log("v2 plugin entry loaded", {
            hasSkillHook: !!ctx.skill,
            hasTransform: typeof ctx.skill?.transform === "function",
        });
        // Server Context has no ui.toast; bridge toast intents to the ./tui companion.
        const toastRpc = await ctx.rpc.register(MemToast, {});
        const legacyClient = createLegacyClient(ctx, toastRpc);
        const legacy = (await OpenCodeMemPlugin({
            client: legacyClient,
            directory: ctx.location.directory,
            worktree: ctx.location.project.directory,
            project: ctx.location.project,
            serverUrl: undefined,
        }));
        // The V1 initializer cannot discover a server URL from a native V2
        // context. Route internal structured-output calls through the adapter.
        const { setV2Client, setStructuredOutputRealSessionFallback, setStructuredOutputTimeoutConfig, } = await loadOpencodeProvider();
        setV2Client(legacyClient);
        // Same timeout wiring as the V1 init path (configureOpencodeHostTransport):
        // the bundled provider module must not import config.js itself.
        setStructuredOutputTimeoutConfig(CONFIG.opencodeTimeoutMs);
        setStructuredOutputRealSessionFallback(CONFIG.opencodeRealSessionFallback);
        return registerV2Adapter(ctx, legacy);
    },
};
export default OpenCodeMemPluginV2;

import type { Context } from "@opencode/plugin/promise/plugin";
import type { MemToastPayload } from "./toast-rpc.js";
export type ToastEmitter = {
    events: {
        emit: (name: "toast", data: MemToastPayload) => Promise<void>;
    };
};
/**
 * Adapts the released OpenCode v2 plugin context to the V1 client shape used
 * by the shared opencode-mem implementation.
 */
export declare function createLegacyClient(ctx: Context, toastRpc?: ToastEmitter): any;
export declare function legacyToolResult(value: unknown): {
    content: string;
    metadata?: unknown;
};
export declare function toLegacyEvent(raw: any): {
    type: string;
    properties: any;
};
export declare function eventBelongsToLocation(ctx: Context, raw: any): Promise<boolean>;
//# sourceMappingURL=legacy-client.d.ts.map
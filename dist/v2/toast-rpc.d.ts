/**
 * Shared server↔TUI contract for toast intents.
 * Server plugins have no ui.toast; they emit via rpc.register events,
 * and the ./tui companion renders with ctx.ui.toast.show.
 */
export declare const MemToast: {
    readonly id: "opencode-mem";
    readonly methods: {};
    readonly events: {
        readonly toast: {
            readonly schema: {
                readonly type: "object";
                readonly properties: {
                    readonly title: {
                        readonly type: "string";
                    };
                    readonly message: {
                        readonly type: "string";
                    };
                    readonly variant: {
                        readonly type: "string";
                    };
                    readonly duration: {
                        readonly type: "number";
                    };
                    readonly sessionID: {
                        readonly type: "string";
                    };
                };
                readonly required: readonly ["message"];
                readonly additionalProperties: false;
            };
        };
    };
};
export type MemToastPayload = {
    readonly message: string;
    readonly title?: string;
    readonly variant?: "info" | "success" | "warning" | "error";
    readonly duration?: number;
    readonly sessionID?: string;
};
//# sourceMappingURL=toast-rpc.d.ts.map
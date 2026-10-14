import type { PluginInput } from "@opencode-ai/plugin";
type UpdateResult = {
    updated: true;
    name: string;
    current: string;
    latest: string;
} | {
    updated: false;
    error: "remove_failed";
    name: string;
    current: string;
    latest: string;
} | {
    updated: false;
};
export declare function startAutoUpdate(ctx: PluginInput, enabled: boolean): void;
export type AutoUpdateDeps = {
    findPackageDir?: (name: string) => Promise<string | undefined>;
    fetchLatestVersion?: (name: string, signal: AbortSignal) => Promise<string | undefined>;
    updateRemoveDir?: (packageDir: string, name: string) => Promise<string | undefined>;
    removeDir?: (path: string) => Promise<void>;
};
export declare function checkAutoUpdate(signal: AbortSignal, deps?: AutoUpdateDeps): Promise<UpdateResult>;
export declare function updateRemoveDir(packageDir: string, name: string): Promise<string | undefined>;
export declare function isAutoUpdatableSpec(spec: string): boolean;
export declare function isVersionNewer(latest: string, current: string): boolean;
export {};
//# sourceMappingURL=auto-update.d.ts.map
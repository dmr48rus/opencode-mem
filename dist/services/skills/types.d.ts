export interface SkillRecord {
    id: string;
    name: string;
    description: string;
    content: string;
    autoinvoke: boolean;
    enabled: boolean;
    containerTag: string | null;
    createdAt: number;
    updatedAt: number;
}
export interface SkillInput {
    id: string;
    name: string;
    description?: string;
    content: string;
    autoinvoke?: boolean;
    enabled?: boolean;
    containerTag?: string | null;
}
export interface SkillUpdate {
    name?: string;
    description?: string;
    content?: string;
    autoinvoke?: boolean;
    enabled?: boolean;
    containerTag?: string | null;
}
/** OpenCode-compatible skill id: lowercase kebab-case, 1–64 chars. */
export declare const SKILL_ID_PATTERN: RegExp;
export declare function isValidSkillId(id: string): boolean;
//# sourceMappingURL=types.d.ts.map
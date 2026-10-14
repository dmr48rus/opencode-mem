import { type SkillInput, type SkillRecord, type SkillUpdate } from "./types.js";
type SkillChangeListener = () => void;
export declare function onSkillsChanged(listener: SkillChangeListener): () => void;
export declare class SkillsManager {
    private db;
    private dbPath;
    private initPromise;
    constructor();
    reset(): void;
    private initialize;
    private initDatabase;
    private getDb;
    /** Absolute SKILL.md path for OpenCode Skill.Info.path */
    skillPath(id: string): string;
    /** OpenCode-compatible SKILL.md (frontmatter + body). */
    formatMarkdown(skill: SkillRecord): string;
    private writeSkillFile;
    private removeSkillFile;
    list(options?: {
        containerTag?: string | null;
        enabledOnly?: boolean;
    }): Promise<SkillRecord[]>;
    get(id: string): Promise<SkillRecord | null>;
    create(input: SkillInput): Promise<SkillRecord>;
    update(id: string, update: SkillUpdate): Promise<SkillRecord>;
    delete(id: string): Promise<boolean>;
    /** Catalog payload for OpenCode HTTP skills sources (`skills: ["http://host/skills/"]`). */
    toHttpCatalog(): Promise<{
        skills: Array<{
            name: string;
            version: string;
            files: string[];
        }>;
    }>;
    toCatalogMarkdown(id: string): Promise<string | null>;
}
export declare const skillsManager: SkillsManager;
export {};
//# sourceMappingURL=skills-manager.d.ts.map
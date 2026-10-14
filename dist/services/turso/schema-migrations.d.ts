import type { TursoDb } from "./turso-db.js";
export type SchemaMigration = {
    version: number;
    description: string;
    statements: Array<{
        sql: string;
        args?: Array<string | number | null>;
    }>;
};
export declare function applySchemaMigrations(db: TursoDb, migrations: SchemaMigration[], options?: {
    dbPath?: string;
    label?: string;
}): Promise<number>;
/** Memory shard schema without DiskANN indexes (exact cosine search). */
export declare function memoryShardMigrations(dimensions: number): SchemaMigration[];
export declare const METADATA_DB_MIGRATIONS: SchemaMigration[];
export declare const USER_PROMPTS_MIGRATIONS: SchemaMigration[];
export declare const USER_PROFILES_MIGRATIONS: SchemaMigration[];
export declare const SKILLS_MIGRATIONS: SchemaMigration[];
export declare const AI_SESSIONS_MIGRATIONS: SchemaMigration[];
/** After CREATE IF NOT EXISTS on older prompt DBs, ensure new columns exist. */
export declare function ensureUserPromptColumns(db: TursoDb): Promise<void>;
export declare function migrationMarkerPath(storagePath: string): string;
//# sourceMappingURL=schema-migrations.d.ts.map
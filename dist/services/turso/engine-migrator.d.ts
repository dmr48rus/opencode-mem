/**
 * Convert any local shards that still use libSQL DiskANN indexes into plain
 * @tursodatabase/database files (F32_BLOB + exact cosine search).
 */
export declare function runTursoEngineMigration(): Promise<void>;
//# sourceMappingURL=engine-migrator.d.ts.map
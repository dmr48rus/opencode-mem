import type { Database } from "@tursodatabase/database";
export type SqlValue = null | string | number | bigint | boolean | Uint8Array | ArrayBuffer;
export type SqlArgs = SqlValue[] | Record<string, SqlValue>;
export interface ResultSet {
    columns: string[];
    columnTypes: string[];
    rows: Array<Record<string, unknown>>;
    rowsAffected: number;
    lastInsertRowid?: number | bigint;
}
type Row = Record<string, unknown>;
/** Minimal transaction handle used by vector insert / API update paths. */
export interface TursoTx {
    execute(statement: {
        sql: string;
        args?: SqlArgs;
    } | string, args?: SqlArgs): Promise<ResultSet>;
    run(sql: string, args?: SqlArgs): Promise<number>;
    get<T extends Row = Row>(sql: string, args?: SqlArgs): Promise<T | null>;
    all<T extends Row = Row>(sql: string, args?: SqlArgs): Promise<T[]>;
}
export declare class TursoDb {
    private readonly database;
    constructor(database: Database);
    getClient(): Database;
    execute(sql: string, args?: SqlArgs): Promise<ResultSet>;
    batch(statements: Array<{
        sql: string;
        args?: SqlArgs;
    }>, mode?: "write" | "read"): Promise<ResultSet[]>;
    get<T extends Row = Row>(sql: string, args?: SqlArgs): Promise<T | null>;
    all<T extends Row = Row>(sql: string, args?: SqlArgs): Promise<T[]>;
    run(sql: string, args?: SqlArgs): Promise<number>;
    transaction<T>(mode: "write" | "read", fn: (tx: TursoTx) => Promise<T>): Promise<T>;
    close(): Promise<void>;
}
export {};
//# sourceMappingURL=turso-db.d.ts.map
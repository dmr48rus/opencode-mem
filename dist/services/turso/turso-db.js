function isReadQuery(sql) {
    return /^\s*(SELECT|WITH)\b/i.test(sql) || /^\s*PRAGMA\s+[^=;]+$/i.test(sql.trim());
}
function normalizeArgs(args) {
    if (!args)
        return [];
    return args;
}
function toResultSet(result) {
    return {
        columns: result.columns ?? [],
        columnTypes: result.columnTypes ?? [],
        rows: (result.rows ?? []),
        rowsAffected: Number(result.rowsAffected ?? 0),
        lastInsertRowid: result.lastInsertRowid,
    };
}
function statementToResultSet(rows, rowsAffected = 0, lastInsertRowid) {
    const columns = rows[0] ? Object.keys(rows[0]) : [];
    return {
        columns,
        columnTypes: columns.map(() => ""),
        rows,
        rowsAffected,
        lastInsertRowid,
    };
}
class TursoTxAdapter {
    runSql;
    getSql;
    allSql;
    constructor(runSql, getSql, allSql) {
        this.runSql = runSql;
        this.getSql = getSql;
        this.allSql = allSql;
    }
    async execute(statement, args) {
        const sql = typeof statement === "string" ? statement : statement.sql;
        const bind = typeof statement === "string" ? args : statement.args;
        const normalized = normalizeArgs(bind);
        const isSelect = isReadQuery(sql);
        if (isSelect) {
            const rows = await this.allSql(sql, normalized);
            return statementToResultSet(rows);
        }
        const info = Array.isArray(normalized)
            ? await this.runSql(sql, normalized)
            : await this.runSql(sql, normalized);
        return statementToResultSet([], Number(info.changes ?? 0), info.lastInsertRowid);
    }
    async run(sql, args) {
        const info = await this.runSql(sql, normalizeArgs(args));
        return Number(info.changes ?? 0);
    }
    async get(sql, args) {
        const row = await this.getSql(sql, normalizeArgs(args));
        return row ?? null;
    }
    async all(sql, args) {
        return (await this.allSql(sql, normalizeArgs(args)));
    }
}
function bindArgs(args) {
    const normalized = normalizeArgs(args);
    if (Array.isArray(normalized))
        return normalized;
    return [normalized];
}
export class TursoDb {
    database;
    constructor(database) {
        this.database = database;
    }
    getClient() {
        return this.database;
    }
    async execute(sql, args) {
        const normalized = normalizeArgs(args);
        if (isReadQuery(sql)) {
            const rows = Array.isArray(normalized)
                ? (await this.database.all(sql, ...normalized))
                : (await this.database.all(sql, normalized));
            return statementToResultSet(rows);
        }
        const info = Array.isArray(normalized)
            ? await this.database.run(sql, ...normalized)
            : await this.database.run(sql, normalized);
        return statementToResultSet([], Number(info.changes ?? 0), info.lastInsertRowid);
    }
    async batch(statements, mode = "write") {
        const batchMode = mode === "read" ? "deferred" : "immediate";
        const results = await this.database.batch(statements.map((statement) => ({
            sql: statement.sql,
            args: normalizeArgs(statement.args),
        })), batchMode);
        return results.map(toResultSet);
    }
    async get(sql, args) {
        const normalized = normalizeArgs(args);
        const row = Array.isArray(normalized)
            ? await this.database.get(sql, ...normalized)
            : await this.database.get(sql, normalized);
        return row ?? null;
    }
    async all(sql, args) {
        const normalized = normalizeArgs(args);
        const rows = Array.isArray(normalized)
            ? await this.database.all(sql, ...normalized)
            : await this.database.all(sql, normalized);
        return rows;
    }
    async run(sql, args) {
        const normalized = normalizeArgs(args);
        const info = Array.isArray(normalized)
            ? await this.database.run(sql, ...normalized)
            : await this.database.run(sql, normalized);
        return Number(info.changes ?? 0);
    }
    async transaction(mode, fn) {
        const txnMode = mode === "read" ? "deferred" : "immediate";
        const wrapped = this.database.transactionAsync(async (nativeTx) => {
            const adapter = new TursoTxAdapter(async (sql, args) => {
                const bind = bindArgs(args);
                if (Array.isArray(bind) && bind.length === 1 && !Array.isArray(args) && args) {
                    return nativeTx.run(sql, bind[0]);
                }
                return nativeTx.run(sql, ...bind);
            }, async (sql, args) => {
                const bind = bindArgs(args);
                if (Array.isArray(bind) && bind.length === 1 && !Array.isArray(args) && args) {
                    return nativeTx.get(sql, bind[0]);
                }
                return nativeTx.get(sql, ...bind);
            }, async (sql, args) => {
                const bind = bindArgs(args);
                if (Array.isArray(bind) && bind.length === 1 && !Array.isArray(args) && args) {
                    return nativeTx.all(sql, bind[0]);
                }
                return nativeTx.all(sql, ...bind);
            });
            return fn(adapter);
        });
        return wrapped[txnMode]();
    }
    async close() {
        await this.database.close();
    }
}

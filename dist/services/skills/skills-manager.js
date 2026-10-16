import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tursoConnectionManager } from "../turso/connection-manager.js";
import { CONFIG } from "../../config.js";
import { log } from "../logger.js";
import { isValidSkillId } from "./types.js";
import { getRemoteStore, } from "../turso/remote-storage.js";
const SKILLS_DB_NAME = "skills.db";
const skillChangeListeners = new Set();
export function onSkillsChanged(listener) {
    skillChangeListeners.add(listener);
    return () => skillChangeListeners.delete(listener);
}
function notifySkillsChanged() {
    for (const listener of skillChangeListeners) {
        try {
            listener();
        }
        catch (error) {
            log("skills change listener failed", { error: String(error) });
        }
    }
}
function rowToSkill(row) {
    return {
        id: String(row.id),
        name: String(row.name),
        description: String(row.description ?? ""),
        content: String(row.content ?? ""),
        autoinvoke: Number(row.autoinvoke ?? 1) === 1,
        enabled: Number(row.enabled ?? 1) === 1,
        containerTag: row.container_tag == null ? null : String(row.container_tag),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
    };
}
/**
 * The server sends ISO timestamps where the local row has epoch numbers. A
 * missing or unparseable date becomes 0 rather than NaN: every caller treats
 * updatedAt as an ordering key, and NaN makes an ORDER BY non-deterministic
 * without any error to notice.
 */
function remoteToSkill(remote) {
    const epoch = (value) => {
        const parsed = value ? Date.parse(value) : NaN;
        return Number.isFinite(parsed) ? parsed : 0;
    };
    return {
        id: remote.id,
        name: remote.name,
        description: remote.description ?? "",
        content: remote.content ?? "",
        autoinvoke: remote.autoinvoke !== false,
        enabled: remote.enabled !== false,
        containerTag: remote.containerTag ?? null,
        createdAt: epoch(remote.createdAt),
        updatedAt: epoch(remote.updatedAt),
    };
}
export class SkillsManager {
    db = null;
    dbPath;
    initPromise = null;
    constructor() {
        this.dbPath = join(CONFIG.storagePath || "", SKILLS_DB_NAME);
    }
    reset() {
        this.db = null;
        this.initPromise = null;
        this.dbPath = join(CONFIG.storagePath || "", SKILLS_DB_NAME);
    }
    async initialize() {
        if (this.initPromise)
            return this.initPromise;
        this.initPromise = this.initDatabase();
        return this.initPromise;
    }
    async initDatabase() {
        this.dbPath = join(CONFIG.storagePath || "", SKILLS_DB_NAME);
        const db = await tursoConnectionManager.getConnection(this.dbPath);
        const { applySchemaMigrations, SKILLS_MIGRATIONS } = await import("../turso/schema-migrations.js");
        await applySchemaMigrations(db, SKILLS_MIGRATIONS, {
            dbPath: this.dbPath,
            label: "skills",
        });
        this.db = db;
    }
    async getDb() {
        await this.initialize();
        // Connection manager is authoritative: boot migrators may close/replace
        // skills.db underneath a cached TursoDb handle (encryption/engine rewrite).
        if (this.db) {
            const current = await tursoConnectionManager.getConnection(this.dbPath);
            if (current === this.db) {
                return this.db;
            }
            this.reset();
            await this.initialize();
        }
        if (!this.db)
            throw new Error("Skills database not initialized");
        return this.db;
    }
    /** Absolute SKILL.md path for OpenCode Skill.Info.path */
    skillPath(id) {
        return join(this.dbPath.replace(/skills\.db$/, "skills-content"), id, "SKILL.md");
    }
    /** OpenCode-compatible SKILL.md (frontmatter + body). */
    formatMarkdown(skill) {
        return [
            "---",
            `name: ${JSON.stringify(skill.name)}`,
            `description: ${JSON.stringify(skill.description)}`,
            "metadata:",
            `  opencode/autoinvoke: ${skill.autoinvoke ? '"true"' : '"false"'}`,
            "---",
            "",
            skill.content,
        ].join("\n");
    }
    async writeSkillFile(skill) {
        const filePath = this.skillPath(skill.id);
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, this.formatMarkdown(skill), "utf8");
    }
    async removeSkillFile(id) {
        const dir = dirname(this.skillPath(id));
        await rm(dir, { recursive: true, force: true });
    }
    async list(options) {
        const remote = getRemoteStore();
        if (remote) {
            // Visibility is no longer per project. container_tag stays in the schema
            // and is still written, but it is not a filter here: the shared store is
            // global, exactly like remote memory, and a skill that is in it is in it
            // for every project. Passing tag= would hide global rows from a client
            // that has no project tag of its own.
            const items = await remote.listSkills({ enabledOnly: options?.enabledOnly });
            return items.map(remoteToSkill);
        }
        const db = await this.getDb();
        const clauses = [];
        const args = [];
        if (options?.enabledOnly) {
            clauses.push(`enabled = 1`);
        }
        if (options?.containerTag !== undefined) {
            if (options.containerTag === null) {
                clauses.push(`container_tag IS NULL`);
            }
            else {
                clauses.push(`(container_tag IS NULL OR container_tag = ?)`);
                args.push(options.containerTag);
            }
        }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        const rows = await db.all(`SELECT * FROM skills ${where} ORDER BY updated_at DESC, id ASC`, args);
        return rows.map(rowToSkill);
    }
    async get(id) {
        const remote = getRemoteStore();
        if (remote) {
            const found = await remote.getSkill(id);
            return found ? remoteToSkill(found) : null;
        }
        const db = await this.getDb();
        const row = await db.get(`SELECT * FROM skills WHERE id = ?`, [id]);
        return row ? rowToSkill(row) : null;
    }
    async create(input) {
        const id = input.id.trim();
        if (!isValidSkillId(id)) {
            throw new Error("Invalid skill id: use lowercase kebab-case (a-z, 0-9, single hyphens), 1–64 characters");
        }
        const name = input.name.trim();
        if (!name)
            throw new Error("Skill name is required");
        const content = input.content;
        if (typeof content !== "string" || !content.trim()) {
            throw new Error("Skill content is required");
        }
        const existing = await this.get(id);
        if (existing)
            throw new Error(`Skill already exists: ${id}`);
        // The row lives on the server, but the SKILL.md is written here on both
        // paths: Skill.Info requires an absolute path even when the content travels
        // inline, and that path has to exist. It is a derived copy of the server's
        // row, never a second source of truth.
        const remote = getRemoteStore();
        if (remote) {
            const payload = {
                id,
                name,
                description: (input.description ?? "").trim(),
                content,
                autoinvoke: input.autoinvoke !== false,
                enabled: input.enabled !== false,
            };
            const created = remoteToSkill(await remote.createSkill(payload));
            if (created.enabled)
                await this.writeSkillFile(created);
            notifySkillsChanged();
            return created;
        }
        const now = Date.now();
        const db = await this.getDb();
        await db.run(`INSERT INTO skills (
        id, name, description, content, autoinvoke, enabled, container_tag, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            id,
            name,
            (input.description ?? "").trim(),
            content,
            input.autoinvoke === false ? 0 : 1,
            input.enabled === false ? 0 : 1,
            input.containerTag ?? null,
            now,
            now,
        ]);
        const created = await this.get(id);
        if (!created)
            throw new Error("Failed to create skill");
        if (created.enabled)
            await this.writeSkillFile(created);
        notifySkillsChanged();
        return created;
    }
    async update(id, update) {
        const existing = await this.get(id);
        if (!existing)
            throw new Error(`Skill not found: ${id}`);
        const name = update.name !== undefined ? update.name.trim() : existing.name;
        if (!name)
            throw new Error("Skill name is required");
        const content = update.content !== undefined ? update.content : existing.content;
        if (typeof content !== "string" || !content.trim()) {
            throw new Error("Skill content is required");
        }
        const description = update.description !== undefined ? update.description.trim() : existing.description;
        const autoinvoke = update.autoinvoke !== undefined ? update.autoinvoke : existing.autoinvoke;
        const enabled = update.enabled !== undefined ? update.enabled : existing.enabled;
        const containerTag = update.containerTag !== undefined ? update.containerTag : existing.containerTag;
        const now = Date.now();
        const remote = getRemoteStore();
        if (remote) {
            const patch = { name, description, content, autoinvoke, enabled };
            const updated = remoteToSkill(await remote.updateSkill(id, patch));
            if (updated.enabled) {
                await this.writeSkillFile(updated);
            }
            else {
                await this.removeSkillFile(id);
            }
            notifySkillsChanged();
            return updated;
        }
        const db = await this.getDb();
        await db.run(`UPDATE skills SET
        name = ?, description = ?, content = ?, autoinvoke = ?, enabled = ?,
        container_tag = ?, updated_at = ?
      WHERE id = ?`, [name, description, content, autoinvoke ? 1 : 0, enabled ? 1 : 0, containerTag, now, id]);
        const updated = await this.get(id);
        if (!updated)
            throw new Error("Failed to update skill");
        if (updated.enabled) {
            await this.writeSkillFile(updated);
        }
        else {
            await this.removeSkillFile(id);
        }
        notifySkillsChanged();
        return updated;
    }
    async delete(id) {
        const existing = await this.get(id);
        if (!existing)
            return false;
        const remote = getRemoteStore();
        if (remote) {
            await remote.deleteSkill(id);
            await this.removeSkillFile(id);
            notifySkillsChanged();
            return true;
        }
        const db = await this.getDb();
        await db.run(`DELETE FROM skills WHERE id = ?`, [id]);
        await this.removeSkillFile(id);
        notifySkillsChanged();
        return true;
    }
    /** Catalog payload for OpenCode HTTP skills sources (`skills: ["http://host/skills/"]`). */
    async toHttpCatalog() {
        const enabled = await this.list({ enabledOnly: true });
        return {
            skills: enabled.map((skill) => ({
                name: skill.id,
                version: String(skill.updatedAt),
                // OpenCode fetches `{base}/{name}/{file}` — named .md form → skill id = name.
                files: [`${skill.id}.md`],
            })),
        };
    }
    async toCatalogMarkdown(id) {
        const skill = await this.get(id);
        if (!skill || !skill.enabled)
            return null;
        return this.formatMarkdown(skill);
    }
}
export const skillsManager = new SkillsManager();

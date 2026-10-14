import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tursoConnectionManager } from "../turso/connection-manager.js";
import { CONFIG } from "../../config.js";
import { log } from "../logger.js";
import { isValidSkillId } from "./types.js";
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

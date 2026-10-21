// Export memories from a backup tree into the fork's portability document.
//
// Why not the plugin's own `memory export`: it only reads the shards of ONE
// project scope, computed from the current directory (memory-portability-service.js:73-75).
// A backup holds a dozen project scopes, so each shard becomes its own document.
//
// Why @libsql/client and not @tursodatabase/database: the db_v1 shards carry
// `CREATE INDEX ... libsql_vector_idx(...)`, and the vendored 0.8.2 (and 0.8.3)
// do not register that function, so every open fails at schema parse. libsql's
// own engine does register it. Read-only tool, runs outside the build.
//
// Embeddings are deliberately dropped: importMemories re-embeds on the server
// (:234), so carrying the vectors would only bloat the files.
//
// usage: node export-memory.mjs <backupDir> <outDir>
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { createClient } from "file:///X:/ai/hermes/app/data/cache/scratch/opencode/libsql-client/node_modules/@libsql/client/lib-esm/node.js";
import {
  PORTABILITY_SCHEMA_VERSION,
  MemoryExportDocumentSchema,
} from "file:///X:/ai/hermes/backend/vendor/opencode-mem/dist/shared/api/portability-schemas.js";
import { extractScopeFromContainerTag } from "file:///X:/ai/hermes/backend/vendor/opencode-mem/dist/services/memory-scope.js";
import {
  stripPrivateContent,
  isFullyPrivate,
} from "file:///X:/ai/hermes/backend/vendor/opencode-mem/dist/services/privacy.js";

const [, , srcDir, outDir] = process.argv;
mkdirSync(outDir, { recursive: true });

const parseJson = (v) => {
  if (!v || typeof v !== "string") return undefined;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
};
// Mirrors rowToExportedMemory (memory-portability-service.js:47-67).
const toMemory = (r) => {
  const content = stripPrivateContent(String(r.content ?? ""));
  if (!content.trim() || isFullyPrivate(String(r.content ?? ""))) return null;
  return {
    id: String(r.id),
    content,
    type: r.type ? String(r.type) : undefined,
    tags:
      typeof r.tags === "string" && r.tags.trim()
        ? r.tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at ?? r.created_at),
    isPinned: Number(r.is_pinned ?? 0) === 1,
    metadata: parseJson(r.metadata),
    displayName: r.display_name ? String(r.display_name) : undefined,
    userName: r.user_name ? String(r.user_name) : undefined,
    userEmail: r.user_email ? String(r.user_email) : undefined,
    projectPath: r.project_path ? String(r.project_path) : undefined,
    projectName: r.project_name ? String(r.project_name) : undefined,
    gitRepoUrl: r.git_repo_url ? String(r.git_repo_url) : undefined,
  };
};

const bad = [];
let grand = 0;
let dropped = 0;
for (const file of readdirSync(srcDir).filter((f) => f.endsWith(".db"))) {
  const path = join(srcDir, file);
  const hash = basename(file)
    .replace(/^project_/, "")
    .replace(/_shard_\d+\.db$/, "");
  const c = createClient({ url: `file:${path}` });
  let rows;
  try {
    rows = (await c.execute("SELECT * FROM memories")).rows;
  } catch (e) {
    console.error(`  FAIL ${file}: ${String(e.message).slice(0, 100)}`);
    c.close();
    continue;
  }
  const memories = rows.map(toMemory).filter(Boolean);
  dropped += rows.length - memories.length;
  if (memories.length === 0) {
    c.close();
    continue;
  }

  // The shard filename IS the scope hash the rows were stored under; prefer the
  // row's own tag when present, since that is what the data was written with.
  // The two really do disagree: shard b22f8959f627e70c carries rows tagged
  // c6168187566451e8 (Translate-Pirate-Books), and the filename is not the truth.
  const tagFromRow = rows.find((r) => r.container_tag)?.container_tag;
  const containerTag = tagFromRow ?? `opencode_project_${hash}`;
  const { hash: scopeHash } = extractScopeFromContainerTag(containerTag);
  memories.sort((a, b) => b.createdAt - a.createdAt);
  const doc = {
    schemaVersion: PORTABILITY_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    plugin: { package: "opencode-mem", version: "2.31.0-patched" },
    source: {
      containerTag,
      scope: "project",
      scopeHash,
      projectPath: memories.find((m) => m.projectPath)?.projectPath,
      projectName: memories.find((m) => m.projectName)?.projectName,
      gitRepoUrl: memories.find((m) => m.gitRepoUrl)?.gitRepoUrl,
    },
    embedding: { model: "Xenova/nomic-embed-text-v1", dimensions: 768 },
    memories,
  };
  const out = join(outDir, `${hash}.json`);
  writeFileSync(out, JSON.stringify(doc, null, 2), "utf-8");

  // Validate against the fork's own schema rather than trusting this mapping: a
  // document that only fails at import time is discovered on the server, where
  // the import is not idempotent and a partial run cannot be repeated.
  const check = MemoryExportDocumentSchema.safeParse(JSON.parse(readFileSync(out, "utf-8")));
  if (!check.success) {
    bad.push({
      hash,
      issues: check.error.issues.slice(0, 4).map((i) => `${i.path.join(".")}: ${i.message}`),
    });
  }
  grand += memories.length;
  console.log(
    `  ${String(memories.length).padStart(4)}  ${String(Math.round(statSync(out).size / 1024)).padStart(5)} KB  ${hash}  tag=${doc.source.containerTag}${check.success ? "" : "  SCHEMA FAIL"}`
  );
  c.close();
}
console.log(`\nexported ${grand} memories, dropped ${dropped} as private/empty, into ${outDir}`);
console.log(`schemaVersion=${PORTABILITY_SCHEMA_VERSION}`);
if (bad.length) {
  console.error(`\nSCHEMA FAILURES: ${bad.length}`);
  for (const b of bad) console.error(`  ${b.hash}: ${b.issues.join("; ")}`);
  process.exitCode = 1;
} else {
  console.log(`schema validation: all documents accepted by MemoryExportDocumentSchema`);
}

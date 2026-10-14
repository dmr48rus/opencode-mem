// Re-file memories onto the tags the client computes today.
//
// Lookup is by container tag, and the tag is hashed from the CURRENT directory
// (getProjectTagInfo, tags.js:221-238), so a project that moved no longer
// produces the hash its memories were filed under. The projectPath stored on a
// row is metadata and does not drive lookup.
//
// The mapping is read from scope-remap.json -- an explicit table, not name
// matching. Substring matching produced two wrong guesses out of eight, and a
// wrong guess scatters memories under a tag that nothing will ever query.
//
// Targets are given as paths and hashed here, with the fork's own function, so
// the tag is exactly what the client will compute for that directory -- not a
// tag invented by this tool.
//
// usage: node remap-scopes.mjs <inDir> <outDir> [scope-remap.json]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getProjectTagInfo } from "file:///X:/ai/hermes/backend/vendor/opencode-mem/dist/services/tags.js";
import { extractScopeFromContainerTag } from "file:///X:/ai/hermes/backend/vendor/opencode-mem/dist/services/memory-scope.js";
import { MemoryExportDocumentSchema } from "file:///X:/ai/hermes/backend/vendor/opencode-mem/dist/shared/api/portability-schemas.js";

const [, , inDir, outDir, mapPath = "scope-remap.json"] = process.argv;
mkdirSync(outDir, { recursive: true });
const spec = JSON.parse(readFileSync(mapPath, "utf-8"));

// Resolve every target to a tag with the fork's own hashing, once.
const resolved = [];
for (const m of spec.mappings) {
  const target = m.toPath.replace(/\//g, "\\"); // Windows separators, as a client uses
  if (!existsSync(target)) {
    console.error(`  SKIP ${m.from} -> ${m.toPath}: path does not exist`);
    continue;
  }
  const info = getProjectTagInfo(target);
  // Keep the fork's own path string, not the one from the mapping file: the
  // mapping is written with forward slashes, and the tag is a hash of the path
  // STRING. A slash style the client never produces would hash to something
  // else, and the mismatch would only surface as a NOTE on the server.
  resolved.push({ from: m.from, tag: info.tag, path: info.projectPath, why: m.why });
}
const byFrom = new Map(resolved.map((r) => [r.from, r]));

// Documents outside the mapping still need their tag recomputed: adding
// .opencode-mem-project changes the identity a git project hashes (tags.js:231),
// so a project that was untouched by the remapping now declares a stale tag.
const recomputed = new Map();
const resolveCurrent = (doc) => {
  const path = doc.source.projectPath;
  if (!path || !existsSync(path)) return null;
  const key = path.toLowerCase();
  if (!recomputed.has(key)) recomputed.set(key, getProjectTagInfo(path));
  return recomputed.get(key);
};

const docs = readdirSync(inDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(inDir, f), "utf-8")));

// Collect by target tag, keeping one document per tag.
const out = new Map();
const put = (tag, doc, memory, target) => {
  if (!out.has(tag)) {
    const { hash } = extractScopeFromContainerTag(tag);
    out.set(tag, {
      schemaVersion: doc.schemaVersion,
      exportedAt: new Date().toISOString(),
      plugin: doc.plugin,
      // projectPath is what the migrator HASHES to pick the storage tag
      // (migrate.mjs:79 -> importMemories currentDirectory), and the declared
      // containerTag is ignored. Leaving it stale makes the host recompute the
      // OLD tag: the dry run then reports "document declares X, host computes Y"
      // with Y the very hash this remap existed to replace. The whole remap is a
      // no-op unless this field moves with the rest.
      source: {
        ...doc.source,
        containerTag: tag,
        scopeHash: hash,
        projectPath: target.path,
        projectName: target.path.split(/[\\/]/).pop(),
      },
      embedding: doc.embedding,
      memories: [],
    });
  }
  out.get(tag).memories.push(memory);
};

let moved = 0;
let retagged = 0;
const perMapping = new Map();
for (const doc of docs) {
  const fromHash = extractScopeFromContainerTag(doc.source.containerTag).hash;
  const to = byFrom.get(fromHash);
  if (!to) {
    const now = resolveCurrent(doc);
    if (now && now.tag !== doc.source.containerTag) {
      retagged++;
      console.log(
        `  retag ${fromHash} -> ${now.tag.replace("opencode_project_", "")}  ${doc.source.projectPath}`
      );
    }
    const tag = now?.tag ?? doc.source.containerTag;
    const path = now?.projectPath ?? doc.source.projectPath;
    for (const m of doc.memories) put(tag, doc, m, { path });
    continue;
  }
  moved += doc.memories.length;
  perMapping.set(to.from, (perMapping.get(to.from) ?? 0) + doc.memories.length);
  for (const m of doc.memories) {
    // The stored path is metadata; leaving it stale would only mislead a human.
    put(to.tag, doc, { ...m, projectPath: to.path, projectName: to.path.split(/[\\/]/).pop() }, to);
  }
}

console.log(`resolved ${resolved.length}/${spec.mappings.length} mappings`);
for (const r of resolved) {
  console.log(
    `  ${r.from} -> ${r.tag.replace("opencode_project_", "")}  ${r.path}  (${perMapping.get(r.from) ?? 0} rows)  ${r.why}`
  );
}
console.log(`\nremapped ${moved} memories`);

const unmapped = Object.entries(spec.leftUnmapped ?? {});
if (unmapped.length) {
  console.log(`\nleft unmapped on purpose:`);
  for (const [hash, why] of unmapped) console.log(`  ${hash}  ${why}`);
}

let rows = 0;
const bad = [];
for (const [tag, doc] of out) {
  rows += doc.memories.length;
  const check = MemoryExportDocumentSchema.safeParse(doc);
  if (!check.success)
    bad.push(
      `${tag}: ${check.error.issues
        .slice(0, 2)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`
    );
  writeFileSync(
    join(outDir, `${tag.replace(/^opencode_project_/, "")}.json`),
    JSON.stringify(doc, null, 2),
    "utf-8"
  );
}
console.log(`\n${out.size} documents, ${rows} memories -> ${outDir}`);
if (bad.length) {
  console.error(`\nSCHEMA FAILURES: ${bad.length}`);
  for (const b of bad) console.error(`  ${b}`);
  process.exitCode = 1;
} else {
  console.log(`schema validation: all documents accepted`);
}

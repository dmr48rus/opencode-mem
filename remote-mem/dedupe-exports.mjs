// Deduplicate the exported memories before any import.
//
// The import is not idempotent (importMemories aborts on a repeated id), and
// the server computes vectors per row, so a duplicate is not harmless: it shows
// up twice in search results and doubles the embedding cost.
//
// Two passes, with very different risk:
//   1. same id            -- certainly the same record; merge and drop copies.
//   2. same normalised content WITHIN one project scope -- the same observation
//      captured twice into the same scope; merge and drop copies.
//   3. same content ACROSS project scopes -- NOT merged. Dropping the copy from
//      the other scope would hide it from that project's search, which is a data
//      loss decision, not a cleanup. Reported for a human instead.
//
// usage: node dedupe-exports.mjs <outDir> <inDir> [<inDir> ...]
//
// All inputs go in at once on purpose: the same project scope appears in more
// than one backup snapshot, and it is precisely ACROSS snapshots that the same
// memory turns up twice. Deduplicating each backup separately reports zero
// duplicates and still ships both copies.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { MemoryExportDocumentSchema } from "file:///X:/ai/hermes/backend/vendor/opencode-mem/dist/shared/api/portability-schemas.js";

const [, , outDir, ...inDirs] = process.argv;
mkdirSync(outDir, { recursive: true });

// Compare on words only: case, punctuation and spacing differences are noise,
// but the words carry the meaning, so "Commit." and "commit" are one memory.
const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

// The copy with the richest record wins, because that is the one whose metadata
// is worth keeping; ties go to the earlier record, which is the original.
const richness = (m) =>
  (m.projectPath ? 1 : 0) + (m.projectName ? 1 : 0) + (m.gitRepoUrl ? 1 : 0) + (m.isPinned ? 1 : 0);

// One document per container tag, memories concatenated across every input.
// The two backups are snapshots of the same machine, so a scope present in both
// is ONE scope with more rows, not two scopes.
//
// Group by containerTag, not by scopeHash: they are not always equal. Shard
// b22f8959f627e70c holds rows tagged opencode_project_c6168187566451e8, and
// grouping by the filename hash split one project into two documents that would
// then import into the same scope twice.
const scopes = new Map();
for (const dir of inDirs) {
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const doc = JSON.parse(readFileSync(join(dir, f), "utf-8"));
    const tag = doc.source.containerTag;
    if (!scopes.has(tag))
      scopes.set(tag, {
        file: `${tag.replace(/^opencode_project_/, "")}.json`,
        doc,
        memories: [],
        parts: [],
      });
    const t = scopes.get(tag);
    t.memories.push(...doc.memories);
    t.parts.push({ dir, file: f, count: doc.memories.length });
    // Keep the richest source metadata: the snapshot with more rows wins.
    if (doc.memories.length > (t.doc.memories?.length ?? 0)) t.doc = doc;
  }
}
const docs = [...scopes.values()].map((t) => ({
  file: t.file,
  doc: { ...t.doc, memories: t.memories },
  parts: t.parts,
}));

const overlapping = docs.filter((d) => d.parts.length > 1);
if (overlapping.length) {
  console.log(`scopes present in more than one backup: ${overlapping.length}`);
  for (const d of overlapping) {
    const detail = d.parts.map((p) => `${p.dir.split("\\").pop()}:${p.count}`).join(" + ");
    console.log(`  ${d.file.replace(".json", "")}  ${detail}`);
  }
}

let inCount = 0;
for (const d of docs) inCount += d.doc.memories.length;
console.log(`input: ${docs.length} documents, ${inCount} memories`);

const byId = new Map();
const contentByScope = new Map();
for (const d of docs) {
  for (const m of d.doc.memories) {
    const scope = d.doc.source.scopeHash;
    if (!byId.has(m.id)) byId.set(m.id, []);
    byId.get(m.id).push({ file: d.file, scope, m });
    const key = `${scope}||${norm(m.content)}`;
    if (!contentByScope.has(key)) contentByScope.set(key, []);
    contentByScope.get(key).push({ file: d.file, scope, m });
  }
}

const dropById = new Map(); // "file" -> Set(ids to remove)
const mergedInto = new Map(); // survivor id -> number of copies folded in
const markDrop = (file, id) => {
  if (!dropById.has(file)) dropById.set(file, new Set());
  dropById.get(file).add(id);
};

const sameIdGroups = [...byId.values()].filter((g) => g.length > 1);
for (const g of sameIdGroups) {
  g.sort((a, b) => richness(b.m) - richness(a.m) || a.m.createdAt - b.m.createdAt);
  const win = g[0];
  for (const l of g.slice(1)) {
    markDrop(l.file, l.m.id);
    mergedInto.set(win.m.id, (mergedInto.get(win.m.id) ?? 1) + 1);
    // Keep anything the survivor was missing rather than discarding it.
    for (const f of ["projectPath", "projectName", "gitRepoUrl", "displayName"]) {
      if (!win.m[f] && l.m[f]) win.m[f] = l.m[f];
    }
    if (l.m.isPinned) win.m.isPinned = true;
    if (l.m.tags) win.m.tags = [...new Set([...(win.m.tags ?? []), ...l.m.tags])];
  }
}

// Second pass, re-reading after id-level drops so a chain does not double count.
const byContent = new Map();
for (const d of docs) {
  const dropped = dropById.get(d.file) ?? new Set();
  for (const m of d.doc.memories) {
    if (dropped.has(m.id)) continue;
    const key = `${d.doc.source.scopeHash}||${norm(m.content)}`;
    if (!byContent.has(key)) byContent.set(key, []);
    byContent.get(key).push({ file: d.file, scope: d.doc.source.scopeHash, m });
  }
}
const sameContent = [...byContent.values()].filter((g) => g.length > 1);
for (const g of sameContent) {
  g.sort((a, b) => richness(b.m) - richness(a.m) || a.m.createdAt - b.m.createdAt);
  const win = g[0];
  for (const l of g.slice(1)) {
    markDrop(l.file, l.m.id);
    mergedInto.set(win.m.id, (mergedInto.get(win.m.id) ?? 1) + 1);
    win.m.isPinned = win.m.isPinned || l.m.isPinned;
    if (l.m.tags) win.m.tags = [...new Set([...(win.m.tags ?? []), ...l.m.tags])];
  }
}

// Same words, different project scope: reported, never merged.
const crossScope = new Map();
for (const d of docs) {
  const dropped = dropById.get(d.file) ?? new Set();
  for (const m of d.doc.memories) {
    if (dropped.has(m.id)) continue;
    const key = norm(m.content);
    if (!crossScope.has(key)) crossScope.set(key, new Map());
    const scopes = crossScope.get(key);
    if (!scopes.has(d.doc.source.scopeHash)) scopes.set(d.doc.source.scopeHash, 0);
    scopes.set(d.doc.source.scopeHash, scopes.get(d.doc.source.scopeHash) + 1);
  }
}
const cross = [...crossScope.entries()].filter(([, scopes]) => scopes.size > 1);

let outCount = 0;
let removed = 0;
const badDocs = [];
for (const d of docs) {
  const dropped = dropById.get(d.file) ?? new Set();
  removed += dropped.size;
  const kept = d.doc.memories.filter((m) => !dropped.has(m.id));
  outCount += kept.length;
  if (kept.length === 0) continue;
  const out = { ...d.doc, exportedAt: new Date().toISOString(), memories: kept };
  const check = MemoryExportDocumentSchema.safeParse(out);
  if (!check.success)
    badDocs.push({
      file: d.file,
      issues: check.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`),
    });
  writeFileSync(join(outDir, d.file), JSON.stringify(out, null, 2), "utf-8");
}

console.log(
  `\ndropped by identical id:      ${sameIdGroups.reduce((s, g) => s + g.length - 1, 0)} rows in ${sameIdGroups.length} groups`
);
console.log(
  `dropped by identical text:    ${sameContent.reduce((s, g) => s + g.length - 1, 0)} rows in ${sameContent.length} groups (same scope)`
);
console.log(`NOT merged, same text across scopes: ${cross.length} texts`);
console.log(
  `\n${inCount} -> ${outCount} memories in ${outCount > 0 ? readdirSync(outDir).filter((f) => f.endsWith(".json")).length : 0} documents`
);

if (cross.length) {
  console.log(
    `\n--- same text in more than one project scope (kept everywhere, needs a human call):`
  );
  for (const [text, scopes] of cross.slice(0, 12)) {
    const list = [...scopes.entries()].map(([s, n]) => `${s.slice(0, 8)}x${n}`).join(" ");
    console.log(`  ${list}  ${text.slice(0, 64)}`);
  }
  if (cross.length > 12) console.log(`  ... and ${cross.length - 12} more`);
}

if (badDocs.length) {
  console.error(`\nSCHEMA FAILURES: ${badDocs.length}`);
  for (const b of badDocs) console.error(`  ${b.file}: ${b.issues.join("; ")}`);
  process.exitCode = 1;
} else {
  console.log(`\nschema validation: all output documents accepted`);
}

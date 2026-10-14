// Clean frozen profile items: an item holding 10 evidence entries can never
// accept another one, because the union in user-profile-manager.js:823-828 is
// sliced to 10 with the existing entries first. Junk at the head is therefore
// permanent, not cosmetic -- this reopens the item.
//
// What is deliberately NOT touched:
//   - items below the 10 cap, because they still have room for real evidence;
//   - items at 10 where nothing looks like junk, because a rich item is not a
//     blocked one and slicing it would throw away real observations.
//
// Evidence never reaches the prompt or the model (buildCategorySummary renders
// category+description only), so nothing here is about looks -- the only rules
// remove things that are plainly not evidence of a durable preference.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

const OUT_DIR = process.argv[2];
const SOURCES = process.argv.slice(3);
const KEEP_CAP = 10;

const cut = (s, n = 72) => String(s).replace(/\s+/g, " ").slice(0, n);
const words = (s) =>
  String(s)
    .toLowerCase()
    .split(/[^a-zа-яё0-9]+/i)
    .filter(Boolean);

function whyJunk(text, descWords, seen) {
  const t = text.trim();
  const w = words(t);
  if (t.length < 12) return "bare token";
  if (/^[\w./\\-]+\.(json|py|js|ts|tsx|md|csv|xlsx|txt|bat|ps1|yml|yaml|ini)$/i.test(t))
    return "bare filename";
  if (/\b(holidays|app|core|data|main|config|index)\.\w+\b/i.test(t) && w.length <= 4)
    return "file name in passing";
  if (/^(you are|you have|your task|implement|write a|create a|the user wants)\b/i.test(t))
    return "prompt fragment";
  if (/(already installed|are installed|уже установлен)/i.test(t)) return "environment note";
  if (t.endsWith("?") && w.length <= 12) return "one-off question";
  const key = w.sort().join(" ");
  if (seen.has(key)) return "duplicate";
  seen.add(key);
  if (descWords.size) {
    const overlap = w.filter((x) => descWords.has(x)).length / Math.max(1, w.length);
    if (overlap >= 0.8) return "restates the description";
  }
  return null;
}

mkdirSync(OUT_DIR, { recursive: true });
let touched = 0;
let removedTotal = 0;
let frozenSeen = 0;

for (const src of SOURCES) {
  const doc = JSON.parse(readFileSync(src, "utf-8"));
  const report = [];

  for (const kind of ["preferences", "patterns", "workflows"]) {
    for (const item of doc.profileData?.[kind] ?? []) {
      const ev = Array.isArray(item.evidence) ? item.evidence : [];
      if (ev.length < KEEP_CAP) continue;
      frozenSeen++;
      const descWords = new Set(words(item.description ?? ""));
      const seen = new Set();
      const junk = [];
      const keep = [];
      for (const e of ev) {
        const why = whyJunk(e, descWords, seen);
        if (why) junk.push([why, e]);
        else keep.push(e);
      }
      // A full item of real observations is not blocked; leave it be.
      if (junk.length === 0 || keep.length >= KEEP_CAP) {
        report.push(
          `  ${kind}/${item.category}: left alone (${ev.length} entries, ${junk.length} junk, ${keep.length} real)`
        );
        continue;
      }
      item.evidence = keep;
      touched++;
      removedTotal += junk.length;
      report.push(`  ${kind}/${item.category}: ${ev.length} -> ${keep.length}`);
      for (const [why, e] of junk) report.push(`      - (${why}) ${cut(e)}`);
    }
  }

  writeFileSync(join(OUT_DIR, basename(src)), JSON.stringify(doc, null, 2) + "\n", "utf-8");
  console.log(`\n=== ${basename(src)}`);
  if (report.length === 0) console.log("  nothing at the cap");
  for (const line of report) console.log(line);
}

console.log(
  `\nfrozen items seen: ${frozenSeen}   cleaned: ${touched}   lines removed: ${removedTotal}`
);

// Verify what we just wrote, from disk, rather than trusting the loop above.
let below = 0;
let noVectors = 0;
let items = 0;
for (const file of readdirSync(OUT_DIR).filter((f) => f.endsWith(".json"))) {
  const doc = JSON.parse(readFileSync(join(OUT_DIR, file), "utf-8"));
  for (const kind of ["preferences", "patterns", "workflows"]) {
    for (const item of doc.profileData?.[kind] ?? []) {
      items++;
      const has = Object.prototype.hasOwnProperty.call(item, "evidence");
      const n = has && Array.isArray(item.evidence) ? item.evidence.length : 0;
      if (n < 3) {
        below++;
        console.log(
          `  BELOW FLOOR: ${file} ${kind}/${item.category} evidence=${has ? n : "ABSENT"}`
        );
      }
      if (!item.centroid || !item.anchor) noVectors++;
    }
  }
}
console.log(`verify: items=${items} below floor=${below} missing vectors=${noVectors}`);
process.exitCode = below > 0 || noVectors > 0 ? 1 : 0;

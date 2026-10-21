// One-off: review a hand-edited profile export against its original.
//
// The edits are made by hand in an editor, so the questions are mechanical:
// which items vanished, which evidence lines were cut, and whether what is left
// still passes the retention floor (user-profile-manager.js:495-507 needs >= 3
// per item) and the validator's non-empty requirement
// (user-profile-validator.js:62-66). It also checks that nothing structural was
// disturbed -- centroid/anchor embeddings must survive, or the item loses its
// merge-by-similarity path.
import { readFileSync } from "node:fs";

const MIN = Number(process.env.MIN ?? 3);
const load = (p) => JSON.parse(readFileSync(p, "utf-8"));
const KINDS = ["preferences", "patterns", "workflows"];

const [before, after] = [load(process.argv[2]), load(process.argv[3])];
const cut = (s, n = 90) => (s == null ? "(null)" : String(s).replace(/\s+/g, " ").slice(0, n));

console.log("=== top level");
for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
  const b = JSON.stringify(before[k] ?? null);
  const a = JSON.stringify(after[k] ?? null);
  if (k === "profileData") continue;
  console.log(`  ${k}: ${b === a ? "same" : `CHANGED  ${cut(b, 60)}  ->  ${cut(a, 60)}`}`);
}
// Index items by kind + identity so a move cannot hide as a delete + add.
const index = (doc) => {
  const m = new Map();
  for (const kind of KINDS) {
    for (const item of doc.profileData?.[kind] ?? []) {
      m.set(`${kind}||${item.category}||${item.description}`, item);
    }
  }
  return m;
};
const B = index(before);
const A = index(after);

const removed = [...B.keys()].filter((k) => !A.has(k));
const added = [...A.keys()].filter((k) => !B.has(k));
const common = [...B.keys()].filter((k) => A.has(k));

console.log(
  `\n=== items: before=${B.size} after=${A.size}  (removed=${removed.length} added=${added.length})`
);
for (const k of removed) console.log(`  REMOVED  ${cut(k, 100)}`);
for (const k of added) console.log(`  ADDED    ${cut(k, 100)}`);

console.log(
  `\n=== changed items (${common.filter((k) => JSON.stringify(B.get(k)) !== JSON.stringify(A.get(k))).length} of ${common.length} common)`
);
let lines = 0;
let evBefore = 0;
let evAfter = 0;
const lost = [];
for (const k of common) {
  const b = B.get(k);
  const a = A.get(k);
  const be = Array.isArray(b.evidence) ? b.evidence : null;
  const ae = Array.isArray(a.evidence) ? a.evidence : null;
  evBefore += be?.length ?? 0;
  evAfter += ae?.length ?? 0;
  if (JSON.stringify(b) === JSON.stringify(a)) continue;
  // Which fields other than evidence moved? Those are the dangerous ones.
  const fields = [];
  for (const f of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (JSON.stringify(b[f] ?? null) !== JSON.stringify(a[f] ?? null)) fields.push(f);
  }
  const nonEvidence = fields.filter((f) => f !== "evidence");
  const kept = ae ? new Set(ae) : new Set();
  const beforeSet = new Set(be ?? []);
  const dropped = (be ?? []).filter((e) => !kept.has(e));
  // A same-size array with a dropped line means an entry was REWRITTEN, not
  // removed -- the kind of edit that hides inside a plain "deleted N lines" diff.
  const added = ae ? ae.filter((e) => !beforeSet.has(e)) : [];
  console.log(`\n  ${cut(k, 100)}`);
  console.log(
    `    evidence ${be === null ? "FIELD ABSENT" : be.length} -> ${ae === null ? "FIELD ABSENT" : ae.length}` +
      (nonEvidence.length ? `   !! ALSO CHANGED: ${nonEvidence.join(", ")}` : "")
  );
  for (const e of dropped) {
    if (lines++ < 40) console.log(`      - ${cut(e)}`);
  }
  if (dropped.length > 40) console.log(`      ... ${dropped.length - 40} more dropped`);
  for (const e of added) {
    if (lines++ < 40) console.log(`      + ${cut(e)}`);
  }
  if (added.length > 40) console.log(`      ... ${added.length - 40} more added`);
}
console.log(`\n=== evidence totals across all common items: ${evBefore} -> ${evAfter}`);

console.log(`\n=== floor check on the EDITED file (need >= ${MIN} per item)`);
let bad = 0;
for (const [k, a] of A) {
  const has = Object.prototype.hasOwnProperty.call(a, "evidence");
  const n = has && Array.isArray(a.evidence) ? a.evidence.length : 0;
  if (n >= MIN) continue;
  bad++;
  if (bad <= 25)
    console.log(
      `  ${has ? (n === 0 ? "EMPTY ARRAY" : `${n} entries`) : "FIELD ABSENT"}  ${cut(k, 90)}`
    );
}
if (bad > 25) console.log(`  ... and ${bad - 25} more`);
console.log(`  total below floor: ${bad} of ${A.size}`);

const noVectors = [...A].filter(([, a]) => !a.centroid || !a.anchor).length;
console.log(`\n=== embeddings: items missing centroid/anchor: ${noVectors} of ${A.size}`);

console.log(`\n=== what the EDITED file actually keeps`);
for (const [k, a] of A) {
  const ev = Array.isArray(a.evidence) ? a.evidence : [];
  console.log(`  ${cut(k, 84)}`);
  for (const e of ev) console.log(`      ${cut(e, 84)}`);
}

// The floor is the one rule that silently eats data on the next refresh, so it
// is the one worth failing on. Missing vectors is reported, not failed: the
// merge path falls back to exact matching.
process.exitCode = bad > 0 || noVectors > 0 ? 1 : 0;
console.log(
  `\nrc=${bad > 0 || noVectors > 0 ? 1 : 0}  (non-zero = below floor or missing vectors)`
);

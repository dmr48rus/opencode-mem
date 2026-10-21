// One-off: how close is each exported profile to the decay floor?
//
// The retention rule (user-profile-manager.js:495-507) drops an item when it has
// not been seen for more than CONFIG.userProfileStaleDays (2) AND fewer than
// CONFIG.userProfileMinEvidenceForRetention (3) evidence entries. Importing an
// old profile untouched means every item is already past the age test, so the
// evidence count alone decides what survives the first refresh.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const MIN_EVIDENCE = Number(process.env.MIN_EVIDENCE ?? 3);
const STALE_DAYS = Number(process.env.STALE_DAYS ?? 2);
const now = Date.now();

for (const file of readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "index.json")) {
  const doc = JSON.parse(readFileSync(join(dir, file), "utf-8"));
  const pd = doc.profileData ?? {};
  let total = 0;
  let atFloor = 0;
  let empty = 0;
  let missing = 0;
  const ageDays = Math.round((now - (doc.lastAnalyzedAt ?? doc.createdAt ?? now)) / 86400000);
  const detail = [];
  for (const kind of ["preferences", "patterns", "workflows"]) {
    for (const item of pd[kind] ?? []) {
      total++;
      // "no evidence field" and "evidence: []" are different states, and an
      // earlier version counted them as one. Items are routinely CREATED without
      // the field, which is exactly the question this tool answers: the gap is
      // how they were made, not what later happened to them.
      const has = Object.prototype.hasOwnProperty.call(item, "evidence");
      const n = has && Array.isArray(item.evidence) ? item.evidence.length : 0;
      if (!has) missing++;
      else if (n === 0) empty++;
      if (n < MIN_EVIDENCE) {
        atFloor++;
        detail.push(`      ${kind}/${item.category}: evidence=${has ? n : "FIELD MISSING"}`);
      }
    }
  }
  console.log(`${file}`);
  console.log(
    `  items=${total}  below floor=${atFloor}  evidence=[]:${empty}  field missing:${missing}  lastAnalyzed=${ageDays}d ago`
  );
  for (const d of detail.slice(0, 12)) console.log(d);
  if (detail.length > 12) console.log(`      ... and ${detail.length - 12} more`);
}

// Extract user profiles from an opencode-mem user-profiles.db.
//
// Two modes: no --out prints the schema and per-profile counts (shape only, no
// content); with --out it writes one JSON file per profile plus an index.
//
// Opened with the fork's own engine rather than a sqlite CLI: the file is
// Turso/encrypted-capable, and a different reader could disagree with the
// product about what it is looking at.
//
// Reads only. The WAL beside the db is picked up by the engine, so the export
// reflects the database as of this read, not just the checkpointed file -- the
// copy-by-hand path loses exactly the newest entries.
//
// Usage: node export-profile.mjs <user-profiles.db> [--out <dir>]
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dbPath = process.argv[2];
const outIdx = process.argv.indexOf("--out");
const outDir = outIdx >= 0 ? process.argv[outIdx + 1] : undefined;
if (!dbPath || !existsSync(dbPath)) {
  console.error("usage: node export-profile.mjs <user-profiles.db> [--out <dir>]");
  process.exit(2);
}

const fork = process.env.REMOTE_MEM_FORK ?? "X:/ai/hermes/backend/vendor/opencode-mem";
const forkRoot = `${fork.replace(/\\/g, "/")}/dist`;
const { connect } = createRequire(pathToFileURL(`${forkRoot}/index.js`).href)(
  "@tursodatabase/database"
);
// connect() is async (connection-manager.js:109 awaits it): taking the promise
// itself yields an object with no query methods, which surfaces as
// "db.all is not a function" and says nothing about the database.
const db = new (await import(pathToFileURL(`${forkRoot}/services/turso/turso-db.js`).href)).TursoDb(
  await connect(dbPath)
);

const tables = (
  await db.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
).map((t) => t.name);
console.log(`db: ${dbPath}`);
console.log(`tables: ${tables.join(", ")}`);

const rows = await db.all(
  "SELECT id, user_id, version, is_active, created_at, last_analyzed_at, " +
    "total_prompts_analyzed, profile_data FROM user_profiles ORDER BY total_prompts_analyzed DESC"
);
const changelogCount = (await db.get("SELECT COUNT(*) AS n FROM user_profile_changelogs"))?.n ?? 0;

const index = [];
for (const r of rows) {
  let data = null;
  let parseError = null;
  try {
    data = JSON.parse(r.profile_data);
  } catch (e) {
    parseError = String(e?.message ?? e);
  }
  const counts =
    data && typeof data === "object"
      ? Object.fromEntries(
          Object.keys(data).map((k) => [k, Array.isArray(data[k]) ? data[k].length : null])
        )
      : null;

  const entry = {
    profileId: r.id,
    userId: r.user_id,
    version: r.version,
    isActive: Boolean(r.is_active),
    createdAt: r.created_at,
    lastAnalyzedAt: r.last_analyzed_at,
    totalPromptsAnalyzed: r.total_prompts_analyzed,
    counts,
    parseError,
  };
  index.push(entry);

  const countsText = counts
    ? Object.entries(counts)
        .map(([k, v]) => `${k}=${v ?? "?"}`)
        .join(" ")
    : "(unparseable)";
  console.log(
    `  ${r.user_id.padEnd(38)} v=${String(r.version).padStart(3)} prompts=${r.total_prompts_analyzed} ${countsText}`
  );
}
console.log(`  changelog entries: ${changelogCount}`);

if (!outDir) {
  console.log("\n(no --out given: shape only, nothing written)");
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const e = index[i];
  if (e.parseError) {
    console.error(`  SKIP ${r.id}: profile_data is not JSON (${e.parseError})`);
    continue;
  }
  // Safe file name: user ids are emails and names with characters a path dislikes.
  const safe =
    String(r.user_id)
      .replace(/[^a-z0-9._-]+/gi, "_")
      .replace(/^_+|_+$/g, "") || "profile";
  const name = `${safe}__v${r.version}__prompts${r.total_prompts_analyzed}.json`;
  writeFileSync(
    join(outDir, name),
    JSON.stringify(
      {
        profileId: r.id,
        userId: r.user_id,
        version: r.version,
        isActive: Boolean(r.is_active),
        createdAt: r.created_at,
        lastAnalyzedAt: r.last_analyzed_at,
        totalPromptsAnalyzed: r.total_prompts_analyzed,
        profileData: JSON.parse(r.profile_data),
      },
      null,
      2
    ) + "\n"
  );
  e.file = name;
}
writeFileSync(
  join(outDir, "index.json"),
  JSON.stringify({ db: dbPath, changelogEntries: changelogCount, profiles: index }, null, 2) + "\n"
);
console.log(`\nwritten: ${outDir} (${index.filter((e) => e.file).length} profiles + index.json)`);

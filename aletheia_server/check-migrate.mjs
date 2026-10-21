// Migration self-check: proves the import path preserves what the HTTP API
// would throw away.
//
// Kept separate from check.mjs on purpose. check.mjs drives a running server in
// a child process and talks to it over HTTP; the import has to run INSIDE a
// process that owns the store, so a shared HOME is not possible. Two checks,
// two purposes: this one owns the store, check.mjs owns the service.
//
// Run: node check-migrate.mjs      (exit 0 = pass)
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const here = new URL(".", import.meta.url).pathname.replace(/^\//, "").replace(/\/$/, "");
const forkSrc = process.env.REMOTE_MEM_FORK ?? "X:/ai/hermes/backend/vendor/opencode-mem";
const tmp = join(here, ".tmp-migrate");
const home = join(tmp, "home");
const PROJECT_PATH = "X:\\ai\\hermes";
const PROJECT_TAG = "opencode_project_3d4a59bc1642ecb1";
const CREATED_AT = 1700000000000; // 2023-11-14, unmistakably not "now"

rmSync(tmp, { recursive: true, force: true });
mkdirSync(join(home, ".config", "opencode"), { recursive: true });

const fails = [];
const ok = [];
const check = (name, pass, detail = "") => {
  (pass ? ok : fails).push(name);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};

const DIM = 768;
let embedCalls = 0;
const embedServer = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (!req.url.endsWith("/embeddings")) return res.writeHead(404).end("{}");
    embedCalls++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        object: "list",
        data: [{ object: "embedding", index: 0, embedding: Array(DIM).fill(0.0125) }],
        model: "stub",
        usage: { prompt_tokens: 1, total_tokens: 1 },
      })
    );
  });
});
await new Promise((r) => embedServer.listen(0, "127.0.0.1", r));
const embedUrl = `http://127.0.0.1:${embedServer.address().port}`;

writeFileSync(
  join(home, ".config", "opencode", "opencode-mem.jsonc"),
  JSON.stringify(
    {
      storagePath: join(home, ".opencode-mem", "data"),
      embeddingApiUrl: embedUrl,
      embeddingApiKey: "stub-key",
      embeddingModel: "Xenova/nomic-embed-text-v1",
      embeddingUseTaskPrefixes: true,
      autoCaptureEnabled: false,
      autoUpdate: false,
    },
    null,
    2
  )
);

process.env.HOME = home;
process.env.USERPROFILE = home;

// Import the fork the same way server.mjs does: by path, from its own tree.
const dist = join(forkSrc, "dist");
const requireFork = createRequire(join(dist, "index.js"));
const load = (rel) => import(pathToFileURL(join(dist, rel)).href);

const { initConfig } = await load("config.js");
const { ensureTursoReady } = await load("services/turso/ready.js");
const { memoryPortabilityService } = await load("services/memory-portability-service.js");
const { tursoShardManager } = await load("services/turso/shard-manager.js");
const { tursoConnectionManager } = await load("services/turso/connection-manager.js");
const { tursoVectorSearch } = await load("services/turso/vector-search.js");
const { extractScopeFromContainerTag } = await load("services/memory-scope.js");

initConfig(home);
await ensureTursoReady();

const docPath = join(tmp, "hermes.json");
writeFileSync(
  docPath,
  JSON.stringify({
    schemaVersion: 1,
    exportedAt: "2026-10-13T00:00:00.000Z",
    plugin: { package: "opencode-mem", version: "2.31.0" },
    source: {
      containerTag: PROJECT_TAG,
      scope: "project",
      scopeHash: "3d4a59bc1642ecb1",
      projectPath: PROJECT_PATH,
      projectName: "hermes",
    },
    embedding: { model: "Xenova/nomic-embed-text-v1", dimensions: DIM },
    memories: [
      {
        id: "mem_migrate_probe_1",
        content: "migration probe: the original timestamp must survive the import",
        type: "technical",
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        isPinned: true,
        tags: ["probe"],
        metadata: { origin: "hermes-local" },
      },
    ],
  })
);

// 1. Dry run writes nothing and reports what it would do.
const dry = await memoryPortabilityService.importMemories({
  inputPath: docPath,
  dryRun: true,
  currentDirectory: PROJECT_PATH,
});
check("dry run succeeds", dry.success === true, dry.error ?? "");
check("dry run counts the memory", dry.imported === 1, `imported=${dry.imported}`);

// 2. The target tag comes from currentDirectory, and must equal the source tag --
//    that is what keeps the client looking memories up in the right place.
const expected = extractScopeFromContainerTag(PROJECT_TAG);
check(
  "dry run targets the document's project tag",
  dry.containerTag === PROJECT_TAG,
  `got ${dry.containerTag}, want ${PROJECT_TAG}`
);
check(
  "project path was actually used",
  expected.hash === "3d4a59bc1642ecb1",
  `hash=${expected.hash}`
);

// 3. A dry run must not have written.
const { scope, hash } = extractScopeFromContainerTag(PROJECT_TAG);
let rowsBefore = 0;
for (const shard of await tursoShardManager.getAllShards(scope, hash)) {
  try {
    const db = await tursoConnectionManager.getConnection(shard.dbPath);
    rowsBefore += (await tursoVectorSearch.getAllMemories(db)).length;
  } catch {
    /* shard not created yet */
  }
}
check("dry run wrote nothing", rowsBefore === 0, `rows=${rowsBefore}`);

// 4. Real import.
const real = await memoryPortabilityService.importMemories({
  inputPath: docPath,
  currentDirectory: PROJECT_PATH,
});
check("import succeeds", real.success === true, real.error ?? "");
check("import used the embedding endpoint", embedCalls > 0, `calls=${embedCalls}`);

// 5. The whole reason for this path: the row keeps id, timestamp, pin and
//    metadata. POST /api/memories rewrites all of those.
let row = null;
for (const shard of await tursoShardManager.getAllShards(scope, hash)) {
  try {
    const db = await tursoConnectionManager.getConnection(shard.dbPath);
    row = await tursoVectorSearch.getMemoryById(db, "mem_migrate_probe_1");
    if (row) break;
  } catch {
    /* keep looking */
  }
}
check("imported memory is readable by its original id", row !== null && row !== undefined);
if (row) {
  // getMemoryById is a raw SELECT *, so the row carries the table's snake_case
  // column names -- reading it as camelCase reports "not preserved" for fields
  // that are sitting right there.
  check("original id preserved", row.id === "mem_migrate_probe_1", `id=${row.id}`);
  check(
    "createdAt preserved (the HTTP path would reset it)",
    Number(row.created_at) === CREATED_AT,
    `created_at=${row.created_at}`
  );
  check(
    "updatedAt preserved",
    Number(row.updated_at) === CREATED_AT,
    `updated_at=${row.updated_at}`
  );
  check(
    "isPinned preserved (the HTTP path drops it)",
    Number(row.is_pinned) === 1,
    `is_pinned=${row.is_pinned}`
  );
  check(
    "metadata preserved (the HTTP path overwrites it)",
    String(row.metadata ?? "").includes("hermes-local"),
    `metadata=${String(row.metadata).slice(0, 60)}`
  );
  check(
    "stored under the document's container tag",
    row.container_tag === PROJECT_TAG,
    `container_tag=${row.container_tag}`
  );
}

// 6. Documented non-idempotence: a second real run must FAIL loudly rather than
//    silently duplicating or half-importing.
const again = await memoryPortabilityService.importMemories({
  inputPath: docPath,
  currentDirectory: PROJECT_PATH,
});
check(
  "second import refuses instead of duplicating",
  again.success === false,
  `success=${again.success}`
);
check(
  "refusal names the cause",
  /already exist/i.test(String(again.error)),
  String(again.error).slice(0, 90)
);

// 7. migrate.mjs itself, driven as a subprocess the way deploy.sh drives it.
check("migrate.mjs is shipped", existsSync(join(here, "migrate.mjs")));

// Release the store first. Turso is single-owner on Windows, and the parent has
// the shard open from every assertion above -- so a subprocess touching the same
// store is refused with a lock error that reads like a migration bug and is not.
const { closeTursoAndInvalidateCaches } = await load("services/turso/lifecycle.js");
await closeTursoAndInvalidateCaches();

// A document that declares a tag belonging to another machine -- exactly what a
// Windows export looks like on a Linux host. migrate.mjs must say so out loud
// instead of filing the memories somewhere the document never mentioned.
const foreignDoc = join(tmp, "foreign.json");
// A distinct id as well as a distinct tag: importMemories pre-scans for id
// conflicts and aborts before it compares tags (memory-portability-service.js:188-216),
// so reusing the probe's id would test the wrong thing entirely.
writeFileSync(
  foreignDoc,
  readFileSync(docPath, "utf-8")
    .replace(PROJECT_TAG, "opencode_project_deadbeefdeadbeef")
    .replace("mem_migrate_probe_1", "mem_migrate_probe_2")
);
// Async spawn, never spawnSync: the embedding stub lives in THIS process, so a
// synchronous spawn blocks the event loop that has to answer the child's request
// -- the child times out waiting on a parent that is waiting on the child.
const proc = await new Promise((resolve) => {
  const child = spawn(process.execPath, [join(here, "migrate.mjs"), foreignDoc, "--dry-run"], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  child.on("close", (code) => resolve({ code, out }));
});
const procOut = proc.out;
check(
  "migrate.mjs dry run exits 0 on a foreign tag",
  proc.code === 0,
  `status=${proc.code} out=${procOut.trim().slice(-400)}`
);
check(
  "migrate.mjs reports the tag mismatch",
  /NOTE\s+document declares/.test(procOut),
  procOut.split("\n").find((l) => l.includes("NOTE")) ?? "(no NOTE)"
);
check(
  "migrate.mjs names the remedy",
  /all-projects/.test(procOut),
  "(mentions defaultScope=all-projects)"
);

embedServer.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${ok.length} passed, ${fails.length} failed`);
if (fails.length) {
  console.log("FAILED: " + fails.join("; "));
  process.exit(1);
}
process.exit(0);

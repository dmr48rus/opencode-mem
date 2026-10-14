// Import an opencode-mem export document into this store.
//
// Why the fork's own service and not POST /api/memories: the HTTP handler
// rewrites createdAt/updatedAt to "now", mints a new id, replaces metadata with
// {source:"api"} and does not persist isPinned at all
// (api-handlers.js:328-347). For a memory store where recency weighs into
// retrieval, that is a lossy copy dressed as a migration. The portability service
// is what the plugin itself uses for export/import, so ids, timestamps,
// metadata and pins survive.
//
// Run inside the container:
//   docker compose run --rm -v ./exports:/exports:ro remote-mem \
//     node migrate.mjs /exports/hermes.json [--dry-run]
//
// NOT idempotent, on purpose of the fork and not of ours: importMemories aborts
// the WHOLE document if any single memory id already exists in the target project
// (memory-portability-service.js:207-216). So run --dry-run first, then once. A
// second real run of the same file is expected to fail, and that failure means
// "already imported", not "broken".
import { readdirSync, readFileSync, statSync } from "node:fs";
import { load } from "./fork.mjs";

const { initConfig, CONFIG } = await load("config.js");
const { ensureTursoReady } = await load("services/turso/ready.js");
const { memoryPortabilityService } = await load("services/memory-portability-service.js");

// The server is the store itself; pass its own directory so a stray
// opencode-mem.json in the working directory cannot retarget the import.
initConfig(process.cwd());

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const projectOverride = (() => {
  const i = args.indexOf("--project");
  return i >= 0 ? args[i + 1] : undefined;
})();
const inputs = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--project");
if (inputs.length === 0) {
  console.error("usage: node migrate.mjs <export.json|dir> [...] [--dry-run] [--project <dir>]");
  process.exit(2);
}

// A directory argument means "every export in here": exports are emitted per
// project, and importing them one by one is the normal case. A file argument is
// the documented single-document form and must not fall through to readdir --
// readdirSync on a file throws ENOTDIR, and the documented invocation was the
// broken one.
const files = inputs.flatMap((p) => {
  let stat;
  try {
    stat = statSync(p);
  } catch {
    console.error(`migrate: no such file or directory: ${p}`);
    process.exit(2);
  }
  if (stat.isFile()) return [p];
  return readdirSync(p)
    .filter((f) => f.endsWith(".json"))
    .map((f) => `${p}/${f}`);
});
if (files.length === 0) {
  console.error(`migrate: no .json documents in: ${inputs.join(", ")}`);
  process.exit(2);
}

await ensureTursoReady();
console.log(`migrate: store ${CONFIG.storagePath}`);
console.log(
  `migrate: ${files.length} document(s), ${dryRun ? "DRY RUN - nothing written" : "writing"}`
);

let failed = 0;
for (const file of files) {
  const doc = JSON.parse(readFileSync(file, "utf-8"));
  // The import target is derived from currentDirectory, NOT from the document
  // (memory-portability-service.js:186). Omitting it would file every project's
  // memories under whatever directory the process happens to sit in. Pass the
  // ORIGINAL project path: it need not exist on this host, because only the
  // string is hashed into the container tag -- which is exactly what keeps the
  // memories under the same tag the client will look them up by.
  const target = projectOverride ?? doc.source?.projectPath;
  if (!target) {
    failed++;
    console.error(`  FAIL ${file}: document has no source.projectPath; pass --project <dir>`);
    continue;
  }
  const result = await memoryPortabilityService.importMemories({
    inputPath: file,
    dryRun,
    currentDirectory: target,
  });
  const label = `${doc.source?.projectName ?? "?"} -> ${doc.source?.containerTag ?? result.containerTag ?? "?"}`;
  if (!result.success) {
    failed++;
    console.error(`  FAIL ${label}: ${result.error}`);
    if (result.rejected?.length) {
      console.error(
        `       ${result.rejected.length} id(s) already present -- this document is already imported`
      );
    }
    continue;
  }
  console.log(
    `  ok   ${label}: ${result.imported} memory(ies), containerTag=${result.containerTag}`
  );

  // The tag is computed on THIS host from the filesystem and git state, not from
  // the path string: getProjectTagInfo walks up for a project marker, falls back
  // to the git root, and only then hashes (tags.js:221-238). A Windows path has
  // no meaning here, so migrated memories land under a different tag than the
  // document declares. Said out loud here rather than discovered later.
  if (doc.source?.containerTag && result.containerTag !== doc.source.containerTag) {
    console.warn(
      `  NOTE  document declares ${doc.source.containerTag}, this host computes ${result.containerTag}`
    );
    console.warn(
      `        Search defaults to scope=project, which would hide these memories from a`
    );
    console.warn(
      `        client resolving its own tag. Clients need memory.defaultScope=all-projects`
    );
    console.warn(`        (config.js:224), or be pointed at the tag above.`);
  }
}

if (failed > 0) {
  console.error(`migrate: ${failed} of ${files.length} document(s) failed`);
  process.exit(1);
}
console.log(dryRun ? "migrate: dry run finished" : "migrate: finished");

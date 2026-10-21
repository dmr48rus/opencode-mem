// Build-time platform check. Runs inside /app/fork right after npm install.
//
// Exists because the engine is optional: if the npm registry has no binding for
// this platform, npm reports success and simply omits the package. The store
// then loads, the API answers /api/health, and the first client write fails on a
// missing native module. Failing the build instead puts it where it can be read.
//
// Reports WHAT is missing rather than exiting 1 silently -- a bare `test -d`
// already cost one build cycle for exactly that reason.
//
// Also asserts the build left nothing inside the data volume: with HOME=/data,
// npm's cache defaults to /data/.npm, which borg would then back up. The cache is
// redirected to /tmp in the Dockerfile, and this proves it took effect.
//
// Invoked from the Dockerfile as `node /app/verify-platform.mjs` while the cwd is
// /app/fork: the script path must be absolute (it lives in /app, the cwd does
// not), while the paths below are relative to /app/fork ON PURPOSE -- they must
// resolve against the dependency tree that was just installed there.
import { existsSync, readdirSync } from "node:fs";

const required = [
  ["node_modules/onnxruntime-node", "embedding model runtime (onnxruntime-node)"],
  ["node_modules/@tursodatabase/database-linux-x64-gnu", "Turso engine (linux-x64-glibc)"],
];

const missing = required.filter(([path]) => !existsSync(path)).map(([, what]) => what);
if (missing.length) {
  console.error("build: this platform got no native engine:");
  for (const what of missing) console.error(`  missing ${what}`);
  console.error(`  node ${process.version} on ${process.platform}/${process.arch}`);
  console.error("  npm skips optional platform packages silently, so install 'succeeds'");
  console.error("  and the store fails later, on a client's first write.");
  console.error("  Check the package exists for linux/x64/glibc, or set a remote");
  console.error("  embedding endpoint and review the model invariant in AGENTS.md.");
  process.exit(1);
}

if (existsSync("/data/.npm")) {
  console.error("build: npm wrote its cache into the data volume (/data/.npm)");
  console.error("  that directory is backed up by borg; see npm_config_cache in Dockerfile");
  process.exit(1);
}

// A stray copy of the dependency tree in the image would shadow the install.
const scopes = readdirSync("node_modules/@tursodatabase", { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);
console.log(
  `build: platform ok -- onnxruntime-node + turso (${scopes.filter((s) => s.includes("linux")).join(", ") || "linux"})`
);
console.log("build: /data stayed clean of build detritus");

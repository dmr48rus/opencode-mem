// Test isolation for the fork's own suite.
//
// Two things leak into the tests from the machine they run on:
//
// 1. OPENCODE_MEM_RRF - the production switch for the rank fusion. The suite
//    asserts the LEGACY scoring (a weak match must not be lifted over the
//    threshold), and an ambient "1" moves every search onto the fusion path.
//    Measured 19.10.2026 on the build machine, where the variable is set for
//    the server: the suite failed with "does not lift a weak match over the
//    threshold" while the same test passed against the pre-fusion code - a
//    red herring that looks like a regression in the fusion.
//
// 2. The live store. The suite writes records into the real memories DB, so
//    running it twice leaves state behind: the second run sees records the
//    first one created and fails ("accepts a legitimate sha256-style
//    containerTag", the tag-migration cases). The store is redirected to a
//    throwaway directory, and the embedding model cache stays where it is -
//    the cache lives under the store, and re-downloading the model per test
//    run is not an option.
//
// A test that wants the fusion path turns it on explicitly; a test that wants
// the live store says so.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

delete process.env.OPENCODE_MEM_RRF;
delete process.env.OPENCODE_MEM_RRF_K;

const realHome = homedir();
const realConfigPath = join(realHome, ".config", "opencode", "opencode-mem.jsonc");
if (existsSync(realConfigPath)) {
  const raw = readFileSync(realConfigPath, "utf-8");
  // The config is JSONC: strip comments and trailing commas outside strings.
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'\\])\/\/.*$/gm, "$1")
    .replace(/,(\s*[}\]])/g, "$1");
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    config = {};
  }
  const temp = mkdtempSync(join(tmpdir(), "opencode-mem-tests-"));
  const store = join(temp, "data");
  mkdirSync(join(temp, ".config", "opencode"), { recursive: true });
  writeFileSync(
    join(temp, ".config", "opencode", "opencode-mem.jsonc"),
    JSON.stringify(
      {
        ...config,
        storagePath: store,
        // The model cache must stay reachable: it lives under the store, and
        // re-downloading it per run is not an option.
        cacheDir: config.cacheDir,
      },
      null,
      2
    ),
    "utf-8"
  );
  process.env.HOME = temp;
  process.env.USERPROFILE = temp;
}

// Locating and loading the vendored fork. Shared by server.mjs and migrate.mjs --
// two entry points that must resolve the fork identically, or a migration would
// silently run against a different build than the one serving traffic.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// Put the config where the fork looks for it.
//
// It used to be done by docker-entrypoint.sh, which is wrong for anything that
// runs with --entrypoint node (migrate.mjs, the checks): the entrypoint is
// overridden, so the copy silently did not happen and the fork fell back to
// defaults -- which meant asking Hugging Face for a model id that is not ours.
// Doing it here covers every entry point that loads the fork, with one
// implementation instead of a lifecycle step that can be bypassed.
// Opt-in, because the checks bring their own config (a stub embedding endpoint
// and a throwaway store): an unconditional copy would silently replace it with
// the production one, and they would go on to download the real model. The image
// sets REMOTE_MEM_INSTALL_CONFIG=1; the harness does not.
const bundledConfig = join(here, "config", "opencode-mem.jsonc");
if (process.env.REMOTE_MEM_INSTALL_CONFIG === "1" && existsSync(bundledConfig)) {
  const targetDir = join(homedir(), ".config", "opencode");
  mkdirSync(targetDir, { recursive: true });
  copyFileSync(bundledConfig, join(targetDir, "opencode-mem.jsonc"));
}

export const fork = process.env.REMOTE_MEM_FORK
  ? resolve(process.env.REMOTE_MEM_FORK)
  : join(here, "fork");
export const dist = join(fork, "dist");

// Both of these are deployment steps, and both fail with a bare module error
// otherwise -- with a restarting container that becomes an endless crash loop
// that never says what to do. Name the missing piece instead.
export function requireFile(path, what, how) {
  if (!existsSync(path)) {
    console.error(`remote-mem: missing ${what}: ${path}\n  ${how}`);
    process.exit(1);
  }
}

requireFile(
  join(dist, "config.js"),
  "fork build (dist/config.js)",
  "run 'node pack.mjs' on the build machine and deploy the bundle it produces"
);
requireFile(
  join(fork, "node_modules"),
  "fork dependencies (node_modules)",
  "run './deploy.sh' -- it builds the image, which installs them. By hand: " +
    "cd fork && npm pkg delete scripts.prepare && npm install --omit=dev. " +
    "Without node_modules there is no onnxruntime and no Turso engine. The " +
    "vendored fork ships no lockfile, so --frozen-lockfile and 'npm ci' both " +
    "fail; 'npm pkg delete scripts.prepare' is needed because the fork's " +
    "prepare runs 'husky', which --omit=dev does not install"
);

// dynamic import() takes a URL, not a path: on Windows a bare "X:\..." parses
// as scheme "x:" and dies with ERR_UNSUPPORTED_ESM_URL_SCHEME.
export const load = (relativePath) => import(pathToFileURL(join(dist, relativePath)).href);

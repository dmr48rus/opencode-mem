// Assemble a self-contained bundle to copy to the server.
//
// Why a bundle: the fork is 1.6 MB of dist plus its manifests, and the server
// should not need a path into a Hermes build to find it. node_modules is NOT
// bundled -- it holds win32 binaries; the server installs its own for glibc.
//
// The fork's .fork-build.json travels with it, so the bundle records which
// patched branch it came from. That matters because the fork carries our own
// fixes (vector-search weight normalisation, lazy external provider in the tag
// migration) and "same version" does not imply "same code".
//
// Run: node pack.mjs            (fork from REMOTE_MEM_FORK or ../hermes path)
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const forkSrc = process.env.REMOTE_MEM_FORK ?? "X:/ai/hermes/backend/vendor/opencode-mem";
const out = resolve(process.env.REMOTE_MEM_BUNDLE ?? join(here, "bundle"));

if (!existsSync(join(forkSrc, "dist", "config.js"))) {
  console.error(`pack: no fork build at ${forkSrc} (need dist/config.js)`);
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// Repo-development files are deliberately NOT shipped: .agent-profile points at
// a Hermes checkout one level up, which is both wrong from bundle/ and absent on
// the server, and .preflight.json/.gitattributes describe the checkout, not the
// deployment.
// This list IS the build contract: a file missing from it is a file the bundle
// does not carry, and the symptom surfaces much later inside docker (a failed
// COPY) instead of at pack time. Every entry is checked below.
const files = [
  "server.mjs",
  "fork.mjs",
  "check.mjs",
  "check-migrate.mjs",
  "migrate.mjs",
  "verify-platform.mjs",
  "package.json",
  "Dockerfile",
  ".dockerignore",
  "docker-compose.yml",
  "docker-compose.llm.yml",
  ".env.example",
  "deploy.sh",
  "AGENTS.md",
];
for (const name of files) {
  const src = join(here, name);
  if (!existsSync(src)) {
    console.error(`pack: missing project file ${name}`);
    process.exit(1);
  }
  cpSync(src, join(out, name));
}
cpSync(join(here, "config"), join(out, "config"), { recursive: true });

// The fork: build output and manifests only. node_modules is deliberately absent.
const forkOut = join(out, "fork");
mkdirSync(forkOut, { recursive: true });
cpSync(join(forkSrc, "dist"), join(forkOut, "dist"), { recursive: true });
for (const name of ["package.json", "index.js", "tui.js", ".fork-build.json"]) {
  const src = join(forkSrc, name);
  if (existsSync(src)) cpSync(src, join(forkOut, name));
}

// No lockfile ships with the vendored fork, which is why deploy.sh installs with
// plain `npm install`. Recorded here so the omission looks deliberate.
const lockfiles = readdirSync(forkSrc).filter((f) => /lock|shrinkwrap/.test(f));
// .fork-build.json comes from PowerShell on Windows and carries a BOM, which
// JSON.parse rejects outright.
const build = JSON.parse(
  readFileSync(join(forkSrc, ".fork-build.json"), "utf-8").replace(/^\uFEFF/, "")
);

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).reduce((n, entry) => {
    const p = join(dir, entry.name);
    return n + (entry.isDirectory() ? walk(p) : statSync(p).size);
  }, 0);

// Dockerfile executes strictly in file order, so a script named in a RUN must
// appear in an earlier COPY. Getting that wrong fails the build as
// MODULE_NOT_FOUND on a path that is otherwise perfectly correct -- which is how
// it cost two build cycles here. Cheap to check here, expensive on the server.
const dockerfile = readFileSync(join(here, "Dockerfile"), "utf-8").split("\n");

// Join line continuations into logical instructions BEFORE looking for names. A
// file named in a multi-line RUN sits on a continuation line that does not start
// with RUN, and an earlier version of this check anchored on ^RUN and therefore
// never fired -- it passed a Dockerfile that docker rejected with
// MODULE_NOT_FOUND.
const instructions = [];
dockerfile.forEach((line, i) => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return;
  const last = instructions[instructions.length - 1];
  if (last && last.open) {
    last.text += " " + trimmed;
    last.line = i;
    last.open = trimmed.endsWith("\\");
    return;
  }
  instructions.push({ text: trimmed.replace(/\\$/, ""), line: i, open: trimmed.endsWith("\\") });
});

const copiedAt = new Map();
for (const ins of instructions) {
  const m = ins.text.match(/^COPY\s+(.*)$/);
  if (!m) continue;
  for (const token of m[1].split(/\s+/)) {
    const name = token.split("/").pop();
    if (name && !copiedAt.has(name)) copiedAt.set(name, ins.line);
  }
}
const orderProblems = [];
for (const ins of instructions) {
  if (!/^(RUN|CMD|ENTRYPOINT|HEALTHCHECK)\b/.test(ins.text)) continue;
  for (const token of ins.text.matchAll(/[\w./-]+\.(?:mjs|js|sh|jsonc?)\b/g)) {
    const name = token[0].split("/").pop();
    const at = copiedAt.get(name);
    if (at !== undefined && at > ins.line) {
      orderProblems.push(`${name} is used at line ${ins.line + 1} but copied at line ${at + 1}`);
    }
  }
}
if (orderProblems.length) {
  console.error("pack: Dockerfile uses files before copying them (docker runs in file order):");
  for (const p of orderProblems) console.error(`  ${p}`);
  process.exit(1);
}

// Digest over every bundled file, so "is the server running the current bundle?"
// is answerable by comparing one line -- instead of after an 8 minute build that
// fails somewhere inside the Dockerfile. Excludes manifest.json, which carries
// this digest.
const digestOf = (dir, skip = new Set()) => {
  const entries = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!skip.has(p.slice(out.length + 1).replace(/\\/g, "/"))) entries.push(p);
    }
  };
  walk(dir);
  const h = createHash("sha256");
  for (const p of entries.sort())
    h.update(p.slice(out.length + 1).replace(/\\/g, "/")).update(readFileSync(p));
  return h.digest("hex");
};

// Unknown instruction check. A bare `REMOTE_MEM_INSTALL_CONFIG=1` line -- ENV
// forgotten -- is not a style slip: docker refuses to parse the file, and that
// only shows up after the bundle has been packed, tarred and transferred. The
// order check above cannot see it, because the line names no file.
const KNOWN = new Set([
  "FROM",
  "RUN",
  "CMD",
  "LABEL",
  "EXPOSE",
  "ENV",
  "ADD",
  "COPY",
  "ENTRYPOINT",
  "VOLUME",
  "USER",
  "WORKDIR",
  "ARG",
  "ONBUILD",
  "STOPSIGNAL",
  "HEALTHCHECK",
  "SHELL",
]);
const badInstructions = [];
for (const ins of instructions) {
  const keyword = ins.text.split(/\s+/)[0]?.toUpperCase();
  if (!KNOWN.has(keyword)) badInstructions.push(`${ins.text.slice(0, 60)} (line ${ins.line + 1})`);
}
if (badInstructions.length) {
  console.error("pack: Dockerfile has instructions docker will not parse:");
  for (const b of badInstructions) console.error(`  ${b}`);
  console.error("  a missing ENV/COPY keyword looks like a comment to a reader and");
  console.error("  fails only at build time, on the server, after the transfer");
  process.exit(1);
}

const manifest = {
  createdAt: new Date().toISOString(),
  digest: digestOf(out),
  fork: {
    source: forkSrc,
    branch: build.branch ?? null,
    commit: build.commit ?? null,
    note: build.note ?? null,
    builtAt: build.builtAt ?? null,
    distFiles: readdirSync(join(forkOut, "dist"), { recursive: true }).filter((f) =>
      statSync(join(forkOut, "dist", String(f))).isFile()
    ).length,
    lockfile: lockfiles.length ? lockfiles : null,
  },
  totalBytes: walk(out),
};
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

console.log(`pack: ${out}`);
console.log(
  `  fork ${manifest.fork.branch} @ ${manifest.fork.commit} (${manifest.fork.distFiles} dist files)`
);
console.log(`  lockfile: ${manifest.fork.lockfile ?? "none - deploy uses plain npm install"}`);
console.log(`  size ${(manifest.totalBytes / 1024 / 1024).toFixed(2)} MB`);
console.log(`  BUNDLE DIGEST ${manifest.digest.slice(0, 16)}  <- compare with deploy.sh output`);

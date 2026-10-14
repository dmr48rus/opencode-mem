// Integration check for remote-mem. Boots the real server against the real
// fork, with a stub embedding endpoint, in an isolated HOME.
//
// Why a stub: POST /api/memories calls embeddingService.warmup() and
// embedWithTimeout() (api-handlers.js:314-318). Without an embedding endpoint
// the write path cannot be exercised at all, and pulling the 522 MB ONNX model
// into a check is not worth it. The stub speaks the OpenAI shape the fork
// expects: POST {url}/embeddings -> {data:[{embedding,index}]}
// (embedding.js:255-268). It proves the remote-embedding path, which is exactly
// what the server uses in production.
//
// Run: node check.mjs        (exit 0 = pass, non-zero = fail with a reason)
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname.replace(/^\//, "").replace(/\/$/, "");
const fork = process.env.REMOTE_MEM_FORK ?? "X:/ai/hermes/backend/vendor/opencode-mem";
const tmp = join(here, ".tmp-check");
const home = join(tmp, "home");
const DIM = 768; // nomic-embed-text-v1
const CONTAINER_TAG = `chk_user_${"a".repeat(16)}`;

rmSync(tmp, { recursive: true, force: true });
mkdirSync(join(home, ".config", "opencode"), { recursive: true });

const fails = [];
const ok = [];
const check = (name, pass, detail = "") => {
  (pass ? ok : fails).push(name + (detail ? ` (${detail})` : ""));
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};

// Stub embedding endpoint on an ephemeral port.
const embedCalls = [];
const embedServer = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (!req.url.endsWith("/embeddings")) {
      res.writeHead(404).end("{}");
      return;
    }
    embedCalls.push(JSON.parse(body || "{}"));
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
const embedPort = embedServer.address().port;
const embedUrl = `http://127.0.0.1:${embedPort}`;

// Config for the child: remote embeddings, own storage, nothing inherited.
const configJson = (homeDir, embedUrl) =>
  JSON.stringify(
    {
      storagePath: join(homeDir, ".opencode-mem", "data"),
      embeddingApiUrl: embedUrl,
      embeddingApiKey: "stub-key",
      embeddingModel: "Xenova/nomic-embed-text-v1",
      webServerEnabled: true,
      autoCaptureEnabled: false,
      autoUpdate: false,
    },
    null,
    2
  );

writeFileSync(join(home, ".config", "opencode", "opencode-mem.jsonc"), configJson(home, embedUrl));

const memPort = 4761 + Math.floor(Math.random() * 200);
const base = `http://127.0.0.1:${memPort}`;
const child = spawn(process.execPath, [join(here, "server.mjs")], {
  env: {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    REMOTE_MEM_FORK: fork,
    REMOTE_MEM_PORT: String(memPort),
    REMOTE_MEM_HOST: "127.0.0.1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let childOut = "";
child.stdout.on("data", (d) => (childOut += d));
child.stderr.on("data", (d) => (childOut += d));

const tokenFile = join(home, ".opencode-mem", ".auth-token");
const readToken = () => (exists(tokenFile) ? readFileSync(tokenFile, "utf-8").trim() : "");
function exists(p) {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}

// Wait for the port, not for a log line: stdout said "listening" in an earlier
// run of a process that was already gone, so only an answered request counts.
let booted = false;
for (let i = 0; i < 90; i++) {
  if (child.exitCode !== null) break;
  try {
    const r = await fetch(`${base}/api/health`);
    if (r.ok) {
      booted = true;
      break;
    }
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 500));
}

const token = readToken();
const authed = (extra = {}) => ({ "x-opencode-mem-token": token, ...extra });

try {
  check(
    "server boots and answers /api/health without a token",
    booted,
    booted ? "" : `child exit=${child.exitCode}`
  );
  check("auth token file created at boot", token.length > 0, `len=${token.length}`);

  // Negative control: /api/* must refuse an unauthenticated caller. If this
  // passes the server, the "auth" check above proves nothing.
  let unauthStatus = 0;
  try {
    unauthStatus = (await fetch(`${base}/api/stats`)).status;
  } catch (e) {
    unauthStatus = 0;
  }
  check("unauthenticated /api/stats is refused (401)", unauthStatus === 401, `got ${unauthStatus}`);

  let badTokenStatus = 0;
  try {
    badTokenStatus = (
      await fetch(`${base}/api/stats`, { headers: { "x-opencode-mem-token": "deadbeef" } })
    ).status;
  } catch (e) {
    badTokenStatus = 0;
  }
  check("wrong token is refused (401)", badTokenStatus === 401, `got ${badTokenStatus}`);

  const stats = await fetch(`${base}/api/stats`, { headers: authed() });
  check("authenticated /api/stats is 200", stats.status === 200, `got ${stats.status}`);

  // The write path: this is what "memory lives on the server" means.
  const add = await fetch(`${base}/api/memories`, {
    method: "POST",
    headers: authed({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      content: "remote-mem check marker: the store answers writes over HTTP",
      containerTag: CONTAINER_TAG,
      tags: ["check"],
    }),
  });
  const addBody = await add.json().catch(() => ({}));
  check(
    "POST /api/memories stores a memory",
    addBody.success === true,
    JSON.stringify(addBody).slice(0, 160)
  );
  check(
    "write path used the remote embedding endpoint",
    embedCalls.length > 0,
    `calls=${embedCalls.length}`
  );

  const search = await fetch(`${base}/api/search?q=store%20answers%20writes`, {
    headers: authed(),
  });
  const searchBody = await search.json().catch(() => ({}));
  const found = JSON.stringify(searchBody).includes("remote-mem check marker");
  check(
    "GET /api/search finds the stored memory",
    search.status === 200 && found,
    `status=${search.status}`
  );

  // Port ownership: a second server on a taken port must refuse loudly rather
  // than degrade into a health-check loop that never owns the store.
  // It gets its OWN home on purpose: sharing storage would make it exit on the
  // Turso single-owner lock instead, and the check would pass for the wrong
  // reason -- the port is the only thing that must stop it here.
  const home2 = join(tmp, "home2");
  mkdirSync(join(home2, ".config", "opencode"), { recursive: true });
  writeFileSync(
    join(home2, ".config", "opencode", "opencode-mem.jsonc"),
    configJson(home2, embedUrl)
  );
  const second = spawn(process.execPath, [join(here, "server.mjs")], {
    env: {
      ...process.env,
      HOME: home2,
      USERPROFILE: home2,
      REMOTE_MEM_FORK: fork,
      REMOTE_MEM_PORT: String(memPort),
      REMOTE_MEM_HOST: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let secondOut = "";
  second.stdout.on("data", (d) => (secondOut += d));
  second.stderr.on("data", (d) => (secondOut += d));
  const secondExited = await new Promise((r) => {
    const timer = setTimeout(() => r(false), 25000);
    second.on("exit", (code) => {
      clearTimeout(timer);
      r(code);
    });
  });
  check(
    "second server on a taken port exits non-zero",
    secondExited !== false && secondExited !== 0,
    `exit=${secondExited}`
  );
  check(
    "port refusal names the reason",
    secondOut.includes("already in use"),
    secondOut.includes("already in use")
      ? ""
      : `output was: ${secondOut.trim().slice(0, 400) || "(empty)"}`
  );
  if (secondExited === false) second.kill();
} finally {
  child.kill("SIGTERM");
  await new Promise((r) => {
    const timer = setTimeout(() => r(), 10000);
    child.on("exit", () => {
      clearTimeout(timer);
      r();
    });
  });
  embedServer.close();
}

console.log(`\n${ok.length} passed, ${fails.length} failed`);
if (fails.length) {
  console.log("FAILED: " + fails.join("; "));
  console.log("--- child output ---\n" + childOut.slice(-2500));
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}
rmSync(tmp, { recursive: true, force: true });
process.exit(0);

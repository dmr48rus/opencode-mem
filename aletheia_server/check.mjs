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
      type: "fact",
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

  // A second record, episodic: the sweep below is allowed to forget this one,
  // and the marker above must survive it.
  const addCapture = await fetch(`${base}/api/memories`, {
    method: "POST",
    headers: authed({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      content: "remote-mem check capture: the sweep must forget this one",
      containerTag: CONTAINER_TAG,
      tags: ["check"],
      type: "capture",
    }),
  });
  const addCaptureBody = await addCapture.json().catch(() => ({}));
  check(
    "POST /api/memories stores an episodic record",
    addCaptureBody.success === true,
    JSON.stringify(addCaptureBody).slice(0, 160)
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

  // Forgetting, end to end: the sweep marks the record and the search stops
  // returning it. A dry run first - forgetting must never happen by accident.
  const sweepDry = await fetch(`${base}/api/sweep`, {
    method: "POST",
    headers: authed({ "Content-Type": "application/json" }),
    body: JSON.stringify({ dryRun: true }),
  });
  const sweepDryBody = await sweepDry.json().catch(() => ({}));
  check(
    "POST /api/sweep dry run answers with a report",
    sweepDry.status === 200 &&
      sweepDryBody.success === true &&
      typeof sweepDryBody.data?.scanned === "number",
    JSON.stringify(sweepDryBody).slice(0, 160)
  );

  const sweep = await fetch(`${base}/api/sweep`, {
    method: "POST",
    headers: authed({ "Content-Type": "application/json" }),
    body: JSON.stringify({ dryRun: false, episodicDays: 0 }),
  });
  const sweepBody = await sweep.json().catch(() => ({}));
  check(
    "POST /api/sweep ages a record",
    sweep.status === 200 && Number(sweepBody.data?.aged ?? 0) >= 1,
    JSON.stringify(sweepBody).slice(0, 160)
  );

  const afterSweep = await fetch(`${base}/api/search?q=sweep%20must%20forget`, {
    headers: authed(),
  });
  const afterSweepBody = await afterSweep.json().catch(() => ({}));
  const stillFound = JSON.stringify(afterSweepBody).includes("remote-mem check capture");
  check(
    "an aged record no longer comes up in search",
    !stillFound,
    "the aged record is still returned"
  );

  // The identity transfer: the master token only, and an unknown identity is
  // refused rather than invented.
  const transferNoMaster = await fetch(`${base}/api/user-profile/transfer`, {
    method: "POST",
    headers: {
      "x-opencode-mem-token": "not-the-master-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fromUserId: "a@local", toUserId: "b@local" }),
  });
  check(
    "the identity transfer refuses a client key",
    transferNoMaster.status === 403 || transferNoMaster.status === 401,
    `status=${transferNoMaster.status}`
  );

  const transfer = await fetch(`${base}/api/user-profile/transfer`, {
    method: "POST",
    headers: authed({ "Content-Type": "application/json" }),
    body: JSON.stringify({ fromUserId: "nobody@local", toUserId: "somebody@local" }),
  });
  const transferBody = await transfer.json().catch(() => ({}));
  check(
    "the identity transfer refuses an unknown identity",
    transfer.status === 200 && transferBody.success === false,
    JSON.stringify(transferBody).slice(0, 160)
  );

  const mark = await fetch(`${base}/api/deduplicate/mark`, {
    method: "POST",
    headers: authed({ "Content-Type": "application/json" }),
    body: JSON.stringify({ dryRun: true }),
  });
  const markBody = await mark.json().catch(() => ({}));
  check(
    "POST /api/deduplicate/mark answers with a dry run",
    mark.status === 200 && markBody.success === true && markBody.data?.dryRun === true,
    JSON.stringify(markBody).slice(0, 160)
  );

  // The compaction: a copy of a cold cluster is folded into its canonical copy
  // and can be unfolded again.
  const compact = await fetch(`${base}/api/compact`, {
    method: "POST",
    headers: authed({ "Content-Type": "application/json" }),
    body: JSON.stringify({ dryRun: true }),
  });
  const compactBody = await compact.json().catch(() => ({}));
  check(
    "POST /api/compact answers with a dry run",
    compact.status === 200 && compactBody.success === true && compactBody.data?.dryRun === true,
    JSON.stringify(compactBody).slice(0, 160)
  );

  // Two records that disagree: the pair is flagged and both records stay.
  const contradictionBodies = [];
  for (const port of [9119, 18801]) {
    const write = await fetch(`${base}/api/memories`, {
      method: "POST",
      headers: authed({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        content: `remote-mem check contradiction: the gate port in hermes is ${port}`,
        containerTag: CONTAINER_TAG,
        tags: ["check"],
        type: "fact",
      }),
    });
    contradictionBodies.push(await write.json().catch(() => ({})));
  }
  check(
    "POST /api/memories stores both sides of a contradiction",
    contradictionBodies.every((body) => body.success === true),
    JSON.stringify(contradictionBodies).slice(0, 160)
  );

  const conflicts = await fetch(`${base}/api/conflicts/scan`, {
    method: "POST",
    headers: authed({ "Content-Type": "application/json" }),
    body: JSON.stringify({ dryRun: false }),
  });
  const conflictsBody = await conflicts.json().catch(() => ({}));
  check(
    "POST /api/conflicts/scan flags the records that contradict each other",
    conflicts.status === 200 &&
      conflictsBody.success === true &&
      Number(conflictsBody.data?.flagged ?? 0) >= 1,
    JSON.stringify(conflictsBody).slice(0, 160)
  );

  const clearConflicts = await fetch(`${base}/api/conflicts/clear`, {
    method: "POST",
    headers: authed({ "Content-Type": "application/json" }),
    body: JSON.stringify({ memoryId: "remote-mem-check-unknown" }),
  });
  const clearBody = await clearConflicts.json().catch(() => ({}));
  check(
    "POST /api/conflicts/clear lifts the flags",
    clearConflicts.status === 200 && clearBody.success === true,
    JSON.stringify(clearBody).slice(0, 160)
  );

  // The usage statistics. This server runs on an isolated HOME with no remote
  // store, so the whole check is also the check of the LOCAL mode: the store is
  // the local one, and the write, the search, the sweep and the dedup below all
  // go through it.
  const statsResponse = await fetch(`${base}/api/stats`, { headers: authed() });
  const statsPayload = await statsResponse.json().catch(() => ({}));
  const statsData = statsPayload?.data ?? {};
  check(
    "GET /api/stats answers with the usage statistics",
    statsResponse.status === 200 &&
      statsPayload.success === true &&
      typeof statsData.total === "number",
    JSON.stringify(statsPayload).slice(0, 160)
  );
  check(
    "the statistics carry the shards, the profile and the daily counters",
    Array.isArray(statsData.shards) && statsData.profile != null && Array.isArray(statsData.daily),
    JSON.stringify(statsPayload).slice(0, 160)
  );
  const probeResponse = await fetch(`${base}/api/stats?probe=1`, { headers: authed() });
  const probePayload = await probeResponse.json().catch(() => ({}));
  check(
    "GET /api/stats?probe=1 stays cheap",
    probeResponse.status === 200 &&
      probePayload.success === true &&
      probePayload.data === undefined,
    JSON.stringify(probePayload).slice(0, 160)
  );

  const reindex = await fetch(`${base}/api/reindex`, {
    method: "POST",
    headers: authed({ "Content-Type": "application/json" }),
    body: JSON.stringify({ limit: 5 }),
  });
  const reindexBody = await reindex.json().catch(() => ({}));
  check(
    "POST /api/reindex answers",
    reindex.status === 200 && reindexBody.success === true,
    JSON.stringify(reindexBody).slice(0, 160)
  );

  // The shadow mode is stored with the data, so a stale mode must not be able
  // to blind the store: with no shadow model configured, "replace" has to fall
  // back to the model in charge and the search must still answer.
  for (const mode of ["replace", "channel", "off"]) {
    const switched = await fetch(`${base}/api/reindex`, {
      method: "POST",
      headers: authed({ "Content-Type": "application/json" }),
      body: JSON.stringify({ mode }),
    });
    const switchedBody = await switched.json().catch(() => ({}));
    check(
      `the shadow mode switches to ${mode}`,
      switched.status === 200 && switchedBody.success === true,
      JSON.stringify(switchedBody).slice(0, 160)
    );
    const stillSearching = await fetch(`${base}/api/search?q=store%20answers%20writes`, {
      headers: authed(),
    });
    const stillBody = await stillSearching.json().catch(() => ({}));
    const found = JSON.stringify(stillBody).includes("remote-mem check marker");
    check(
      `the search still answers in mode ${mode}`,
      stillSearching.status === 200 && found,
      `status=${stillSearching.status}`
    );
  }

  // Per-client keys: issued by the master, scoped, and revocable on their own.
  const keyIssued = await fetch(`${base}/api/keys`, {
    method: "POST",
    headers: authed({ "Content-Type": "application/json" }),
    body: JSON.stringify({ label: "check-client", clientId: "check-client", scope: "read" }),
  });
  const keyBody = await keyIssued.json().catch(() => ({}));
  const clientKey = keyBody?.data?.key;
  check(
    "POST /api/keys issues a client key",
    keyIssued.status === 200 && Boolean(clientKey),
    JSON.stringify(keyBody).slice(0, 160)
  );

  if (clientKey) {
    const keyHeaders = { "x-opencode-mem-token": clientKey };
    const readWithKey = await fetch(`${base}/api/memories?pageSize=1`, { headers: keyHeaders });
    check("a client key can read", readWithKey.status === 200, `status=${readWithKey.status}`);

    const writeWithKey = await fetch(`${base}/api/memories`, {
      method: "POST",
      headers: { ...keyHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "read-only key must not write",
        containerTag: CONTAINER_TAG,
      }),
    });
    check(
      "a read-only key cannot write",
      writeWithKey.status === 403,
      `status=${writeWithKey.status}`
    );

    const revoked = await fetch(`${base}/api/keys/${keyBody.data.record.id}`, {
      method: "DELETE",
      headers: authed(),
    });
    check("a client key is revoked on its own", revoked.status === 200, `status=${revoked.status}`);

    const afterRevoke = await fetch(`${base}/api/memories?pageSize=1`, { headers: keyHeaders });
    check(
      "a revoked key stops working",
      afterRevoke.status === 401,
      `status=${afterRevoke.status}`
    );
  }

  const restore = await fetch(`${base}/api/sweep`, {
    method: "POST",
    headers: authed({ "Content-Type": "application/json" }),
    body: JSON.stringify({ restore: true }),
  });
  const restoreBody = await restore.json().catch(() => ({}));
  check(
    "POST /api/sweep restores the aged records",
    restore.status === 200 && Number(restoreBody.data?.restored ?? 0) >= 1,
    JSON.stringify(restoreBody).slice(0, 160)
  );

  const afterRestore = await fetch(`${base}/api/search?q=sweep%20must%20forget`, {
    headers: authed(),
  });
  const afterRestoreBody = await afterRestore.json().catch(() => ({}));
  const backAgain = JSON.stringify(afterRestoreBody).includes("remote-mem check capture");
  check(
    "a restored record comes back to search",
    backAgain,
    "the restored record is still missing"
  );

  const afterSweepMarker = await fetch(`${base}/api/search?q=store%20answers%20writes`, {
    headers: authed(),
  });
  const afterSweepMarkerBody = await afterSweepMarker.json().catch(() => ({}));
  const markerSurvived = JSON.stringify(afterSweepMarkerBody).includes("remote-mem check marker");
  check("a fact survives the sweep", markerSurvived, "the durable record was aged too");

  // MCP over HTTP: the path that lets any harness use the store with nothing
  // but a URL and a token - no Python, no build, no local copy.
  const mcpCall = async (body) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: authed({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  const init = await mcpCall({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
  check(
    "POST /mcp answers initialize",
    init.status === 200 && Boolean(init.body?.result?.protocolVersion),
    `status=${init.status}`
  );

  // Negative control: an unauthenticated caller must not reach the tools. If
  // this passes, the MCP checks above prove nothing about the token.
  let mcpNoAuth = 0;
  try {
    mcpNoAuth = (
      await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      })
    ).status;
  } catch (e) {
    mcpNoAuth = 0;
  }
  check("POST /mcp refuses an unauthenticated caller (401)", mcpNoAuth === 401, `got ${mcpNoAuth}`);

  const toolList = await mcpCall({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const toolNames = (toolList.body?.result?.tools ?? []).map((tool) => tool.name);
  check(
    "POST /mcp lists the memory tools",
    toolNames.includes("memory_search") && toolNames.includes("memory_snapshot"),
    toolNames.join(",")
  );

  const toolCall = await mcpCall({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "memory_search", arguments: { query: "store answers writes" } },
  });
  check(
    "POST /mcp tools/call searches the store",
    toolCall.status === 200 && JSON.stringify(toolCall.body).includes("remote-mem check marker"),
    `status=${toolCall.status}`
  );

  const snapshot = await mcpCall({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "memory_snapshot", arguments: { limit: 5 } },
  });
  check(
    "POST /mcp tools/call returns a snapshot without a question",
    snapshot.status === 200 && JSON.stringify(snapshot.body).includes("remote-mem check marker"),
    `status=${snapshot.status}`
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

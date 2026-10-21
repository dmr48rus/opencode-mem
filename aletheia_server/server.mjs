// remote-mem: memory store for Hermes. Runs the vendored opencode-mem fork as a
// standalone process (no OpenCode, no plugin hooks) and exposes its HTTP API.
//
// Why a wrapper instead of the plugin: auto-capture stays local (it needs the
// local OpenCode for the summary), only storage moves here. See
// ../hermes/app/data/opencode/config/FINDINGS.md (2026-10-13, Ф0) for the
// measurements this decision rests on.
import { createServer } from "node:net";
import { fork, load } from "./fork.mjs";

const here = new URL(".", import.meta.url).pathname.replace(/^\//, "").replace(/\/$/, "");

const { initConfig, CONFIG } = await load("config.js");
const { ensureTursoReady } = await load("services/turso/ready.js");
const { startWebServer } = await load("services/web-server.js");
const { WebAuth } = await load("services/web-auth.js");
const { log } = await load("services/logger.js");

// initConfig(directory) merges the global config (~/.config/opencode) with a
// per-project one. The server is the project: pass its own directory so a
// stray opencode-mem.json in the cwd cannot retarget the store.
initConfig(here);

// Ensure the token exists before binding: a client that cannot authenticate
// must not be able to make the port look healthy. Short-circuit: /api/health is
// the only unauthenticated route, so a token-less server is not a soft failure.
const { getOrCreateAuthToken } = await load("services/auth-token.js");
const token = getOrCreateAuthToken();

const port = Number(process.env.REMOTE_MEM_PORT ?? CONFIG.webServerPort ?? 4747);
const host = process.env.REMOTE_MEM_HOST ?? CONFIG.webServerHost ?? "127.0.0.1";

log("remote-mem: booting", { fork, port, host, storagePath: CONFIG.storagePath });

// Own the port before touching the database. Two reasons this check is ours and
// not the fork's: web-server.js:109 calls server.unref(), so a standalone
// process exits cleanly right after "listening" with nothing holding the event
// loop; and web-server.js:113 tests listenError synchronously although listen()
// reports EADDRINUSE asynchronously, so the fork's "port taken" path never fires.
const claimPort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (error) =>
      reject(
        error.code === "EADDRINUSE" ? new Error(`port ${port} is already in use on ${host}`) : error
      )
    );
    // exclusive: true is the whole point of the probe. The fork itself binds with
    // exclusive: false (web-server.js:108), which on Windows means SO_REUSEADDR and
    // lets a second process bind a port that is already served -- a probe with the
    // same setting silently "succeeds" and the port check proves nothing. On Linux
    // `exclusive` is ignored, so this stays correct there.
    probe.listen({ port, host, exclusive: true }, () => probe.close(() => resolve(undefined)));
  });

try {
  await claimPort();
} catch (error) {
  // Refuse loudly: degrading into the fork's health-check loop would leave a
  // process that runs, reports nothing, and owns no store.
  log("remote-mem: refusing to start", { error: String(error) });
  console.error(`remote-mem: ${error.message}`);
  process.exit(1);
}
// shortcut: between closing the probe and the fork's listen() another process
// could take the port. Fine for one service per host; revisit with systemd
// socket activation if that stops being true.

await ensureTursoReady();

const server = await startWebServer({
  port,
  host,
  enabled: true,
  auth: new WebAuth({
    password: CONFIG.webServerAuthPassword,
    username: CONFIG.webServerAuthUsername,
  }),
  apiToken: token,
});

// The socket above is unref'd, so nothing keeps the event loop alive by itself.
// A ref'd timer is what makes this a service instead of a script that exits.
const keepAlive = setInterval(() => {}, 1 << 30);

// Confirm with an answered request, not with a log line: an earlier run printed
// "listening" for a process that was already gone.
let ready = false;
for (let attempt = 0; attempt < 40; attempt++) {
  try {
    const response = await fetch(`${server.getUrl()}/api/health`);
    const body = await response.json();
    if (response.ok && body.success === true && body.status === "ok") {
      ready = true;
      break;
    }
  } catch {
    /* not bound yet */
  }
  await new Promise((r) => setTimeout(r, 250));
}
if (!ready) {
  log("remote-mem: bound no answering port", { url: server.getUrl() });
  console.error(`remote-mem: ${server.getUrl()} did not answer /api/health`);
  clearInterval(keepAlive);
  process.exit(1);
}

log("remote-mem: ready", { url: server.getUrl() });
console.log(`remote-mem listening on ${server.getUrl()}`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    log("remote-mem: shutting down", { signal });
    // stop() is async: exiting before it settles leaves the Turso shard open
    // and the next boot reports a lock error that nobody caused.
    clearInterval(keepAlive);
    try {
      await server.stop();
    } catch (error) {
      log("remote-mem: stop failed", { error: String(error) });
    }
    process.exit(0);
  });
}

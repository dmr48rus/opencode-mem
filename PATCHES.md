# What this fork changes

Differences from `tickernelz/opencode-mem` at 2.31.0, one line each: what it
does, and why it was necessary. `FORK-NOTES.md` explains the layout and the
build; this file is the list of behaviour changes.

Upstream commits are not repeated here. Ours start at `b46a0ca`.

## Scoring and capture

**`b46a0ca` renormalise hybrid scoring over present signals** —
`turso/vector-search.ts`, `config.ts`, `auto-capture.ts`, `client.ts`,
`api-handlers.ts`, `opencode-provider.ts`, `index.ts`, `v2/plugin.ts`.
A memory with no tags has no `tags_vector`, but the tag weight was still added,
which could push a record above the threshold and then never find it again.
Weights are now normalised over the signals a record actually has. Embedding
task prefixes were switched on at the same time, because the vectors were
computed with them.

**`954a18a` keep the error name out of the failure toast** — `auto-capture.ts`.
Failures were logged as `{"error":""}` when the SDK rejection carried no
message. A `describeError()` helper now logs name and stack, and only the bare
message reaches the toast.

**`8b7bd34` one diagnostics record per capture attempt, and a retry policy** —
`capture-diagnostics.ts`, `capture-retry-policy.ts`, `auto-capture.ts`,
two test files. Ported from OMMS. Every attempt now writes one countable record
with a reason code and an HTTP status, and a permanent failure ends the turn
instead of sleeping through the remaining backoff. One deliberate deviation from
the source: a persist-error is classified by status here, because our store is a
server where a 401 answers identically forever, not a local file that is merely
busy.

## Memory on a server

**`8f4f2ce` + `b91f124` remote storage client** — `remote-storage.ts`,
`config.ts`. A service-level client, not a database driver: the plugin issues
SQLite-specific queries that cannot be proxied over REST, so what is proxied is
the set of operations the plugin actually performs. The server embeds, which is
what lets the client drop its local model.

**`199fb50` route the client's store calls to the remote API** —
`client.ts`, `api-handlers.ts`, `remote-storage.ts`. Search goes out as text
and the server embeds it; writes go out as content and the server embeds it.
The same patch fixed `handleAddMemory`, which was dropping `sessionId`, so
auto-capture lost its session link.

**`cb59628` run tag migration through the OpenCode provider** —
`api-handlers.ts`. The migration built its external provider before doing any
work, so in an OpenCode-only configuration the button failed every time instead
of using the provider the rest of the plugin already uses.

## Profile on a server

**`1c8a761` `PUT /api/user-profile`** — `api-handlers.ts`, `web-server.ts`. An
upsert, so a client the server has never seen still lands somewhere.

**`acb8e9f` read and write the profile over HTTP** — `user-profile-manager.ts`,
`remote-storage.ts`, `client.ts`, `api-handlers.ts`, `web-server.ts`. GET gained
`raw=1` so embeddings survive the round trip; the manager reads and updates
through the server instead of a local table.

**`715bf97` create the profile on the server** — `user-profile-manager.ts`.
The remote branch had been added to the read and the update but not to the
create, which runs exactly once per identity. It fell through to a local INSERT
that collided with the row an earlier local-only build had left, so every
learning round ended in `UNIQUE constraint failed` after the model call had
already been paid for.

## Web surface

**`e25a296` let the API past the Basic challenge** — `web-auth.ts`. The
password guards the browser-facing surface; `/api/*` falls through to the token
check that runs after it. One challenge before both would have locked the
plugin's own client out of the store it reads and writes.

## Skills

**`f8bbd50` store skills in the shared store** — `skills-manager.ts`,
`remote-storage.ts`. The last piece of state left on this machine while memory
and the profile moved to the server. The server's `/api/skills` routes already
existed, so the server is unchanged and its local store became the shared one.
`remoteStorage.enabled` remains the switch back to a purely local install, and
`container_tag` stops being a filter: the shared store is global.

**Registration in OpenCode** — `v2/adapter.ts`. Enabled skills are pushed into
the host's own skill registry at start and after every change, with stale ones
removed, so a stored skill reaches the model exactly like a file-based one. The
project tag is no longer part of the filter, for the same global-store reason as
above.

One thing that reads like a design choice and is not: `SKILL.md` is still
written on **every** path, remote included. `Skill.Info` requires an absolute
`path` even for a skill whose content travels inline, and that path has to
exist. The row on the server stays the only source of truth; the file is a
derived copy the host contract demands.

A correction worth keeping: an earlier version of this file said the
registration could not run, because `SkillDraft` in `@opencode-ai/plugin`
1.18.34 has only `source()` and `list()`. That is the **OpenCode v1** SDK. The
v2 adapter is typed by `@opencode/plugin` 2.0.24, which is what OpenCode 2.0.28
in this build actually provides, and it has `SkillEditor` with
`list/get/add/update/remove`. No skill has ever appeared here because none was
ever created, not because registration was broken.

## Repository, not runtime

**`afd5287` self-contained repository** — `dist/` is committed (what the build
vendors must not depend on a rebuild), `aletheia_server/` holds the server, and
`eslint.config.js` / `package.json` keep the pre-commit hook off both, since
prettier over `dist/` would rewrite the artifact this repository ships.

## Ported upstream fixes (2.31.1 - 2.31.3)

Three fixes from upstream releases, two cherry-picked as-is and one applied by
hand. They are not ours; they are listed because each one changes behaviour,
and because all three touch code this fork also changed.

**`fe8cd04` (upstream `552825f`) JSONC trailing commas, string-safe** -
`services/jsonc.ts`, picked as-is; this fork never touched the file. Upstream's
stripper was eating commas inside string contents, so a value such as
`"https://host/x,"` lost its comma. Our own Python reader of that same config
(`hermes_tools_mcp.py`, outside this repository) had the mirror-image gap: it
removed comments only, so a trailing comma the plugin tolerates made
`json.loads` fail there while the plugin carried on.

**`4643f12` (upstream `2dd1255`) re-raise SIGINT/SIGTERM after cleanup** -
`index.ts`, picked as-is. Registering the handlers suppressed the runtime's
default termination; without dropping them and re-delivering the signal the
host never exits. No forced `process.exit` - that crashes the onnxruntime
finalisers.

**`ab499fd` (upstream `832d8f8`) reopen the skills DB after a boot-time close** -
`skills/skills-manager.ts` **applied by hand**, while `turso/lifecycle.ts` and the
test were taken from upstream. `getDb()` trusted its own cached handle: when a
boot migrator closed or replaced `skills.db` underneath it, skills quietly
stopped working while the plugin still looked healthy - the same shape as the
`{"count":0}` registration line seen in the build log.
`closeTursoAndInvalidateCaches` now resets `skillsManager` along with the other
caches. The hunk was applied rather than picked because this file carries our
remote/local branches.

The base is still `2.31.0` and the tag says so. These three make the fork
behave like `2.31.3` in these places only; the dependency bumps from those
releases were deliberately not taken, so the version in the tag is not a lie
about the package versions actually installed.

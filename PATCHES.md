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

**Not done, and it is the honest gap:** stored skills are not pushed into the
OpenCode registry. `v2/adapter.ts` calls `editor.get/add/update/remove`, and
SDK 1.18.34's `SkillDraft` has only `source()` and `list()` — that code cannot
run against this host, which is why no skill has ever appeared here. What
`source()` does on a repeated call, and how a source is withdrawn, are questions
about the host that were not guessed at. Storage and reading work; the model
sees these skills when it asks for them.

## Repository, not runtime

**`afd5287` self-contained repository** — `dist/` is committed (what the build
vendors must not depend on a rebuild), `remote-mem/` holds the server, and
`eslint.config.js` / `package.json` keep the pre-commit hook off both, since
prettier over `dist/` would rewrite the artifact this repository ships.

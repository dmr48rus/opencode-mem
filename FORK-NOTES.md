# Fork notes — what this branch adds over upstream 2.31.0

Upstream: `tickernelz/opencode-mem`, branch `patched/2.31.0`.
Everything below is committed on that branch; `main` is untouched upstream.

## The server lives here too

`remote-mem/` is the standalone memory server this fork was paired with: a
Docker image that runs the very same `dist/` from this repository, stores
shards under `/data/.opencode-mem/data`, and serves the plugin's HTTP API plus
its web UI.

- `remote-mem/server.mjs` — boots the plugin's web server from the bundled dist
- `remote-mem/config/opencode-mem.jsonc` — server-side config, read-only mount
- `remote-mem/Dockerfile`, `docker-compose.yml` — image and loopback publish
- `remote-mem/pack.mjs` — copies the working set into `remote-mem/bundle/` and
  prints the digest that `deploy.sh` must reproduce on the target host
- `remote-mem/deploy.sh` — runs on the server

`remote-mem/bundle/` is build output and is not committed; `pack.mjs` recreates
it from `dist/`.

## dist/ is committed on purpose

Upstream ignores `dist/`. Here it is tracked, because the build consumes this
repository's `dist/` directly and a clean checkout must yield the exact artifact
that was tested — not a rebuild that might differ.

If you change `src/`, rebuild and commit the result together:

    bun install --frozen-lockfile
    bun test
    bun run build
    git add dist && git commit

`.fork-build.json` at the repository root records which commit the committed
`dist/` was built from. The same file is read from the consumer's vendor
directory, so a mismatch between the two means the vendor is stale.

`big-pickle`/`bun` are required for the build; `dist/` contains no secrets.

## Secrets are never in this repository

Only templates are committed:

- `remote-mem/.env.example` — copy to `.env` on the server and fill in
  `REMOTE_MEM_WEB_PASSWORD`
- `remote-mem/config/opencode-mem.jsonc` — reads the password through
  `env://REMOTE_MEM_WEB_PASSWORD`, never a literal

The API token is generated on the server at first boot into
`data/.opencode-mem/.auth-token`, which is a bind-mounted host directory and is
not part of this repository.

## What the branch changes

1. Memory store can be remote: `remote-storage.ts` provides the store the client
   uses, and `client.ts` reads and writes through it instead of the local DB.
   The server is the source of truth; there is no local cache.
2. Profile read/write over HTTP: `GET /api/user-profile` gains `raw=1` so
   embeddings survive the round trip, and `PUT /api/user-profile` is an upsert
   so a client the server has never seen still lands. `createProfile` goes to
   the server too — leaving it on the local INSERT made every first learning
   round die on `UNIQUE constraint failed: user_profiles.user_id`.
3. Tag migration builds its external provider lazily, so the button works in an
   OpenCode-only configuration instead of always failing.
4. The web UI's password guards only the browser surface; `/api/*` falls through
   to the token check that runs after it. One challenge before both would have
   locked the plugin's own client out of the store.

Vector search, embeddings, auto-capture and the profile manager are otherwise
untouched.

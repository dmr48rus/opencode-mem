#!/bin/sh
# Deploy remote-mem on the server. Run from the extracted bundle root:
#   tar -xzf remote-mem-bundle.tar.gz && cd bundle && ./deploy.sh
#
# Idempotent: safe to re-run after a new bundle.
set -eu

cd "$(dirname "$0")"

log() { printf '\n=== %s\n' "$1"; }

# Bundle integrity. Both fork/ and bundle/ are build output listed in
# .gitignore, so a transfer through git (clone, archive, worktree) silently
# delivers a bundle with no fork in it. Name that now rather than letting it
# surface as "missing dist/config.js" from a crash-looping container.
log "bundle identity and integrity"
# Printed FIRST, before an eight minute build. A server left on an older bundle
# fails inside the Dockerfile with a MODULE_NOT_FOUND that reads like a bug in
# this project rather than a stale transfer; comparing one line settles it.
# Read the manifest with node -- the same runtime that wrote it -- rather than
# scraping it with sed, whose untested quoting is one more thing to break here.
docker run --rm -v "$PWD:/app:ro" -w /app node:22-bookworm-slim node -e "
  const fs = require('fs');
  const m = JSON.parse(fs.readFileSync('manifest.json', 'utf-8').replace(/^\uFEFF/, ''));
  console.log('  BUNDLE DIGEST ' + m.digest.slice(0, 16) + '   <- compare with pack.mjs output');
  console.log('  fork ' + m.fork.branch + ' @ ' + m.fork.commit);
  const count = (d) => fs.readdirSync(d, { withFileTypes: true })
    .reduce((n, e) => n + (e.isDirectory() ? count(d + '/' + e.name) : 1), 0);
  const have = fs.existsSync('fork/dist') ? count('fork/dist') : 0;
  if (have !== m.fork.distFiles) {
    console.error('  bundle incomplete: fork/dist has ' + have +
      ' files, manifest says ' + m.fork.distFiles);
    console.error('  transfer the bundle/ directory as a tarball, not through git');
    process.exit(1);
  }
  console.log('  fork/dist complete: ' + have + ' files');
"

mkdir -p data

# Build. The dependency install lives in the Dockerfile: the fork's `prepare`
# script (husky) is deleted first, because --omit=dev does not install husky and
# npm would exit 127 on a missing binary; --omit=dev itself drops
# eslint/typescript/prettier, of no use to a server; and two `test -d`
# assertions so a platform that produced no native engine fails the BUILD instead
# of the first client request. No node or npm on the host, and no win32 binaries
# from a Hermes checkout can be picked up by accident.
log "build"
docker compose build --remove-orphans

# Image freshness. A bundle can be current while the image is not: docker reuses
# the built layer, and the failure then arrives as MODULE_NOT_FOUND on a script
# that was simply never in that image. Compare the digest baked into the image
# with the digest of the bundle on disk, and stop here instead of three commands
# later. Both sides are read with node -- the runtime that wrote the manifest --
# rather than scraping JSON with sed, whose quoting is untested on this host.
bundle_digest=$(docker run --rm -v "$PWD:/b:ro" node:22-bookworm-slim node -e \
  "console.log(JSON.parse(require('fs').readFileSync('/b/manifest.json','utf-8').replace(/^\uFEFF/,'')).digest.slice(0,16))")
image_digest=$(docker compose run --rm --no-deps remote-mem -e \
  "console.log(JSON.parse(require('fs').readFileSync('/app/manifest.json','utf-8').replace(/^\uFEFF/,'')).digest.slice(0,16))" | tr -d '\r')
if [ "$bundle_digest" = "$image_digest" ]; then
  echo "  image matches the bundle ($bundle_digest)"
else
  echo "  IMAGE IS STALE"
  echo "    bundle on disk:      $bundle_digest"
  echo "    image was built from: ${image_digest:-<unknown>}"
  echo "    run 'docker compose build' and retry"
  exit 1
fi

# Self-check on this platform, inside the image that was just built.
log "self-check on $(uname -m)"
docker compose run --rm --no-deps remote-mem check.mjs
docker compose run --rm --no-deps remote-mem check-migrate.mjs

# Embedding model into the data volume, so a rebuild does not re-download it.
# Without this the fork reaches for the network on first use and dies on
# certificate verification.
log "embedding model"
docker compose run --rm --no-deps remote-mem -e "
  const { AutoModel } = require('@huggingface/transformers');
  AutoModel.from_pretrained('Xenova/nomic-embed-text-v1')
    .then(() => console.log('  model ok'))
    .catch((e) => { console.error(e.message); process.exit(1); });
"

log "start"
docker compose up -d
docker compose ps

log "verify"
printf '  token: %s\n' "$(cat data/.opencode-mem/.auth-token 2>/dev/null || echo '(not created yet)')"
# Straight at the store, on the loopback: proves the app is up regardless of the
# proxy, certificates or DNS.
curl -fsS http://127.0.0.1:4747/api/health && echo

if [ -f .env ]; then
  public=$(sed -n 's/^REMOTE_MEM_PUBLIC_URL=//p' .env | head -1)
else
  public=""
fi

if [ -n "$public" ]; then
  echo
  echo "  through the proxy: $public/api/health"
  echo "  clients send the token as: x-opencode-mem-token: <token above>"
  # Separate verdicts on purpose: a dead app and a broken proxy host look
  # identical from the outside, and the fix differs.
  if curl -fsS -o /dev/null -w '  public health: HTTP %{http_code}\n' "$public/api/health"; then
    echo "  proxy path is good."
  else
    echo "  public path NOT answering. The store answered on loopback, so the"
    echo "  cause is on the proxy side: is mem.agrohim.info created in Nginx Proxy"
    echo "  Manager forwarding to http://remote-mem:4747, and is NPM attached to"
    echo "  the dockerbee network?"
  fi
else
  echo
  echo "  No REMOTE_MEM_PUBLIC_URL in .env -- copying the example."
  echo "  Set it to the address the proxy serves, so this script can check it."
  [ -f .env ] || cp .env.example .env
fi

echo
echo "Next: the store is up. Point a client at it, then migrate the existing"
echo "memory into it (export from the Hermes machine, import here)."
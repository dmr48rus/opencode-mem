# Memory store for Hermes. See AGENTS.md.
#
# glibc, not musl: @tursodatabase/database resolves its engine through
# database-linux-x64-gnu and onnxruntime-node 1.30.0 fetches a glibc binary in
# postinstall. A musl base would install and then fail at first use.
FROM node:22-bookworm-slim

WORKDIR /app

# HOME is the data directory so that the auth token lands in the volume: it is
# generated at first boot, and a token that changed on every rebuild would
# silently break every client.
ENV HOME=/data
# npm's cache must be redirected for EVERY npm invocation, not just the install:
# npm creates $HOME/.npm/_logs for any command, so a single `--cache` flag on
# the install line left /data/.npm behind from the `npm pkg delete` that ran
# before it -- build detritus inside the volume borg backs up. Set it in the
# environment so the whole RUN is covered, and assert it below.
ENV npm_config_cache=/tmp/npm
ENV NPM_CONFIG_CACHE=/tmp/npm
ENV HF_HOME=/data/.cache
ENV TRANSFORMERS_CACHE=/data/.cache
# Install the bundled config into $HOME/.config/opencode at startup, from
# fork.mjs rather than an entrypoint script: an entrypoint is overridden by
# `docker compose run --entrypoint node`, and the migration runs that way.
ENV REMOTE_MEM_INSTALL_CONFIG=1
# transformers.js refuses to download into a custom cache dir, so pinning these
# only moves the cache; the env vars are what actually keep it on the volume.
# The npm cache above needs the same treatment for the reason given there.

# The fork first, so the dependency layer is cached across rebuilds that only
# touch the service code.
#
# The fork's `prepare` script is `husky` -- a git-hook installer, of no use here.
# npm runs `prepare` on install, and with --omit=dev husky is not installed, so
# the shell reports `husky: not found` and npm exits 127. HUSKY=0 cannot help:
# an env var read by a binary does not install that binary. So drop the script
# rather than the flag. --ignore-scripts is NOT an option, because
# onnxruntime-node's own postinstall is what fetches the native binary.
COPY fork/ /app/fork/

# The platform check must exist before the step that runs it, and so must the
# fork loader -- verify-platform.mjs is not the only RUN-time script any more.
# Docker executes in file order, so these COPYs sit ABOVE the install RUN: an
# earlier version listed one of them below, and the build failed with
# MODULE_NOT_FOUND on a path that was correct in every other respect.
# Absolute in the RUN, because the RUN cds to /app/fork.
COPY verify-platform.mjs fork.mjs /app/

# One RUN, and the platform check is a script rather than a chain of bare
# `test -d`: two bare tests had already failed the build, and the second time
# they failed with exit code 1 and no word about WHICH package was absent.
# The failure mode this guards is real -- a platform with no native engine would
# otherwise reach a client's first write instead of failing the build -- but it
# has to name itself when it fires.
#
# The install is retried. onnxruntime-node pulls a ~100 MB native package from
# nuget during its postinstall, and this server's connection was reset mid-
# transfer twice in a row (read ECONNRESET) -- long enough to look like a defect
# and short enough that a retry succeeds. node_modules is removed between
# attempts so a half-installed tree cannot satisfy the next one and let a broken
# build through; the last attempt's failure is the one that decides the exit code.
RUN cd /app/fork \
 && npm pkg delete scripts.prepare \
 && attempt=1 \
 && until HUSKY=0 npm install --omit=dev --no-audit --no-fund \
       && node /app/verify-platform.mjs; do \
      if [ "$attempt" -ge 5 ]; then rm -rf /tmp/npm; exit 1; fi; \
      echo "install attempt $attempt failed; retrying after a short pause"; \
      rm -rf node_modules /tmp/npm; \
      sleep $((attempt * 15)); \
      attempt=$((attempt + 1)); \
    done \
 && rm -rf /tmp/npm

COPY server.mjs fork.mjs check.mjs check-migrate.mjs migrate.mjs package.json /app/
COPY config/ /app/config/

# The bundle's manifest goes in with the code. It carries the digest of every
# other bundled file, so an image built from an older bundle is detectable
# instead of surfacing as MODULE_NOT_FOUND on a script that simply was not in it
# -- the same staleness the bundle digest catches one level up, one level down.
COPY manifest.json /app/manifest.json

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4747/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
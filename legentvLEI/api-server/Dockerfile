################################################################################
# api-server/Dockerfile  -  Phase 1 containerisation of the vLEI verification /
# IPEX API server.
#
# DESIGN (read this before changing anything)
#
#   The image is SELF-CONTAINED at /app. The repo is NOT baked in - it is
#   bind-mounted at /vlei-repo at runtime and located via the VLEI_DIR env var.
#
#   Why not just bind-mount ./ over the app too?
#     api-server/node_modules on the host is WINDOWS-BUILT. Bind-mounting the
#     repo over the app directory would drag those into the container, where
#     they are wrong (and for anything with a native/wasm asset, broken). The
#     usual workaround is an anonymous volume shadowing node_modules, which
#     silently goes stale the moment package.json changes. Splitting app (/app,
#     Linux-built, immutable) from data (/vlei-repo, bind-mounted, mutable) has
#     neither problem.
#
#   That split is what server.js's VLEI_DIR override exists for. With VLEI_DIR
#   unset the server behaves exactly as before (repo-relative ../).
#
#   The container drives the other containers through /var/run/docker.sock with
#   plain `docker exec` - never `docker compose exec`, which would need a
#   compose project context this container does not have. That is the whole
#   point of Phase 0 fix D0-2.
#
# BUILD ARGS (all overridable - see docker-compose.yml)
#   NODE_VERSION         Node major/tag for the base image.      default 22
#   DOCKER_CLI_VERSION   Static docker CLI to install.           default 27.5.1
#   NPM_INSTALL_FLAGS    Extra flags for `npm ci`.               default --omit=dev
#
# RUNTIME ENV (see docker-compose.yml for the values actually used)
#   PORT        listen port                                      default 4000
#   VLEI_DIR    repo root inside the container                   default /vlei-repo
#
# NOTE ON UID/GID
#   This image does NOT bake in a user. docker-compose.yml sets
#   `user: "${UID}:${GID}"` so files written into the bind-mounted ./task-data
#   are owned by you and stay interoperable with tsx-shell, which runs as the
#   same pair. Socket access is granted with compose's `group_add`, NOT by
#   creating a docker group here - the socket's GID is a property of the HOST,
#   so it must be supplied at run time, not build time.
################################################################################

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm-slim

ARG DOCKER_CLI_VERSION=27.5.1
ARG NPM_INSTALL_FLAGS=--omit=dev

# ---------------------------------------------------------------------------
# Runtime tools the bundled shell scripts actually invoke.
#   bash    - the scripts are #!/bin/bash, not sh
#   jq      - every task script parses task-data/*.json with it
#   curl    - health probes + OOBI resolution
#   openssl - bran/salt generation
#   ca-certificates - TLS for the above
# ---------------------------------------------------------------------------
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        bash jq curl openssl ca-certificates; \
    rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Docker CLI ONLY (no daemon, no compose plugin).
#
# Installed from the official static tarball rather than Debian's `docker.io`
# package, because that package pulls in the whole engine - ~250MB of daemon we
# would never start. The compose plugin is deliberately absent: if a script
# ever regresses to `docker compose exec`, it should fail loudly here rather
# than half-work.
# ---------------------------------------------------------------------------
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
        amd64) dockerArch='x86_64' ;; \
        arm64) dockerArch='aarch64' ;; \
        *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/docker.tgz \
        "https://download.docker.com/linux/static/stable/${dockerArch}/docker-${DOCKER_CLI_VERSION}.tgz"; \
    tar -xzf /tmp/docker.tgz -C /usr/local/bin --strip-components=1 docker/docker; \
    rm -f /tmp/docker.tgz; \
    docker --version

WORKDIR /app

# ---------------------------------------------------------------------------
# Dependencies first, so a source-only edit does not re-resolve the tree.
# `npm ci` (not `npm install`) so package-lock.json is authoritative and the
# libsodium-wrappers-sumo override in package.json is honoured deterministically.
# ---------------------------------------------------------------------------
COPY package.json package-lock.json ./
RUN npm ci ${NPM_INSTALL_FLAGS} && npm cache clean --force

COPY . .

ENV NODE_ENV=production \
    PORT=4000 \
    VLEI_DIR=/vlei-repo

EXPOSE 4000

HEALTHCHECK --interval=5s --timeout=3s --retries=6 --start-period=10s \
    CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "server.js"]

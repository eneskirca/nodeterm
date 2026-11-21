# nodeterm Server Edition — container image (browser canvas backed by the headless server).
#
# The one real trap in here is node-pty's ABI: the repo's `postinstall` runs
# `electron-rebuild -f -w node-pty`, which compiles node-pty against ELECTRON's ABI — but the
# server runs under plain `node`, which would crash at boot with a NODE_MODULE_VERSION mismatch.
# So every npm install below uses --ignore-scripts and the deps stage compiles node-pty against
# Node's own ABI with an explicit `npm rebuild node-pty`. Keep the deps and runtime stages on the
# SAME Node major (the compiled binary must match the runtime ABI). smart-whisper is the second
# addon with the same problem and one difference: --ignore-scripts skips its build too, and
# without it local dictation is dead ("the smart-whisper module is not installed"), so it is
# rebuilt beside node-pty.
#
# TLS is terminated by the reverse proxy in front (Dokploy/Traefik, nginx, Caddy…): the server
# speaks plain HTTP inside the Docker network, which is why CMD passes --insecure-http (the
# server refuses a non-loopback bind without it). It sets the Secure cookie flag by itself when
# the proxy forwards X-Forwarded-Proto: https. Do NOT publish the container port directly on a
# public interface.

# ---- build: renderer + server bundle (needs devDependencies, no native builds) ----
FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts skips electron-rebuild AND electron's own binary download (not needed to build)
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build && npm run server:build

# ---- deps: production node_modules with node-pty compiled for Node (toolchain lives here) ----
FROM node:22-bookworm AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm rebuild node-pty smart-whisper

# ---- runtime: slim image, no compilers ----
FROM node:22-bookworm-slim
# tmux: terminal session continuity (without it PtyManager falls back to a plain shell).
# git: the Source Control panel. curl: the managed agent-hook scripts POST through it,
# and the HEALTHCHECK uses it. ca-certificates: git/curl over https.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tmux git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/out ./out
COPY package.json ./

# Auth, sessions, workspace, settings and scrollback snapshots live here — mount a volume or
# every restart forgets the password and the canvas. NOTE: the tmux server itself lives INSIDE
# the container, so a container restart/redeploy kills all tmux sessions (unlike the desktop,
# where only a machine reboot does); the cold-restore path replays scrollback and resumes
# resumable agents from /data on the next attach.
ENV NODETERM_DATA_DIR=/data \
    NODETERM_HOST=0.0.0.0 \
    NODETERM_PORT=8443
VOLUME /data
EXPOSE 8443

# /login is served without auth — a cheap liveness probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
    CMD curl -fsS "http://127.0.0.1:${NODETERM_PORT}/login" > /dev/null || exit 1

# Seed the first-boot password via NODETERM_SERVER_PASSWORD (ignored once one exists) — with no
# TTY attached nobody would see the printed one-time setup URL. Exec form: node is PID 1, so
# docker stop's SIGTERM reaches it directly.
CMD ["node", "out/server/main.cjs", "--insecure-http"]

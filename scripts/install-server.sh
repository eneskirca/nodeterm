#!/usr/bin/env bash
#
# nodeterm headless notification host — one-line installer / updater.
#
#   curl -fsSL https://raw.githubusercontent.com/eneskirca/nodeterm/main/scripts/install-server.sh | bash
#
# Installs (or updates) the nodeterm Server Edition on this Linux host and runs it in HEADLESS
# mode (NODETERM_HEADLESS=1): it boots every core service — the loopback hook server, agent-status
# mirror, usage poll and the granted push senders — but binds NO public HTTP/WS listener, so there
# are ZERO open ports. A phone that SSHes into this host and drops a push grant gets full push /
# Live-Activity coverage for as long as the service runs. See docs/SERVER.md.
#
# Idempotent: re-run it any time to pull the latest code, rebuild, and restart the service.
set -euo pipefail

# systemd SYSTEM units run with no HOME in their environment — the nightly auto-update oneshot
# re-execs this script exactly that way, and `set -u` turned the bare $HOME below into a hard
# stop (the pull succeeded but the rebuild/restart never ran, leaving the service on a stale
# build). Resolve it from the passwd db when absent; npm/git below need it exported too.
HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"
export HOME

REPO_URL="${NODETERM_REPO_URL:-https://github.com/eneskirca/nodeterm}"
APP_DIR="${NODETERM_APP_DIR:-$HOME/.nodeterm-server-app}"
# Where the running server keeps its state (auth, sessions, workspace, scrollback). Matches the
# server's own default (src/server/config.ts) so the install-meta.json we write below lands where
# the server reads it. Override with NODETERM_DATA_DIR (mirror the same override into the service if
# you use one).
DATA_DIR="${NODETERM_DATA_DIR:-$HOME/.nodeterm-server}"
SERVICE_NAME="nodeterm-server"
UPDATE_SERVICE_NAME="nodeterm-server-update"
MIN_NODE_MAJOR=20
# When the system Node is missing or too old we provision this pinned LTS privately (see ensure_node).
# v22.14.0 is a Node 22 "Jod" LTS release. Override with NODETERM_NODE_VERSION for a different pin.
NODE_LTS_VERSION="${NODETERM_NODE_VERSION:-v22.14.0}"
NODE_DIST_BASE="${NODETERM_NODE_DIST_BASE:-https://nodejs.org/dist}"

# ---- pretty output ---------------------------------------------------------------------------
# Colour only on a terminal (and not under NO_COLOR): this output is also captured — the desktop's
# "Share with team" dialog streams it over an ssh exec channel with no pty, and the nightly update
# writes it to the journal — where escape codes arrive as literal text.
color_out=''; color_err=''
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then color_out=1; fi
if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then color_err=1; fi
# mark <enabled> <colour> <glyph>
mark() { if [ -n "$1" ]; then printf '\033[%sm%s\033[0m' "$2" "$3"; else printf '%s' "$3"; fi; }
info() { printf '%s %s\n' "$(mark "$color_out" 36 →)" "$1"; }
ok()   { printf '%s %s\n' "$(mark "$color_out" 32 ✓)" "$1"; }
warn() { printf '%s %s\n' "$(mark "$color_err" 33 ⚠)" "$1" >&2; }
fail() { printf '%s %s\n' "$(mark "$color_err" 31 ✗)" "$1" >&2; exit 1; }

# ---- preflight: OS + required tools ----------------------------------------------------------
[ "$(uname -s)" = "Linux" ] || fail "The headless host targets Linux (systemd). For macOS run the desktop app; for containers use the Dockerfile (see docs/SERVER.md)."

command -v git >/dev/null 2>&1 || fail "git is not installed. Install it first (e.g. 'sudo apt install git' or 'sudo dnf install git')."

# ---- Node.js: use a good-enough system install, else provision a private one --------------------
# Sets NODE_BIN (absolute — used by npm ci, the node-pty rebuild, and the systemd ExecStart) and,
# when it provisions, prepends its bin to PATH so `node`/`npm`/`npx`/build scripts all use it. This
# is what makes the one-tap iOS install flow work on a host whose system Node is missing or < 20.
ensure_node() {
  # 1. A good-enough system Node (>= MIN_NODE_MAJOR, with npm)? Use it unchanged — today's behavior.
  if command -v node >/dev/null 2>&1; then
    local sys_node sys_major
    sys_node="$(command -v node)"
    sys_major="$("$sys_node" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [ "$sys_major" -ge "$MIN_NODE_MAJOR" ] && command -v npm >/dev/null 2>&1; then
      NODE_BIN="$sys_node"
      ok "Using system Node.js $("$NODE_BIN" -v)"
      return
    fi
    if [ "$sys_major" -ge "$MIN_NODE_MAJOR" ]; then
      warn "System Node.js $("$sys_node" -v) found but npm is missing — provisioning a private Node runtime instead."
    else
      info "System Node.js $("$sys_node" -v) is older than v${MIN_NODE_MAJOR} — provisioning Node ${NODE_LTS_VERSION} privately (no system changes)."
    fi
  else
    info "Node.js not found — provisioning Node ${NODE_LTS_VERSION} privately (no system changes)."
  fi

  # 2. Provision the pinned Node LTS under the app dir. Map uname → nodejs.org dist naming.
  local os arch runtime_dir node_bin
  case "$(uname -s)" in
    Linux)  os="linux" ;;
    Darwin) os="darwin" ;;
    *) fail "Automatic Node provisioning supports Linux and macOS only (found $(uname -s)). Install Node.js >= ${MIN_NODE_MAJOR} manually and re-run." ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)  arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) fail "Automatic Node provisioning supports x64 and arm64 only (found $(uname -m)). Install Node.js >= ${MIN_NODE_MAJOR} manually and re-run." ;;
  esac

  # The official tarballs are glibc-linked; musl (Alpine) can't run them.
  if [ "$os" = "linux" ] && { [ -f /etc/alpine-release ] || ldd --version 2>&1 | grep -qi musl; }; then
    fail "This host uses musl libc (e.g. Alpine); the official Node.js binaries need glibc. Install Node.js >= ${MIN_NODE_MAJOR} via your package manager (e.g. 'apk add nodejs npm') and re-run."
  fi

  runtime_dir="$APP_DIR/runtime/node"
  node_bin="$runtime_dir/bin/node"

  # Idempotent: reuse an existing extract only when it is exactly the pinned version.
  if [ -x "$node_bin" ] && [ "$("$node_bin" -v 2>/dev/null)" = "$NODE_LTS_VERSION" ]; then
    ok "Node ${NODE_LTS_VERSION} already provisioned at $runtime_dir"
  else
    local tarname url tmp free_kb
    tarname="node-${NODE_LTS_VERSION}-${os}-${arch}"
    url="${NODE_DIST_BASE}/${NODE_LTS_VERSION}/${tarname}.tar.gz"
    rm -rf "$runtime_dir"                 # clear any partial / stale (wrong-version) extract
    mkdir -p "$runtime_dir"
    # Download NEXT TO the destination, not /tmp: small/full tmpfs /tmp (50 MB on some VPSes)
    # made the ~30 MB tarball download die with "curl: (23) Failure writing output" — a field
    # report. Same filesystem also makes the extract cheaper. Preflight ~600 MB free for
    # tarball + extract + the app build that follows, with a readable failure.
    tmp="$APP_DIR/runtime/.download"
    rm -rf "$tmp" && mkdir -p "$tmp"
    free_kb=$(df -Pk "$APP_DIR" 2>/dev/null | awk 'NR==2 {print $4}')
    if [ -n "$free_kb" ] && [ "$free_kb" -lt 614400 ] 2>/dev/null; then
      rm -rf "$tmp" "$runtime_dir"
      fail "Not enough disk space in $APP_DIR ($(( free_kb / 1024 )) MB free, need ~600 MB). Free up space and re-run."
    fi
    info "Downloading Node ${NODE_LTS_VERSION} (${os}-${arch}) from ${url}"
    if ! curl -fsSL "$url" -o "$tmp/node.tar.gz"; then
      rm -rf "$tmp" "$runtime_dir"
      fail "Failed to download Node.js from ${url}. Check the host's network / DNS / disk space and re-run."
    fi
    if ! tar -xzf "$tmp/node.tar.gz" -C "$runtime_dir" --strip-components=1; then
      rm -rf "$tmp" "$runtime_dir"
      fail "Failed to extract the Node.js tarball. Ensure 'tar' (with gzip) is installed and re-run."
    fi
    rm -rf "$tmp"
  fi

  # 3. Verify the binary runs before we depend on it, then put it first on PATH so npm/npx/build use it.
  if ! "$node_bin" --version >/dev/null 2>&1; then
    rm -rf "$runtime_dir"
    fail "The provisioned Node.js binary at $node_bin does not run on this host. Install Node.js >= ${MIN_NODE_MAJOR} manually and re-run."
  fi
  NODE_BIN="$node_bin"
  export PATH="$runtime_dir/bin:$PATH"
  ok "Provisioned Node $("$NODE_BIN" -v) at $runtime_dir"
}

# node-pty is a native module and is (re)built from source against Node's ABI, which needs a C/C++
# toolchain + python3. Missing tools → warn with the install one-liner, but don't hard-fail: if a
# prebuilt binary is available the build still succeeds.
MISSING_BUILD=""
for tool in make gcc python3; do
  command -v "$tool" >/dev/null 2>&1 || MISSING_BUILD="$MISSING_BUILD $tool"
done
if [ -n "$MISSING_BUILD" ]; then
  warn "Missing build tools for the node-pty native module:$MISSING_BUILD"
  warn "  Debian/Ubuntu:  sudo apt install -y build-essential python3"
  warn "  Fedora/RHEL:    sudo dnf install -y make gcc gcc-c++ python3"
  warn "Continuing — install them and re-run this script if the build below fails."
fi

# tmux is what makes terminal sessions survive restarts; the server falls back to a plain shell
# without it. Not fatal for a notification host, but worth flagging.
command -v tmux >/dev/null 2>&1 || warn "tmux is not installed — terminal sessions won't survive restarts (install 'tmux' for continuity)."

# ---- clone or update -------------------------------------------------------------------------
if [ -d "$APP_DIR/.git" ]; then
  info "Updating existing checkout in $APP_DIR"
  git -C "$APP_DIR" fetch --depth 1 origin main
  git -C "$APP_DIR" reset --hard origin/main
else
  [ -e "$APP_DIR" ] && fail "$APP_DIR exists but is not a git checkout. Remove it and re-run, or set NODETERM_APP_DIR."
  info "Cloning $REPO_URL into $APP_DIR"
  git clone --depth 1 "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"

# ---- Node.js runtime (system if good enough, else provision under $APP_DIR/runtime/node) ------
# Runs AFTER the clone so the runtime lives inside the checkout without tripping the clone's
# "dir already exists" guard; the untracked runtime/ survives `git reset --hard` on later updates.
ensure_node

# ---- install deps + build --------------------------------------------------------------------
# The repo's postinstall runs electron-rebuild (targets ELECTRON's ABI). The server runs under
# plain Node, so we --ignore-scripts and rebuild node-pty against Node's own ABI afterwards. Same
# trap the Dockerfile documents — see docs/SERVER.md.
info "Installing dependencies (npm ci --ignore-scripts)…"
npm ci --ignore-scripts

info "Building renderer + server bundle…"
npm run build
npm run server:build

info "Rebuilding node-pty against Node's ABI…"
npm rebuild node-pty

[ -f "$APP_DIR/out/server/main.cjs" ] || fail "Build did not produce out/server/main.cjs — check the output above."

# ---- install metadata (surfaced to the phone via the agent-status mirror's `server` block) -----
# The server reads <DATA_DIR>/install-meta.json at boot (src/server/index.ts readInstallMeta) and
# advertises {version, commit, installedAt} to a paired phone, so a connection can show which
# version this install is on. Written only after a successful build above.
write_install_meta() {
  local meta_file commit version now
  meta_file="$DATA_DIR/install-meta.json"
  commit="$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  version="$("$NODE_BIN" -p "require('$APP_DIR/package.json').version" 2>/dev/null || echo 0.0.0)"
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  mkdir -p "$DATA_DIR"
  cat > "$meta_file" <<META
{
  "commit": "$commit",
  "installedAt": "$now",
  "version": "$version"
}
META
  ok "Wrote install metadata to $meta_file (commit $commit, v$version)"
}
write_install_meta

# ---- install + (re)start the systemd service -------------------------------------------------
UNIT_DESC="nodeterm headless notification host"

write_unit() {
  # $1 = target unit path
  cat > "$1" <<UNIT
[Unit]
Description=$UNIT_DESC
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=NODETERM_HEADLESS=1
ExecStart=$NODE_BIN $APP_DIR/out/server/main.cjs
Restart=on-failure
RestartSec=5
# KillMode=process is LOAD-BEARING: the default control-group kill would SIGTERM every
# process the service ever spawned — including the tmux server holding the user's live
# agent sessions — so each restart (installer re-run, the nightly auto-update timer)
# silently killed every session and their resumed turns re-emitted duplicate done
# notifications. Only the node process dies on restart; tmux and its sessions survive.
KillMode=process
# Logs go to journald (journalctl); StandardOutput/Error default to journal.

[Install]
WantedBy=$2
UNIT
}

# ---- auto-update: a oneshot service + daily timer --------------------------------------------
# The timer fires the oneshot service ~daily (randomized). The service pulls the latest code and
# then RE-EXECS the freshly-pulled install-server.sh — so the updater logic updates itself. The
# installer is idempotent, so a no-op pull (already current) is harmless. Opt out with
# NODETERM_NO_AUTOUPDATE=1 (see the branches below), which also removes an existing timer.
write_update_units() {
  # $1 = target unit directory (system-wide or per-user)
  cat > "$1/${UPDATE_SERVICE_NAME}.service" <<UNIT
[Unit]
Description=$UNIT_DESC — auto-update
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$APP_DIR
# git pull to update the checkout (incl. THIS updater script), then re-exec the pulled installer,
# which rebuilds and restarts the service. Absolute paths are baked in at write time.
ExecStart=/bin/sh -c 'cd "$APP_DIR" && git pull --ff-only && exec bash "$APP_DIR/scripts/install-server.sh"'
UNIT
  cat > "$1/${UPDATE_SERVICE_NAME}.timer" <<UNIT
[Unit]
Description=$UNIT_DESC — daily auto-update check

[Timer]
OnCalendar=daily
# Spread the load off exactly-midnight and de-sync fleets.
RandomizedDelaySec=3600
# Catch up a run missed while the host was off.
Persistent=true

[Install]
WantedBy=timers.target
UNIT
}

if [ "$(id -u)" = "0" ]; then
  # Root install: system-wide unit.
  UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
  info "Installing system service at $UNIT_PATH"
  write_unit "$UNIT_PATH" "multi-user.target"
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  systemctl restart "$SERVICE_NAME"
  ok "Service installed and (re)started."

  # Auto-update timer (system-wide). Opt out with NODETERM_NO_AUTOUPDATE=1, which also removes an
  # existing timer so a re-run can turn auto-update off.
  UPDATE_UNIT_DIR="/etc/systemd/system"
  if [ -n "${NODETERM_NO_AUTOUPDATE:-}" ]; then
    systemctl disable --now "${UPDATE_SERVICE_NAME}.timer" >/dev/null 2>&1 || true
    rm -f "$UPDATE_UNIT_DIR/${UPDATE_SERVICE_NAME}.service" "$UPDATE_UNIT_DIR/${UPDATE_SERVICE_NAME}.timer"
    systemctl daemon-reload
    info "Auto-update disabled (NODETERM_NO_AUTOUPDATE set)."
  else
    write_update_units "$UPDATE_UNIT_DIR"
    systemctl daemon-reload
    systemctl enable --now "${UPDATE_SERVICE_NAME}.timer"
    ok "Auto-update timer installed (daily; opt out with NODETERM_NO_AUTOUPDATE=1)."
  fi
  echo
  systemctl --no-pager status "$SERVICE_NAME" || true
  echo
  [ -z "${NODETERM_NO_AUTOUPDATE:-}" ] && { systemctl --no-pager list-timers "${UPDATE_SERVICE_NAME}.timer" || true; echo; }
  info "Logs:   journalctl -u $SERVICE_NAME -f"
  info "Update: automatic (daily timer) or re-run this script."
else
  # Non-root install: per-user unit + linger so it runs without an active login session.
  command -v systemctl >/dev/null 2>&1 || fail "systemctl not found — a systemd host is required for the service. (You can still run it manually: NODETERM_HEADLESS=1 node $APP_DIR/out/server/main.cjs)"
  UNIT_DIR="$HOME/.config/systemd/user"
  UNIT_PATH="$UNIT_DIR/${SERVICE_NAME}.service"
  info "Installing user service at $UNIT_PATH"
  mkdir -p "$UNIT_DIR"
  write_unit "$UNIT_PATH" "default.target"
  # enable-linger keeps the user manager (and the service) alive across logout / reboot.
  loginctl enable-linger "$(id -un)" 2>/dev/null || warn "Could not enable linger — the service may stop when you log out."
  systemctl --user daemon-reload
  systemctl --user enable "$SERVICE_NAME"
  systemctl --user restart "$SERVICE_NAME"
  ok "Service installed and (re)started."

  # Auto-update timer (per-user). Linger (enabled above) keeps the user manager running so the
  # timer fires without an active login. Opt out with NODETERM_NO_AUTOUPDATE=1.
  if [ -n "${NODETERM_NO_AUTOUPDATE:-}" ]; then
    systemctl --user disable --now "${UPDATE_SERVICE_NAME}.timer" >/dev/null 2>&1 || true
    rm -f "$UNIT_DIR/${UPDATE_SERVICE_NAME}.service" "$UNIT_DIR/${UPDATE_SERVICE_NAME}.timer"
    systemctl --user daemon-reload
    info "Auto-update disabled (NODETERM_NO_AUTOUPDATE set)."
  else
    write_update_units "$UNIT_DIR"
    systemctl --user daemon-reload
    systemctl --user enable --now "${UPDATE_SERVICE_NAME}.timer"
    ok "Auto-update timer installed (daily; opt out with NODETERM_NO_AUTOUPDATE=1)."
  fi
  echo
  systemctl --user --no-pager status "$SERVICE_NAME" || true
  echo
  [ -z "${NODETERM_NO_AUTOUPDATE:-}" ] && { systemctl --user --no-pager list-timers "${UPDATE_SERVICE_NAME}.timer" || true; echo; }
  info "Logs:   journalctl --user -u $SERVICE_NAME -f"
  info "Update: automatic (daily timer) or re-run this script."
fi

echo
ok "nodeterm headless notification host is running (NODETERM_HEADLESS=1 — zero open ports)."

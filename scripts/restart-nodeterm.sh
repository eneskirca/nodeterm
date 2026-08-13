#!/usr/bin/env bash
# restart-nodeterm.sh — rebuild nodeterm from THIS worktree's branch, kill the running
# nodeterm, and launch the freshly built one from source. Safe to run from INSIDE a
# nodeterm session: the new app is fully detached (nohup + disown) so it survives the
# old session (and the shell that ran this script) being killed.
#
# Order matters: we BUILD first (while anything can still log), THEN kill, THEN launch.
# A build failure exits non-zero and leaves the running nodeterm untouched.
#
# Usage:  ./scripts/restart-nodeterm.sh             # build, kill, launch
#         ./scripts/restart-nodeterm.sh --no-build  # skip the build (reuse existing out/)
#         ./scripts/restart-nodeterm.sh --no-kill   # build + launch without killing (two will run)
set -euo pipefail

cd "$(dirname "$0")/.."

BUILD=1
KILL=1
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --no-kill) KILL=0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# --- 1. Build (renderer + main) -------------------------------------------------
# Done BEFORE killing so a build failure leaves the running app alive. `electron-vite build`
# emits ./out/{main,preload,renderer}; native modules (node-pty, smart-whisper) are already
# rebuilt against this node_modules (see postinstall), so no electron-rebuild here.
if [[ "$BUILD" -eq 1 ]]; then
  echo "→ Building from this branch (npm run build)…"
  npm run build
fi

# --- 2. Locate the Electron binary ---------------------------------------------
ELECTRON_BIN="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if [[ ! -x "$ELECTRON_BIN" ]]; then
  echo "✗ Electron binary not found at $ELECTRON_BIN" >&2
  echo "  Run:  node node_modules/electron/install.js" >&2
  exit 1
fi

# --- 3. Kill any running nodeterm ------------------------------------------------
# The installed app's main process is named "nodeterm"; a from-source run is the Electron
# binary under a repo's node_modules. Scope the Electron match to THIS repo path so we
# don't touch unrelated Electron apps (VS Code, Slack, etc.). Tolerate absence.
if [[ "$KILL" -eq 1 ]]; then
  echo "→ Stopping running nodeterm…"
  pkill -x nodeterm 2>/dev/null || true
  pkill -f "node_modules/electron/dist/Electron.app" 2>/dev/null || true
  this_repo=$(pwd | sed 's/[\/&]/\\&/g')
  pkill -f "Electron.app/Contents/MacOS/Electron.*${this_repo}" 2>/dev/null || true
  sleep 1   # let the OS reclaim the single-instance lock + user-data-dir handle
fi

# --- 4. Launch (fully detached) -------------------------------------------------
# nohup + disown detaches the new app from this shell's session and SIGHUP, so it keeps
# running after this shell (and, if we were launched from inside nodeterm, the old nodeterm
# session) exits. Logs go to /tmp/nodeterm-dev.log.
echo "→ Launching nodeterm from this branch…"
LOG=/tmp/nodeterm-dev.log
nohup "$ELECTRON_BIN" . >"$LOG" 2>&1 &
disown
echo "✓ Launched (pid $!). Logs: $LOG"

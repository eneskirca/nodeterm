#!/usr/bin/env bash
# run-dev.sh — kill the running nodeterm and launch a fresh one from this branch.
#
# Kills the installed /Applications/nodeterm.app and any `electron-vite dev` instance,
# builds the renderer+main (npm run build — native modules like node-pty ship N-API
# prebuilds, so electron-rebuild is NOT needed), then launches the Electron binary
# against the built out/ with this branch's code. Logs to stdout/stderr.
#
# Usage:  ./scripts/run-dev.sh          # build, then run
#         ./scripts/run-dev.sh --no-build   # skip the build (reuse existing out/)
set -euo pipefail

cd "$(dirname "$0")/.."

BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# --- 1. Kill any running nodeterm -----------------------------------------------
# The installed app's main process is literally named "nodeterm"; a `dev` run is the
# Electron binary (path contains node_modules/electron). Kill both, tolerate absence.
echo "→ Stopping running nodeterm…"
pkill -x nodeterm 2>/dev/null || true
pkill -f "node_modules/electron/dist/Electron.app" 2>/dev/null || true
# `electron-vite dev` spawns an Electron whose app name is "Electron"; scope the match
# to our repo's node_modules so we don't touch other Electron apps (VS Code, etc.).
pkill -f "Electron.app/Contents/MacOS/Electron.*$(pwd | sed 's/[\/&]/\\&/g')" 2>/dev/null || true
sleep 1   # let the OS reclaim the single-instance lock + user-data-dir handle

# --- 2. Build (renderer + main) -------------------------------------------------
if [[ "$BUILD" -eq 1 ]]; then
  echo "→ Building (npm run build)…"
  npm run build
fi

# --- 3. Locate the Electron binary ---------------------------------------------
ELECTRON_BIN="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if [[ ! -x "$ELECTRON_BIN" ]]; then
  echo "✗ Electron binary not found at $ELECTRON_BIN" >&2
  echo "  Run:  node node_modules/electron/install.js" >&2
  exit 1
fi

# --- 4. Launch -----------------------------------------------------------------
# Electron loads `main` from package.json (./out/main/index.js). Running from the repo
# root with our binary uses this branch's built code, NOT /Applications/nodeterm.app.
echo "→ Launching nodeterm from this branch…"
exec "$ELECTRON_BIN" .

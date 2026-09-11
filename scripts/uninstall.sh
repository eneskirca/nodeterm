#!/usr/bin/env bash
# nodeterm uninstaller — removes the app and every trace it leaves on this machine.
#
#   curl -fsSL https://nodeterm.dev/uninstall.sh | bash -s -- --dry-run   # list what would happen
#   curl -fsSL https://nodeterm.dev/uninstall.sh | bash -s -- --yes       # actually uninstall
#   bash scripts/uninstall.sh                                             # interactive (asks first)
# (a piped bash has no interactive stdin, so the piped form requires an explicit --yes)
#
# What it does, in order:
#   1. PLAN: inspects the machine and prints everything it found (processes, tmux sessions,
#      files, config entries in other tools' files). --dry-run stops here.
#   2. Stops processes cleanly: the desktop app, the Server Edition systemd units, the tmux
#      servers on nodeterm's private sockets (node-terminal / nodeterm-rmt), lingering SSH
#      ControlMasters.
#   3. Reverts the integration nodeterm merged into OTHER tools' config — idempotently, using
#      the same markers the installer wrote, never touching entries that aren't ours:
#        ~/.claude/settings.json      managed hook entries (marker: agent-hooks / claude-signals)
#        ~/.claude/skills/…           the two nodeterm-owned skill dirs
#        ~/.gemini/settings.json      managed hook entries
#        ~/.gemini/GEMINI.md          <!-- nodeterm:… --> marker blocks
#        ~/.codex/hooks.json          managed hook entries + config.toml trust entries
#        ~/.codex/AGENTS.md           marker blocks
#        ~/.copilot/hooks/nodeterm-status.json (owned file) + copilot-instructions.md blocks
#        ~/.grok/hooks/nodeterm-status.json    (owned file)
#        ~/.config/opencode/plugins/nodeterm-status.js (owned, marker-checked) + AGENTS.md blocks
#      Your agents' credentials, sessions and own settings are never touched.
#   4. Deletes nodeterm's own state: ~/.nodeterm, the Electron user-data dir, caches, prefs,
#      logs, the Keychain entry, /Applications/nodeterm.app (or the brew cask), and the Server
#      Edition checkout + data dir if present.
#   5. Reports what it deliberately does NOT delete: the per-project `.nodeterm/` folders inside
#      your repos (they are your canvas layouts, and may be committed/shared), and anything on
#      remote SSH hosts.
#
# Notes:
#   - JSON/TOML surgery needs a JS runtime (node). Without one those entries are left in place
#     with a warning — they are harmless: the installed hook command is self-guarded and becomes
#     a silent no-op once the script it points to is deleted.
#   - macOS and Linux. On Windows use the NSIS uninstaller (Add/Remove Programs), then delete
#     %APPDATA%\nodeterm and %USERPROFILE%\.nodeterm.
set -u

DRY_RUN=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y)  ASSUME_YES=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//' | sed -n '2,40p'; exit 0 ;;
    *) printf 'Unknown option: %s (try --help)\n' "$arg" >&2; exit 2 ;;
  esac
done

OS="$(uname -s)"
info()  { printf '\033[36m→\033[0m %s\n' "$1"; }
ok()    { printf '\033[32m✓\033[0m %s\n' "$1"; }
warn()  { printf '\033[33m⚠\033[0m %s\n' "$1" >&2; }
plan()  { printf '  \033[33m•\033[0m %s\n' "$1"; }
note()  { printf '  \033[2m%s\033[0m\n' "$1"; }

HOME="${HOME:-$(cd ~ && pwd)}"

# ---- locations (must mirror what the app writes; see docs/uninstall.md) ----------------------
if [ "$OS" = "Darwin" ]; then
  USER_DATA="$HOME/Library/Application Support/nodeterm"
else
  USER_DATA="${XDG_CONFIG_HOME:-$HOME/.config}/nodeterm"
fi
NT_HOME="$HOME/.nodeterm"                       # agent-hooks, ssh-cm sockets, acks, push-grants…
SERVER_APP="${NODETERM_APP_DIR:-$HOME/.nodeterm-server-app}"
SERVER_DATA="${NODETERM_DATA_DIR:-$HOME/.nodeterm-server}"
APP_BUNDLE="/Applications/nodeterm.app"
GROK_HOME="${GROK_HOME:-$HOME/.grok}"
COPILOT_HOME="${COPILOT_HOME:-$HOME/.copilot}"
if [ -n "${XDG_CONFIG_HOME:-}" ] && [ "${XDG_CONFIG_HOME#\/}" != "$XDG_CONFIG_HOME" ]; then
  OPENCODE_DIR="$XDG_CONFIG_HOME/opencode"
else
  OPENCODE_DIR="$HOME/.config/opencode"
fi

# Markers the installers wrote — the uninstall keys off the SAME strings (see
# src/core/agents/hooks/install-helper.ts and src/core/canvas-control-core.ts).
HOOK_MARKERS='agent-hooks|claude-signals'
CC_START='<!-- nodeterm:manage-canvas:start -->'
CC_END='<!-- nodeterm:manage-canvas:end -->'
CL_START='<!-- nodeterm:get-linked-context:start -->'
CL_END='<!-- nodeterm:get-linked-context:end -->'
OPENCODE_PLUGIN_MARKER='nodeterm managed plugin'

# ---- JS runtime for JSON/TOML surgery --------------------------------------------------------
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [ -x "$SERVER_APP/runtime/node/bin/node" ]; then
  NODE_BIN="$SERVER_APP/runtime/node/bin/node"
fi

# jsedit <mode> <args…> — runs the embedded helper. Modes:
#   clean-hooks <settings.json>          remove managed entries (claude / gemini shape), print count
#   clean-codex <codexHome>              remove managed entries + drop/re-key trust entries
#   list-projects <workspace.json>       print each local project cwd (one per line)
jsedit() {
  [ -n "$NODE_BIN" ] || return 3
  "$NODE_BIN" - "$@" <<'JSEOF'
const fs = require('fs')
const path = require('path')
const [mode, target] = process.argv.slice(2)
const MARKER = /agent-hooks|claude-signals/

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// Remove managed entries from a claude/gemini-shaped settings.json:
// hooks[event] = [{ matcher?, hooks: [{ type, command }] }]. Returns removed count (dry=true
// leaves the file untouched).
function cleanHooks(file, dry) {
  const s = readJson(file)
  if (!s || !isObj(s.hooks)) return 0
  let removed = 0
  for (const ev of Object.keys(s.hooks)) {
    const defs = s.hooks[ev]
    if (!Array.isArray(defs)) continue
    const kept = []
    for (const def of defs) {
      if (isObj(def) && Array.isArray(def.hooks)) {
        const keptHooks = def.hooks.filter(
          (h) => !(isObj(h) && typeof h.command === 'string' && MARKER.test(h.command))
        )
        removed += def.hooks.length - keptHooks.length
        def.hooks = keptHooks
        if (keptHooks.length === 0) continue // the def existed only to carry our hook
      }
      kept.push(def)
    }
    if (kept.length === 0) delete s.hooks[ev]
    else s.hooks[ev] = kept
  }
  if (Object.keys(s.hooks).length === 0) delete s.hooks
  if (removed > 0 && !dry) fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n')
  return removed
}

// Codex: hooks.json carries our entries; config.toml gates each hook behind a
// [hooks.state."<realpath(hooks.json)>:<event_label>:<group>:<handler>"] trust block. Removing
// our entries shifts the indexes of any LATER user entries in the same event array, so their
// trust keys are re-keyed to the new indexes (trusted_hash covers content, not position).
function cleanCodex(codexHome, dry) {
  const hooksPath = path.join(codexHome, 'hooks.json')
  const tomlPath = path.join(codexHome, 'config.toml')
  const cfg = readJson(hooksPath)
  const out = { removedHooks: 0, removedTrust: 0, rekeyedTrust: 0 }
  if (!cfg || !isObj(cfg.hooks)) return out

  const LABEL = {
    SessionStart: 'session_start', UserPromptSubmit: 'user_prompt_submit',
    PreToolUse: 'pre_tool_use', PermissionRequest: 'permission_request',
    PostToolUse: 'post_tool_use', Stop: 'stop', PreCompact: 'pre_compact',
    PostCompact: 'post_compact'
  }
  const drop = new Set()   // "label:g:h" of our handlers
  const remap = new Map()  // "label:oldG:oldH" -> [newG, newH] for surviving handlers
  for (const ev of Object.keys(cfg.hooks)) {
    const label = LABEL[ev]
    const defs = cfg.hooks[ev]
    if (!label || !Array.isArray(defs)) continue
    let newG = 0
    const keptDefs = []
    defs.forEach((def, g) => {
      const handlers = isObj(def) && Array.isArray(def.hooks) ? def.hooks : null
      // A def with no handler array carries no trust entries — keep it, position advances.
      if (!handlers) { keptDefs.push(def); newG++; return }
      let newH = 0
      const keptHandlers = []
      handlers.forEach((h, hIdx) => {
        const ours = isObj(h) && typeof h.command === 'string' && MARKER.test(h.command)
        if (ours) { drop.add(`${label}:${g}:${hIdx}`); out.removedHooks++; return }
        remap.set(`${label}:${g}:${hIdx}`, [newG, newH])
        keptHandlers.push(h); newH++
      })
      if (keptHandlers.length === 0 && handlers.length > 0) return // def was entirely ours
      def.hooks = keptHandlers
      keptDefs.push(def); newG++
    })
    if (keptDefs.length === 0) delete cfg.hooks[ev]
    else cfg.hooks[ev] = keptDefs
  }
  if (out.removedHooks === 0) return out

  // Rewrite config.toml trust blocks that reference this hooks.json.
  let canonical = hooksPath
  try { canonical = fs.realpathSync.native(hooksPath) } catch {}
  let toml = null
  try { toml = fs.readFileSync(tomlPath, 'utf8') } catch {}
  if (toml !== null) {
    const lines = toml.split(/\r?\n/)
    const header = /^[ \t]*\[hooks\.state\."((?:[^"\\]|\\.)*)"\][ \t]*(?:#[^\r\n]*)?$/
    const outLines = []
    let skip = false
    for (let i = 0; i < lines.length; i++) {
      const m = header.exec(lines[i])
      if (!m) {
        if (skip && /^[ \t]*\[/.test(lines[i])) skip = false
        if (!skip) outLines.push(lines[i])
        continue
      }
      skip = false
      const key = m[1].replace(/\\(["\\])/g, '$1')
      // key = <sourcePath>:<label>:<g>:<h>; sourcePath may itself contain ':'
      const parts = key.split(':')
      const [h, g, label] = [parts.pop(), parts.pop(), parts.pop()]
      const src = parts.join(':')
      const matches = src === canonical || src === hooksPath
      const tail = `${label}:${g}:${h}`
      if (matches && drop.has(tail)) { skip = true; out.removedTrust++; continue }
      if (matches && remap.has(tail)) {
        const [ng, nh] = remap.get(tail)
        const newKey = `${src}:${label}:${ng}:${nh}`.replace(/([\\"])/g, '\\$1')
        outLines.push(lines[i].replace(header, `[hooks.state."${newKey}"]`))
        out.rekeyedTrust++
        continue
      }
      outLines.push(lines[i])
    }
    if (!dry && (out.removedTrust > 0 || out.rekeyedTrust > 0)) {
      fs.writeFileSync(tomlPath, outLines.join('\n'))
    }
  }

  if (!dry) {
    const onlyHooksKey = Object.keys(cfg).every((k) => k === 'hooks')
    if (Object.keys(cfg.hooks).length === 0 && onlyHooksKey) fs.unlinkSync(hooksPath)
    else fs.writeFileSync(hooksPath, JSON.stringify(cfg, null, 2) + '\n')
  }
  return out
}

function listProjects(file) {
  const ws = readJson(file)
  if (!ws) return []
  const cwds = new Set()
  const walk = (v) => {
    if (Array.isArray(v)) { v.forEach(walk); return }
    if (!isObj(v)) return
    if (typeof v.cwd === 'string' && v.cwd.startsWith('/')) cwds.add(v.cwd)
    Object.values(v).forEach(walk)
  }
  walk(ws)
  return [...cwds]
}

if (mode === 'clean-hooks') {
  process.stdout.write(String(cleanHooks(target, false)))
} else if (mode === 'clean-codex') {
  const r = cleanCodex(target, false)
  process.stdout.write(`${r.removedHooks} ${r.removedTrust} ${r.rekeyedTrust}`)
} else if (mode === 'list-projects') {
  process.stdout.write(listProjects(target).join('\n'))
} else {
  process.exit(2)
}
JSEOF
}

# strip_blocks <file> — remove every nodeterm marker block; delete the file if only whitespace
# remains (the installer created it in that case).
strip_blocks() {
  local f="$1" tmp
  [ -f "$f" ] || return 0
  tmp="$(mktemp)"
  awk -v s1="$CC_START" -v e1="$CC_END" -v s2="$CL_START" -v e2="$CL_END" '
    index($0, s1) || index($0, s2) { skip = 1 }
    !skip { print }
    index($0, e1) || index($0, e2) { skip = 0 }
  ' "$f" > "$tmp"
  if ! cmp -s "$f" "$tmp"; then
    if [ -z "$(tr -d '[:space:]' < "$tmp")" ]; then
      rm -f "$f"
      ok "Removed $f (contained only nodeterm blocks)"
    else
      cat "$tmp" > "$f"
      ok "Removed nodeterm blocks from $f"
    fi
  fi
  rm -f "$tmp"
}

has_blocks() {
  [ -f "$1" ] || return 1
  grep -qF "$CC_START" "$1" 2>/dev/null || grep -qF "$CL_START" "$1" 2>/dev/null
}

# ================================ 1. PLAN =====================================================
echo
info "nodeterm uninstall — scanning this machine ($OS)…"
echo

FOUND_ANY=0

# -- processes / services
APP_PGREP="$APP_BUNDLE/Contents/MacOS"
[ "$OS" != "Darwin" ] && APP_PGREP='/opt/nodeterm/nodeterm|nodeterm.*\.AppImage'
if pgrep -f "$APP_PGREP" >/dev/null 2>&1; then
  plan "Quit the running nodeterm app"; FOUND_ANY=1
fi
SYSTEMD_SCOPE=""
if command -v systemctl >/dev/null 2>&1; then
  if systemctl --user cat nodeterm-server.service >/dev/null 2>&1; then SYSTEMD_SCOPE="user"
  elif systemctl cat nodeterm-server.service >/dev/null 2>&1; then SYSTEMD_SCOPE="system"; fi
  if [ -n "$SYSTEMD_SCOPE" ]; then
    plan "Stop + remove the Server Edition systemd units (nodeterm-server, nodeterm-server-update) [$SYSTEMD_SCOPE]"
    FOUND_ANY=1
  fi
fi
for sock in node-terminal nodeterm-rmt; do
  if command -v tmux >/dev/null 2>&1 && tmux -L "$sock" list-sessions >/dev/null 2>&1; then
    n="$(tmux -L "$sock" list-sessions 2>/dev/null | wc -l | tr -d ' ')"
    plan "Kill the tmux server on socket '$sock' ($n session(s) — running processes in them will end):"
    tmux -L "$sock" list-sessions -F '      #{session_name}  (#{session_windows} win, created #{t:session_created})' 2>/dev/null || true
    FOUND_ANY=1
  fi
done
if ls "$NT_HOME"/ssh-cm/*.sock >/dev/null 2>&1; then
  plan "Close SSH ControlMaster connections ($(ls "$NT_HOME"/ssh-cm/*.sock 2>/dev/null | wc -l | tr -d ' ') socket(s) in ~/.nodeterm/ssh-cm)"
  FOUND_ANY=1
fi

# -- integration in other tools' config
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
GEMINI_SETTINGS="$HOME/.gemini/settings.json"
for f in "$CLAUDE_SETTINGS" "$GEMINI_SETTINGS"; do
  if [ -f "$f" ] && grep -Eq "$HOOK_MARKERS" "$f" 2>/dev/null; then
    plan "Remove nodeterm hook entries from $f (other hooks kept)"; FOUND_ANY=1
  fi
done
if [ -f "$HOME/.codex/hooks.json" ] && grep -Eq "$HOOK_MARKERS" "$HOME/.codex/hooks.json" 2>/dev/null; then
  plan "Remove nodeterm hook entries from ~/.codex/hooks.json + matching trust entries in ~/.codex/config.toml"
  FOUND_ANY=1
fi
for d in "$HOME/.claude/skills/manage-nodeterm-canvas" "$HOME/.claude/skills/get-linked-context"; do
  [ -d "$d" ] && { plan "Delete skill dir $d"; FOUND_ANY=1; }
done
for f in "$GROK_HOME/hooks/nodeterm-status.json" "$COPILOT_HOME/hooks/nodeterm-status.json"; do
  [ -f "$f" ] && { plan "Delete $f"; FOUND_ANY=1; }
done
OPENCODE_PLUGIN="$OPENCODE_DIR/plugins/nodeterm-status.js"
if [ -f "$OPENCODE_PLUGIN" ] && head -1 "$OPENCODE_PLUGIN" | grep -qF "$OPENCODE_PLUGIN_MARKER"; then
  plan "Delete $OPENCODE_PLUGIN"; FOUND_ANY=1
fi
for f in "$HOME/.codex/AGENTS.md" "$HOME/.gemini/GEMINI.md" "$COPILOT_HOME/copilot-instructions.md" "$OPENCODE_DIR/AGENTS.md"; do
  has_blocks "$f" && { plan "Remove nodeterm marker blocks from $f"; FOUND_ANY=1; }
done

# -- nodeterm-owned files and directories
DIRS_TO_REMOVE=()
add_dir() { [ -e "$1" ] && { DIRS_TO_REMOVE+=("$1"); plan "Delete $1"; FOUND_ANY=1; }; }
add_dir "$NT_HOME"
add_dir "$USER_DATA"
if [ "$OS" = "Darwin" ]; then
  add_dir "$HOME/Library/Caches/nodeterm"
  add_dir "$HOME/Library/Caches/com.nodeterm.app"
  add_dir "$HOME/Library/Caches/com.nodeterm.app.ShipIt"
  add_dir "$HOME/Library/Application Support/Caches/nodeterm-updater"
  add_dir "$HOME/Library/Preferences/com.nodeterm.app.plist"
  add_dir "$HOME/Library/Saved Application State/com.nodeterm.app.savedState"
  add_dir "$HOME/Library/HTTPStorages/com.nodeterm.app"
  add_dir "$HOME/Library/Logs/nodeterm"
else
  add_dir "${XDG_CACHE_HOME:-$HOME/.cache}/nodeterm"
fi
add_dir "$SERVER_APP"
add_dir "$SERVER_DATA"

BREW_CASK=0
if [ "$OS" = "Darwin" ]; then
  if command -v brew >/dev/null 2>&1 && brew list --cask nodeterm >/dev/null 2>&1; then
    BREW_CASK=1
    plan "Uninstall the Homebrew cask 'nodeterm' (removes $APP_BUNDLE)"; FOUND_ANY=1
  elif [ -d "$APP_BUNDLE" ]; then
    plan "Delete $APP_BUNDLE"; FOUND_ANY=1
  fi
  if security find-generic-password -s "nodeterm Safe Storage" >/dev/null 2>&1; then
    plan "Delete the 'nodeterm Safe Storage' Keychain entry"; FOUND_ANY=1
  fi
fi

# -- per-project data: enumerate BEFORE the workspace index is deleted; never auto-deleted.
PROJECT_DIRS=""
for ws in "$USER_DATA/workspace.json" "$SERVER_DATA/workspace.json"; do
  [ -f "$ws" ] || continue
  cwds="$(jsedit list-projects "$ws" 2>/dev/null || true)"
  while IFS= read -r cwd; do
    [ -n "$cwd" ] && [ -d "$cwd/.nodeterm" ] && PROJECT_DIRS="$PROJECT_DIRS$cwd/.nodeterm
"
  done <<EOF
$cwds
EOF
done
PROJECT_DIRS="$(printf '%s' "$PROJECT_DIRS" | sort -u)"

if [ "$FOUND_ANY" = 0 ]; then
  ok "Nothing to do — no nodeterm traces found on this machine."
  exit 0
fi

if [ -z "$NODE_BIN" ]; then
  echo
  warn "No JS runtime (node) found: hook entries inside ~/.claude/settings.json, ~/.gemini/settings.json and ~/.codex will be LEFT IN PLACE."
  warn "They are harmless no-ops once the hook scripts are deleted (the command is self-guarded), but for a fully clean file install node and re-run."
fi

if [ "$DRY_RUN" = 1 ]; then
  echo
  if [ -n "$PROJECT_DIRS" ]; then
    info "Would be KEPT (your project data — delete manually if you want):"
    printf '%s\n' "$PROJECT_DIRS" | sed 's/^/      /'
  fi
  info "Dry run — nothing was changed."
  exit 0
fi

echo
if [ "$ASSUME_YES" != 1 ]; then
  if [ ! -t 0 ]; then
    warn "Not running interactively. Re-run with --yes to proceed (or --dry-run to inspect)."
    exit 2
  fi
  printf 'Proceed with the actions above? Terminal sessions and their processes will be terminated. [y/N] '
  read -r answer
  case "$answer" in y|Y|yes|YES) ;; *) info "Aborted — nothing was changed."; exit 0 ;; esac
fi

# ================================ 2. STOP PROCESSES ===========================================
echo
if [ -n "$SYSTEMD_SCOPE" ]; then
  if [ "$SYSTEMD_SCOPE" = "user" ]; then SCTL="systemctl --user"; UNIT_DIR="$HOME/.config/systemd/user"
  else SCTL="systemctl"; UNIT_DIR="/etc/systemd/system"; fi
  $SCTL disable --now nodeterm-server-update.timer >/dev/null 2>&1 || true
  $SCTL disable --now nodeterm-server.service >/dev/null 2>&1 || true
  rm -f "$UNIT_DIR/nodeterm-server.service" "$UNIT_DIR/nodeterm-server-update.service" \
        "$UNIT_DIR/nodeterm-server-update.timer" 2>/dev/null || true
  $SCTL daemon-reload >/dev/null 2>&1 || true
  ok "Server Edition services stopped and removed"
fi

if pgrep -f "$APP_PGREP" >/dev/null 2>&1; then
  [ "$OS" = "Darwin" ] && osascript -e 'quit app "nodeterm"' >/dev/null 2>&1
  [ "$OS" != "Darwin" ] && pkill -TERM -f "$APP_PGREP" 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -f "$APP_PGREP" >/dev/null 2>&1 || break
    sleep 1
  done
  pkill -f "$APP_PGREP" 2>/dev/null || true
  ok "nodeterm app quit"
fi

for sock in node-terminal nodeterm-rmt; do
  if command -v tmux >/dev/null 2>&1 && tmux -L "$sock" list-sessions >/dev/null 2>&1; then
    tmux -L "$sock" kill-server 2>/dev/null || true
    ok "tmux server on '$sock' stopped"
  fi
done

for cm in "$NT_HOME"/ssh-cm/*.sock; do
  [ -e "$cm" ] || continue
  ssh -o ControlPath="$cm" -O exit nodeterm-cm 2>/dev/null || true
done
pkill -f "ssh-agent.*\.nodeterm" 2>/dev/null || true

# ================================ 3. REVERT AGENT INTEGRATION =================================
for f in "$CLAUDE_SETTINGS" "$GEMINI_SETTINGS"; do
  if [ -f "$f" ] && grep -Eq "$HOOK_MARKERS" "$f" 2>/dev/null; then
    if n="$(jsedit clean-hooks "$f")" && [ "${n:-0}" -gt 0 ] 2>/dev/null; then
      ok "Removed $n nodeterm hook entr(ies) from $f"
    else
      warn "Could not clean $f — left as is (entries are inert without the hook script)"
    fi
  fi
done
if [ -f "$HOME/.codex/hooks.json" ] && grep -Eq "$HOOK_MARKERS" "$HOME/.codex/hooks.json" 2>/dev/null; then
  if r="$(jsedit clean-codex "$HOME/.codex")"; then
    set -- $r
    ok "Codex: removed ${1:-0} hook entr(ies), ${2:-0} trust entr(ies) (re-keyed ${3:-0}) in ~/.codex"
  else
    warn "Could not clean ~/.codex — left as is (entries are inert without the hook script)"
  fi
fi
rm -rf "$HOME/.claude/skills/manage-nodeterm-canvas" "$HOME/.claude/skills/get-linked-context" 2>/dev/null || true
rm -f "$GROK_HOME/hooks/nodeterm-status.json" "$COPILOT_HOME/hooks/nodeterm-status.json" 2>/dev/null || true
if [ -f "$OPENCODE_PLUGIN" ] && head -1 "$OPENCODE_PLUGIN" | grep -qF "$OPENCODE_PLUGIN_MARKER"; then
  rm -f "$OPENCODE_PLUGIN"
fi
for f in "$HOME/.codex/AGENTS.md" "$HOME/.gemini/GEMINI.md" "$COPILOT_HOME/copilot-instructions.md" "$OPENCODE_DIR/AGENTS.md"; do
  strip_blocks "$f"
done

# ================================ 4. DELETE NODETERM'S OWN STATE ==============================
for d in ${DIRS_TO_REMOVE[@]+"${DIRS_TO_REMOVE[@]}"}; do
  rm -rf "$d" && ok "Deleted $d"
done
if [ "$OS" = "Darwin" ]; then
  if [ "$BREW_CASK" = 1 ]; then
    brew uninstall --cask nodeterm >/dev/null 2>&1 && ok "Homebrew cask uninstalled" \
      || warn "brew uninstall --cask nodeterm failed — run it manually"
  elif [ -d "$APP_BUNDLE" ]; then
    rm -rf "$APP_BUNDLE" && ok "Deleted $APP_BUNDLE" \
      || warn "Could not delete $APP_BUNDLE — drag it to the Trash"
  fi
  security delete-generic-password -s "nodeterm Safe Storage" >/dev/null 2>&1 || true
  defaults delete com.nodeterm.app >/dev/null 2>&1 || true
fi

# ================================ 5. WHAT REMAINS =============================================
echo
ok "nodeterm has been removed from this machine."
if [ -n "$PROJECT_DIRS" ]; then
  echo
  info "Kept (your project data — canvas layouts inside your repos; delete if you don't want them):"
  printf '%s\n' "$PROJECT_DIRS" | sed 's/^/      /'
  note "Each is a '.nodeterm' folder in a project you opened; safe to delete with rm -rf."
fi
echo
note "Not covered by this script:"
note "  • Remote SSH hosts you connected projects to may hold: ~/.nodeterm, hook/skill installs"
note "    under the host's agent dirs, and tmux sessions on the 'nodeterm-rmt' socket."
note "    On each host: tmux -L nodeterm-rmt kill-server; rm -rf ~/.nodeterm  (then re-run this"
note "    script's agent-integration steps there if you used agents on that host)."
note "  • The tmux/agent CLIs themselves (claude, codex, …) — nodeterm never owned them."
if [ "$OS" != "Darwin" ]; then
  # Both packages carry package.json's `name`, not the productName the app is installed
  # under: electron-builder's linuxPackageName is `node-terminal`, /opt/nodeterm is not.
  if command -v dpkg >/dev/null 2>&1 && dpkg -s node-terminal >/dev/null 2>&1; then
    note "  • The .deb package needs root to remove: sudo apt remove node-terminal"
  elif command -v rpm >/dev/null 2>&1 && rpm -q node-terminal >/dev/null 2>&1; then
    if command -v dnf >/dev/null 2>&1; then
      note "  • The .rpm package needs root to remove: sudo dnf remove node-terminal"
    else
      note "  • The .rpm package needs root to remove: sudo rpm -e node-terminal"
    fi
  fi
  note "  • If you used the AppImage, delete the nodeterm-*.AppImage file you downloaded."
fi

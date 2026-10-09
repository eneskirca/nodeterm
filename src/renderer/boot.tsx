import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ensureClaudeCliCaps, ensureCursorCliCaps, ensureGrokCliCaps } from './state/permissionMode'
import { ensureCodexIdentityCaps } from './state/codexIdentity'
import { ensureCodexCliCaps } from './state/codexCli'
import { initAgentResolver } from './state/agent-resolver'
import { refreshAgentEnv } from './lib/agentEnv'
import { applyWindowChrome } from './lib/windowChrome'
import { installMarkdownLinkGuard, LOCAL_LINK_MESSAGE, openExternalQuietly } from './lib/markdownLinks'
import './styles.css'
import './tailwind.css'

// Does this window draw the macOS traffic lights inside our own tab bar? Stamped on <html> before
// the first paint so the tab bar reserves room for them only where they exist (issue #564: on
// Windows/Linux and in a Server Edition browser tab there are none, and the reservation pushed the
// logo in and squeezed the tabs). Runs after main.tsx's shell switch, so the browser flag is set.
applyWindowChrome()

// Links in rendered markdown (terminal ⌘M view, transcript bubbles, sticky notes, editor preview,
// the kanban card modal) must never navigate this window: a relative link used to wipe the canvas
// on the desktop, and any link navigated the Server Edition's tab away. One delegated listener for
// every surface — contract and reasoning in lib/markdownLinks.ts. Web links go through the bridge
// (system browser on desktop, a new tab in the Server Edition), guarded so a rejecting bridge
// cannot surface as an unhandled rejection. The toast is kind 'error' because
// that is the only kind Canvas renders — an 'info' toast would be a silent no-op.
installMarkdownLinkGuard(document, {
  openExternal: (url) => openExternalQuietly((u) => window.nodeTerminal.shell.openExternal(u), url),
  notifyLocal: () =>
    window.dispatchEvent(
      new CustomEvent('nodeterm:toast', { detail: { kind: 'error', message: LOCAL_LINK_MESSAGE } })
    )
})

// Register the custom-agent → baseAgent resolver so the capability predicates (hasHooks, canResume,
// canControlCanvas, …) resolve a custom agent's inherited harness. Reads the live settings store.
initAgentResolver()

// Probe the local Claude CLI once, up front (never awaited — a launch is never blocked on it):
// `--permission-mode auto` only exists in Claude Code >= 2.1.71, and until we know the version we
// conservatively omit the flag. The shell warms the same memo at startup, so this normally
// resolves immediately.
void ensureClaudeCliCaps()
// Same, for grok: its own probe, kicked off at boot so a node created seconds later already has
// the real answer instead of the fail-open one.
void ensureGrokCliCaps()
// cursor's model list is network-backed: kick it off at boot so the menu is ready, never awaited.
void ensureCursorCliCaps()

// Same shape, same reason: a Codex launch line names the managed shared-identity launcher only if
// this machine has one installed and armed. Unprobed ⇒ plain `codex`, which is what every Codex
// node ran before this feature — never a launcher path that might not resolve.
void ensureCodexIdentityCaps()
// What this machine's codex accepts for `--ask-for-approval`. Warmed here for the same reason as
// the probes above it: every Codex launch line reads it synchronously, so the answer must be in
// hand before the user can create a node. Unprobed degrades to the baseline vocabulary, never to a
// blocked launch.
void ensureCodexCliCaps()

// One env snapshot for `${env:VAR}` expansion, fetched up front and cached (src/renderer/lib/
// agentEnv.ts): the Settings preview and every launch path expand against the same object, so the
// preview cannot drift from the typed command. Browser/relay bridges resolve `{}` by design and
// expansion degrades to the missing-env refusal. Not awaited — an unexpanded first-frame launch
// of a `${env:…}`-referencing custom agent refuses via missingEnv rather than blocking boot.
void refreshAgentEnv()

// Note: StrictMode is intentionally not used — its double mount in dev would open
// two PTY sessions per terminal node.
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<App />)

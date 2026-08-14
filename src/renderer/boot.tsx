import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ensureClaudeCliCaps } from './state/permissionMode'
import { ensureCodexIdentityCaps } from './state/codexIdentity'
import './styles.css'
import './tailwind.css'

// Probe the local Claude CLI once, up front (never awaited — a launch is never blocked on it):
// `--permission-mode auto` only exists in Claude Code >= 2.1.71, and until we know the version we
// conservatively omit the flag. The shell warms the same memo at startup, so this normally
// resolves immediately.
void ensureClaudeCliCaps()

// Same shape, same reason: a Codex launch line names the managed shared-identity launcher only if
// this machine has one installed and armed. Unprobed ⇒ plain `codex`, which is what every Codex
// node ran before this feature — never a launcher path that might not resolve.
void ensureCodexIdentityCaps()

// Note: StrictMode is intentionally not used — its double mount in dev would open
// two PTY sessions per terminal node.
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<App />)

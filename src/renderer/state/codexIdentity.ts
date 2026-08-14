/**
 * The renderer's half of the Codex shared-identity fallback.
 *
 * TWO questions, and they are not the same one:
 *
 *  1. "Should this launch line name the managed launcher?" — answered BEFORE the node exists, by
 *     `codexSharedIdentity(ssh)` below. Same shape as the `--permission-mode auto` gate: a
 *     memoized shell probe whose unknown answer is the conservative one, so an unprobed or failed
 *     machine emits the bare `codex` it always did rather than a launcher path that may not
 *     resolve. That is the difference between "no shared identity" and "a dead node".
 *
 *  2. "What did this node ACTUALLY get?" — answered AFTER it launched, by the node's own launcher
 *     (`codex-identity:event`). Only the launcher can see the pane's env, whether the endpoint
 *     file was readable, or whether the installed `codex` even has an app-server, so the script
 *     is the authority and question 1 is only an optimistic gate in front of it.
 *
 * The mode is TRANSIENT — never persisted. It describes one launch of one process; a node reloaded
 * from disk has not launched anything yet, and a stale "plain" badge on it would be a lie.
 */
import { create } from 'zustand'
import { UNKNOWN_CODEX_IDENTITY_CAPS, type CodexIdentityCaps } from '@shared/types'

const CAPS_WAIT_MS = 3000

let caps: CodexIdentityCaps = UNKNOWN_CODEX_IDENTITY_CAPS
let capsPromise: Promise<CodexIdentityCaps> | null = null

/** Probe once per app run. Never rejects; a slow bridge resolves to what we have so far. */
export function ensureCodexIdentityCaps(): Promise<CodexIdentityCaps> {
  if (!capsPromise) {
    const probe = Promise.resolve()
      .then(() => window.nodeTerminal.codex.identityCaps())
      .then((c) => (caps = c ?? UNKNOWN_CODEX_IDENTITY_CAPS))
      .catch(() => UNKNOWN_CODEX_IDENTITY_CAPS)
    const timeout = new Promise<CodexIdentityCaps>((resolve) =>
      setTimeout(() => resolve(caps), CAPS_WAIT_MS)
    )
    capsPromise = Promise.race([probe, timeout])
  }
  return capsPromise
}

export function codexIdentityCapsNow(): CodexIdentityCaps {
  return caps
}

/**
 * Should a node use the shared-identity launcher? `remote` is anything truthy that marks the
 * session as running on another machine (`project.ssh`, `data.ssh`, `data.sshRemoteTmux` — the
 * caller passes whichever it holds; only its truthiness is read).
 *
 * An SSH project's session runs on the HOST, which has no launcher installed (that is a later
 * slice), so a launcher-named launch line there would be `command not found` — a dead node, the
 * exact failure this whole fallback exists to prevent. Remote ⇒ plain codex.
 */
export function codexSharedIdentity(remote?: unknown): boolean {
  return !remote && codexIdentityCapsNow().shared
}

export function resetCodexIdentityCapsForTests(next?: CodexIdentityCaps): void {
  caps = next ?? UNKNOWN_CODEX_IDENTITY_CAPS
  capsPromise = null
}

export type CodexIdentityMode = 'shared' | 'plain'

interface CodexIdentityState {
  byId: Record<string, { mode: CodexIdentityMode; reason?: string }>
  setMode(nodeId: string, mode: CodexIdentityMode, reason?: string): void
}

export const useCodexIdentity = create<CodexIdentityState>((set) => ({
  byId: {},
  setMode: (nodeId, mode, reason) =>
    set((s) => {
      const prev = s.byId[nodeId]
      if (prev?.mode === mode && prev.reason === reason) return s
      return { byId: { ...s.byId, [nodeId]: { mode, reason } } }
    })
}))

/** Human copy for the reasons the generated launcher can report. */
export const CODEX_FALLBACK_REASONS: Record<string, string> = {
  'node-id-unavailable': 'this session was not started by nodeterm',
  'hook-endpoint-unavailable': "nodeterm's hook endpoint was unreadable",
  'broker-unreachable': "nodeterm's hook server was unreachable",
  'node-token-unavailable': 'this build could not mint a node identity key',
  'thread-id-unavailable': 'the session id to resume was not usable',
  // Two different facts, and the single old string named only the first — "an older CLI" sent a
  // reader looking for a version problem on a codex 0.146.0 whose real problem was its install
  // channel. That is the misleading-error-message class this repo has lost diagnosis time to.
  'app-server-unavailable': 'this codex CLI could not start its app-server (it may be too old)',
  'codex-standalone-missing':
    'this codex was installed without the standalone runtime the shared app-server needs (npm or snap install)',
  'thread-bind-refused': 'another live node already owns that conversation',
  'thread-start-failed': 'the shared app-server would not start a conversation'
}

export function codexFallbackText(reason?: string): string {
  const why = (reason && CODEX_FALLBACK_REASONS[reason]) || 'the managed identity was unavailable'
  return `Running plain codex — ${why}.`
}

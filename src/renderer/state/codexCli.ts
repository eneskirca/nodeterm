/**
 * The renderer's half of the Codex approval-vocabulary gate.
 *
 * Same shape as `codexIdentity.ts` and as claude's `--permission-mode auto` gate: a memoized probe
 * whose unknown answer is the conservative one, read at the moment a launch command is built and
 * never rendered from — so it is a module memo, not a store.
 *
 * WHAT THE CONSERVATIVE ANSWER IS HERE, because it is not "emit nothing". An unprobed launch falls
 * back to the BASELINE vocabulary (`on-request`, `never` — every codex from 0.146.0 to 0.154.0
 * takes both), so Auto and Bypass keep the exact command line they have always had. The one value
 * that moved is `untrusted`, removed in 0.149.0, and that one is emitted only when a probe has
 * actually SEEN this binary advertise it. Unknown therefore costs at most "Ask each time"
 * degrading to Codex's own default — never a launch that dies on a value clap does not know.
 */
import {
  UNKNOWN_CODEX_CLI_CAPS,
  type CodexCliCaps
} from '@shared/types'
import type { ApprovalCaps } from '@shared/agents/approval-mode'
import { codexProbeHostKey } from '@shared/agents/codex-daemon'
import { useSshConn } from './sshConn'

const CAPS_WAIT_MS = 3000

let caps: CodexCliCaps = UNKNOWN_CODEX_CLI_CAPS
let capsPromise: Promise<CodexCliCaps> | null = null

/** Probe once per app run. Never rejects; a slow bridge resolves to what we have so far. The
 *  timeout is what makes "a launch is never blocked on the probe" true by construction — in the
 *  Server Edition this call goes over WS-RPC, which does not reject pending requests when the
 *  socket drops. */
export function ensureCodexCliCaps(): Promise<CodexCliCaps> {
  if (!capsPromise) {
    const probe = Promise.resolve()
      .then(() => window.nodeTerminal.codex.cliCaps())
      .then((c) => (caps = c ?? UNKNOWN_CODEX_CLI_CAPS))
      .catch(() => UNKNOWN_CODEX_CLI_CAPS)
    const timeout = new Promise<CodexCliCaps>((resolve) =>
      setTimeout(() => resolve(caps), CAPS_WAIT_MS)
    )
    capsPromise = Promise.race([probe, timeout])
  }
  return capsPromise
}

export function codexCliCapsNow(): CodexCliCaps {
  return caps
}

/**
 * Is this project a RELAY tab (a live connection to another machine's core)? Registered by the
 * projects store at module load (`registerCodexRelayProjectCheck`) so this module does not import
 * the store — the store imports `workspace.ts`, which imports this file. Absent = no project is a
 * relay tab, the safe answer for a test that never loads the store.
 */
let relayProjectCheck: ((projectId: string) => boolean) | null = null
export function registerCodexRelayProjectCheck(fn: ((projectId: string) => boolean) | null): void {
  relayProjectCheck = fn
}

/**
 * The caps to build a Codex launch line with.
 *
 * `remote` marks a session that runs on ANOTHER machine: an SSH node (`data.ssh`, a project's
 * `{ server, remoteCwd }`, or a bare `data.sshRemoteTmux` / `true`), or a relay tab (the caller's
 * `session.source === 'relay'`, or `projectId` naming a relay-bound project). A remote session runs
 * the HOST's codex, which this machine's probe never looked at: a host on 0.154 handed `untrusted`
 * because the laptop has 0.148 dies on the host, and a host older than 0.156 handed `--no-daemon`
 * dies the same way. So a remote session gets the baseline vocabulary, and `--no-daemon` only from
 * THAT host's own probe (SSH, `core/remote-ssh/codex-no-daemon-probe.ts`). A relay tab has no probe
 * of its host's codex at all and emits neither.
 */
export function codexApprovalCaps(remote?: unknown, projectId?: string): ApprovalCaps {
  const relay = !!projectId && !!relayProjectCheck?.(projectId)
  if (remote || relay)
    return { codexApprovalValues: null, codexNoDaemon: relay ? null : remoteCodexNoDaemon(remote) }
  return { codexApprovalValues: caps.approvalValues, codexNoDaemon: caps.noDaemon ?? null }
}

/** How long a Codex launch waits for its probe before building the line without it. */
export const CODEX_CAPS_LAUNCH_WAIT_MS = 3000

/**
 * `codexApprovalCaps`, but WAITS (bounded) for the probe that answers it, for a codex launch.
 *
 * Why this exists: the synchronous read is a race at exactly the worst moment. After a reboot every
 * Codex node cold-restores in the same tick; if the probe has not landed, the first node launches
 * WITHOUT `--no-daemon`, starts Codex's shared app-server with ITS pane environment, and every other
 * node joins it — the bug the flag exists to prevent. On a shared-identity machine it is worse:
 * `codex app-server daemon version` reports that daemon `running`, so the managed launcher adopts it
 * and every managed thread runs inside it too. Local: `ensureCodexCliCaps` (already bounded). SSH:
 * wait for this host's answer to arrive in `useSshConn`, bounded — a host with no codex never
 * answers, and a launch must never be held hostage by a probe (fail open to the old line).
 * Non-codex agents and relay tabs never wait.
 */
export async function ensureCodexLaunchCaps(
  capabilityId: string,
  remote?: unknown,
  projectId?: string,
  waitMs = CODEX_CAPS_LAUNCH_WAIT_MS
): Promise<ApprovalCaps> {
  const relay = !!projectId && !!relayProjectCheck?.(projectId)
  if (capabilityId === 'codex' && !relay) {
    if (!remote) await ensureCodexCliCaps()
    else {
      const key = remoteHostKey(remote)
      if (key) await waitForHostAnswer(key, waitMs)
    }
  }
  return codexApprovalCaps(remote, projectId)
}

function waitForHostAnswer(key: string, waitMs: number): Promise<void> {
  if (key in useSshConn.getState().codexNoDaemonByHost) return Promise.resolve()
  return new Promise((resolve) => {
    let unsub = (): void => {}
    const done = (): void => {
      clearTimeout(timer)
      unsub()
      resolve()
    }
    const timer = setTimeout(done, waitMs)
    unsub = useSshConn.subscribe((s) => {
      if (key in s.codexNoDaemonByHost) done()
    })
  })
}

function remoteHostKey(remote: unknown): string | null {
  const r = remote as { host?: unknown; server?: unknown }
  const conn = typeof r?.host === 'string' ? r : r?.server
  return conn && typeof conn === 'object' ? codexProbeHostKey(conn as Record<string, unknown>) : null
}

/**
 * `--no-daemon` for an SSH session comes from that host's own probe, published per
 * `user@host:port` (`codexProbeHostKey`). A bare `true` cannot name a host and answers unknown,
 * i.e. no flag, i.e. the line this has always sent.
 */
function remoteCodexNoDaemon(remote: unknown): boolean | null {
  const key = remoteHostKey(remote)
  return key && useSshConn.getState().remoteCodexNoDaemon(key) ? true : null
}

/** Test seam: drop the memo (and optionally preload a known answer). */
export function resetCodexCliCapsForTests(next?: CodexCliCaps): void {
  caps = next ?? UNKNOWN_CODEX_CLI_CAPS
  // A preloaded answer counts as landed, so a launch under test does not wait for a bridge.
  capsPromise = next ? Promise.resolve(caps) : null
}

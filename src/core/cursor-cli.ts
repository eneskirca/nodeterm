// Probe for the LOCAL cursor-agent CLI: its model catalogue only (`cursor-agent models`).
// Session-id minting needs no probe (see UNCONDITIONAL_SESSION_ID_CAPABLE in shared/agents/config).
// Rule 9: cursor's own probe, never claude's or grok's. The list is account-scoped and network-backed,
// so every failure (missing CLI, offline, timeout, unparseable) fails open to [] = no model switching.
import { execFile } from 'child_process'
import { promisify } from 'util'
import { IPC } from '../shared/ipc'
import { directExecutableInvocation } from './exec-path'
import { findInLoginPath } from './pty-manager'
import { platform } from './platform'
import { cursorModelsFrom } from '../shared/agents/model-gateway'
import { UNKNOWN_CURSOR_CLI_CAPS, type CursorCliCaps } from '../shared/types'

const execFileP = promisify(execFile)
// The call goes to the network; ~1.5 s measured, so leave room without hanging boot.
const PROBE_TIMEOUT_MS = 10_000

/** Pure composition around an injected runner, so the wiring is testable. Never rejects. */
export async function cursorCapsFromRunner(
  run: (args: string[]) => Promise<string | null>
): Promise<CursorCliCaps> {
  return { models: cursorModelsFrom(await run(['models'])) }
}

export function probeCursorCliAt(bin: string): Promise<CursorCliCaps> {
  return cursorCapsFromRunner(async (args) => {
    try {
      const invocation = directExecutableInvocation(bin, args)
      if (!invocation) return null
      const { stdout } = await execFileP(invocation.executable, invocation.args, {
        ...invocation.options,
        timeout: PROBE_TIMEOUT_MS
      })
      return stdout
    } catch {
      return null
    }
  })
}

let cached: Promise<CursorCliCaps> | null = null

async function probe(): Promise<CursorCliCaps> {
  const bin = await findInLoginPath('cursor-agent').catch(() => null)
  return bin ? probeCursorCliAt(bin) : UNKNOWN_CURSOR_CLI_CAPS
}

/** The local cursor-agent's catalogue. Memoized for the process lifetime (note: an account
 *  switch or a model shipped mid-session shows after a restart). A failed probe is NOT kept, so the
 *  next ask retries. Never rejects. */
export function cursorCliCaps(): Promise<CursorCliCaps> {
  if (!cached) {
    cached = probe().then((c) => {
      if (!c.models.length) cached = null
      return c
    })
  }
  return cached
}

/** Both shells call this (Invariant 11), or the picker works on one surface only. */
export function registerCursorCliIpc(): void {
  platform().handle(IPC.cursorCliCaps, () => cursorCliCaps())
}

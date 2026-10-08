import type { PaneOwner } from '../shared/agents/pane-owner-predicate'
import { readWindowsConsoleOwner, sameNativeProcess } from './windows-pane-owner'

export interface SleepingWakeSession {
  generation: string
  exited: boolean
  proc: { pid: number; write(data: string): void }
}

/** Core already validates the assembled command. This additive host boundary accepts only a
 * bounded single submitted line (with its shell-specific line-clearing prefix). */
export function validSleepingWakeInput(data: unknown): data is string {
  return typeof data === 'string' && data.length > 1 && data.length <= 131104 &&
    data.endsWith('\r') && !/[\r\n\0]/.test(data.slice(0, -1))
}

/** Never use the ordinary deferred, name-only write for an offscreen wake. The persistent host
 * retains the exact generation across the fresh OS read; a same-PID replacement also needs the
 * same process birth time. Older hosts can reject this extension without restarting a shell. */
export function hostSleepingWake(
  lookup: () => SleepingWakeSession | undefined,
  probe = readWindowsConsoleOwner
) {
  return async (generation: string, data: string, expected: PaneOwner): Promise<boolean> => {
    const session = lookup()
    const current = (): boolean => !!session && !session.exited && lookup() === session
    if (!session || !current() || generation !== session.generation || !validSleepingWakeInput(data)) return false
    const owner = await probe(session.proc.pid, session.generation).catch(() => null)
    if (!current() || !sameNativeProcess(expected, owner)) return false
    try {
      // No await between this final generation/birth check and the write to the captured PTY.
      session.proc.write(data)
      return true
    } catch { return false }
  }
}

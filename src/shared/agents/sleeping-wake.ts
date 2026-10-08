import type { PaneOwner } from './pane-owner-predicate'
import { decideWakeResume, type WakeContext, type WakeVerdict } from './wake-identity'
import { shellKillLineSequence } from '../shell-kill-line'

/** Internal renderer → owning core request. No attach, spawn, or caller-supplied SSH descriptor. */
export interface SleepingWakeRequest {
  nodeId: string
  agentId: string
  command: string
  recorded?: WakeContext | null
  exitedByUs: boolean
}
export interface SleepingWakeResult {
  delivered: boolean
  verdict: WakeVerdict | 'invalid-request' | 'delivery-failed'
}

/** The ownership check must fence the same live/released generation before and after every await. */
export async function deliverSleepingWake(
  request: SleepingWakeRequest,
  io: {
    owned(): boolean
    owner(): Promise<PaneOwner | null>
    write(data: string, owner: PaneOwner): Promise<boolean>
    binaries?: readonly string[] | null
    platform?: string
  }
): Promise<SleepingWakeResult> {
  if (!request || typeof request.nodeId !== 'string' || !request.nodeId || request.nodeId.length > 256 ||
      typeof request.agentId !== 'string' || !request.agentId || request.agentId.length > 256 ||
      typeof request.command !== 'string' || !request.command.trim() || request.command.length > 131072 ||
      /[\r\n\x00]/.test(request.command) || typeof request.exitedByUs !== 'boolean') {
    return { delivered: false, verdict: 'invalid-request' }
  }
  if (!io.owned()) return { delivered: false, verdict: 'unreadable' }
  let timer: ReturnType<typeof setTimeout> | undefined
  const owner = await Promise.race([
    Promise.resolve().then(() => io.owner()).catch(() => null),
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 6000) })
  ]).finally(() => { if (timer) clearTimeout(timer) })
  if (!io.owned()) return { delivered: false, verdict: 'context-changed' }
  const verdict = decideWakeResume({ owner, recorded: request.recorded, exitedByUs: request.exitedByUs,
    agentId: request.agentId, binaries: io.binaries })
  if (verdict !== 'resume' || !owner) return { delivered: false, verdict }
  const killLine = shellKillLineSequence(undefined, owner.command, io.platform)
  // One delivery, never a retry after an uncertain write. The saved shell already owns cwd/account.
  const delivered = await io.write(killLine + request.command + '\r', owner)
  return { delivered, verdict: delivered ? 'resume' : 'delivery-failed' }
}

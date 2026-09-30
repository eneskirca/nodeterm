// Core's copy of what each renderer's board dispatch holds (@shared/board-dispatch-report) — read
// only by the `issues` control verb to DISPLAY a dispatch state beside an issue. Registered by BOTH
// shells (the Server Edition's browser tab runs the dispatcher too, for the project on screen).
//
// Kept per SENDER and read only for senders still attached (`clientIds`), so a closed browser tab or
// a reloaded window cannot leave a stale "queued" behind. A relay peer never reaches it: the channel
// is host-only (src/shared/host-control.ts) — a relay tab's board is the host's, and its dispatch is
// refused anyway.
import type { CorePlatform } from './platform'
import { IPC } from '../shared/ipc'
import { sanitizeDispatchReport, type BoardDispatchReportEntry } from '../shared/board-dispatch-report'

export interface BoardDispatchReports {
  /** Every live sender's entries for one project. */
  forProject(projectId: string): BoardDispatchReportEntry[]
}

export function createBoardDispatchReports(
  platform: Pick<CorePlatform, 'clientIds'> & Partial<Pick<CorePlatform, 'isOwnerClient'>>
): BoardDispatchReports & { receive(senderId: number, raw: unknown): void } {
  const bySender = new Map<number, BoardDispatchReportEntry[]>()
  return {
    receive(senderId, raw) {
      // Only an owner client's dispatcher is this machine's: a Server Edition tab signed in to it, or
      // the desktop's main window (both platforms implement `isOwnerClient`; a relay peer is not one).
      // A platform without it (a test double) accepts every sender.
      if (platform.isOwnerClient && !platform.isOwnerClient(senderId)) return
      const entries = sanitizeDispatchReport(raw)
      if (entries.length) bySender.set(senderId, entries)
      else bySender.delete(senderId)
    },
    forProject(projectId) {
      const live = new Set(platform.clientIds())
      for (const id of [...bySender.keys()]) if (!live.has(id)) bySender.delete(id)
      return [...bySender.values()].flat().filter((e) => e.projectId === projectId)
    }
  }
}

export function registerBoardDispatchReportIpc(
  platform: Pick<CorePlatform, 'clientIds' | 'handleWithSender'> & Partial<Pick<CorePlatform, 'isOwnerClient'>>
): BoardDispatchReports {
  const reports = createBoardDispatchReports(platform)
  platform.handleWithSender(IPC.boardDispatchReport, (senderId: number, raw: unknown) => {
    reports.receive(senderId, raw)
    return true
  })
  return { forProject: (projectId) => reports.forProject(projectId) }
}

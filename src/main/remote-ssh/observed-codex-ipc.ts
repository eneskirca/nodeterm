import { IPC } from '../../shared/ipc'
import type { PaneObservedResumeReply } from '../../shared/agents/pane-adoption'

interface SenderEvent { sender: { id: number; mainFrame?: unknown }; senderFrame?: unknown }
const refused = (): PaneObservedResumeReply => ({ ok: false, code: 'not-permitted', error: 'Observed SSH resume: not-permitted.' })

/** Raw Electron registration only. Callers send node/project IDs; all executable/runtime/launch
 * material stays in main. An agent control route, relay, popup or subframe cannot use this path.
 */
export function registerObservedCodexResumeIpc(
  ipc: { handle(channel: string, listener: (event: SenderEvent, raw: unknown) => Promise<unknown>): void },
  mainWindowId: () => number | undefined,
  service: { resume(senderId: number, raw: unknown, frameCurrent?: () => boolean): Promise<PaneObservedResumeReply> }
): void {
  ipc.handle(IPC.paneOwnershipResumeObserved, (event, raw) => {
    const windowId = mainWindowId()
    if (windowId === undefined || event.sender.id !== windowId || !event.senderFrame ||
        typeof event.senderFrame !== 'object' || event.senderFrame !== event.sender.mainFrame) return Promise.resolve(refused())
    return service.resume(event.sender.id, raw, () => event.senderFrame === event.sender.mainFrame)
  })
}

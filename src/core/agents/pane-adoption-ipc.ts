import { IPC } from '../../shared/ipc'
import type { PaneAdoptionReply } from '../../shared/agents/pane-adoption'

/** Raw local Electron IPC only. Never register on relay-dispatchable CorePlatform/control. */
export function registerPaneAdoptionIpc(
  ipc: { handle(channel: string, listener: (event: { sender: { id: number; mainFrame?: unknown }; senderFrame?: unknown }, raw: unknown) => Promise<unknown>): void },
  service: { request(senderId: number, raw: unknown, frameCurrent?: () => boolean): Promise<PaneAdoptionReply> }
): void {
  ipc.handle(IPC.paneOwnershipAdopt, (event, request) => {
    if (!event.senderFrame || typeof event.senderFrame !== 'object' || event.senderFrame !== event.sender.mainFrame) return Promise.resolve({ ok: false, code: 'not-permitted', error: 'Local pane adoption: not-permitted.' })
    return service.request(event.sender.id, request, () => event.senderFrame === event.sender.mainFrame)
  })
}

import type { LegacyMailboxSummary, LegacyMailboxViewReply, LegacyMailboxViewRequest } from '../../shared/agents/agent-mailbox-legacy'
import { isRecord } from '../../shared/is-record'
import { IPC } from '../../shared/ipc'
import { validateLegacyMailbox, type LegacyMailboxRecord } from './agent-mailbox-legacy'

const refused = (code: Extract<LegacyMailboxViewReply, { ok: false }>['code']): LegacyMailboxViewReply =>
  ({ ok: false, code, retryable: false, error: `Legacy mailbox recovery: ${code}.` })
const id = (v: unknown): v is string => typeof v === 'string' && /^legacy-[a-f0-9]{64}$/.test(v)

function request(raw: unknown): LegacyMailboxViewRequest | undefined {
  if (!isRecord(raw)) return undefined
  if (raw.kind === 'read') return Object.keys(raw).every(k => ['kind', 'legacyId'].includes(k)) && id(raw.legacyId)
    ? { kind: 'read', legacyId: raw.legacyId } : undefined
  if (raw.kind !== 'list' || !Object.keys(raw).every(k => ['kind', 'limit', 'cursor'].includes(k))) return undefined
  if (raw.limit !== undefined && (!Number.isSafeInteger(raw.limit) || Number(raw.limit) < 1 || Number(raw.limit) > 100)) return undefined
  if (raw.cursor !== undefined && !id(raw.cursor)) return undefined
  return { kind: 'list', ...(raw.limit !== undefined ? { limit: Number(raw.limit) } : {}),
    ...(raw.cursor !== undefined ? { cursor: raw.cursor as string } : {}) }
}
function summary(r: LegacyMailboxRecord): LegacyMailboxSummary {
  return {
    legacyId: r.legacyId, origin: r.origin, deliveryStatus: r.deliveryStatus, processingStatus: r.processingStatus,
    unverified: true, sourceEvidence: r.sourceEvidence, targetEvidence: r.targetEvidence, reason: r.reason,
    sourceNodeId: r.entry.req.sourceNodeId, targetNodeId: r.entry.req.targetNodeId,
    sourceTitle: r.entry.req.sourceTitle, verb: String(r.entry.req.verb), importedAt: r.importedAt, enqueuedAt: r.entry.enqueuedAt,
    ...(r.entry.binding ? { recordedTargetBinding: {
      ...(r.entry.binding.sessionId !== undefined ? { sessionId: r.entry.binding.sessionId } : {}),
      ...(r.entry.binding.agentId !== undefined ? { agentId: r.entry.binding.agentId } : {})
    } } : {}),
    bodyAvailable: r.entry.bodyOmitted !== true,
    ...(r.entry.bodyOmitted ? { missingBodyReason: 'omitted-by-legacy-queue' as const } : {})
  }
}

/** Local administrator recovery view, not a request to any historical or current agent. Sender
 * identity comes from Electron's event, never the request body. Foreign and absent windows are
 * refused before parsing or loading. The loader capability contains no commit/write operation.
 */
export function createLegacyMailboxViewHandler(deps: {
  mainWindowId(): number | undefined
  load(): Promise<LegacyMailboxRecord[]>
}): (senderId: number, raw: unknown) => Promise<LegacyMailboxViewReply> {
  return async (senderId, raw) => {
    const main = deps.mainWindowId()
    if (!Number.isSafeInteger(main) || main === undefined || senderId !== main) return refused('not-permitted')
    const req = request(raw)
    if (!req) return refused('invalid-request')
    try {
      const rows = await deps.load()
      validateLegacyMailbox(rows)
      // Window ownership can change while disk I/O is in flight.
      if (deps.mainWindowId() !== main) return refused('not-permitted')
      if (req.kind === 'read') {
        const r = rows.find(r => r.legacyId === req.legacyId)
        if (!r) return refused('not-found')
        return { ok: true, result: { schemaVersion: 1, record: {
          ...summary(r), ...(r.entry.bodyOmitted ? {} : { body: r.entry.req.body })
        } } }
      }
      const index = req.cursor ? rows.findIndex(r => r.legacyId === req.cursor) : -1
      if (req.cursor && index < 0) return refused('invalid-request')
      const limit = req.limit ?? 30, page = rows.slice(index + 1, index + 1 + limit)
      return { ok: true, result: { schemaVersion: 1, records: page.map(summary),
        ...(index + 1 + limit < rows.length && page.length ? { cursor: page[page.length - 1].legacyId } : {}) } }
    } catch { return refused('store-unavailable') }
  }
}

/** Raw, main-process-only IPC registration. Never register via relay-dispatchable CorePlatform. */
export function registerLegacyMailboxViewIpc(
  ipc: { handle(channel: string, listener: (event: { sender: { id: number } }, raw: unknown) => Promise<LegacyMailboxViewReply>): void },
  deps: Parameters<typeof createLegacyMailboxViewHandler>[0]
): void {
  const handler = createLegacyMailboxViewHandler(deps)
  ipc.handle(IPC.agentMailboxLegacyView, (event, raw) => handler(event.sender.id, raw))
}

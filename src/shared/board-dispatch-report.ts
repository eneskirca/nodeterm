// What the renderer's board dispatch (#1051, `renderer/state/boardDispatch.ts`) currently holds,
// REPORTED to core so the read-only `issues` control verb (core/github/control-read.ts) can say
// "queued for an agent (#2)" / "starting" / "not dispatched: <reason>" on an issue row.
//
// The queue lives in the renderer on purpose (a queue that survived a restart would start agents at
// boot), and core cannot see it. This is a one-way snapshot, replaced whole on every change, read
// only for DISPLAY: nothing in core acts on it. It arrives over IPC / the browser bridge, so every
// field is re-checked here, bounded, and a reason is flattened to one line like any untrusted text.
import { oneLine } from './one-line'

export type BoardDispatchReportStatus = 'queued' | 'starting' | 'refused'

export interface BoardDispatchReportEntry {
  projectId: string
  /** `owner/repo`, lower-cased: which repository `number` belongs to. */
  repository: string
  number: number
  status: BoardDispatchReportStatus
  /** Why nothing started (refused), in the card's words. */
  reason?: string
  /** 1-based place in its project's queue (queued only). */
  position?: number
}

/** At most this many entries per report. The dispatcher's cap is 8 running per project, and a queue
 *  longer than this is not something anyone reads line by line. */
export const DISPATCH_REPORT_MAX = 500
const REASON_MAX = 200
const STATUSES: ReadonlySet<string> = new Set(['queued', 'starting', 'refused'])
const FORMAT_CHARS = /\p{Cf}+/gu

function safeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value)
}

/** The report as core may keep it; anything malformed is dropped entry by entry. */
export function sanitizeDispatchReport(raw: unknown): BoardDispatchReportEntry[] {
  if (!Array.isArray(raw)) return []
  const out: BoardDispatchReportEntry[] = []
  for (const item of raw.slice(0, DISPATCH_REPORT_MAX)) {
    if (!item || typeof item !== 'object') continue
    const e = item as Record<string, unknown>
    if (!safeId(e.projectId) || typeof e.repository !== 'string' ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(e.repository) || e.repository.length > 200) continue
    if (typeof e.number !== 'number' || !Number.isSafeInteger(e.number) || e.number < 1) continue
    if (typeof e.status !== 'string' || !STATUSES.has(e.status)) continue
    const reason = typeof e.reason === 'string' ? oneLine(e.reason.replace(FORMAT_CHARS, '')).slice(0, REASON_MAX) : ''
    const position = typeof e.position === 'number' && Number.isSafeInteger(e.position) && e.position > 0
      ? e.position
      : undefined
    out.push({
      projectId: e.projectId,
      repository: e.repository.toLocaleLowerCase('en-US'),
      number: e.number,
      status: e.status as BoardDispatchReportStatus,
      ...(reason ? { reason } : {}),
      ...(e.status === 'queued' && position ? { position } : {})
    })
  }
  return out
}

/** The renderer's side: its dispatch map as a report, with each queued entry's place in its
 *  project's queue (oldest first — the order the drain starts them). Pure. */
export function dispatchReportFrom(
  byKey: Readonly<Record<string, {
    projectId: string
    ref: { owner: string; repo: string }
    number: number
    queuedAt: number
    status: BoardDispatchReportStatus
    reason?: string
  }>>
): BoardDispatchReportEntry[] {
  const entries = Object.values(byKey)
  return entries.slice(0, DISPATCH_REPORT_MAX).map((e) => {
    const position = e.status === 'queued'
      ? entries.filter((o) => o.status === 'queued' && o.projectId === e.projectId && o.queuedAt <= e.queuedAt).length
      : 0
    return {
      projectId: e.projectId,
      repository: `${e.ref.owner}/${e.ref.repo}`.toLocaleLowerCase('en-US'),
      number: e.number,
      status: e.status,
      ...(e.reason ? { reason: e.reason } : {}),
      ...(position ? { position } : {})
    }
  })
}

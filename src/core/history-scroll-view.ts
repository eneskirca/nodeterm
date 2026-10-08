import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import {
  HISTORY_CAPTURE_MAX_BYTES, HISTORY_CAPTURE_MAX_ROWS, HISTORY_PAGE_MAX_BYTES,
  HISTORY_PAGE_MAX_ROWS, HISTORY_ROWS_PER_NOTCH,
  type HistoryScrollCapture, type HistoryScrollPage, type HistoryScrollRow
} from '../shared/history-scroll'

export const HISTORY_VIEW_TTL_MS = 60_000
export const HISTORY_VIEW_GLOBAL_BYTES = 16 * 1024 * 1024

/** All relay peers share this retained snapshot budget; one peer cannot allocate per-host caps. */
export class HistoryScrollBudget {
  private used = 0
  constructor(private readonly limit = HISTORY_VIEW_GLOBAL_BYTES) {}
  get usedBytes(): number { return this.used }
  reserve(bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limit - this.used) return false
    this.used += bytes
    return true
  }
  release(bytes: number): void { this.used -= bytes }
}
const sharedBudget = new HistoryScrollBudget()

interface HeldView {
  id: string
  capture: HistoryScrollCapture
  bytes: number
  offset: number
  expiresAt: number
}

/** Owned by one exact attached stream. It never moves or writes the application's terminal. */
export class HistoryScrollView {
  private held: HeldView | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  constructor(private readonly budget = sharedBudget, private readonly now = () => performance.now()) {}

  /** Missing id starts a new intent; an expired/foreign id cannot silently become another view. */
  needsCapture(viewId?: string): boolean {
    if (!viewId) return true
    if (!this.held || this.held.id !== viewId || this.held.expiresAt <= this.now()) {
      if (this.held?.expiresAt !== undefined && this.held.expiresAt <= this.now()) this.clear()
      throw new Error('This history view expired or changed. Swipe again to open history.')
    }
    return false
  }

  install(value: HistoryScrollCapture): void {
    if (!value || !Number.isInteger(value.cols) || value.cols < 1 || value.cols > 65535 ||
        !Number.isInteger(value.viewportRows) || value.viewportRows < 1 || value.viewportRows > HISTORY_PAGE_MAX_ROWS ||
        typeof value.olderTruncated !== 'boolean' || !Array.isArray(value.rows) || value.rows.length < 1 || value.rows.length > HISTORY_CAPTURE_MAX_ROWS)
      throw new Error('The computer returned invalid terminal history.')
    const rows: HistoryScrollRow[] = []
    for (const row of value.rows) {
      if (!row || typeof row.text !== 'string' || typeof row.isWrapped !== 'boolean' ||
          (row.section !== 'normal' && row.section !== 'alternate'))
        throw new Error('The computer returned invalid terminal history.')
      rows.push({ text: row.text, isWrapped: row.isWrapped, section: row.section })
    }
    const capture = { cols: value.cols, viewportRows: value.viewportRows, olderTruncated: value.olderTruncated, rows }
    const bytes = Buffer.byteLength(JSON.stringify(capture), 'utf8')
    if (bytes > HISTORY_CAPTURE_MAX_BYTES) throw new Error('The computer returned too much terminal history.')
    this.clear()
    if (!this.budget.reserve(bytes)) throw new Error('Terminal history is busy. Close another history view and try again.')
    this.held = { id: randomUUID(), capture, bytes, offset: 0, expiresAt: 0 }
    this.renew()
  }

  page(up: boolean, notches: number): HistoryScrollPage {
    if (!Number.isInteger(notches) || notches < 1 || notches > 20) throw new Error('Invalid history movement.')
    const held = this.held
    if (!held || held.expiresAt <= this.now()) { this.clear(); throw new Error('This history view expired. Swipe again to open history.') }
    const { capture } = held
    const totalRows = capture.rows.length
    const maxOffset = Math.max(0, totalRows - capture.viewportRows)
    const offset = Math.max(0, Math.min(maxOffset, held.offset + (up ? 1 : -1) * notches * HISTORY_ROWS_PER_NOTCH))
    const end = totalRows - offset
    const start = Math.max(0, end - capture.viewportRows)
    const result: HistoryScrollPage = {
      status: 'history', viewId: held.id, offset, totalRows, cols: capture.cols,
      rows: capture.rows.slice(start, end).map(row => ({ ...row })),
      olderTruncated: capture.olderTruncated, hasOlder: offset < maxOffset, hasNewer: offset > 0
    }
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > HISTORY_PAGE_MAX_BYTES)
      throw new Error('This history page is too large. Use a smaller terminal view.')
    held.offset = offset
    this.renew()
    return result
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.held) this.budget.release(this.held.bytes)
    this.held = null
  }

  private renew(): void {
    const held = this.held
    if (!held) return
    held.expiresAt = this.now() + HISTORY_VIEW_TTL_MS
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { if (this.held === held) this.clear() }, HISTORY_VIEW_TTL_MS)
    this.timer.unref?.()
  }
}

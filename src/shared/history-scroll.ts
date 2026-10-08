/** Native retained-history scrolling. The mixed operation is input-capable and never replayed. */
export interface HistoryScrollRow {
  text: string
  isWrapped: boolean
  section: 'normal' | 'alternate'
}

/** Bounded physical rows, including pre-attach history and the current alternate screen. */
export interface HistoryScrollCapture {
  cols: number
  viewportRows: number
  rows: HistoryScrollRow[]
  olderTruncated: boolean
}

export type NativeScrollResult =
  | { status: 'history'; capture?: HistoryScrollCapture }
  | { status: 'input' }
  | { status: 'refused' | 'uncertain'; message: string }

/** A pure emulator decision. Only the captured backend owner may perform these writes. */
export type NativeScrollPlan =
  | { status: 'history'; capture?: HistoryScrollCapture }
  | { status: 'wheel'; data: string[] }
  | { status: 'refused'; message: string }

export interface HistoryScrollPage {
  status: 'history'
  viewId: string
  offset: number
  totalRows: number
  cols: number
  rows: HistoryScrollRow[]
  olderTruncated: boolean
  hasOlder: boolean
  hasNewer: boolean
}

export type HistoryScrollResult = HistoryScrollPage | Exclude<NativeScrollResult, { status: 'history' }>
export const HISTORY_CAPTURE_MAX_BYTES = 1024 * 1024
export const HISTORY_CAPTURE_MAX_ROWS = 8192
export const HISTORY_PAGE_MAX_BYTES = 256 * 1024
export const HISTORY_PAGE_MAX_ROWS = 200
export const HISTORY_ROWS_PER_NOTCH = 3

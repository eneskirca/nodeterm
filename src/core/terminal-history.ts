/** Literal, case-sensitive search of ALL retained output, with a bounded answer. */
export const HISTORY_MAX_BYTES = 50 * 1024 * 1024
export const HISTORY_RESULT_BYTES = 256 * 1024
export const HISTORY_MAX_ROWS = 200
export const HISTORY_QUERY_MAX = 256

export interface HistoryRow { line: number; text: string }
export interface HistorySearch { searchedLines: number; truncated: boolean; rows: HistoryRow[] }

export function validHistoryQuery(query: unknown): query is string {
  // One literal line. No shell/regexp syntax is interpreted; spaces are significant.
  // eslint-disable-next-line no-control-regex
  return typeof query === 'string' && query.length > 0 && query.length <= HISTORY_QUERY_MAX && !/[\x00-\x1f\x7f]/.test(query)
}

export function searchTerminalHistory(text: string, query: string): HistorySearch {
  if (!validHistoryQuery(query)) throw new Error('Enter a single-line search of 1–256 characters.')
  if (Buffer.byteLength(text, 'utf8') > HISTORY_MAX_BYTES) throw new Error('Retained history exceeds the 50 MiB search limit.')
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const rows: HistoryRow[] = []
  let bytes = 0
  let truncated = false
  for (let line = 0; line < lines.length; line++) {
    const value = lines[line].replace(/\r$/, '')
    if (!value.includes(query)) continue
    const cost = Buffer.byteLength(value, 'utf8') + String(line).length + 2
    if (rows.length >= HISTORY_MAX_ROWS || bytes + cost > HISTORY_RESULT_BYTES) { truncated = true; continue }
    bytes += cost
    rows.push({ line, text: value })
  }
  return { searchedLines: lines.length, truncated, rows }
}

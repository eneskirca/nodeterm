import { describe, expect, it } from 'vitest'
import { HISTORY_MAX_BYTES, HISTORY_MAX_ROWS, searchTerminalHistory, validHistoryQuery } from './terminal-history'

describe('retained terminal history search', () => {
  it('finds old history, literal metacharacters, UTF-8, and significant spaces', () => {
    const text = 'old.* Ω 😀\n' + 'recent\n'.repeat(500)
    expect(searchTerminalHistory(text, '.* Ω 😀')).toEqual({ searchedLines: 501, truncated: false, rows: [{ line: 0, text: 'old.* Ω 😀' }] })
    expect(searchTerminalHistory(' Word\nword\n', ' Word').rows).toHaveLength(1)
    expect(searchTerminalHistory('Word\n', 'word').rows).toEqual([])
    expect(searchTerminalHistory('unrelated Ω 😀\n', '.* Ω 😀').rows).toEqual([])
    expect(searchTerminalHistory('anything\n', '[unclosed').rows).toEqual([])
  })
  it('scans through capped results and reports a real truncated answer', () => {
    const result = searchTerminalHistory('match\n'.repeat(HISTORY_MAX_ROWS + 100) + 'tail\n', 'match')
    expect(result.rows).toHaveLength(HISTORY_MAX_ROWS)
    expect(result.searchedLines).toBe(HISTORY_MAX_ROWS + 101)
    expect(result.truncated).toBe(true)
    expect(searchTerminalHistory('match\n'.repeat(HISTORY_MAX_ROWS), 'match').truncated).toBe(false)
  })
  it('bounds UTF-8 answer bytes while continuing the full scan', () => {
    const huge = '😀'.repeat(70_000) + 'needle'
    expect(searchTerminalHistory(huge + '\nneedle\n', 'needle')).toEqual({ searchedLines: 2, truncated: true, rows: [{ line: 1, text: 'needle' }] })
    expect(() => searchTerminalHistory('x'.repeat(HISTORY_MAX_BYTES + 1), 'x')).toThrow(/50 MiB/)
  })
  it('refuses invalid queries without trimming valid literals', () => {
    for (const q of ['', 'x\ny', '\u0000', '\r', 'x'.repeat(257), undefined]) expect(validHistoryQuery(q)).toBe(false)
    expect(validHistoryQuery(' ')).toBe(true)
    expect(() => searchTerminalHistory('anything', '')).toThrow(/single-line/)
  })
})

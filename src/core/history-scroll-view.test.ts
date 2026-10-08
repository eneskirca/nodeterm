import { afterEach, describe, expect, it, vi } from 'vitest'
import { HistoryScrollBudget, HistoryScrollView, HISTORY_VIEW_TTL_MS } from './history-scroll-view'
import { HISTORY_CAPTURE_MAX_BYTES, HISTORY_PAGE_MAX_BYTES, type HistoryScrollCapture } from '../shared/history-scroll'

const views: HistoryScrollView[] = []
const capture = (count = 50, viewportRows = 4): HistoryScrollCapture => ({ cols: 80, viewportRows,
  olderTruncated: false, rows: Array.from({ length: count }, (_, i) => ({ text: `row ${i}`, isWrapped: i === 2,
    section: i >= count - 2 ? 'alternate' : 'normal' })) })
function view(budget = new HistoryScrollBudget()) { const v = new HistoryScrollView(budget); views.push(v); return v }
afterEach(() => { views.splice(0).forEach(v => v.clear()); vi.useRealTimers() })

describe('one viewer-owned native history snapshot', () => {
  it('pages physical rows in both directions without mutating input or sharing another viewer position', () => {
    const a = view(), b = view(), source = capture(); a.install(source); b.install(source)
    const first = a.page(true, 2)
    expect(first.offset).toBe(6); expect(first.rows.map(r => r.text)).toEqual(['row 40', 'row 41', 'row 42', 'row 43'])
    expect(first.hasOlder).toBe(true); expect(first.hasNewer).toBe(true)
    expect(a.needsCapture(first.viewId)).toBe(false)
    expect(b.page(true, 1).offset).toBe(3)
    const down = a.page(false, 20)
    expect(down.offset).toBe(0); expect(down.hasNewer).toBe(false)
    expect(down.rows.at(-1)?.section).toBe('alternate')
    source.rows[40].text = 'new output'; first.rows[1].text = 'caller changed page'
    expect(a.page(true, 2).rows.map(r => r.text)).toEqual(['row 40', 'row 41', 'row 42', 'row 43'])
  })
  it('keeps wraps, alternate boundaries and honest truncation at the oldest retained page', () => {
    const v = view(), source = capture(8); source.olderTruncated = true; v.install(source)
    const page = v.page(true, 20)
    expect(page.offset).toBe(4); expect(page.hasOlder).toBe(false); expect(page.olderTruncated).toBe(true)
    expect(page.rows[2]).toEqual({ text: 'row 2', isWrapped: true, section: 'normal' })
    expect(v.page(false, 1).rows.at(-1)?.section).toBe('alternate')
  })
  it('refuses a foreign/expired id and reclaims the shared budget on clear, replacement and TTL', () => {
    vi.useFakeTimers(); const budget = new HistoryScrollBudget(1200), a = view(budget), b = view(budget)
    a.install(capture(10)); const used = budget.usedBytes, id = a.page(true, 1).viewId
    expect(() => b.needsCapture(id)).toThrow('expired or changed')
    expect(() => b.install(capture(10))).toThrow('busy'); expect(budget.usedBytes).toBe(used)
    a.install(capture(2)); expect(budget.usedBytes).toBeLessThan(used)
    expect(() => a.needsCapture(id)).toThrow('expired or changed')
    a.clear(); a.clear(); expect(budget.usedBytes).toBe(0)
    b.install(capture(10)); const newId = b.page(true, 1).viewId
    vi.advanceTimersByTime(HISTORY_VIEW_TTL_MS)
    expect(budget.usedBytes).toBe(0); expect(() => b.needsCapture(newId)).toThrow('expired or changed')
  })
  it('bounds encoded snapshot/page bytes and refuses malformed capture/gestures without changing position', () => {
    const v = view()
    for (const bad of [{ ...capture(), cols: 0 }, { ...capture(), viewportRows: 201 }, { ...capture(), rows: capture(8193).rows }, { ...capture(), rows: [] },
      { ...capture(), rows: [{ text: 'x', isWrapped: false, section: 'foreign' }] }])
      expect(() => v.install(bad as HistoryScrollCapture)).toThrow('invalid')
    expect(() => v.install({ ...capture(), rows: [{ text: 'Ω'.repeat(HISTORY_CAPTURE_MAX_BYTES), isWrapped: false, section: 'normal' }] })).toThrow('too much')
    v.install(capture()); const initial = v.page(false, 1)
    for (const n of [0, -1, 21, 1.5, Number.NaN]) expect(() => v.page(true, n)).toThrow('Invalid')
    expect(v.page(false, 1).offset).toBe(initial.offset)
    v.install({ cols: 65535, viewportRows: 1, olderTruncated: false, rows: [{ text: 'Ω'.repeat(HISTORY_PAGE_MAX_BYTES / 2), isWrapped: false, section: 'normal' }] })
    expect(() => v.page(true, 1)).toThrow('too large')
  })
})

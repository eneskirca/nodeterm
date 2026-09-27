import { describe, expect, it } from 'vitest'
import { usageDiagnosticLines, usageDiagnosticText } from './usageDiagnostic'

describe('usageDiagnosticLines (issue #912)', () => {
  it('prints one line per view when the reasons differ', () => {
    expect(usageDiagnosticLines('Grok', [
      { view: 'credits', reason: 'http', httpStatus: 401 },
      { view: 'default', reason: 'timeout' }
    ])).toEqual([
      usageDiagnosticText('Grok', { view: 'credits', reason: 'http', httpStatus: 401 }),
      usageDiagnosticText('Grok', { view: 'default', reason: 'timeout' })
    ])
  })

  it('prints an identical reason ONCE, naming every view it applies to', () => {
    const lines = usageDiagnosticLines('Grok', [
      { view: 'credits', reason: 'http', httpStatus: 401 },
      { view: 'default', reason: 'http', httpStatus: 401 }
    ])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^Credits view and Default view: Grok authentication failed \(HTTP 401\)/)
  })

  it('keeps a single diagnostic byte-identical to the per-view text', () => {
    const d = { view: 'credits', reason: 'network' } as const
    expect(usageDiagnosticLines('Grok', [d])).toEqual([usageDiagnosticText('Grok', d)])
  })

  it('does not name a view twice when it reports the same reason twice', () => {
    expect(usageDiagnosticLines('Grok', [
      { view: 'credits', reason: 'timeout' },
      { view: 'credits', reason: 'timeout' }
    ])).toEqual([usageDiagnosticText('Grok', { view: 'credits', reason: 'timeout' })])
  })

  it('returns nothing for no diagnostics', () => {
    expect(usageDiagnosticLines('Grok', undefined)).toEqual([])
    expect(usageDiagnosticLines('Grok', [])).toEqual([])
  })
})

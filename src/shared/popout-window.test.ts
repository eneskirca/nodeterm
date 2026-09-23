import { describe, expect, it } from 'vitest'
import { popoutHash, popoutProjectIdFromHash } from './popout-window'

describe('popout window hash', () => {
  it('round-trips a project id, including one with characters a URL would mangle', () => {
    for (const id of ['proj-1', 'a b/c?d&e=f#g', 'ünïcödé']) {
      expect(popoutProjectIdFromHash(popoutHash(id))).toBe(id)
    }
  })

  it('answers null for the main window and for anything that is not a pop-out', () => {
    expect(popoutProjectIdFromHash('')).toBeNull()
    expect(popoutProjectIdFromHash('#')).toBeNull()
    expect(popoutProjectIdFromHash('#glyphgrid')).toBeNull()
    expect(popoutProjectIdFromHash('#popout')).toBeNull()
    expect(popoutProjectIdFromHash('#popout=')).toBeNull()
    expect(popoutProjectIdFromHash('#popout=%20')).toBeNull()
    expect(popoutProjectIdFromHash('#other=x')).toBeNull()
    expect(popoutProjectIdFromHash(undefined as unknown as string)).toBeNull()
  })

  it('tolerates a leading-hash-less value and a malformed percent escape', () => {
    expect(popoutProjectIdFromHash('popout=p1')).toBe('p1')
    expect(popoutProjectIdFromHash('#popout=%E0%A4%A')).toBeNull()
  })
})

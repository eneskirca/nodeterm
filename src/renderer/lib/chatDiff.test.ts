import { describe, expect, it } from 'vitest'
import { LINE_DIFF_MAX_CELLS, diffCounts, lineDiff, type DiffLine } from './chatDiff'

const ctx = (text: string): DiffLine => ({ kind: 'ctx', text })
const add = (text: string): DiffLine => ({ kind: 'add', text })
const del = (text: string): DiffLine => ({ kind: 'del', text })

describe('lineDiff — the in-thread Edit/Write diff', () => {
  it('pairs unchanged lines as context and marks the rest', () => {
    expect(lineDiff('a\nb\nc', 'a\nx\nc')).toEqual([ctx('a'), del('b'), add('x'), ctx('c')])
  })

  it('a deletion-only edit', () => {
    expect(diffCounts(lineDiff('a\nb', ''))).toEqual({ added: 0, removed: 2 })
    expect(lineDiff('a\nb', '')).toEqual([del('a'), del('b')])
  })

  it('a Write (no old text) is every line added', () => {
    expect(lineDiff('', 'x\ny')).toEqual([add('x'), add('y')])
    expect(lineDiff('', '')).toEqual([])
  })

  it('a trailing newline does not produce an empty extra line', () => {
    expect(lineDiff('a\n', 'a\nb\n')).toEqual([ctx('a'), add('b')])
    expect(lineDiff('', 'x\n')).toEqual([add('x')])
    // A blank line in the middle (or a lone newline) is a real, empty line.
    expect(lineDiff('a\n\nb', 'a\nb')).toEqual([ctx('a'), del(''), ctx('b')])
    expect(lineDiff('', '\n')).toEqual([add('')])
  })

  it('keeps the longest common run: an insertion in the middle leaves both ends as context', () => {
    expect(lineDiff('a\nb\nc\nd', 'a\nb\nnew\nc\nd')).toEqual([ctx('a'), ctx('b'), add('new'), ctx('c'), ctx('d')])
    // A moved line pairs the longer common run, not the first match.
    expect(lineDiff('m\na\nb\nc', 'a\nb\nc\nm')).toEqual([del('m'), ctx('a'), ctx('b'), ctx('c'), add('m')])
  })

  it('at exactly the size bound it still pairs', () => {
    const old = Array.from({ length: 500 }, (_, i) => `l${i}`)
    expect(old.length * old.length).toBe(LINE_DIFF_MAX_CELLS)
    const out = lineDiff(old.join('\n'), old.map((l, i) => (i === 250 ? 'changed' : l)).join('\n'))
    expect(diffCounts(out)).toEqual({ added: 1, removed: 1 })
    expect(out.filter((l) => l.kind === 'ctx')).toHaveLength(499)
  })

  it('falls back to del-all/add-all past the size bound without pairing', () => {
    const big = Array.from({ length: 600 }, (_, i) => `l${i}`).join('\n')
    const out = lineDiff(big, big + '\nz')
    expect(out.filter((l) => l.kind === 'ctx')).toHaveLength(0)
    expect(out).toHaveLength(1201)
    // Every old line first, then every new line, each in its own order.
    expect(out.slice(0, 600).every((l, i) => l.kind === 'del' && l.text === `l${i}`)).toBe(true)
    expect(out.slice(600).map((l) => l.text)).toEqual([...big.split('\n'), 'z'])
    expect(out.slice(600).every((l) => l.kind === 'add')).toBe(true)
  })
})

describe('diffCounts', () => {
  it('counts added and removed lines; context counts as neither', () => {
    expect(diffCounts([ctx('a'), del('b'), add('x'), add('y'), ctx('c')])).toEqual({ added: 2, removed: 1 })
    expect(diffCounts([])).toEqual({ added: 0, removed: 0 })
  })
})

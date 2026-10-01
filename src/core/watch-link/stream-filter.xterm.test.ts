// The stream filter held to xterm.js itself, through xterm 5.5's own VT500 table (copied verbatim in
// __fixtures__/xterm-vt500.ts). Two ways a viewer could get what is not on the owner's screen, one
// check each, on random streams:
// - payload: every letter xterm consumes INSIDE a string sequence is changed; if the filter's
//   output changes with it, a byte of string payload reached the viewer;
// - synthesis: xterm reading the filter's OUTPUT must never enter a string sequence (a lone ESC
//   glued to the text after a removed string would be one, without any payload byte leaking).
// This is what the hand-written cases cannot do: it asks xterm, not the filter's own reading of
// xterm, where each string starts and ends.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createStreamFilter } from './stream-filter'
import { xtermEntersString, xtermStringPayload } from './__fixtures__/xterm-vt500'

const ESC = '\x1b'
const BEL = '\x07'
const XTERM_PARSER = join(__dirname, '..', '..', '..', 'node_modules', '@xterm', 'xterm', 'src', 'common', 'parser')

const read = (file: string): string => readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
function block(src: string, start: string, end: string): string {
  const i = src.indexOf(start)
  if (i === -1) return `<missing: ${start}>`
  return src.slice(i, src.indexOf(end, i) + end.length)
}

// mulberry32, seeded: reproducible.
function rng(seed: number): (n: number) => number {
  return (n) => {
    seed = (seed + 0x6d2b79f5) >>> 0
    let z = seed
    z = Math.imul(z ^ (z >>> 15), z | 1)
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61)
    return ((z ^ (z >>> 14)) >>> 0) % n
  }
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'
const IS_LETTER = new Set(LETTERS)
// Changing one lowercase letter to another moves neither parser: both take them as the same class
// in every state (printable, OSC/DCS data, an ESC or DCS final byte).
const flipLetter = (c: string): string => LETTERS[(LETTERS.indexOf(c) + 1) % LETTERS.length]

// Text, C0 (BEL, CAN, SUB and others), DEL, ESC, the 7-bit introducer letters, 8-bit introducers and
// other C1, and non-ASCII (U+00A0 is where xterm's NON_ASCII_PRINTABLE starts).
const SINGLES = [
  '\x00', '\t', '\n', '\r', BEL, '\x18', '\x1a', '\x19', '\x1c', '\x7f', ESC, ']', 'P', 'X', '^', '_', '[',
  '\\', ';', '0', '9', ' ', '(', 'é', '\u00a0', '🙂', '\x85', '\x99', '\x9b', '\x9c', '\x9d', '\x90', '\x98',
  '\x9e', '\x9f'
]
const SNIPPETS = [
  [ESC, ']'], [ESC, 'P'], [ESC, 'X'], [ESC, '^'], [ESC, '_'], [ESC, '\\'], [ESC, '['], [ESC, ESC], [ESC, '\n'],
  [ESC, '\x7f'], [ESC, '('], [ESC, '\x9d'], ['\x9d'], ['\x90'], ['\x9c'], [BEL],
  [ESC, ']', '5', '2', ';', 'c', ';'], [ESC, ']', '8', ';', ';'], [ESC, 'P', 'q'], [ESC, 'P', '1', ';', '2', '$', 'q'],
  ['\x90', 'q'], [ESC, '_', 'G']
]

/** A random stream as code points, so a join lands between code points like a decoded pty read. */
function randomStream(rand: (n: number) => number): string[] {
  const cps: string[] = []
  for (let parts = 1 + rand(40); parts > 0; parts--) {
    const kind = rand(10)
    if (kind < 4) for (let i = 1 + rand(6); i > 0; i--) cps.push(LETTERS[rand(LETTERS.length)])
    else if (kind < 8) cps.push(...SNIPPETS[rand(SNIPPETS.length)])
    else cps.push(SINGLES[rand(SINGLES.length)])
  }
  return cps
}

function filterInChunks(text: string, cuts: number[], midStream: boolean): string[] {
  const f = createStreamFilter({ midStream })
  const outs: string[] = []
  let from = 0
  for (const to of [...cuts, text.length]) {
    outs.push(f.push(text.slice(from, to)))
    from = to
  }
  return outs
}

const codePoints = (s: string): number[] => Array.from(s, (c) => c.codePointAt(0) ?? 0)

/**
 * Feeds the stream from code point `join` on (xterm itself read it from the start), once as it is
 * and once with every string-payload letter after the join changed, cut into the same random
 * chunks; the two outputs must be equal, and xterm must not enter a string reading the output, as a
 * whole or any one push of it (the caller may drop pushes). Returns how many letters were changed.
 */
function checkNothingHiddenReachesOutput(cps: string[], join: number, midStream: boolean, rand: (n: number) => number): number {
  const payload = xtermStringPayload(cps.map((c) => c.codePointAt(0) ?? 0))
  let flips = 0
  const changed = cps.map((c, i) => {
    if (i < join || !payload[i] || !IS_LETTER.has(c)) return c
    flips++
    return flipLetter(c)
  })
  const text = cps.slice(join).join('')
  const cuts: number[] = []
  for (let k = rand(4); k > 0; k--) cuts.push(rand(text.length + 1))
  cuts.sort((a, b) => a - b)
  const outs = filterInChunks(text, cuts, midStream)
  const out = outs.join('')
  const ctx = JSON.stringify({ stream: cps.join(''), join, midStream, cuts, out })
  expect(filterInChunks(changed.slice(join).join(''), cuts, midStream).join(''), ctx).toBe(out)
  for (const piece of [out, ...outs]) expect(xtermEntersString(codePoints(piece)), ctx).toBe(false)
  return flips
}

describe('createStreamFilter against xterm 5.5', () => {
  // R66: the copied blocks carry xterm.js's MIT notice in full — every line of the installed package's
  // LICENSE, in order, in the fixture's header comment.
  it("the fixture carries xterm's MIT permission notice, verbatim from the installed LICENSE", () => {
    const fixture = read(join(__dirname, '__fixtures__', 'xterm-vt500.ts'))
    const header = fixture.slice(0, fixture.indexOf('// ---- BEGIN verbatim'))
    const comment = header
      .split('\n')
      .map((l) => l.replace(/^\/\/ ?/, ''))
      .join('\n')
    const license = read(join(XTERM_PARSER, '..', '..', '..', 'LICENSE')).trim()
    expect(license).toMatch(/^Copyright \(c\)/)
    expect(license).toContain('Permission is hereby granted')
    expect(comment).toContain(license)
  })

  it('the model is the installed xterm parser table, verbatim', () => {
    const fixture = read(join(__dirname, '__fixtures__', 'xterm-vt500.ts'))
    const constants = read(join(XTERM_PARSER, 'Constants.ts'))
    const parser = read(join(XTERM_PARSER, 'EscapeSequenceParser.ts'))
    const blocks: [string, string, string][] = [
      [constants, 'export const enum ParserState {', '\n}'],
      [constants, 'export const enum ParserAction {', '\n}'],
      [parser, 'const enum TableAccess {', '\n}'],
      [parser, 'export class TransitionTable {', '\n}'],
      [parser, 'const NON_ASCII_PRINTABLE = 0xA0;', ';'],
      [parser, 'export const VT500_TRANSITION_TABLE = (function (): TransitionTable {', '\n})();']
    ]
    for (const [src, start, end] of blocks) {
      expect(block(fixture, start, end), `re-copy ${start} from the installed xterm`).toBe(block(src, start, end))
    }
  })

  it("the model's walk is parse()'s: the lines of it that step() stands for are unchanged", () => {
    // step() is not a copy but a statement of these lines of EscapeSequenceParser.parse()'s sync
    // loop, so an upgrade that changes only parse() must reach this test too.
    const parser = read(join(XTERM_PARSER, 'EscapeSequenceParser.ts'))
    const loop = block(parser, '// continue with main sync loop', 'this.currentState = transition & TableAccess.TRANSITION_STATE_MASK;')
    const actionCase = (action: string): string => {
      const i = loop.indexOf(`case ParserAction.${action}:`)
      const j = loop.indexOf('case ParserAction.', i + 1)
      return i === -1 ? `<missing case ${action}>` : loop.slice(i, j === -1 ? loop.length : j)
    }
    const lines = (text: string, line: string): number => text.split('\n').filter((l) => l.trim() === line).length
    // The table lookup and the state it moves to.
    expect(lines(loop, 'transition = this._transitions.table[this.currentState << TableAccess.INDEX_STATE_SHIFT | (code < 0xa0 ? code : NON_ASCII_PRINTABLE)];')).toBe(1)
    expect(loop.endsWith('this.currentState = transition & TableAccess.TRANSITION_STATE_MASK;')).toBe(true)
    // An OSC or DCS ended by ESC goes to ESCAPE, not the table's GROUND; nothing else is patched.
    const escPatch = 'if (code === 0x1b) transition |= ParserState.ESCAPE;'
    expect(lines(actionCase('OSC_END'), escPatch)).toBe(1)
    expect(lines(actionCase('DCS_UNHOOK'), escPatch)).toBe(1)
    expect(lines(loop, escPatch)).toBe(2)
    // The read-ahead loops stop exactly where the table would leave the state they are in.
    expect(lines(actionCase('PRINT'), 'if (j >= length || (code = data[j]) < 0x20 || (code > 0x7e && code < NON_ASCII_PRINTABLE)) {')).toBe(1)
    expect(lines(actionCase('PRINT'), 'if (++j >= length || (code = data[j]) < 0x20 || (code > 0x7e && code < NON_ASCII_PRINTABLE)) {')).toBe(3)
    expect(lines(actionCase('PARAM'), '} while (++i < length && (code = data[i]) > 0x2f && code < 0x3c);')).toBe(1)
    expect(lines(actionCase('DCS_PUT'), 'if (j >= length || (code = data[j]) === 0x18 || code === 0x1a || code === 0x1b || (code > 0x7f && code < NON_ASCII_PRINTABLE)) {')).toBe(1)
    expect(lines(actionCase('OSC_PUT'), 'if (j >= length || (code = data[j]) < 0x20 || (code > 0x7f && code < NON_ASCII_PRINTABLE)) {')).toBe(1)
  })

  it('nothing xterm hides reaches the output, from the start of a stream', () => {
    const rand = rng(0xc0ffee)
    let flips = 0
    for (let n = 0; n < 3000; n++) flips += checkNothingHiddenReachesOutput(randomStream(rand), 0, false, rand)
    // Not vacuous: the seeded run changes ~51k payload letters here, ~28k in the midStream run.
    expect(flips).toBeGreaterThan(20_000)
  })

  it('nothing xterm hides reaches the output, joined at a random offset (midStream)', () => {
    const rand = rng(0x10ad)
    let flips = 0
    for (let n = 0; n < 3000; n++) {
      const cps = randomStream(rand)
      flips += checkNothingHiddenReachesOutput(cps, rand(cps.length + 1), true, rand)
    }
    expect(flips).toBeGreaterThan(10_000)
  })
})

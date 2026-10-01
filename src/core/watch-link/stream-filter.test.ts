import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createStreamFilter } from './stream-filter'

const ESC = '\x1b'
const BEL = '\x07'
const run = (chunks: string[]): string => {
  const f = createStreamFilter()
  return chunks.map((c) => f.push(c)).join('')
}
// One string pushed in pieces of `size` chars, the way a pty delivers a large write.
const pushInPieces = (text: string, size: number, midStream = false): string => {
  const f = createStreamFilter({ midStream })
  let out = ''
  for (let i = 0; i < text.length; i += size) out += f.push(text.slice(i, i + size))
  return out
}
// 2 MiB of base64, the shape of a large OSC 52.
const BIG = 'QUJD'.repeat(512 * 1024)

// The filter's rules, one UTF-16 unit at a time and without a fast path: the oracle the fuzz test
// holds the production parser to.
function oneCharAtATime(input: string, midStream: boolean): string {
  // midStream: as if an 8-bit DCS introducer had just been read.
  let mode: 'text' | 'esc' | 'string' | 'stringEsc' = midStream ? 'string' : 'text'
  let osc = false
  let out = ''
  const start = (ch: string): 'string' => {
    osc = ch === ']' || ch === '\x9d'
    return 'string'
  }
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    const n = ch.charCodeAt(0)
    const intro8 = '\x90\x98\x9d\x9e\x9f'.includes(ch)
    if (mode === 'text') {
      if (ch === ESC) mode = 'esc'
      else if (intro8) mode = start(ch)
      else out += ch
    } else if (mode === 'string') {
      if (ch === '\x9c' || (ch === BEL && osc)) mode = 'text'
      else if (ch === ESC) mode = 'stringEsc'
      else if (intro8) mode = start(ch)
    } else if (']PX^_'.includes(ch) || intro8) mode = start(ch)
    else if (ch === ESC) mode = 'esc'
    else if (n <= 0x17 || n === 0x19 || (n >= 0x1c && n <= 0x1f)) out += ch
    else if (n === 0x7f) continue
    else if (ch === '\\' && mode === 'stringEsc') mode = 'text'
    else {
      out += ESC + ch
      mode = 'text'
    }
  }
  return out
}

describe('createStreamFilter', () => {
  it('passes text, CSI and SGR untouched', () => {
    const s = `plain ${ESC}[31mred${ESC}[0m ${ESC}[2J${ESC}[H\r\n${ESC}7${ESC}8 é🙂`
    expect(run([s])).toBe(s)
  })

  it('removes OSC 52 terminated by BEL and by ST, and every string-type sequence', () => {
    expect(run([`a${ESC}]52;c;c2VjcmV0\x07b`])).toBe('ab')
    expect(run([`a${ESC}]0;title${ESC}\\b`])).toBe('ab')
    expect(run([`a${ESC}Pq#0;2;0;0;0${ESC}\\b`])).toBe('ab')
    expect(run([`a${ESC}_Gf=100;AAAA${ESC}\\b`])).toBe('ab')
    expect(run([`a${ESC}^pm${ESC}\\b${ESC}Xsos${ESC}\\c`])).toBe('abc')
    expect(run([`a\x9d52;c;x\x9cb\x90dcs\x9cc`])).toBe('abc')
  })

  it('handles a split at every position of an OSC 52', () => {
    const s = `before${ESC}]52;c;c2VjcmV0${ESC}\\after${ESC}[1m!`
    for (let i = 0; i <= s.length; i++) {
      expect(run([s.slice(0, i), s.slice(i)])).toBe(`beforeafter${ESC}[1m!`)
    }
  })

  it('an ESC inside a string aborts it and starts a new sequence', () => {
    expect(run([`a${ESC}]52;c;xx${ESC}[31mred`])).toBe(`a${ESC}[31mred`)
  })

  // No length cap: xterm has none, so any cap would show a viewer bytes the owner's screen did not
  // (measured: a 900 KB tmux copy is one 1.2 MB OSC 52). The sizes and push sizes are a pty's.
  it('a 2 MiB OSC 52, BEL- or ST-terminated, is swallowed whole in 64 KiB or 4 KiB pushes', () => {
    for (const end of [BEL, `${ESC}\\`, '\x9c']) {
      for (const size of [65536, 4096]) {
        expect(pushInPieces(`a${ESC}]52;c;${BIG}${end}b${ESC}[mc`, size), `${JSON.stringify(end)} / ${size}`).toBe(
          `ab${ESC}[mc`
        )
      }
    }
  })

  it('a 2 MiB DCS is swallowed whole, a BEL in its data included', () => {
    const half = BIG.slice(0, BIG.length / 2)
    for (const size of [65536, 4096]) {
      expect(pushInPieces(`a${ESC}Pq${half}${BEL}${half}${ESC}\\b`, size)).toBe('ab')
      expect(pushInPieces(`a\x90q${half}${BEL}${half}\x9cb`, size)).toBe('ab')
    }
  })

  it("is swallowed whole even past xterm's own 10,000,000-char payload limit", () => {
    // xterm stops handing a string that long to its handler but stays in it until the terminator.
    const huge = 'QUJD'.repeat(4 * 1024 * 1024)
    expect(pushInPieces(`a${ESC}]52;c;${huge}${BEL}b`, 65536)).toBe('ab')
  })

  it('the string branch counts nothing, so no length can end a string (source)', () => {
    // The tests above catch a cap up to the longest string they push (16 MiB); a cap past that
    // would need a longer test to see. A cap needs a counter and a comparison, and the branch that
    // reads a string's payload has neither.
    const src = readFileSync(join(__dirname, 'stream-filter.ts'), 'utf8').replace(/\r\n/g, '\n')
    const start = src.indexOf("} else if (mode === 'string') {")
    const branch = src.slice(start, src.indexOf('} else {', start)).replace(/\/\/.*$/gm, '')
    expect(start).toBeGreaterThan(-1)
    expect(branch).toContain('.exec(chunk)')
    expect(branch).not.toMatch(/\+\+|--|\+=|-=|[<>]/)
  })

  it('reset forgets a half-read sequence', () => {
    const f = createStreamFilter()
    expect(f.push(`a${ESC}]52;c;`)).toBe('a')
    f.reset()
    expect(f.push('visible')).toBe('visible')
  })

  it('a keyframe screen (capture-pane -e) loses its OSC 8 links and keeps the link text', () => {
    // tmux 3.4 `capture-pane -p -e` emits hyperlinks verbatim (measured), ST-terminated; programs
    // may end them with BEL instead. A keyframe is one push of a whole screen through a FRESH filter.
    const screen = [
      `${ESC}[1m$ ${ESC}[0mls -l`,
      `see ${ESC}]8;id=1;https://example.com/a${ESC}\\the docs${ESC}]8;;${ESC}\\ for more`,
      `${ESC}]8;;file:///etc/passwd${ESC}\\passwd${ESC}]8;;${ESC}\\ and ${ESC}[4m${ESC}]8;;https://x.test/${BEL}x${ESC}]8;;${BEL}${ESC}[24m`,
      ''
    ].join('\n')
    const out = createStreamFilter().push(screen)
    expect(out).toBe(
      [`${ESC}[1m$ ${ESC}[0mls -l`, 'see the docs for more', `passwd and ${ESC}[4mx${ESC}[24m`, ''].join('\n')
    )
    expect(out).not.toContain(']8;')
  })

  // Each case below is a way the viewer could otherwise RECEIVE bytes the owner's terminal treats as
  // string payload. The reference is xterm.js 5.5's VT500 transition table
  // (node_modules/@xterm/xterm/src/common/parser/EscapeSequenceParser.ts): it renders the owner's
  // node, the session host's emulator and the viewer page alike.

  it('BEL ends only an OSC: a DCS, SOS, PM or APC keeps swallowing until ST', () => {
    // xterm.js treats BEL inside DCS as data and inside SOS/PM/APC as ignored, so the owner never
    // sees what follows it; ending the string there would show the viewer hidden bytes.
    expect(run([`a${ESC}Ptmux;x${BEL}hidden${ESC}\\b`])).toBe('ab')
    expect(run([`a${ESC}_Gq${BEL}hidden${ESC}\\b`])).toBe('ab')
    expect(run([`a${ESC}^pm${BEL}hidden${ESC}\\b${ESC}Xsos${BEL}hidden\x9cc`])).toBe('abc')
    expect(run([`a\x90dcs${BEL}hidden\x9cb`])).toBe('ab')
    expect(run([`a\x9eq${BEL}hidden\x9cb\x98s${BEL}h\x9cc\x9fa${BEL}h\x9cd`])).toBe('abcd')
  })

  it('an 8-bit introducer after ESC starts a string, as it does in xterm.js', () => {
    expect(run([`a${ESC}\x9d52;c;c2VjcmV0\x9cb`])).toBe('ab')
    expect(run([`a${ESC}]0;t${ESC}\x9d52;c;c2VjcmV0\x9cb`])).toBe('ab')
    expect(run([`a${ESC}`, `\x90q#0\x9cb`])).toBe('ab')
  })

  it('a C0 control or DEL between ESC and the introducer does not end the escape', () => {
    // xterm.js executes C0 and ignores DEL while in ESCAPE, so `ESC \n ]52;…` is still an OSC 52.
    expect(run([`a${ESC}\n]52;c;c2VjcmV0${BEL}b`])).toBe('a\nb')
    expect(run([`a${ESC}\x7f]52;c;c2VjcmV0${BEL}b`])).toBe('ab')
    expect(run([`a${ESC}]0;t${ESC}\r\x7f]52;c;c2VjcmV0${BEL}b`])).toBe('a\rb')
    // The C0 is still executed, and the ESC still applies to what follows it.
    expect(run([`a${ESC}\r[1mB`])).toBe(`a\r${ESC}[1mB`)
  })

  it('never emits a lone ESC that the text after a removed string would complete', () => {
    // `ESC ESC ]…` is ONE OSC in xterm.js (the second ESC restarts the escape); emitting the first
    // ESC would glue it to the text after the removed string, here into an OSC 0 of its own.
    expect(run([`${ESC}${ESC}]52;c;c2VjcmV0${BEL}]0;x${BEL}`])).toBe(`]0;x${BEL}`)
    expect(run([`a${ESC}`, `${ESC}`, `]52;c;x${BEL}]b`])).toBe('a]b')
    expect(run([`a${ESC}${ESC}[1mb`])).toBe(`a${ESC}[1mb`)
  })

  it('an 8-bit introducer inside a string starts a new string of its own kind', () => {
    // OSC → DCS: the BEL is now DCS data, not a terminator.
    expect(run([`a${ESC}]0;t\x90q${BEL}hidden\x9cb`])).toBe('ab')
    // DCS → OSC: and now it is one.
    expect(run([`a${ESC}Pq\x9d0;t${BEL}b`])).toBe('ab')
  })

  it('reset also forgets a pending ESC', () => {
    const f = createStreamFilter()
    expect(f.push(`a${ESC}`)).toBe('a')
    f.reset()
    expect(f.push(']visible')).toBe(']visible')
  })

  it('output never carries a string introducer, whatever the input, start and chunking', () => {
    // Why this is enough: in xterm.js a string state (OSC/DCS/SOS/PM/APC) is entered only from
    // ESCAPE on ] P X ^ _, or anywhere on an 8-bit introducer; ESCAPE is entered only by ESC and is
    // left by any char except C0 executables, DEL and ESC. So if no push emits an 8-bit introducer
    // or ends on ESC, and every ESC it emits is followed by a char that leaves ESCAPE without
    // entering a string, the viewer's parser can never enter one — even when the caller drops some
    // pushes (drop-and-redraw) or starts on a keyframe.
    const ALPHABET = [
      'a', 'b', ' ', '\n', '\r', '\t', '\x00', ESC, ']', 'P', 'X', '^', '_', '[', '\\', 'm', '8', ';',
      BEL, '\x18', '\x1a', '\x7f', '\x9c', '\x9d', '\x90', '\x98', '\x9e', '\x9f', '\x9b', '\x85', 'é', '🙂'
    ]
    const INTRO_8 = /[\x90\x98\x9d\x9e\x9f]/
    const staysOrStringAfterEsc = (c: string): boolean => {
      const n = c.charCodeAt(0)
      const c0Executable = n <= 0x17 || n === 0x19 || (n >= 0x1c && n <= 0x1f)
      return c0Executable || n === 0x7f || c === ESC || ']PX^_'.includes(c) || INTRO_8.test(c)
    }
    // mulberry32, seeded: reproducible, and without an LCG's short low-bit cycles.
    let seed = 0x5eed
    const rand = (n: number): number => {
      seed = (seed + 0x6d2b79f5) >>> 0
      let z = seed
      z = Math.imul(z ^ (z >>> 15), z | 1)
      z ^= z + Math.imul(z ^ (z >>> 7), z | 61)
      return ((z ^ (z >>> 14)) >>> 0) % n
    }
    for (let iter = 0; iter < 4000; iter++) {
      let input = ''
      for (let i = rand(60); i > 0; i--) input += ALPHABET[rand(ALPHABET.length)]
      const midStream = rand(2) === 1
      // Cut anywhere, a surrogate pair included: nothing in the filter counts or splits on one.
      const cuts = [0, input.length]
      for (let k = rand(5); k > 0; k--) cuts.push(rand(input.length + 1))
      cuts.sort((x, y) => x - y)
      const chunks = cuts.slice(1).map((end, i) => input.slice(cuts[i], end))

      const f = createStreamFilter({ midStream })
      const outs = chunks.map((c) => f.push(c))
      for (const out of outs) {
        const ctx = JSON.stringify({ input, chunks, midStream, out })
        expect(INTRO_8.test(out), ctx).toBe(false)
        expect(out.endsWith(ESC), ctx).toBe(false)
        for (let i = out.indexOf(ESC); i !== -1; i = out.indexOf(ESC, i + 1)) {
          expect(staysOrStringAfterEsc(out[i + 1]), ctx).toBe(false)
        }
      }
      // However it is chunked, the result is the char-by-char statement of the same rules: the
      // parser's slicing and fast path neither drop, reorder nor add a char.
      expect(outs.join(''), JSON.stringify({ chunks, midStream })).toBe(oneCharAtATime(input, midStream))
    }
  })
})

describe('createStreamFilter, joined mid-stream', () => {
  // A watcher co-attaches to a RUNNING session, so its first byte can land anywhere: inside an OSC 52,
  // or right after an ESC that the previous read ended on. A filter that starts in text would print
  // the rest of that string, or read `]52;…` as text.
  const mid = (chunks: string[]): string => {
    const f = createStreamFilter({ midStream: true })
    return chunks.map((c) => f.push(c)).join('')
  }

  it('a join at any offset never prints a byte of a string, and resyncs at the next escape', () => {
    // Text is lowercase, spaces and `ESC [ m`; every string's payload is from a disjoint alphabet
    // (uppercase, digits, `=;]\`), so any payload byte in the output is visible as such.
    const STREAM = [
      'pre ', `${ESC}[m`, 'one ',
      `${ESC}]52;C;U0VDUkVUQQ==${BEL}`, 'mid ',
      `${ESC}]52;C;U0VDUkVUQg==${ESC}\\`, 'two ',
      `${ESC}PQDATA${BEL}MORE${ESC}\\`, 'three ',
      `${ESC}_GAPC${BEL}HIDDEN${ESC}\\`, 'four ',
      `\x9d52;C;U0VDUkVUQw==\x9c`, 'five ',
      `\x90QDATA${BEL}MORE\x9c`,
      `${ESC}[m`, 'tail'
    ].join('')
    const resync = STREAM.lastIndexOf(ESC)
    for (let k = 0; k <= STREAM.length; k++) {
      const rest = STREAM.slice(k)
      for (const out of [mid([rest]), mid([rest.slice(0, 3), rest.slice(3)])]) {
        expect(out, `join at ${k}`).toMatch(/^[a-z \x1b[]*$/)
        if (k <= resync) expect(out.endsWith(`${ESC}[mtail`), `join at ${k}: ${JSON.stringify(out)}`).toBe(true)
      }
    }
  })

  it('a join right after a lone trailing ESC does not print the OSC 52 that ESC started', () => {
    const rest = `]52;c;c2VjcmV0${BEL}rest${ESC}[mtail`
    expect(mid([rest])).toBe(`${ESC}[mtail`)
    // What a filter starting in text would have sent: the whole clipboard.
    expect(run([rest])).toContain('c2VjcmV0')
  })

  it('a join into plain text loses only the text up to the first ESC', () => {
    expect(mid(['hello world', ` ${ESC}[1mbold${ESC}[m after`])).toBe(`${ESC}[1mbold${ESC}[m after`)
  })

  it('starts as an unknown string: ST, ESC-ST and 8-bit introducers end it, BEL does not', () => {
    expect(mid([`DATA${ESC}\\after`])).toBe('after')
    expect(mid([`DATA${ESC}`, `\\after`])).toBe('after')
    expect(mid(['DATA\x9cafter'])).toBe('after')
    // It may be a DCS or APC, where BEL is data.
    expect(mid([`DATA${BEL}more${ESC}[mafter`])).toBe(`${ESC}[mafter`)
    // An 8-bit introducer starts a string of ITS kind: this one is an OSC, which BEL ends.
    expect(mid([`DATA\x9d52;c;x${BEL}after`])).toBe('after')
  })

  it('a join into the tail of a 2 MiB OSC 52 swallows all of it', () => {
    const tail = BIG.slice(12345)
    for (const size of [65536, 4096]) {
      expect(pushInPieces(`${tail}${BEL}rest${ESC}[mafter`, size, true)).toBe(`${ESC}[mafter`)
      expect(pushInPieces(`${tail}${ESC}\\after`, size, true)).toBe('after')
    }
  })

  it('reset({ midStream }) inside an OSC forgets that it was one: BEL no longer ends it', () => {
    const g = createStreamFilter()
    expect(g.push(`a${ESC}]0;t`)).toBe('a')
    g.reset({ midStream: true })
    expect(g.push(`x${BEL}y${ESC}[mz`)).toBe(`${ESC}[mz`)
  })

  // Controller ruling R23: the link host takes a follow-up keyframe once a joined filter has left its
  // unknown start state (the text it swallowed until then is on the owner's screen, not the viewer's).
  describe('onSettled', () => {
    const settledBy = (input: string): number => {
      let n = 0
      createStreamFilter({ midStream: true, onSettled: () => n++ }).push(input)
      return n
    }

    it('fires once, when the unknown start state is first left: ESC, ST or an 8-bit introducer', () => {
      expect(settledBy(`x${ESC}[mtext`)).toBe(1)
      expect(settledBy(`x${ESC}\\text`)).toBe(1)
      expect(settledBy('x\x9ctext')).toBe(1)
      expect(settledBy(`x\x9d52;c;x${BEL}text`)).toBe(1)
      // BEL does not end the unknown string (it may be a DCS or APC), so it settles nothing.
      expect(settledBy(`x${BEL}more`)).toBe(0)
      expect(settledBy('plain text, no escape')).toBe(0)
    })

    it('fires once only, however many escapes follow, across pushes', () => {
      let n = 0
      const f = createStreamFilter({ midStream: true, onSettled: () => n++ })
      expect(f.push('swallowed ')).toBe('')
      expect(n).toBe(0)
      expect(f.push(`${ESC}[1mA${ESC}[m ${ESC}]0;t${BEL}B`)).toBe(`${ESC}[1mA${ESC}[m B`)
      expect(n).toBe(1)
      // Later strings end at later stop chars; none of them is the start state any more.
      expect(f.push(`${ESC}[2J${ESC}]0;x${BEL}${ESC}P1$r${ESC}\\${ESC}[H`)).toBe(`${ESC}[2J${ESC}[H`)
      expect(n).toBe(1)
    })

    it('fires after the chunk is parsed: the push still returns everything after the escape', () => {
      const seen: string[] = []
      const f = createStreamFilter({ midStream: true, onSettled: () => seen.push('settled') })
      expect(f.push(`lost${ESC}[Hkept`)).toBe(`${ESC}[Hkept`)
      expect(seen).toEqual(['settled'])
    })

    it('never fires for a filter that starts in text', () => {
      let n = 0
      const f = createStreamFilter({ onSettled: () => n++ })
      f.push(`a${ESC}]52;c;x${BEL}b${ESC}[m`)
      expect(n).toBe(0)
    })

    it('reset({ midStream, onSettled }) re-arms it; reset() and a midStream reset without it disarm it', () => {
      let a = 0
      let b = 0
      const f = createStreamFilter({ midStream: true, onSettled: () => a++ })
      f.push(`${ESC}[m`)
      f.reset({ midStream: true, onSettled: () => b++ })
      f.push(`${ESC}[m`)
      expect([a, b]).toEqual([1, 1])
      // Each disarmed filter then reads a whole OSC, whose BEL is a stop char a stale callback would fire on.
      f.reset({ midStream: true, onSettled: () => b++ })
      f.reset({ midStream: true })
      f.push(`${ESC}[m${ESC}]0;t${BEL}${ESC}[m`)
      f.reset({ midStream: true, onSettled: () => b++ })
      f.reset()
      f.push(`${ESC}]0;t${BEL}${ESC}[m`)
      expect([a, b]).toEqual([1, 1])
    })

    it('a throwing callback costs nothing: the chunk is returned whole and the state is right', () => {
      const f = createStreamFilter({
        midStream: true,
        onSettled: () => {
          throw new Error('boom')
        }
      })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        expect(f.push(`lost${ESC}[Hkept`)).toBe(`${ESC}[Hkept`)
        expect(f.push(`${ESC}]52;c;c2VjcmV0${BEL}after`)).toBe('after')
      } finally {
        warn.mockRestore()
      }
    })
  })

  it('reset({ midStream }) drops what was being read and starts as a join', () => {
    const f = createStreamFilter()
    expect(f.push('a')).toBe('a')
    f.reset({ midStream: true })
    expect(f.push(`b${ESC}[mc`)).toBe(`${ESC}[mc`)
    f.reset()
    expect(f.push('d')).toBe('d')
  })
})

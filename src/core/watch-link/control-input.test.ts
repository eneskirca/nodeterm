import { describe, it, expect } from 'vitest'
import type { ControlInputChunk } from '../pane-input'
import {
  PASTE_END,
  PASTE_MAX,
  PASTE_START,
  TYPING_WINDOW_MS,
  createInputSplitter,
  createTypingTracker,
  type InputSplitter
} from './control-input'

const keys = (data: string): ControlInputChunk => ({ kind: 'keys', data })
const paste = (text: string): ControlInputChunk => ({ kind: 'paste', text })
const ESC = '\x1b'

/** Adjacent keys chunks joined: two pushes of plain keys are two chunks, one push is one, and what
 *  reaches the pane is the same bytes either way. Only a paste boundary separates keys. */
function merged(chunks: ControlInputChunk[]): ControlInputChunk[] {
  const out: ControlInputChunk[] = []
  for (const c of chunks) {
    const last = out.at(-1)
    if (c.kind === 'keys' && last?.kind === 'keys') out[out.length - 1] = keys(last.data + c.data)
    else out.push(c)
  }
  return out
}
/** Push every part, then drain what is still held (the host's flush). */
function run(s: InputSplitter, ...parts: string[]): ControlInputChunk[] {
  const out: ControlInputChunk[] = []
  for (const p of parts) out.push(...s.push(p))
  out.push(...s.drain())
  return out
}

describe('createInputSplitter', () => {
  it('plain typing is one keys chunk per push, byte for byte (control bytes and escapes included)', () => {
    const s = createInputSplitter()
    expect(s.push('ls -la\r')).toEqual([keys('ls -la\r')])
    expect(s.push('\x03')).toEqual([keys('\x03')])
    expect(s.push(`${ESC}[A${ESC}OB\x7f`)).toEqual([keys(`${ESC}[A${ESC}OB\x7f`)])
    expect(s.push('çé漢🙂')).toEqual([keys('çé漢🙂')])
  })

  it('a paste in one push is one paste chunk; keys around it stay keys, in order', () => {
    const s = createInputSplitter()
    expect(s.push(`${PASTE_START}echo hi\nls${PASTE_END}`)).toEqual([paste('echo hi\nls')])
    expect(s.push(`ab${PASTE_START}x${ESC}[Ay${PASTE_END}\r`)).toEqual([keys('ab'), paste(`x${ESC}[Ay`), keys('\r')])
    // Two pastes back to back stay two pastes.
    expect(s.push(`${PASTE_START}1${PASTE_END}${PASTE_START}2${PASTE_END}`)).toEqual([paste('1'), paste('2')])
  })

  it('an empty paste yields nothing (there is nothing to deliver)', () => {
    const s = createInputSplitter()
    expect(s.push(`${PASTE_START}${PASTE_END}`)).toEqual([])
    expect(s.push('a')).toEqual([keys('a')])
  })

  it('markers split at EVERY boundary across two pushes give the same chunks as one push', () => {
    const input = `ab${PASTE_START}one\ntwo${PASTE_END}cd${PASTE_START}x${PASTE_END}`
    const want = [keys('ab'), paste('one\ntwo'), keys('cd'), paste('x')]
    expect(run(createInputSplitter(), input)).toEqual(want)
    for (let i = 1; i < input.length; i++) {
      const got = run(createInputSplitter(), input.slice(0, i), input.slice(i))
      expect(merged(got), `split at ${i}`).toEqual(want)
    }
  })

  it('a marker split over three pushes is still a marker', () => {
    const s = createInputSplitter()
    expect(s.push(`${ESC}[2`)).toEqual([])
    expect(s.push('00')).toEqual([])
    expect(s.push(`~hi${ESC}`)).toEqual([])
    expect(s.push('[201~')).toEqual([paste('hi')])
  })

  it('a held marker prefix that turns out not to be a marker comes out as keys', () => {
    const s = createInputSplitter()
    expect(s.push(`a${ESC}[20`)).toEqual([keys('a')])
    expect(s.push('x')).toEqual([keys(`${ESC}[20x`)])
    // F9 and Insert start like the marker and are not it.
    expect(s.push(`${ESC}[20~`)).toEqual([keys(`${ESC}[20~`)])
    expect(s.push(`${ESC}[2~`)).toEqual([keys(`${ESC}[2~`)])
  })

  it('a lone Esc (a prefix of the paste marker) is held, and drain() hands it over as keys', () => {
    const s = createInputSplitter()
    expect(s.push(ESC)).toEqual([])
    expect(s.drain()).toEqual([keys(ESC)])
    expect(s.drain()).toEqual([])
    // Drained, it is gone: the next push does not repeat it.
    expect(s.push('[A')).toEqual([keys('[A')])
  })

  it('drain() hands over only what a key press can end on (Esc, Alt+[); a longer marker prefix waits for the next input', () => {
    const s = createInputSplitter()
    expect(s.push(`${ESC}[`)).toEqual([])
    expect(s.drain()).toEqual([keys(`${ESC}[`)])
    for (const prefix of [`${ESC}[2`, `${ESC}[20`, `${ESC}[200`]) {
      expect(s.push(`a${prefix}`)).toEqual([keys('a')])
      expect(s.drain()).toEqual([])
      // The rest of the marker, a whole batch later: still a paste.
      expect(s.push(`${PASTE_START.slice(prefix.length)}hi${PASTE_END}`)).toEqual([paste('hi')])
    }
    // A held prefix that the next input does not complete comes out then, as keys.
    expect(s.push(`${ESC}[20`)).toEqual([])
    expect(s.drain()).toEqual([])
    expect(s.push('x')).toEqual([keys(`${ESC}[20x`)])
  })

  it('drain() never hands over a held high surrogate (no key press ends on half a character)', () => {
    const s = createInputSplitter()
    expect(s.push('a\ud83d')).toEqual([keys('a')])
    expect(s.drain()).toEqual([])
    expect(s.push('\ude42')).toEqual([keys('\ud83d\ude42')])
  })

  it('pasteOpen() tells whether a paste is waiting for its end', () => {
    const s = createInputSplitter()
    expect(s.pasteOpen()).toBe(false)
    s.push(`${PASTE_START}x`)
    expect(s.pasteOpen()).toBe(true)
    s.push(PASTE_END)
    expect(s.pasteOpen()).toBe(false)
    s.push(`${PASTE_START}x`)
    s.reset()
    expect(s.pasteOpen()).toBe(false)
  })

  it('drain() inside a paste hands over nothing: an open paste waits for its end', () => {
    const s = createInputSplitter()
    expect(s.push(`${PASTE_START}abc${ESC}[20`)).toEqual([])
    expect(s.drain()).toEqual([])
    // The held part completes the end marker.
    expect(s.push('1~z')).toEqual([paste('abc'), keys('z')])
    // A held part that does not end it is paste text.
    expect(s.push(`${PASTE_START}d${ESC}[20`)).toEqual([])
    expect(s.drain()).toEqual([])
    expect(s.push(`9${PASTE_END}`)).toEqual([paste(`d${ESC}[209`)])
  })

  it('a PASTE_END outside a paste is keys, passed through as typed', () => {
    const s = createInputSplitter()
    expect(s.push(`a${PASTE_END}b`)).toEqual([keys(`a${PASTE_END}b`)])
  })

  it('a PASTE_START inside a paste is paste text', () => {
    const s = createInputSplitter()
    expect(s.push(`${PASTE_START}a${PASTE_START}b${PASTE_END}`)).toEqual([paste(`a${PASTE_START}b`)])
  })

  it('a high surrogate at the end of a push waits for its pair (an emoji split across two casts)', () => {
    const s = createInputSplitter()
    const emoji = '🙂'
    expect(s.push(`a${emoji[0]}`)).toEqual([keys('a')])
    expect(s.push(`${emoji[1]}b`)).toEqual([keys(`${emoji}b`)])
  })

  it('a paste over PASTE_MAX is cut to PASTE_MAX; the rest up to its end is discarded, and typing goes on', () => {
    const s = createInputSplitter()
    const half = 'x'.repeat(PASTE_MAX / 2 + 10)
    expect(s.push(PASTE_START + half)).toEqual([])
    expect(s.push(half)).toEqual([])
    expect(s.push('y'.repeat(1000))).toEqual([])
    const out = s.push(`${PASTE_END}ls\r`)
    expect(out).toHaveLength(2)
    expect(out[0].kind).toBe('paste')
    expect((out[0] as { text: string }).text).toBe('x'.repeat(PASTE_MAX))
    expect(out[1]).toEqual(keys('ls\r'))
  })

  it('a paste cut at PASTE_MAX never ends on half a surrogate pair', () => {
    const s = createInputSplitter()
    const text = 'a'.repeat(PASTE_MAX - 1) + '🙂🙂'
    const out = s.push(`${PASTE_START}${text}${PASTE_END}`)
    expect(out).toEqual([paste('a'.repeat(PASTE_MAX - 1))])
  })

  it('reset() drops an open paste and a held prefix', () => {
    const s = createInputSplitter()
    expect(s.push(`${PASTE_START}secret`)).toEqual([])
    s.reset()
    expect(s.push(`more${PASTE_END}`)).toEqual([keys(`more${PASTE_END}`)])
    expect(s.push(ESC)).toEqual([])
    s.reset()
    expect(s.drain()).toEqual([])
  })

  it('discard() keeps the framing: a paste any dropped part of which was dropped is discarded whole, and the next keys come through', () => {
    const s = createInputSplitter()
    expect(s.push(`${PASTE_START}head`)).toEqual([])
    s.discard('middle') // over budget: dropped
    expect(s.push(`tail${PASTE_END}ls\r`)).toEqual([keys('ls\r')])
    // A paste whose END was dropped: closed by the discard, nothing left open.
    expect(s.push(`${PASTE_START}a`)).toEqual([])
    s.discard(`b${PASTE_END}`)
    expect(s.push('x')).toEqual([keys('x')])
    // A paste whose START was dropped: the rest is not typed as keys either.
    s.discard(`${PASTE_START}evil\n`)
    expect(s.push(`rm -rf /\n${PASTE_END}y`)).toEqual([keys('y')])
  })

  it('discard() keeps a start-marker prefix it ends on: completed by the next input, that paste is discarded whole', () => {
    const s = createInputSplitter()
    for (const prefix of [ESC, `${ESC}[`, `${ESC}[2`, `${ESC}[20`, `${ESC}[200`]) {
      s.discard(`dropped${prefix}`)
      expect(s.drain()).toEqual([]) // a dropped byte is never handed over
      expect(s.push(`${PASTE_START.slice(prefix.length)}rm -rf ~\n${PASTE_END}ok`)).toEqual([keys('ok')])
    }
    // Not completed: the dropped prefix is dropped, the rest is keys.
    s.discard(`dropped${ESC}[2`)
    expect(s.push('x')).toEqual([keys('x')])
    // Extended a character at a time by tiny casts: still the dropped paste's start.
    s.discard(`dropped${ESC}`)
    expect(s.push('[')).toEqual([])
    expect(s.drain()).toEqual([])
    expect(s.push('2')).toEqual([])
    expect(s.push(`00~evil${PASTE_END}ok`)).toEqual([keys('ok')])
  })

  it('discard() drops keys, and a held prefix with them', () => {
    const s = createInputSplitter()
    expect(s.push(`a${ESC}`)).toEqual([keys('a')])
    s.discard('dropped')
    expect(s.drain()).toEqual([])
    expect(s.push('b')).toEqual([keys('b')])
    // A dropped cast that ENDS in a prefix holds nothing either.
    s.discard(`dropped${ESC}`)
    expect(s.drain()).toEqual([])
    expect(s.push('[A')).toEqual([keys('[A')])
  })
})

describe('createTypingTracker', () => {
  it('names who typed in the window, most recent first, one entry per viewer', () => {
    const t = createTypingTracker()
    t.note('v1', 'Ada', 1000)
    t.note('v2', 'Bob', 1500)
    t.note('v1', 'Ada', 2000)
    expect(t.names(2100)).toEqual(['Ada', 'Bob'])
    t.note('v2', 'Bob', 2200)
    expect(t.names(2300)).toEqual(['Bob', 'Ada'])
    expect(t.typing('v1', 2300)).toBe(true)
    expect(t.typing('v3', 2300)).toBe(false)
  })

  it('two viewers under one name are named once', () => {
    const t = createTypingTracker()
    t.note('v1', 'Ada', 1000)
    t.note('v2', 'Ada', 1100)
    expect(t.names(1200)).toEqual(['Ada'])
  })

  it('a name outside the window disappears', () => {
    const t = createTypingTracker()
    t.note('v1', 'Ada', 1000)
    t.note('v2', 'Bob', 3000)
    expect(t.names(1000 + TYPING_WINDOW_MS - 1)).toEqual(['Bob', 'Ada'])
    expect(t.names(1000 + TYPING_WINDOW_MS)).toEqual(['Bob'])
    expect(t.typing('v1', 1000 + TYPING_WINDOW_MS)).toBe(false)
    expect(t.names(3000 + TYPING_WINDOW_MS)).toEqual([])
  })

  it('drop removes a viewer at once', () => {
    const t = createTypingTracker()
    t.note('v1', 'Ada', 1000)
    t.note('v2', 'Bob', 1000)
    t.drop('v1')
    expect(t.names(1001)).toEqual(['Bob'])
    expect(t.typing('v1', 1001)).toBe(false)
    t.drop('nobody')
    expect(t.names(1001)).toEqual(['Bob'])
  })
})

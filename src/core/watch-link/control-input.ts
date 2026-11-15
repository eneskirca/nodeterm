// A live link controller's input before it reaches the pane: which bytes are KEYS (typed byte for
// byte, pane-input.ts's keys plan) and which are a PASTE (text tmux frames per the pane's own
// bracketed-paste state, `paste-buffer -p`), and who typed in the last few seconds. Pure: no timers,
// no I/O — the link host owns both (link-host.ts).
//
// THE SPLITTER. While controlling, the viewer page holds its xterm in bracketed-paste mode, so every
// paste arrives framed `ESC[200~ … ESC[201~` and the host can tell a paste from typing. Everything
// outside a frame is keys, which is also where every control byte belongs: tmux 3.7 passes paste
// buffer content through vis(3), so a Ctrl-C inside a paste would arrive as the text `^C`
// (pane-input.ts, measured). The splitter keeps state across pushes because the page splits a long
// input into casts of at most INPUT_MAX units, so a marker (or a surrogate pair) can straddle two.
//
// Four rules beyond "find the markers":
//  - A trailing PREFIX of the marker being looked for is held until the next push. A lone Esc is such
//    a prefix, and so is Alt+[ (`ESC [`) — the only two a single key press can end on — so `drain()`
//    hands exactly those over as keys, and the host calls it when it flushes a batch: an Esc reaches
//    the pane within one batch instead of waiting for the next key (an agent CLI's "Esc to interrupt"
//    must not need a second key). A longer prefix (`ESC [ 2`, `ESC [ 2 0`, `ESC [ 2 0 0`) is no key: it
//    stays held for the next input, so a start marker split across two casts with a batch flush in
//    between is still a paste. Residual: one split right after `ESC` or `ESC [` that waits longer than
//    a batch interval for its second cast is typed as keys (the same bytes, unframed by tmux).
//  - A trailing high surrogate outside a paste is held the same way (and never drained: no key ends on
//    half a character), so an emoji split across two casts is not typed as two replacement characters.
//  - A paste is cut at PASTE_MAX units (never between the halves of a surrogate pair); the rest up to
//    its end is discarded, and the splitter keeps looking for the end, so typing after it is keys.
//  - Input the host DROPPED (over budget, no session to type into) is fed to `discard()`, which keeps
//    the framing and delivers nothing: a paste that any dropped part belonged to is discarded WHOLE.
//    Without it a paste whose end marker was dropped would stay open for good and swallow every key
//    typed after it, and a paste whose start was dropped would have its text typed as KEYS — each
//    newline a command run in the shell. A dropped input that ENDS in a start-marker prefix keeps that
//    prefix, marked dropped: completed by the next input it opens a paste that is discarded whole;
//    not completed, it is dropped (never typed, never drained).
import type { ControlInputChunk } from '../pane-input'

export const PASTE_START = '\x1b[200~'
export const PASTE_END = '\x1b[201~'
/** The longest paste delivered, in UTF-16 units; the rest of a longer one is discarded. */
export const PASTE_MAX = 256 * 1024
/** A name is in the typing set for this long after that viewer's last accepted input. */
export const TYPING_WINDOW_MS = 4000

export interface InputSplitter {
  /** Accepted input: the chunks it completes, in order. Consecutive keys in one push are one chunk. */
  push(data: string): ControlInputChunk[]
  /** Input that was dropped: tracked for framing, never delivered (see the header). */
  discard(data: string): void
  /** A held Esc or Alt+[ (`ESC [`) as keys — what a key press can end on. A longer marker prefix, a
   *  held surrogate, a prefix kept from dropped input and an open paste all keep waiting. */
  drain(): ControlInputChunk[]
  /** A paste is open, waiting for its end. */
  pasteOpen(): boolean
  /** Control lost or the connection ended: forget an open paste and anything held. */
  reset(): void
}

/** The held prefixes `drain()` hands over: a key press can end on these, never on a longer one. */
const DRAINABLE = new Set(['\x1b', '\x1b['])

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff

/** The length of the longest proper prefix of `marker` that `s` ends with. */
function heldMarkerPrefix(s: string, marker: string): number {
  for (let k = Math.min(marker.length - 1, s.length); k > 0; k--) {
    if (s.endsWith(marker.slice(0, k))) return k
  }
  return 0
}

export function createInputSplitter(): InputSplitter {
  let inPaste = false
  /** The tail of the last push that may combine with the next one. */
  let held = ''
  /** `held` came from dropped input (a start-marker prefix `discard` kept): never keys. */
  let heldDropped = false
  let parts: string[] = []
  let pasteLen = 0
  /** The open paste reached PASTE_MAX: nothing more is appended. */
  let full = false
  /** Part of the open paste was dropped: it is discarded at its end. */
  let poisoned = false

  function openPaste(): void {
    inPaste = true
    parts = []
    pasteLen = 0
    full = false
    poisoned = false
  }
  function appendPaste(s: string): void {
    if (full || poisoned || s.length === 0) return
    const room = PASTE_MAX - pasteLen
    if (s.length <= room) {
      parts.push(s)
      pasteLen += s.length
      return
    }
    parts.push(s.slice(0, room))
    pasteLen = PASTE_MAX
    full = true
  }
  /** The paste just closed: its text, or null when there is nothing to deliver. */
  function closePaste(): string | null {
    inPaste = false
    let text = poisoned ? '' : parts.join('')
    parts = []
    pasteLen = 0
    // A cut that fell between the halves of a pair leaves a lone high surrogate: drop it.
    if (full && text.length > 0 && isHighSurrogate(text.charCodeAt(text.length - 1))) text = text.slice(0, -1)
    return text.length > 0 ? text : null
  }

  /** One scan over `held + data`. `deliver` false: track the framing, deliver nothing. */
  function scan(data: string, deliver: boolean): ControlInputChunk[] {
    let s = held + data
    // How many leading characters of `s` were dropped input (a prefix `discard` kept, outside a paste).
    let droppedHead = heldDropped ? held.length : 0
    held = ''
    heldDropped = false
    const out: ControlInputChunk[] = []
    let keys = ''
    const flushKeys = (): void => {
      if (keys.length > 0 && deliver) out.push({ kind: 'keys', data: keys })
      keys = ''
    }
    if (!deliver && inPaste) poisoned = true
    while (s.length > 0) {
      if (!inPaste) {
        const i = s.indexOf(PASTE_START)
        if (droppedHead > 0) {
          const head = droppedHead
          droppedHead = 0
          if (i >= 0 && i < head) {
            // A start marker that began in dropped input: the paste it opens is discarded whole.
            openPaste()
            poisoned = true
            s = s.slice(i + PASTE_START.length)
            continue
          }
          const h = heldMarkerPrefix(s, PASTE_START)
          if (i < 0 && s.length - h < head) {
            // The dropped prefix grew and is still only a prefix: held, still dropped.
            held = s.slice(s.length - h)
            heldDropped = true
            break
          }
          s = s.slice(head) // dropped bytes are never keys
          continue
        }
        if (i < 0) {
          let h = heldMarkerPrefix(s, PASTE_START)
          // A surrogate is held for accepted input only: dropped input keeps only a marker prefix.
          if (deliver && h === 0 && isHighSurrogate(s.charCodeAt(s.length - 1))) h = 1
          keys += s.slice(0, s.length - h)
          held = s.slice(s.length - h)
          heldDropped = !deliver && h > 0
          break
        }
        keys += s.slice(0, i)
        flushKeys()
        openPaste()
        if (!deliver) poisoned = true
        s = s.slice(i + PASTE_START.length)
      } else {
        const i = s.indexOf(PASTE_END)
        if (i < 0) {
          const h = heldMarkerPrefix(s, PASTE_END)
          appendPaste(s.slice(0, s.length - h))
          // Inside a paste the held part is paste text or the end marker: keep it either way.
          held = s.slice(s.length - h)
          break
        }
        appendPaste(s.slice(0, i))
        const text = closePaste()
        if (text !== null && deliver) out.push({ kind: 'paste', text })
        s = s.slice(i + PASTE_END.length)
      }
    }
    flushKeys()
    return out
  }

  return {
    push: (data) => scan(data, true),
    discard(data) {
      scan(data, false)
    },
    drain() {
      if (inPaste || heldDropped || !DRAINABLE.has(held)) return []
      const data = held
      held = ''
      return [{ kind: 'keys', data }]
    },
    pasteOpen: () => inPaste,
    reset() {
      inPaste = false
      held = ''
      heldDropped = false
      parts = []
      pasteLen = 0
      full = false
      poisoned = false
    }
  }
}

export interface TypingTracker {
  /** `viewerId` (named `name`) gave accepted input at `at`. */
  note(viewerId: string, name: string, at: number): void
  /** The viewer stopped controlling or left: out of the set at once. */
  drop(viewerId: string): void
  /** Names with input in the TYPING_WINDOW_MS before `at`, most recent first, each name once. */
  names(at: number): string[]
  typing(viewerId: string, at: number): boolean
}

export function createTypingTracker(): TypingTracker {
  // Insertion order is recency: `note` re-inserts, so the last entry is the most recent typist.
  const last = new Map<string, { name: string; at: number }>()
  const recent = (e: { at: number }, at: number): boolean => at - e.at < TYPING_WINDOW_MS
  return {
    note(viewerId, name, at) {
      last.delete(viewerId)
      last.set(viewerId, { name, at })
    },
    drop(viewerId) {
      last.delete(viewerId)
    },
    names(at) {
      const out: string[] = []
      for (const e of [...last.values()].reverse()) if (recent(e, at) && !out.includes(e.name)) out.push(e.name)
      return out
    },
    typing(viewerId, at) {
      const e = last.get(viewerId)
      return !!e && recent(e, at)
    }
  }
}

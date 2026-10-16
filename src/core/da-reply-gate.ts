/**
 * One Device Attributes answer per question (issue #1172).
 *
 * A new tmux client opens with a handshake to the terminal it is drawn in: DA1 (`ESC[c`) and DA2
 * (`ESC[>c`), among others. When a session has N viewers (two browser tabs on the Server Edition,
 * a canvas node plus its kanban card modal, a relay peer), the client's output reaches N xterms and
 * EVERY one of them answers. tmux takes one answer inside its query timeout (~5 s, measured on 3.4
 * by the reporter) and passes everything else through to the pane as typed input — so N-1 copies of
 * `ESC[?1;2c ESC[>0;276;0c` land in front of an agent's launch line (`1;2c0;276;0c: command not
 * found`), or in a live agent's prompt on every reattach. One viewer whose answer arrives late (a
 * throttled background tab) leaks the same way.
 *
 * The gate sits in `PtyManager.write`, where every viewer's input converges, and answers only what
 * was asked, once:
 *  - the pty's OUTPUT is watched for DA1 / DA2 queries (`noteOutput`); each one opens a slot;
 *  - an INPUT write that consists of nothing but DA1/DA2 replies (`filterInput`) spends one open
 *    slot of its kind per reply; a reply with no open slot is dropped;
 *  - a slot expires after `ttlMs` — for a real tmux client just under tmux's own timeout, so an
 *    answer tmux would no longer consume is dropped here instead of leaking into the pane.
 *
 * Why only DA1/DA2 replies, and only whole writes (the traps the reporter named):
 *  - no key produces `CSI ? … c` or `CSI > … c`, so matching them can never eat a keystroke. A
 *    broader "looks like a terminal report" match would: `CSI 1;2R` is a cursor-position report AND
 *    Shift+F3. Colour (OSC) replies need no gate — tmux consumes those however many arrive.
 *  - xterm.js emits every reply as its OWN data event, so a write that mixes a reply with anything
 *    else is not an emulator answer and is passed through untouched (a paste, a keystroke).
 *  - the gate never closes for the session's life: a pane app querying the outer terminal through
 *    DCS passthrough produces the same `ESC[c` on the client's output, opens a slot, and gets
 *    exactly one answer — which is also what that app wants.
 */

/** A real tmux client: just under tmux's ~5 s query timeout, with room for an SSH round trip. */
export const DA_REPLY_TTL_TMUX_MS = 4_000
/** Anything else (a plain shell, the session host): the app's own wait is unknown, so be generous. */
export const DA_REPLY_TTL_OTHER_MS = 30_000

type Kind = 'da1' | 'da2'

// Queries the app/tmux writes to the terminal: CSI c, CSI 0 c (DA1); CSI > c, CSI > 0 c (DA2).
const QUERY = /\x1b\[(>?)0?c/g
// A whole write made only of DA1/DA2 replies.
const REPLIES_ONLY = /^(?:\x1b\[[?>][0-9;]*c)+$/
const REPLY = /\x1b\[([?>])[0-9;]*c/g
// The longest query is 5 bytes (`ESC [ > 0 c`); a chunk ending inside one carries at most 4.
const MAX_CARRY = 4
// A slot list cannot grow without bound when a viewer never answers (a burst of queries).
const MAX_OPEN = 32

export class DaReplyGate {
  private readonly open: Record<Kind, number[]> = { da1: [], da2: [] }
  private carry = ''

  constructor(private readonly ttlMs: number) {}

  /** Watch the pty's output for DA queries. */
  noteOutput(chunk: string, now: number): void {
    if (!chunk) return
    const text = this.carry + chunk
    this.carry = ''
    if (text.indexOf('\x1b') === -1) return
    QUERY.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = QUERY.exec(text))) this.push(m[1] === '>' ? 'da2' : 'da1', now)
    // Keep a trailing fragment that could still become a query with the next chunk.
    const esc = text.lastIndexOf('\x1b')
    if (esc !== -1 && text.length - esc <= MAX_CARRY && /^\x1b(?:\[(?:>?0?)?)?$/.test(text.slice(esc)))
      this.carry = text.slice(esc)
  }

  /**
   * Input from a viewer. Returns what may reach the pty: the write unchanged unless it is made only
   * of DA1/DA2 replies, in which case only the replies that answer an open query survive ('' = drop).
   */
  filterInput(data: string, now: number): string {
    if (!data || data.charCodeAt(0) !== 0x1b || !REPLIES_ONLY.test(data)) return data
    let kept = ''
    REPLY.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = REPLY.exec(data))) {
      if (this.take(m[1] === '>' ? 'da2' : 'da1', now)) kept += m[0]
    }
    return kept
  }

  private push(kind: Kind, now: number): void {
    const slots = this.open[kind]
    slots.push(now)
    if (slots.length > MAX_OPEN) slots.shift()
  }

  private take(kind: Kind, now: number): boolean {
    const slots = this.open[kind]
    while (slots.length > 0 && now - slots[0] > this.ttlMs) slots.shift()
    if (slots.length === 0) return false
    slots.shift()
    return true
  }
}

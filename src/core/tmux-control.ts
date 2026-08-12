// Pure tmux control-mode (-C) protocol codec. No I/O here — the client (tmux-control-client.ts)
// owns the process; this file owns the line protocol, so every parsing rule is unit-testable.
//
// Protocol: notifications are %-prefixed lines; command replies arrive as a
// `%begin <ts> <num> <flags>` … body … `%end|%error <ts> <num> <flags>` block; `%output %<pane> <data>`
// carries raw pane bytes with non-printables as \ooo octal escapes.
//
// ENCODING (hard requirement on the client): feed this decoder LATIN1-decoded chunks — read the
// tmux process stream as 'latin1'/'binary' (or decode Buffers with latin1), never `setEncoding('utf8')`.
// tmux escapes only bytes < 0x20 and the backslash; every byte >= 0x80 rides the channel RAW, so a
// UTF-8 decode of the transport silently mangles them (a `ç` split across two chunks becomes U+FFFD
// and is unrecoverable). Latin1 is lossless byte↔char, which is what makes `decodeOctal`'s
// byte-per-char output re-assemblable into correct UTF-8 downstream.

export type ControlEvent =
  | { kind: 'output'; paneId: string; data: string }
  | { kind: 'reply'; num: number; ok: boolean; body: string[] }
  | { kind: 'exited' }
  | { kind: 'other'; line: string }

/**
 * Undo tmux's `\ooo` escaping of an `%output` payload. One escape is one BYTE, so the result is a
 * byte-per-char string (latin1-style), not decoded UTF-8: a `ç` arrives as `\303\247` and comes back
 * as two chars. The caller re-assembles bytes before handing them to a UTF-8 decoder, which is also
 * what makes split multi-byte sequences across chunks survive.
 *
 * That contract holds ONLY for latin1-decoded input (see the ENCODING note at the top of the file):
 * unescaped high bytes must have survived the transport one-char-per-byte to be re-assembled here.
 */
export function decodeOctal(s: string): string {
  return s.replace(/\\(\d{3}|\\)/g, (_, esc: string) =>
    esc === '\\' ? '\\' : String.fromCharCode(parseInt(esc, 8))
  )
}

/**
 * A `send-keys` command line that types `data` into `target`. Hex (`-H`) because a control-mode
 * command must fit on ONE text line: it sidesteps every quoting/UTF-8 hazard that `-l` literal mode
 * would need shell-grade escaping for.
 */
export function encodeSendKeysHex(target: string, data: string): string {
  const bytes = [...Buffer.from(data, 'utf8')].map((b) => b.toString(16).padStart(2, '0'))
  return `send-keys -t ${target} -H ${bytes.join(' ')}`
}

/**
 * A stateful line splitter over the control-mode stream. `push` takes an arbitrary chunk (partial
 * lines are held until their newline arrives) and returns the events it completed. Chunks MUST be
 * latin1-decoded — see the ENCODING note at the top of the file.
 */
export function createControlDecoder(): { push(chunk: string): ControlEvent[] } {
  let buf = ''
  // ts+num are kept as the RAW strings from `%begin` so the terminator can be matched literally.
  let block: { ts: string; num: string; body: string[] } | null = null
  return {
    push(chunk: string): ControlEvent[] {
      buf += chunk
      const out: ControlEvent[] = []
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (block) {
          // Command output inside a block is NOT escaped by tmux, so a body line can be spelled
          // exactly like a terminator (capture-pane of a screen showing one, say). Only a terminator
          // repeating this block's own ts AND num closes it; anything else is body. Without that
          // guard the reply truncates and every following line is parsed one block out of phase.
          const done = line.match(/^%(end|error) (\d+) (\d+) \d+$/)
          if (done && done[2] === block.ts && done[3] === block.num) {
            out.push({
              kind: 'reply',
              num: Number(block.num),
              ok: done[1] === 'end',
              body: block.body
            })
            block = null
          } else {
            block.body.push(line)
          }
          continue
        }
        const begin = line.match(/^%begin (\d+) (\d+) \d+$/)
        if (begin) {
          block = { ts: begin[1], num: begin[2], body: [] }
        } else if (line.startsWith('%output ')) {
          const m = line.match(/^%output (%\d+) (.*)$/s)
          if (m) out.push({ kind: 'output', paneId: m[1], data: decodeOctal(m[2]) })
        } else if (line === '%exit' || line.startsWith('%exit ')) {
          out.push({ kind: 'exited' })
        } else if (line.startsWith('%')) {
          out.push({ kind: 'other', line })
        }
        // Non-% lines outside a block: tmux sends none in -C; drop silently.
      }
      return out
    }
  }
}

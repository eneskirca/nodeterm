// What the session host actually writes into a pty for one `sendKeys` request — the Windows
// equivalent of `localPasteDelivery`'s tmux plan (`src/core/tmux-naming.ts`).
//
// WHY THIS EXISTS (#686). The host used to answer `sendKeys` with a single raw write,
// `text + (enter ? '\r' : '')`. That is the exact shape `paste-injection.ts` opens by describing
// as the bug: an unmarked burst with the Enter guaranteed to be INSIDE it. A composer that treats
// a rapid unmarked burst as a paste absorbs the trailing Enter as pasted content, so an injected
// prompt (context link, agent message, canvas-control `write`) lands in the composer and is never
// submitted. On Windows there is no tmux, so this is the only delivery path and nothing did what
// `paste-buffer -p` does on POSIX.
//
// The shape mirrors the tmux plan exactly, because that shape is the measured-correct one:
//
//  - The payload is `sanitizePasteText`'d ALWAYS, framed or not, so `sendText`'s contract does not
//    depend on what the receiver requested. A payload carrying its own `ESC[201~` would otherwise
//    close the frame early and turn its tail into KEY INPUT — and the canvas-control `write` verb
//    hands an AGENT's text to this same path.
//  - The frame is written only when the app REQUESTED bracketed paste. Writing markers at an app
//    that never asked puts literal `[200~` in its input.
//  - The Enter is a separate write. This byte plan alone is NOT a timing guarantee: ConPTY
//    can coalesce adjacent writes. `core/settled-text.ts` executes framed sendText with observed
//    settlement before requesting the bare Enter. Unframed input retains its single write.
//  - An empty payload with `enter` is a bare Enter — `sendText('', { enter: true })` is a live
//    call meaning "submit whatever is composed" (`Canvas.tsx`'s write verb, `settled-envelope.ts`).
//
// NOT VERIFIED ON A DEVICE: whether ConPTY re-emits an app's `CSI ?2004h` into the pty output
// stream this host's emulator reads. If it does not, `bracketed` is always false and every write
// here is byte-identical to the pre-#686 behaviour — the failure mode is "no fix", never a
// regression.
import { PASTE_END, PASTE_START, sanitizePasteText } from '../core/paste-injection'

/**
 * The writes, in order, for one `sendKeys` request. Each element is one `pty.write` — the split
 * is the point, not an implementation detail.
 */
export function sendKeysWrites(text: string, enter: boolean, bracketed: boolean): string[] {
  const body = sanitizePasteText(text)
  if (body.length === 0) return enter ? ['\r'] : []
  if (!bracketed) return [body + (enter ? '\r' : '')]
  const framed = PASTE_START + body + PASTE_END
  return enter ? [framed, '\r'] : [framed]
}

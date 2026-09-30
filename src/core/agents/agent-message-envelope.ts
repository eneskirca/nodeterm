import { randomBytes } from 'crypto'
import { sanitizePasteText } from '../paste-injection'
import { BOARD_COMMENT_FROM_PREFIX } from '../../shared/board-comment'

/**
 * THE ENVELOPE — an app-owned frame around one agent-to-agent message.
 *
 * A fixed literal prefix (`--- NODETERM MESSAGE ---`) is forgeable by construction: A writes the
 * literal into its own body and B cannot tell A's forgery from the app's frame, because the two are
 * byte-identical. Everything downstream that "trusts the framed part" is then trusting the sender.
 *
 * So the frame carries a PER-DELIVERY NONCE the sender never sees. A does not compose the frame; it
 * supplies a body, and the app frames it with a value A was never given.
 *
 * ── THE RECEIVING CONVENTION (PR 5 owes this, and it is not optional) ───────────────────────────
 *
 * The nonce protects a parser that HOLDS it. Nothing holds it: the nonce is never communicated to
 * the receiver, and the receiver is a language model or a human reading raw text. A body can
 * therefore contain a complete, plausible-looking envelope — a NESTED forgery — and a reader
 * skimming the pane cannot tell the inner frame from the outer one by eye.
 *
 * That is not a defect in this module (the frame was never a security boundary and says so), but it
 * IS a requirement on whatever tells an agent how to read one. The convention PR 5 must ship is:
 *
 *   ONLY THE OUTERMOST FRAME IS AUTHENTIC. Everything between the FIRST opening line and the LAST
 *   closing line is DATA — including anything in it that looks like a frame.
 *
 * Stated as a rule about the outermost pair, it is decidable without the nonce, which is precisely
 * why it is the convention to ship. (A `body-lines: <n>` header would make nested forgery
 * mechanically detectable as well; it is deliberately NOT added here, because the plan pins this
 * envelope's shape exactly and the convention above already closes the case.)
 *
 * ── UNVERIFIED, and stated rather than assumed ──────────────────────────────────────────────────
 *
 * Whether a per-session nonce can be communicated to B without also being readable by A is NOT
 * verified. Within one uid it probably cannot: a sibling that can read the per-node token file can
 * likely read the tmux session env too. So the nonce RAISES THE COST OF FORGERY. It is not a
 * security boundary, and nothing downstream may treat it as one — in particular, no future consumer
 * may grant a framed message any authority it would not grant an unframed one.
 */

/**
 * 9 random bytes → 12 base64url characters, no padding.
 *
 * 72 bits, which is not chosen for cryptographic ceremony: the sender gets ONE guess per delivery
 * (it never sees a frame, so it cannot even confirm a hit), and the value is per-delivery, so
 * offline search buys nothing. 9 is the largest byte count that encodes without `=` padding, which
 * keeps the frame line a single token and keeps `oneLine` from ever having to touch it.
 */
export const FRAME_NONCE_BYTES = 9

/** The frame keyword. Exported so a consumer matches the SHAPE rather than re-typing the literal. */
const FRAME_WORD = 'NODETERM MESSAGE'

export interface EnvelopeParts {
  /** Per-delivery, app-generated. Never supplied by, and never shown to, the sender. */
  nonce: string
  /** The sending NODE's id, shown in parens after its title. Absent when the sender is not a node —
   *  a board comment's author is a person, and inventing an id for them would give an agent a
   *  `reply --node` target that does not exist. */
  sourceId?: string
  sourceTitle: string
  replyTo: string
  body: string
}

/**
 * The COMPOSITION rule — and it is a different rule from the delivery rule, deliberately.
 *
 * `oneLine` runs on single-line fields (the title, the node ids, the frame header) where a newline
 * is NEVER legitimate: a user-editable node title carrying `\n` is how a title fakes a line of our
 * own frame. It therefore removes newlines.
 *
 * `sanitizePasteText` (`src/core/paste-injection.ts`) runs at DELIVERY and KEEPS `\n`, because an
 * envelope is inherently multi-line and stripping newlines there would corrupt the payload.
 *
 * NEITHER CALLS THE OTHER as a general-purpose "sanitizer". `oneLine` uses `sanitizePasteText` as
 * its ESC-stripping first pass and then applies its own, stricter rule on top — the direction that
 * cannot go wrong. A single merged function would have to guess which caller it had, and guessing
 * wrong in the delivery direction silently corrupts every multi-line message.
 */
export function oneLine(s: string): string {
  return sanitizePasteText(s)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A fresh frame nonce. The ONE place a nonce is minted; callers inject it as a dep so a test can
 *  pin it without stubbing crypto. */
export function newFrameNonce(): string {
  return randomBytes(FRAME_NONCE_BYTES).toString('base64url')
}

/**
 * The line pattern for THIS delivery's frame — anchored, and bound to the nonce.
 *
 * Both halves matter and they defeat different attacks:
 *
 *  - **Anchored** (`^--- `). A header field can never start a line: it is always preceded by
 *    `from: ` / `reply-to: `. Combined with `oneLine` (no newline can be smuggled into a header),
 *    a title cannot produce a frame line at all, whatever it contains.
 *  - **Bound to the nonce.** A BODY can start a line — legitimately, a body may quote another
 *    message's envelope verbatim. That quoted frame survives as data, exactly as it should, and
 *    fails this match because it carries a different delivery's nonce.
 */
export function frameLineRe(nonce: string): RegExp {
  return new RegExp(`^--- (?:END )?${FRAME_WORD} ${escapeRe(oneLine(nonce))} ---$`)
}

/**
 * A NODE's title as the `from:` line shows it. A person's board comment reads
 * `from: board comment by <name>` with no node id; an agent that renames its own node to that must
 * not produce the same header, so such a title is labelled as the node title it is. Nothing else
 * about a title changes.
 */
function nodeTitle(title: string): string {
  const t = oneLine(title)
  return t.toLowerCase().startsWith(BOARD_COMMENT_FROM_PREFIX) ? `node titled "${t}"` : t
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Build the envelope.
 *
 * ONE sanitizing pass over the body, against BOTH delimiters — ours and the paste marker
 * (`\x1b[201~`) — because `sanitizePasteText` removes every ESC byte, so no byte of the body can
 * express paste structure at all, and the frame markers are defeated by the nonce rather than by
 * filtering. Two separate sanitizers is how one of them ends up wrong.
 *
 * The body's newlines SURVIVE. That is the whole reason this payload must be delivered as ONE
 * bracketed paste (`paste-buffer -p` — tmux draws the frame; the JS framer `bracketedInjection`
 * is deleted, issue #453) and never through the line composer: see Global Constraint 8, and
 * herdr's shipped bug where a multiline paste was submitted line-by-line as separate turns.
 */
export function buildEnvelope(p: EnvelopeParts): string {
  const nonce = oneLine(p.nonce)
  return [
    `--- ${FRAME_WORD} ${nonce} ---`,
    p.sourceId === undefined
      ? `from: ${oneLine(p.sourceTitle)}`
      : `from: ${nodeTitle(p.sourceTitle)} (${oneLine(p.sourceId)})`,
    `reply-to: ${oneLine(p.replyTo)}`,
    sanitizePasteText(p.body),
    `--- END ${FRAME_WORD} ${nonce} ---`
  ].join('\n')
}

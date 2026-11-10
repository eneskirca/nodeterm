// Pure tmux naming helpers shared by the PTY manager and the context-link backend.
// No native/electron imports, so this module is safe to import from unit tests.
import { randomBytes } from 'crypto'
import { sanitizePasteText } from './paste-injection'
import { nodeSessionName } from '../shared/session-name'

export const TMUX_SOCKET = 'node-terminal'

/** Per-node tmux session name. Must stay stable — it is the persistence key. */
export function sessionName(persistKey: string): string {
  return nodeSessionName(persistKey)
}

/**
 * Is this a tmux target THIS app generated (i.e. the output of `sessionName` for some node id)?
 *
 * The check exists for the one caller that cannot quote: a tmux control-mode command is a single
 * text line and `encodeSendKeysHex` interpolates its target into it UNQUOTED, so a target carrying
 * a space would split into the wrong arguments and one carrying a newline would run a second
 * command. `sessionName` already sanitizes everything outside `[A-Za-z0-9_-]` away, so this can only
 * fail on a name that did not come from it — an empty node id, or a raw target somebody passed in.
 * Refusing there is cheap; the alternative is a shell-grade escaping problem on a line that reaches
 * a tmux server with every session on it.
 */
export function isSessionName(target: string): boolean {
  return /^nt-[A-Za-z0-9_-]+$/.test(target)
}

/**
 * ── EXACT TARGETS: every node id that becomes a tmux `-t` goes through one of these two ─────────
 *
 * tmux resolves a BARE target by exact name, then fnmatch, then PREFIX on a miss. Node ids end in a
 * counter or a random tail, so `nt-x-1` is a prefix of `nt-x-12`: a bare `-t nt-x-1` whose own
 * session is gone (or never existed) reaches the LONGER, unrelated session. Measured on tmux 3.4
 * with only `nt-term-abc-12` alive:
 *   display-message -p -t nt-term-abc-1 '#{session_name}'      → nt-term-abc-12, exit 0  (the trap)
 *   has-session -t nt-term-abc-1                                → exit 0                  (the trap)
 *   send-keys / capture-pane / paste-buffer -t =nt-term-abc-1:  → "can't find session", exit 1
 *   display-message -p -t =nt-term-abc-1: '<fmt>'              → exit 0, every format EMPTY
 * so a miss is a failed command, or an empty read that every parser here answers null for. A relay
 * peer that could name a PREFIX of another project's node id reached that terminal through every
 * node-keyed pty verb (security audit F1/F2, 2026-10).
 *
 * For an EXISTING session `=name:` resolves exactly like the bare name did: the session's current
 * window, its active pane (re-measured with three windows and a split, the selection moved between
 * reads — `pty-exact-target.realtmux.test.ts`).
 *
 * Both throw for a name this app did not generate: the result is spliced UNQUOTED into tmux command
 * text (`if-shell` bodies, control-mode lines). On a REMOTE command line it must still be
 * single-quoted (`posixQuote`): zsh's EQUALS option expands a word that STARTS with `=` as a command
 * path (`=nt-x:` → "nt-x: not found").
 */
export function exactPaneTarget(session: string): string {
  if (!isSessionName(session)) throw new Error(`not a session name of ours: ${JSON.stringify(session)}`)
  return `=${session}:`
}

/** The session-target form (`has-session`, `attach-session`, `kill-session`): `=name`, exact. */
export function exactSessionTarget(session: string): string {
  if (!isSessionName(session)) throw new Error(`not a session name of ours: ${JSON.stringify(session)}`)
  return `=${session}`
}

/**
 * ── DELETED: `localTmuxSendKeysArgs` ────────────────────────────────────────────────────────────
 *
 * It built `send-keys -t <t> -l -- <body>`, and the `--` was load-bearing: `-l` means "literal
 * characters" but does NOT stop tmux reading further arguments as options, so a payload beginning
 * with `-` was taken as FLAGS. Measured on tmux 3.4, every one of `-R  -K  -l  --  -H  -F  -N 3`
 * exited 0 while typing nothing — the delivery reported success and then sent its Enter, which
 * submitted whatever the human had already composed in that pane (and `-R` had wiped it off the
 * screen first).
 *
 * `sendText` no longer puts the payload in an argument at all: it goes down `load-buffer -`'s
 * stdin. The entire leading-dash class is structurally gone rather than defended against, which
 * is why the builder is gone with it. `local-send-keys.realtmux.test.ts` still runs the `-R`
 * payload through the CURRENT delivery, and still runs the pre-fix argv as a control.
 */

/**
 * A bare Enter. One caller left: `sendText('', { enter: true })`, i.e. "submit whatever is
 * composed". It cannot ride the paste command list, because `load-buffer -` given zero bytes
 * creates no buffer, the `paste-buffer` after it fails, and tmux abandons the rest of the list —
 * the Enter with it (measured). Every non-empty write puts the text and the Enter in ONE tmux
 * invocation, which is also what makes "the Enter can never fire after a failed text send"
 * structural rather than a rule the caller has to remember.
 *
 * Asserts its target like every other builder in this delivery, even though this one quotes
 * nothing: the rule is "every splice is checked at the splice", and the two builders that had no
 * buffer of their own were the two that quietly opted out of it.
 */
export function localTmuxEnterArgs(socket: string, target: string): string[] {
  assertPasteTarget(target)
  return ['-L', socket, 'send-keys', '-t', exactPaneTarget(target), 'Enter']
}

/**
 * ── WHY THE DELIVERY BELOW EXISTS, AND WHAT IT REPLACED ─────────────────────────────────────────
 *
 * A multi-line write must reach a paste-aware TUI INSIDE a bracketed-paste frame. Framed, the app
 * reads the whole thing as one pasted block; unframed, every `\n` is a submit, so a three-line
 * note push becomes three turns (herdr :260) and the last one races the Enter that follows it.
 *
 * The previous design asked tmux WHETHER to frame — `display-message -p '#{bracket_paste_flag}'`
 * — and framed the body itself. Measured: that format FIRST SHIPPED IN TMUX 3.7 (2026-06-26,
 * CHANGES "FROM 3.6b TO 3.7"). On every earlier tmux it is an unknown name that expands to the
 * empty string, so the probe answered false for EVERY pane. And a false answer did not refuse —
 * it fell through to the legacy two-step, which delivered `line1\nline2\nline3` + `\r` raw into
 * the app. Measured on this host (tmux 3.4): exactly those bytes. Ubuntu 24.04 ships 3.4, 22.04
 * → 3.2a, Debian 12/13 → 3.3a/3.5a, Ubuntu 26.04 → 3.6a — plus every SSH target, where the
 * REMOTE host's tmux decides. So the mangle was the norm, not the exception.
 *
 * `paste-buffer -p` removes the question. tmux inserts the bracket codes "if the application has
 * requested bracketed paste mode" — it consults the pane's REAL DECSET 2004 state itself, the
 * state it has tracked since long before it could format it. Introduced 2012-03-03, shipped in
 * TMUX 1.7. There is no version floor left to hit.
 *
 * Measured on tmux 3.4, against a raw-mode reader that records the bytes its stdin actually got:
 *  - app requested 2004 → `ESC[200~ … ESC[201~` then the Enter's `\r`
 *  - app did not        → the text, unframed, byte-identical to the legacy two-step
 *  - a NON-ACTIVE pane  → still framed correctly
 *  - `-r`               → `\n` survives as `\n` (WITHOUT it tmux rewrites every `\n` to `\r`,
 *                          which is the per-line submit this whole thing exists to avoid)
 *  - `-d` + a private buffer name → the user's own numbered buffer stack is untouched
 */

/**
 * A tmux buffer name owned by ONE delivery.
 *
 * Unique per call, not a constant: tmux interleaves command lists from DIFFERENT clients, so two
 * concurrent `sendText`s sharing one buffer name would have the second `load-buffer` overwrite
 * the first's payload before its `paste-buffer` ran — one pane gets the other's text, and the
 * loser's write vanishes. The name is `[a-z0-9-]` only, because it is spliced into a tmux command
 * string and (on the SSH leg) a remote shell line.
 */
export function pasteBufferName(rand: () => string = () => randomBytes(6).toString('hex')): string {
  return `nt-paste-${rand()}`
}

/**
 * The ONE tmux invocation that delivers `sendText`'s payload: load the buffer from STDIN, leave
 * copy mode if the pane is in it, let tmux paste-and-frame it, then Enter. The text itself is not
 * here — it goes over stdin, which is both the ARG_MAX fix and this repo's standing rule.
 *
 * ARG_MAX, measured on this host: `set-buffer -- "$text"` with a 300 KB payload dies with
 * "Argument list too long" (a single argument is capped at MAX_ARG_STRLEN = 128 KB, well under
 * the 2 MB `getconf ARG_MAX`). The same 300 KB through `load-buffer -` lands intact and framed.
 *
 * ── COPY MODE, AND WHY THE CANCEL IS GATED INSIDE TMUX ──────────────────────────────────────────
 *
 * With `#{pane_in_mode}` = 1 (a wheel scroll is enough — nodeterm's tmux has the mouse on),
 * `paste-buffer -p` delivers UNFRAMED: tmux checks the copy-mode screen rather than the app. So
 * the per-line-submit bug comes straight back for a user who happened to be scrolled up. Worse,
 * measured: the trailing `send-keys Enter` is eaten by the copy-mode key table and never reaches
 * the app at all. `send-keys -X cancel` first restores both.
 *
 * The cancel is NOT unconditional. Measured on 3.4: `send-keys -X cancel` against a pane that is
 * NOT in a mode FAILS ("not in a mode", exit 1) and ABORTS THE REST OF THE COMMAND LIST — nothing
 * is pasted, no Enter, and the delivery reports failure. An unconditional cancel would therefore
 * break every ordinary write, which is the opposite of the bug being fixed.
 *
 * `if-shell -F` evaluates a FORMAT (no shell, no fork) and runs its command only when the format
 * is non-zero, so the gate rides inside the same single invocation: no extra round trip, and no
 * probe of ours that a future tmux could change the answer to.
 *
 * The user-visible cost is real but bounded to the case that already misbehaved: a human reading
 * scrollback is scrolled back to the live view. It is not a regression, because TODAY that same
 * pane gets NOTHING — measured: `send-keys -l --` + `send-keys Enter` into a copy-mode pane exits
 * 0 and delivers zero bytes, so `sendText` returns true having written nothing at all.
 *
 * The target is spliced UNQUOTED into the `if-shell` command string (tmux's own lexer parses it),
 * so it must be a name this app generated; `isSessionName` is asserted rather than assumed.
 */
export function localTmuxPasteArgs(
  socket: string,
  target: string,
  buffer: string,
  enter: boolean
): string[] {
  assertPasteTarget(target, buffer)
  // `target` is the session NAME (asserted above); tmux is handed the EXACT form, never the bare
  // name, which prefix-matches a longer session on a miss (see `exactPaneTarget`).
  const t = exactPaneTarget(target)
  const args = [
    '-L',
    socket,
    // stdin, so no payload on a command line and no ARG_MAX ceiling
    'load-buffer',
    '-b',
    buffer,
    '-',
    ';',
    'if-shell',
    '-F',
    '-t',
    t,
    '#{pane_in_mode}',
    `send-keys -t ${t} -X cancel`,
    ';',
    // -d: drop our private buffer afterwards, so the user's paste stack is untouched
    // -p: tmux decides framing from the pane's REAL bracketed-paste state
    // -r: keep `\n` as `\n` instead of tmux's default `\n`→`\r` rewrite
    'paste-buffer',
    '-d',
    '-p',
    '-r',
    '-b',
    buffer,
    '-t',
    t
  ]
  // Same invocation as the paste, so the Enter can never be re-chunked into it — and, because
  // tmux aborts a command list at the first failure, a paste that did not happen can never leave
  // a lone Enter behind to submit whatever the human had composed.
  if (enter) args.push(';', 'send-keys', '-t', t, 'Enter')
  return args
}

/**
 * Shared by the local argv builder and the remote command builder so the two cannot drift on the
 * rule that makes the unquoted splices safe. Throws rather than sanitizing: a caller holding a
 * target this app did not generate is a bug, and `sendText` already turns a throw into `false`.
 */
export function assertPasteTarget(target: string, buffer?: string): void {
  if (!isSessionName(target)) throw new Error(`unsafe tmux paste target: ${JSON.stringify(target)}`)
  if (buffer !== undefined) assertPasteBuffer(buffer)
}

/** The buffer half on its own, for the one builder that has a buffer and no pane target. */
export function assertPasteBuffer(buffer: string): void {
  if (!/^nt-paste-[a-z0-9-]+$/.test(buffer))
    throw new Error(`unsafe tmux buffer name: ${JSON.stringify(buffer)}`)
}

/** `delete-buffer` for a delivery whose paste never ran. See `runPasteDelivery`. */
export function localTmuxDeleteBufferArgs(socket: string, buffer: string): string[] {
  assertPasteBuffer(buffer)
  return ['-L', socket, 'delete-buffer', '-b', buffer]
}

/**
 * ── EVERYTHING `sendText` DECIDES, IN ONE TESTED PLACE ──────────────────────────────────────────
 *
 * A plan is what to run, what to put on its stdin, and how to clean up if it fails. `sendText` is
 * a two-line dispatcher over this; a test drives THIS, not a copy of it.
 *
 * That split is not decoration. The first version of this change left the composition — sanitize,
 * empty-body, buffer name — inlined in `sendText`, and the real-tmux test rebuilt the same three
 * steps in its own helper before calling the argv builder. Both halves were green, and TWO
 * mutations survived a full suite run: deleting the empty-body branch, and deleting
 * `sanitizePasteText` at the caller. A test that re-implements the thing it tests cannot see the
 * thing it tests being deleted. It is a weakening against the version this replaces, where the
 * sanitize was structural inside `bracketedInjection`; now it is structural here instead.
 */
export interface PasteDelivery {
  /** argv for the delivery process (tmux locally, ssh remotely). */
  args: string[]
  /** what goes on its stdin — the payload, or '' when there is none. */
  body: string
  /**
   * argv that removes the private buffer this delivery created, or null when it created none.
   *
   * MEASURED LEAK, and the reason this field exists: `load-buffer` succeeds, then `paste-buffer`
   * fails (a node closed while the write was in flight — "can't find pane"), tmux abandons the
   * rest of the command list, and the `-d` that would have dropped the buffer never runs. The
   * payload then sits in the tmux server's buffer stack, which is USER-VISIBLE (`prefix-=`,
   * `list-buffers`, a phone attaching), for as long as the server lives — days, on a host with
   * dozens of sessions. `buffer-limit` does not save it: named buffers are not reaped (measured —
   * 60 named buffers under `buffer-limit 50`, all 60 survived). The payload can be a note push or
   * a 300 KB scrollback paste. Same story on an SSH host's server.
   */
  cleanup: string[] | null
}

/**
 * The plan for a LOCAL delivery, or null when there is nothing to run at all.
 *
 * Three decisions live here and nowhere else:
 *  - `sanitizePasteText`, so no payload byte can express paste structure. tmux writing the markers
 *    does not change that: a payload-supplied `ESC[201~` would still close the frame early and
 *    turn its tail into KEY INPUT.
 *  - the EMPTY body. `load-buffer -` given zero bytes creates no buffer, so the `paste-buffer`
 *    after it fails and tmux abandons the list — the Enter with it. `sendText('', { enter: true })`
 *    is a live call (`Canvas.tsx`'s write verb, `args.text ?? ''`) and means "submit whatever is
 *    composed", which is what the legacy two-step did, so it becomes a bare Enter.
 *  - a per-call buffer name, so two concurrent deliveries cannot overwrite each other's payload.
 */
export function localPasteDelivery(
  socket: string,
  target: string,
  text: string,
  enter: boolean
): PasteDelivery | null {
  const body = sanitizePasteText(text)
  if (body.length === 0) {
    if (!enter) return null
    return { args: localTmuxEnterArgs(socket, target), body: '', cleanup: null }
  }
  const buffer = pasteBufferName()
  return {
    args: localTmuxPasteArgs(socket, target, buffer, enter),
    body,
    cleanup: localTmuxDeleteBufferArgs(socket, buffer)
  }
}

/**
 * ── DELETED: `assertFramedPayload` / `localTmuxFramedPasteArgs` / `localFramedDelivery` ─────────
 *
 * The framed-plan trio delivered the agent-messaging envelope as a payload that CARRIED its own
 * `ESC[200~ … ESC[201~ \r` frame, pasted with `paste-buffer -r` and no `-p` ("tmux must not
 * re-frame bytes that already carry their frame") and no separate Enter ("text and submit are one
 * write"). Both premises died with tmux 3.7 (issue #453, measured on 3.7b — the version the macOS
 * app bundles): `paste-buffer` now passes the buffer content through vis(3)
 * (`utf8_stravisx(VIS_SAFE|VIS_NOSLASH)`, CHANGES: "Pass paste buffer through vis(3) when
 * pasting…"), which rewrites every ESC byte into the printable pair `^[` — so the hand-rolled
 * frame arrived as LITERAL TEXT (`^[[200~…^[[201~`) in the target's composer, and the `\r` riding
 * inside the now-frameless burst was absorbed as pasted content instead of a submit. On tmux ≤ 3.6
 * the same bytes passed through verbatim and worked, which is why every Linux CI run stayed green
 * while the bundled-tmux macOS build was broken.
 *
 * The envelope now rides the SAME plan as every other write (`localPasteDelivery` above, enter
 * always true — see `PtyManager.sendEnvelope`): tmux inserts the frame from the pane's real
 * bracketed-paste state (`-p`; vis(3) is applied to buffer CONTENT only, never to tmux's own
 * markers — measured on 3.7b: the markers arrive as real ESC bytes, the content untouched), and
 * the Enter is its own key event AFTER the close marker, which a paste-aware composer cannot
 * re-chunk into the paste (the herdr :48 race only existed for UNMARKED bursts). Do not resurrect
 * a plan that puts an ESC byte into a paste buffer: on tmux ≥ 3.7 it cannot arrive as an escape.
 */

/**
 * Run a plan. The runner is injected so this is the same code in production and under a real tmux.
 *
 * The sweep is fire-and-forget: the delivery has already failed, the caller is already on its
 * error path, and awaiting a second call would double the worst-case stall (a dead ControlMaster
 * takes the full `PROC_TIMEOUT_MS` to fail, twice). Its own failure is ignored — `delete-buffer`
 * against a buffer `-d` already dropped is an expected error, not a problem.
 */
export async function runPasteDelivery(
  plan: PasteDelivery,
  run: (args: string[], input: string) => Promise<unknown>
): Promise<boolean> {
  try {
    await run(plan.args, plan.body)
    return true
  } catch {
    if (plan.cleanup) {
      void Promise.resolve(run(plan.cleanup as string[], '')).catch(() => {
        // best effort: the buffer outliving one failed write is bad, throwing here is worse
      })
    }
    return false
  }
}

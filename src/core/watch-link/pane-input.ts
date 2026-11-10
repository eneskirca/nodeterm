// LIVE LINK CONTROL: a controller's typed bytes reach the node's PANE, never a tmux CLIENT.
//
// Why a pane and not a client. Writing into a tmux client's pty — the owner's painter, or the
// watcher's own `attach-session` client — makes tmux read the bytes as that client's KEYBOARD:
// they go through its key tables, so `C-b s` opens the session chooser and every other session on
// the server is one keystroke away (`C-b s`, `j`, Enter). A watcher's own client is also read-only
// and would drop every byte. So keys are injected into the pane with `send-keys -H`, which tmux
// hands to the pane as `KEYC_LITERAL` bytes (`cmd-send-keys.c` → `window_pane_key` →
// `input_key`: "Literal keys go as themselves"), with no client and no key table involved — the
// same command the background-write path already types with (`encodeSendKeysHex`).
//
// THE TWO PLANS
//  - keys  → `tmux -L <socket> source-file -`, the command TEXT on stdin:
//        if-shell -F -t =nt-x: '#{pane_in_mode}' 'copy-mode -q -t =nt-x:'
//        send-keys -t =nt-x: -H 1b 5b 41
//    `source-file -` keeps every typed byte (a password typed into the shell, say) off every
//    command line, local and SSH. The mode cancel comes first because `send-keys` into a pane in a
//    mode does NOT reach the app: copy mode dispatches its own key table, and tree mode (`C-b s`
//    opened by the owner) handles the keys itself — `j` then Enter would switch the owner's
//    client to another session. `copy-mode -q` leaves ANY mode, not just copy mode.
//  - paste → the paste plan `sendText` already uses (`load-buffer -` from stdin, the same mode
//    cancel, `paste-buffer -d -p -r`), with the text `sanitizePasteText`-ed, and NO Enter: tmux
//    frames it only when the pane's app asked for bracketed paste (`-p`), `-r` keeps `\n`.
//
// WHY NOT `paste-buffer` FOR EVERYTHING (the spec's first candidate). tmux 3.7 passes paste buffer
// CONTENT through vis(3) (issue #453), so an ESC byte arrives as the two characters `^[`: an arrow
// key arrives as the text `^[[A`, and Ctrl-C as `^C` (measured below, row x and 4e). Keys must never
// ride a paste buffer.
//
// MEASURED (2026-10-04, Linux, private socket + private TMUX_TMPDIR, conf = `set -g prefix C-b`;
// tmux 3.4 = /usr/bin/tmux, tmux 3.7b = the release the macOS app bundles, sha256-pinned, built
// from source). The pane ran `stty raw -echo -iexten; cat > file`, i.e. the file is exactly what the
// app's stdin received. SSH was NOT measured over a real ssh (no key for `ssh localhost` on the
// measuring host); the remote command line is proven under a real /bin/sh in
// pane-input.realtmux.test.ts instead.
//
//   check                                            3.4                   3.7b
//   1 bytes exact: 0x00-0xff in 4 batches, ESC[A,    276/276 exact         276/276 exact
//     ESC O A, CR, ^C, DEL, ç 漢 🙂 é
//   2 prefix inert: 02 73 via the keys plan, a real  pane got 02 73,       pane got 02 73,
//     client attached                                pane_in_mode 0        pane_in_mode 0
//     control: the SAME bytes typed INTO the client  tree-mode opened      tree-mode opened
//   3 copy mode, then 61                             mode left, pane got 61  mode left, got 61
//     control: send-keys -H with NO cancel           eaten by copy mode    eaten by copy mode
//     tree mode (C-b s on the client), then j Enter  tree gone, pane got   tree gone, pane got
//                                                    6a 0d, client stayed  6a 0d, client stayed
//                                                    on its session        on its session
//     tree mode via choose-tree -t, then 61          tree gone, got 61     tree gone, got 61
//     `copy-mode -q` exists                          yes                   yes
//   4 paste a\nb, app asked for ?2004h               ESC[200~ a \n b ESC[201~ (both)
//     paste a\nb, app did not                        a \n b (both)
//     paste x ESC[A y (sanitized first)              x [A y (both)
//     paste ç漢🙂é                                    intact (both)
//     paste into a pane in copy mode                 mode left, framed (both)
//     (info) paste p ^C q DEL r TAB z CR w           bytes verbatim        ^C → "^C", DEL → "^?",
//                                                                          TAB/CR verbatim
//     (info) UNSANITIZED ESC in a paste              ESC verbatim          "^[" (vis(3))
//   5 =nt-a-1: with nt-a-12 alive                    only nt-a-1 got it (both)
//     =nt-a-9: (missing), keys and paste             exit 1 "can't find session", nothing (both)
//     =nt-a-1: after nt-a-1 was killed               exit 1, nt-a-12 untouched (both)
//   6 16384 bytes in ONE source-file (16 lines)      exact, 58 ms          exact, 96 ms
//   7 latency, 50 single bytes (spawn → bytes in     median 3.1-3.3 ms,    median 2.4 ms,
//     the file)                                      p95 4.0-5.9 ms        p95 12.1 ms
//   8 SSH                                            not measured over ssh (see above)
//   x (info) ESC[A through paste-buffer -r           ESC[A                 "^[[A" (text)
//
// Also measured: a guard command tmux cannot PARSE (an unknown flag inside the if-shell string)
// rejects the whole `source-file -` text before anything runs — exit 1, nothing typed — on both
// versions; separate LINES are separate command groups at RUN time (a failing line does not stop
// the next one), which is harmless here because every line names the same exact target.
// Version floors: `source-file -` needs tmux 3.1 (CHANGES 3.0a→3.1); an older SSH host fails the
// keys plan closed (exit 1). `copy-mode -q` is 3.2+ per the plan; untested below 3.4.
// Read from tmux's source (window.c `window_pane_key`), not measured: `send-keys` honours a window's
// `synchronize-panes` (the keys are copied to its other panes) and silently drops input to a pane
// disabled with `select-pane -d` while still exiting 0. nodeterm's conf sets neither.
import type { SshConnection } from '../../shared/ssh'
import { posixQuote } from '../../shared/ssh'
import { sanitizePasteText } from '../paste-injection'
import {
  assertPasteBuffer,
  exactPaneTarget,
  localTmuxDeleteBufferArgs,
  pasteBufferName,
  type PasteDelivery
} from '../tmux-naming'
import { RMT_TMUX_SOCKET, childArgs, remoteDeleteBufferArgs, tmuxCmd } from '../remote-ssh/control-master'

/** One unit of a controller's input. `keys` are typed byte for byte; `paste` is text tmux frames
 *  per the pane's own bracketed-paste state. */
export type ControlInputChunk = { kind: 'keys'; data: string } | { kind: 'paste'; text: string }

/**
 * How a controller's input reaches a session's pane (`PtyManager.watcherInputRoute`):
 *  - `tmux`  — the local tmux, by the plans in this file;
 *  - `ssh`   — the same plans on the host, over the project's ControlMaster;
 *  - `write` — PtyManager's ordinary write path (the Windows session host, a direct Windows pane,
 *              the plain-shell fallback: there is no tmux client in between to reach a key table);
 *  - `none`  — refused (Zellij: its key bindings are session-wide; an unknown session).
 */
export type WatcherInputRoute = 'tmux' | 'ssh' | 'write' | 'none'
/** Every route, for a reader that must check one it did not produce (link-host.ts `normalizeJoin`). */
export const WATCHER_INPUT_ROUTES = ['tmux', 'ssh', 'write', 'none'] as const satisfies readonly WatcherInputRoute[]

/**
 * How long one chunk of a controller's input may take, from the moment it is HANDED OVER: the link
 * host gives up on it then (INPUT_DELIVERY_TIMEOUT_MS is this value) and tells its controller it was
 * dropped, and `PtyManager.controlInput` answers false at the same instant — a chunk that waited
 * behind a slow one gets only what is left — and moves the session's chain on. So a delivery that
 * never answers cannot hold every later chunk behind it, and a chunk with nothing left when its turn
 * comes is never delivered at all.
 */
export const PANE_INPUT_DEADLINE_MS = 20_000

/** Bytes per `send-keys -H` line: 3 characters each on the line, so ~3 KiB a line. */
export const KEYS_PER_COMMAND = 1024

/**
 * "Exactly this session, its active pane". Node ids end in a counter, so `nt-a-1` is a prefix of
 * `nt-a-12`, and tmux resolves a bare target by prefix on a miss: a bare target would type into
 * ANOTHER node. `=name:` is exact and resolves (capture-route.ts has the measurement). Throws for a
 * name this app did not generate: the target is spliced UNQUOTED into tmux command text. ONE
 * definition (tmux-naming.ts), shared with every other node-keyed tmux verb.
 */
export { exactPaneTarget }

/** The stdin of `tmux source-file -`: leave any mode, then type each byte literally. */
export function keysCommandText(session: string, data: string): string {
  const t = exactPaneTarget(session)
  const bytes = Buffer.from(data, 'utf8')
  if (bytes.length === 0) throw new Error('no bytes to type')
  let out = `if-shell -F -t ${t} '#{pane_in_mode}' 'copy-mode -q -t ${t}'\n`
  for (let i = 0; i < bytes.length; i += KEYS_PER_COMMAND) {
    const hex = [...bytes.subarray(i, i + KEYS_PER_COMMAND)].map((b) => b.toString(16).padStart(2, '0'))
    out += `send-keys -t ${t} -H ${hex.join(' ')}\n`
  }
  return out
}

/** argv (after the tmux binary) for the keys plan; the command text rides stdin. */
export function localKeysArgs(socket: string): string[] {
  return ['-L', socket, 'source-file', '-']
}

/** The text rides stdin (load-buffer -); tmux frames it only if the pane's app asked (-p). No Enter. */
export function localPasteArgs(socket: string, session: string, buffer: string): string[] {
  const t = exactPaneTarget(session)
  assertPasteBuffer(buffer)
  return [
    '-L', socket,
    'load-buffer', '-b', buffer, '-', ';',
    'if-shell', '-F', '-t', t, '#{pane_in_mode}', `copy-mode -q -t ${t}`, ';',
    // -d: drop our private buffer afterwards; -p: tmux decides framing from the pane's real state;
    // -r: keep `\n` as `\n` instead of tmux's default `\n`→`\r` rewrite.
    'paste-buffer', '-d', '-p', '-r', '-b', buffer, '-t', t
  ]
}

/** ssh args running `tmux -L node-terminal source-file -` on the host; the command text rides stdin. */
export function remoteKeysArgs(conn: SshConnection, controlPath: string): string[] {
  return childArgs(conn, controlPath, tmuxCmd(`tmux -L ${RMT_TMUX_SOCKET} source-file -`))
}

/**
 * ssh args for the remote paste plan with an exact target; the text rides stdin. Every piece the
 * remote SHELL would otherwise read is single-quoted: tmux's `;` (bare, it would end the tmux
 * command), the `=name:` target, the `#{…}` format (`#` starts a comment) and the inner command,
 * which is one tmux argument.
 */
export function remotePasteArgs(conn: SshConnection, controlPath: string, session: string, buffer: string): string[] {
  const t = exactPaneTarget(session)
  assertPasteBuffer(buffer)
  const q = posixQuote(t)
  return childArgs(
    conn,
    controlPath,
    tmuxCmd(
      `tmux -L ${RMT_TMUX_SOCKET} load-buffer -b ${buffer} - ';' ` +
        `if-shell -F -t ${q} '#{pane_in_mode}' ${posixQuote(`copy-mode -q -t ${t}`)} ';' ` +
        `paste-buffer -d -p -r -b ${buffer} -t ${q}`
    )
  )
}

/**
 * EVERYTHING one chunk decides, in one tested place (the lesson in tmux-naming.ts's
 * `localPasteDelivery`: a caller that re-composes sanitize / empty / buffer name lets a test pass
 * while one of them is deleted). The argv to run, its stdin, and the buffer sweep for a paste whose
 * `paste-buffer` never ran (run it with `runPasteDelivery`). null: a paste that sanitized to
 * nothing — there is nothing to run. Throws for an empty key chunk or a name we did not generate.
 */
export function controlInputPlan(socket: string, session: string, chunk: ControlInputChunk): PasteDelivery | null {
  if (chunk.kind === 'keys') {
    return { args: localKeysArgs(socket), body: keysCommandText(session, chunk.data), cleanup: null }
  }
  const body = sanitizePasteText(chunk.text)
  if (body.length === 0) return null
  const buffer = pasteBufferName()
  return { args: localPasteArgs(socket, session, buffer), body, cleanup: localTmuxDeleteBufferArgs(socket, buffer) }
}

/** `controlInputPlan` on the host, over the ControlMaster (the host's `node-terminal` socket). */
export function remoteControlInputPlan(
  conn: SshConnection,
  controlPath: string,
  session: string,
  chunk: ControlInputChunk
): PasteDelivery | null {
  if (chunk.kind === 'keys') {
    return { args: remoteKeysArgs(conn, controlPath), body: keysCommandText(session, chunk.data), cleanup: null }
  }
  const body = sanitizePasteText(chunk.text)
  if (body.length === 0) return null
  const buffer = pasteBufferName()
  return {
    args: remotePasteArgs(conn, controlPath, session, buffer),
    body,
    cleanup: remoteDeleteBufferArgs(conn, controlPath, buffer)
  }
}

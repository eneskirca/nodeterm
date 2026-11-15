/**
 * Claude Code "Remote Control" (`/remote-control`, alias `/rc`): whether a session is currently
 * reachable from claude.ai / the Claude mobile app, read from the session's own transcript.
 *
 * There is no hook for it, so the transcript is the only signal. Two records matter, and the
 * LATEST one wins:
 *
 * - ON:  `{"type":"system","subtype":"bridge_status","url":…}` — appended when the bridge
 *        connects ("/remote-control is active · Continue here, on your phone, or at <url>").
 * - OFF: a `local_command` record whose stdout says "Remote Control disconnected" — what the
 *        command's "Disconnect this session" choice prints.
 *
 * WHAT IS MEASURED AND WHAT IS NOT (Claude Code 2.1.325). The `local_command` record SHAPE is
 * measured: running `/remote-control` writes `subtype:"local_command"` records carrying
 * `<local-command-stdout>…</local-command-stdout>`. The `bridge_status` record and the disconnect
 * text are read out of the CLI's own source, NOT captured from a live connect — nobody has run a
 * real connect/disconnect against this parser yet. So it degrades to nothing: a line that does not
 * match exactly is ignored and the icon simply stays off. It can under-report; it never invents ON.
 *
 * Other ways the bridge ends (the CLI exits, the server drops it, org policy) write nothing we
 * know of, which is why the renderer also clears the flag at a session boundary.
 */

const DISCONNECTED = 'Remote Control disconnected'

/** The state the LAST matching record in `lines` asserts, or null when none does. Pure. */
export function parseRemoteControl(text: string | string[]): boolean | null {
  const lines = Array.isArray(text) ? text : text.split('\n')
  let state: boolean | null = null
  for (const line of lines) {
    const s = line.trim()
    // Cheap pre-filter: both records are `system` records naming one of two subtypes.
    if (!s || (!s.includes('bridge_status') && !s.includes(DISCONNECTED))) continue
    let o: { type?: unknown; subtype?: unknown; content?: unknown; url?: unknown }
    try {
      o = JSON.parse(s)
    } catch {
      continue
    }
    if (!o || o.type !== 'system') continue
    if (o.subtype === 'bridge_status') {
      state = true
    } else if (
      o.subtype === 'local_command' &&
      typeof o.content === 'string' &&
      o.content.includes('<local-command-stdout>') &&
      o.content.includes(DISCONNECTED)
    ) {
      state = false
    }
  }
  return state
}

/** What the shells broadcast on `agent:remote-control`. */
export interface RemoteControlUpdate {
  nodeId: string
  sessionId: string
  on: boolean
}

/**
 * The context tails' `onRemoteControl` handler, shared by both shells so the desktop and the
 * Server Edition cannot drift: map the tail's session id back to its node and broadcast.
 * `nodeBySession` is each shell's own `nodeContextSession` (nodeId → sessionId).
 */
export function remoteControlHandler(
  nodeContextSession: ReadonlyMap<string, string>,
  broadcast: (update: RemoteControlUpdate) => void
): (sessionId: string, on: boolean) => void {
  return (sessionId, on) => {
    for (const [nodeId, sid] of nodeContextSession) {
      if (sid === sessionId) broadcast({ nodeId, sessionId, on })
    }
  }
}

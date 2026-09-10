/**
 * What gets pasted into a target terminal when two Mesa cells talk.
 *
 * User-initiated (the chrome button), so it never goes through the per-node hook
 * identity belt — that belt is what made "send to the other node" look possessed.
 * The callsign in the header is the identity a human (or an agent) can actually read.
 */

export function formatTalkPayload(opts: {
  fromCallsign: string
  fromTitle: string
  toCallsign?: string
  toTitle?: string
  body: string
  forAgent: boolean
}): string {
  const who = (sign: string, title: string) =>
    title.trim() ? `${sign} · ${title.trim()}` : sign
  const from = who(opts.fromCallsign, opts.fromTitle)
  const to = opts.toCallsign ? who(opts.toCallsign, opts.toTitle ?? '') : ''
  const body = opts.body.replace(/\s+$/u, '')
  if (opts.forAgent) {
    return (
      `[Mesa · mensaje manual del usuario]\n` +
      `Contexto: terminal ${from}${to ? ` → terminal ${to}` : ''}\n\n${body}`
    )
  }
  // Plain shell: a comment line so Enter (if the user hits it) is a no-op in POSIX shells,
  // plus the body as a second comment. sendText is called with enter:false for shells.
  const safe = body.replace(/\r?\n/g, ' · ')
  return `# [${from}] ${safe}`
}

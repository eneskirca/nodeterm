// "Does this `claude --help` advertise `--session-id`?" — ONE rule in two spellings.
//
// The flag is FEATURE-detected from the help text rather than gated on a version (see
// `claudeCliCapsFrom` for why a guessed floor is uniquely dangerous here: an unrecognised flag makes
// the CLI exit, taking the launch with it). The local probe reads the text with the regex; the
// remote probe (`core/remote-ssh/claude-session-id-probe.ts`) cannot ship help text back through a
// login shell's banner noise, so it asks the HOST's grep with the ERE and returns only yes/no. Two
// readers of one fact drift unless they are declared side by side, and a test runs both against
// the same help text.
//
// Anchored on whitespace so `--session-id-file`, or prose that merely says "session-id" inside
// another option's description (`--resume <session-id>,` in the real help), cannot answer yes.
export const CLAUDE_SESSION_ID_HELP_RE = /(^|\s)--session-id(\s|=|$)/m
export const CLAUDE_SESSION_ID_HELP_ERE = '(^|[[:space:]])--session-id([[:space:]]|=|$)'

/** Absent help output ⇒ false ⇒ no flag ⇒ the command line every older build emitted. */
export const claudeHelpHasSessionIdFlag = (helpOutput: string | null | undefined): boolean =>
  CLAUDE_SESSION_ID_HELP_RE.test(helpOutput ?? '')

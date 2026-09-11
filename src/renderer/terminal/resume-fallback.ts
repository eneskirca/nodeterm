/**
 * A COLD-RESTORE RESUME THAT RESOLVES NOTHING FALLS BACK TO A FRESH LAUNCH (issue #707).
 *
 * On a `fresh` mount of an agent node the renderer re-launches the CLI with `--resume <id>`, taking
 * the id from hooks or, failing that, from the one nodeterm MINTED at node creation
 * (`data.agentSessionId`). Both can name a conversation that does not exist:
 *
 *  - the minted id is stamped at creation and the session is only created when the launch actually
 *    RUNS, so anything that stops that launch — an armed `--after` node whose command is still
 *    held, a launch line the tty truncated (#706), an app closed between the two — leaves an id
 *    with nothing behind it;
 *  - a hook-fed id outlives its transcript. Measured on the reporting host of #616: 9 of 149 panes
 *    sat at a bare shell because exactly this had happened.
 *
 * What the user sees either way is one line and then nothing:
 *
 *     No conversation found with session ID: 6c0e…-…
 *
 * The CLI has exited, tmux's shell owns the pane, and the node keeps its agent badge over a session
 * that was never started. The fix is to notice that line and start the agent fresh.
 *
 * MEASURED (claude 2.1.266, this box): `claude --resume <unknown-uuid>` prints exactly
 * `No conversation found with session ID: <id>` and exits **1**. That is the whole detector — no
 * exit-code plumbing, because the line is what reaches the renderer.
 *
 * Three rules keep it from firing on a healthy pane, and each is a refusal:
 *
 *  1. **Only an agent whose message we have measured.** The table below has one entry. codex needs
 *     a tty to answer at all and gemini was not captured, so they get `false` — the CLI keeps its
 *     pane and the node keeps its badge, which is exactly today's behaviour. Adding an id without
 *     first capturing its wording is the "guess that degrades to something wrong" this repo warns
 *     about: a false positive types a second CLI launch into a pane that already has one.
 *  2. **The message must name the id WE asked for.** A bare substring would also match the user
 *     resuming some other session by hand in the same pane, and a transcript that happens to quote
 *     the sentence. Binding it to `sessionId` makes the evidence specific to our own launch.
 *  3. **Only inside a bounded window after the resume was delivered.** The CLI prints this
 *     immediately or not at all; a watcher left running would fire on output that arrives minutes
 *     later from something else entirely.
 *
 * The caller owes a fourth: verify a SHELL owns the pane before writing, exactly as the hibernation
 * wake does. This module decides nothing about delivery.
 */

/**
 * How long after delivering a resume we keep watching for its refusal. The CLI answers in
 * milliseconds; this is generous only so a slow cold boot cannot miss it, and bounded so the
 * watcher is not still armed when the user starts working in the pane.
 */
export const RESUME_MISS_WINDOW_MS = 20_000

/**
 * Per-agent: the line the CLI prints when the session id it was handed names no conversation.
 * **Only add an entry you have run the CLI to capture** — see rule 1.
 *
 * A `Map`, not an object literal, because `agentId` is `data.agentId` — a value out of
 * `.nodeterm/project.json`, which is hand-editable and git-shared. An `in`/index lookup on a plain
 * object answers for `constructor` and `toString` too, returning a **Function** where this code
 * expects a message builder; that is the same hole `approvalFlags` closes with `isPermissionMode`
 * at the interpolation site. A Map has no prototype chain to walk.
 */
const RESUME_MISS_LINES = new Map<string, (sessionId: string) => string>([
  // Measured on claude 2.1.266: `claude --resume <unknown>` → this line, exit 1.
  ['claude', (sessionId) => `No conversation found with session ID: ${sessionId}`]
])

/** Does this agent report a missing session in a way we can recognise? */
export function detectsResumeMiss(agentId: string | undefined): boolean {
  return !!agentId && RESUME_MISS_LINES.has(agentId)
}

/**
 * Did the pane say the conversation we asked to resume does not exist?
 *
 * `text` is expected to be the pane output with escape sequences and line breaks removed (the CLI
 * wraps and colours its own output, and tmux re-wraps it at the pane width, so a raw `includes`
 * would miss the line whenever it happened to straddle a column boundary).
 */
export function resumeSessionMissing(
  agentId: string | undefined,
  sessionId: string | undefined,
  text: string
): boolean {
  if (!agentId || !sessionId) return false
  const line = RESUME_MISS_LINES.get(agentId)
  return !!line && text.includes(line(sessionId))
}

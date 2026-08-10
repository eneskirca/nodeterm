// Is a remote node that the mirror still calls `working` actually still working?
//
// Hook POSTs are fire-and-forget: an event that fires while the reverse tunnel is down is gone,
// so a node can sit at `working` long after its turn ended (until the 20-minute stale sweep guesses
// from silence — see shared/agents/stale.ts). After a reconnect we can ask the host directly.
//
// Pure by design: this decides, the caller in src/main does the ssh. The ONE rule that matters is
// that `undecided` is the default — a wrong `ended` costs the user a false "finished" notification,
// so every uncertainty resolves to leaving the node alone.

import { isShellCommand } from '@shared/agents/pane'

export type ResyncVerdict = 'ended' | 'working' | 'undecided'

/**
 * What the pane's foreground command proves. A shell owns it ⇒ the agent CLI exited ⇒ the turn
 * cannot still be running. The CLI still owning it proves NOTHING: "mid-turn" and "finished,
 * sitting at its prompt" look identical from here, which is why the transcript leg exists.
 */
export function decideFromPane(paneCommand: string | null | undefined): ResyncVerdict {
  if (!paneCommand) return 'undecided'
  return isShellCommand(paneCommand) ? 'ended' : 'undecided'
}

/**
 * What the tail of a claude transcript proves.
 *
 * A turn ends with an assistant message carrying no tool call. While a tool is running, the
 * assistant's `tool_use` sits in the file with no matching `tool_result` — that is the signature of
 * Claude's Bash tool, which can run ~10 minutes writing nothing else, and mistaking it for a
 * finished turn is the failure mode this whole function is shaped to avoid.
 *
 * The input is a bounded TAIL, so its first line is usually truncated and tool calls opened before
 * the window are never seen. Both are handled by only ever tracking ids opened INSIDE the window:
 * an orphan `tool_result` is dropped, an unparseable line is skipped.
 */
export function decideFromTranscriptTail(tail: string): ResyncVerdict {
  const pending = new Set<string>()
  let last: 'assistant-text' | 'assistant-tool' | 'user' | undefined
  for (const line of tail.split('\n')) {
    const s = line.trim()
    if (!s) continue
    let rec: { type?: string; message?: { content?: unknown } } | undefined
    try {
      rec = JSON.parse(s)
    } catch {
      continue // truncated head of the window, or a partially flushed write
    }
    const content = rec?.message?.content
    if (rec?.type === 'assistant' && Array.isArray(content)) {
      let sawTool = false
      for (const c of content as { type?: string; id?: string }[]) {
        if (c?.type === 'tool_use') {
          // Seeing the call is what makes this a tool turn; tracking its id is a separate, weaker
          // claim. An id we cannot read leaves the call untrackable, so the record must still read
          // as 'assistant-tool' (⇒ undecided) rather than decaying into a finished turn.
          sawTool = true
          if (typeof c.id === 'string') pending.add(c.id)
        }
      }
      last = sawTool ? 'assistant-tool' : 'assistant-text'
    } else if (rec?.type === 'user') {
      if (Array.isArray(content)) {
        for (const c of content as { type?: string; tool_use_id?: string }[]) {
          if (c?.type === 'tool_result' && typeof c.tool_use_id === 'string') pending.delete(c.tool_use_id)
        }
      }
      last = 'user'
    }
  }
  if (pending.size > 0) return 'working'
  return last === 'assistant-text' ? 'ended' : 'undecided'
}

/** The cheap probe first; the transcript only when the pane could not answer. */
export function decideNode(paneCommand: string | null | undefined, tail: string | null): ResyncVerdict {
  const byPane = decideFromPane(paneCommand)
  if (byPane === 'ended') return 'ended'
  if (tail === null) return 'undecided'
  return decideFromTranscriptTail(tail)
}

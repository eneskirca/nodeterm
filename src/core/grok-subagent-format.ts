// One chunk of a grok SUBAGENT's `chat_history.jsonl`, as card text.
//
// The card is a live view of a child session, so this is fed incremental chunks by
// `subagent-tail.ts` rather than a whole file. It delegates every shape decision to `linesFromGrok`
// (core/context-link-render.ts) — the same reader context links, the ⌘M panel and cross-agent
// transfer use — so a card can never disagree with the transcript the user can open next to it.
//
// WHICH FILE: `chat_history.jsonl`, derived from the child's `subagentId`. NOT the `transcriptPath`
// grok's own subagent payloads carry. On `SubagentStart` that path is the PARENT'S session (measured
// on 1.0.13 across two parallel children), so following it would paint the parent's conversation
// inside the child's card — full, plausible, and somebody else's. On `SubagentStop` the directory is
// finally the child's, but the file is still `updates.jsonl`, which parses to nothing here. Both
// spellings of the trap are documented at `handoff/locate.ts`.
import { linesFromGrok } from './context-link-render'

/**
 * A fresh formatter per card. Stateless today — grok's child transcript has no replay prefix to
 * skip, unlike codex's fork-replay — but built with the same factory shape as
 * `createCodexSubagentFormatter` so the tail has ONE contract, and so a future state (a
 * compaction marker, a nested spawn) has somewhere to live.
 */
export function createGrokSubagentFormatter(): (text: string) => string {
  return (text: string): string => {
    // `linesFromGrok` skips model reasoning and labels harness-injected text with its own reason,
    // so neither can appear in the card as something the child said.
    const lines = linesFromGrok(text)
    return lines.length ? lines.join('\n') : ''
  }
}

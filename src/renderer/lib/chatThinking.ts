// Pure decisions behind the ⌘M thread's thinking fold (ChatPanel): how long a thinking block took,
// and what its summary line says. No React — see ChatPanel.tsx for the glue and chatThinking.test.ts
// for the pins.
import type { ChatMessage } from '@shared/types'

/**
 * How long message `i` spent thinking, in ms: the gap from its `at` to the NEXT message's `at`.
 *
 * Only when message `i` holds ONLY thinking parts — a line that also carries text or a tool call did
 * not spend that gap thinking — and both lines are stamped. A negative gap (the next line written by
 * a clock behind this one) is no duration either: undefined, never a made-up or negative time.
 */
export function thinkingDuration(messages: readonly ChatMessage[], i: number): number | undefined {
  const m = messages[i]
  const next = messages[i + 1]
  if (!m || !next || m.at === undefined || next.at === undefined) return undefined
  if (m.parts.length === 0 || !m.parts.every((p) => p.kind === 'thinking')) return undefined
  const gap = next.at - m.at
  return gap >= 0 ? gap : undefined
}

/** The fold's summary: "Thinking" with no duration, else "Thought for 12s" / "Thought for 1m 35s". */
export function thinkingLabel(ms: number | undefined): string {
  if (ms === undefined) return 'Thinking'
  // Rounded to whole seconds BEFORE choosing the unit, so 59.6 s reads "1m 0s", never "60s".
  const s = Math.max(1, Math.round(ms / 1000))
  return s < 60 ? `Thought for ${s}s` : `Thought for ${Math.floor(s / 60)}m ${s % 60}s`
}

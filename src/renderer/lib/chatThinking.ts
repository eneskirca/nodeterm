// The ⌘M thread's thinking fold (ChatPanel): what its summary line says. How long the thinking took
// is the parser's to stamp (`ms` on the part — see `ChatPart` in shared/types.ts for why the thread
// cannot derive it from its neighbours). No React — see chatThinking.test.ts for the pins.

/** The fold's summary: "Thinking" with no duration, else "Thought for 12s" / "Thought for 1m 35s". */
export function thinkingLabel(ms: number | undefined): string {
  if (ms === undefined) return 'Thinking'
  // Rounded to whole seconds BEFORE choosing the unit, so 59.6 s reads "1m 0s", never "60s".
  const s = Math.max(1, Math.round(ms / 1000))
  return s < 60 ? `Thought for ${s}s` : `Thought for ${Math.floor(s / 60)}m ${s % 60}s`
}

// The context meter's launch-record precedence, as ONE pair of pure decisions shared by the
// canvas node, the kanban card and the card modal — the same session can be seen from all three.

/**
 * Which model label a context meter shows. `nodeModel` is the node's launch record
 * (`data.agentLaunchModel` — the exact id emitted by the launch assembler); `transcriptModel` is what the
 * transcript's latest usage row names (what the CLI most recently echoed running).
 *
 * BOTH are true statements about different instants, and trailing a switch the transcript
 * one is STALE: a resumed transcript replays pre-switch rows, so `context-tail` keeps
 * re-publishing the pre-switch model until the CLI's first genuinely new assistant row —
 * which for an idle session is the user's next prompt, potentially days later. The pivot is
 * that the launch record is the one the USER has evidence for (they clicked it, or a grouped
 * restart wrote it), while the transcript label is only as fresh as its last row.
 *
 * So: the launch record outranks to give the restarted session the RIGHT label before the
 * transcript has any post-switch row to name — no lingering "GLM-5.2" under the context %.
 * Otherwise the transcript stands (a hand-launched `claude` in a plain terminal has no
 * record anywhere; a node whose record was never set (`clearEnv`, CLI default) falls back to
 * the live read too — an empty record says nothing, it does not assert).
 */
export function contextMeterModel(transcriptModel: string | null, nodeModel?: string): string | null {
  const record = typeof nodeModel === 'string' ? nodeModel.trim() : ''
  if (record) return record
  return transcriptModel
}

export interface ContextMeterUsage {
  windowTokens: number
  usedPercent: number
}

/**
 * The denominator and resulting fill shown by a context meter. The used-token count remains
 * transcript-owned, but a positive launch record outranks the transcript's window: after a
 * model switch the resumed transcript replays the last pre-switch assistant row until the user
 * sends another prompt, so its old denominator can otherwise linger indefinitely.
 *
 * Nodes that Nodeterm did not launch have no record and retain the transcript's denominator.
 */
export function contextMeterUsage(
  usedTokens: number,
  transcriptWindow: number,
  launchWindow?: number
): ContextMeterUsage {
  const hasLaunchWindow =
    typeof launchWindow === 'number' && Number.isFinite(launchWindow) && launchWindow > 0
  const windowTokens = hasLaunchWindow ? launchWindow : transcriptWindow
  const usedPercent =
    Number.isFinite(windowTokens) && windowTokens > 0
      ? Math.min(100, Math.max(0, (usedTokens / windowTokens) * 100))
      : 0
  return { windowTokens, usedPercent }
}

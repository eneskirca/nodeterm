// Reader over a codex rollout (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` — the same root
// `handoff/locate.ts`'s `locateCodex` walks). Codex's hook envelope is claude-shaped and carries
// `session_id` / `transcript_path` / `cwd` / `hook_event_name` (its own hook wire structs name
// exactly those fields), so the shells hand us the path.
//
// Codex is the only agent that states its OWN context window in its transcript
// (`model_context_window`), which is strictly better than inferring one: claude's window has to be
// guessed from the model family (core/model-window.ts) and gemini's from its model id.
import { latestJsonLineWhere, type AgentUsage } from './gemini-session'

export type { AgentUsage }

/** One of codex's two token blocks. `cached_input_tokens` is a SUBSET of `input_tokens`. */
interface CodexTokenUsage {
  input_tokens?: number
  cached_input_tokens?: number
  cache_write_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
  total_tokens?: number
}

/**
 * The latest live context size plus the window codex reported.
 *
 * **`last_token_usage`, not `total_token_usage`.** Both sit side by side in the same `token_count`
 * event, and `total_token_usage` is CUMULATIVE over the session — measured across the
 * token_count events of `__fixtures__/codex/rollout.jsonl` it runs 17855 → 204277 while
 * `last_token_usage` runs 17855 → 34635, against a 258400 window. Using the cumulative field would
 * have shown that session at 79% when it was really at 13%, and would have sailed past 100% a
 * couple of turns later. `last_token_usage` is the most recent REQUEST, and since every request
 * re-sends the whole conversation, its input is the live context size.
 *
 * `usedTokens` = `last_token_usage.input_tokens` alone:
 *  - `cached_input_tokens` is NOT added. Verified over every usage record in `~/.codex/sessions`:
 *    `input_tokens + output_tokens === total_tokens` and `cached_input_tokens <= input_tokens`, so
 *    cached input is already counted inside `input_tokens`. It does occupy the window; adding it
 *    again would double-count it.
 *  - output/reasoning tokens are excluded, matching what `context-tail.ts:parseLatestUsage` counts
 *    for claude (its three INPUT-side fields), so the same meter means the same thing on both.
 *
 * Measured shape (codex-cli 0.146.0):
 *   {"type":"event_msg","payload":{"type":"token_count","info":{
 *      "total_token_usage":{…},
 *      "last_token_usage":{"input_tokens":34635,"cached_input_tokens":33792,…},
 *      "model_context_window":258400}}}
 * Note the nesting: everything is under `payload.info`, NOT at the top level.
 */
export function pickCodexUsage(rollout: string | string[]): AgentUsage | null {
  return latestJsonLineWhere(rollout, '"last_token_usage"', (o) => {
    const info = (o.payload as { info?: Record<string, unknown> } | undefined)?.info
    const u = info?.last_token_usage as CodexTokenUsage | undefined
    if (!u || typeof u !== 'object') return null
    const input = u.input_tokens
    if (typeof input !== 'number' || !Number.isFinite(input) || input <= 0) return null
    const win = info?.model_context_window
    return {
      usedTokens: input,
      windowTokens: typeof win === 'number' && Number.isFinite(win) && win > 0 ? win : null
    }
  })
}

/**
 * The model codex is running, from the `turn_context` line's `payload.model`
 * (`"gpt-5.6-sol"` in the fixture). A SEPARATE line from the usage, so it needs its own scan —
 * `turn_context` is written once per turn, near its start, and `token_count` events follow it.
 *
 * Null when this chunk holds no `turn_context`: `createContextTail` keeps the last model it was
 * told (`t.model = latest.model ?? t.model`), and the tail's first read covers up to
 * INITIAL_READ_CAP of the file, so in practice the model is settled on the very first tick and
 * sticks. Claiming a model we did not read would be worse than reporting none.
 */
export function codexContextModel(text: string | string[]): string | null {
  return latestJsonLineWhere(text, '"turn_context"', (o) => {
    if (o.type !== 'turn_context') return null
    const model = (o.payload as { model?: unknown } | undefined)?.model
    return typeof model === 'string' && model ? model : null
  })
}

/** `pickCodexUsage` plus the model — the exact shape `createContextTail`'s `parse` dep consumes. */
export function codexContextParse(
  text: string | string[]
): { used: number; window: number | null; model: string | null } | null {
  const u = pickCodexUsage(text)
  if (!u) return null
  return { used: u.usedTokens, window: u.windowTokens, model: codexContextModel(text) }
}

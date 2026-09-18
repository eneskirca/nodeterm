// Resolves a Claude model id → its context window (max input tokens).
//
// Empirically (verified via `/context` on this machine) Claude Code runs opus/sonnet/fable
// sessions in a 1M window — the model id in the transcript stays bare ("claude-opus-4-8")
// even when 1M is active, so the window can NOT be detected from the id alone. We therefore
// map the model FAMILY to its window: opus/sonnet/fable/mythos → 1M, haiku → 200k, unknown
// → 200k. (Accounts with 1M access see the right denominator; the Models API is not consulted
// — it returns capability, and the call added latency for no gain.) Fully synchronous.

const DEFAULT_WINDOW = 200_000
const LARGE_WINDOW = 1_000_000

// Model family → window. First match wins; an explicit "1m" marker also forces the large
// window. Plain ids like "claude-opus-4-8" resolve to 1M via the opus/sonnet/fable rule.
const STATIC: Array<[RegExp, number]> = [
  [/haiku/i, DEFAULT_WINDOW],
  [/opus|sonnet|fable|mythos|(^|[^a-z0-9])1m([^a-z0-9]|$)/i, LARGE_WINDOW]
]

export type GatewayModelWindowSource = () => readonly {
  id: string
  contextWindow?: number
}[]

/** Live source for the current gateway scope. PtyManager registers its already scope-checked
 *  catalogue; keeping the source as a function makes a settings or credential change take effect
 *  on the next lookup without a second cache or duplicated scope logic. */
let gatewayModelWindowSource: GatewayModelWindowSource | null = null

export function setGatewayModelWindowSource(source: GatewayModelWindowSource | null): void {
  gatewayModelWindowSource = source
}

function gatewayModels(): ReturnType<GatewayModelWindowSource> {
  try {
    return gatewayModelWindowSource?.() ?? []
  } catch {
    return []
  }
}

function gatewayWindowFor(model: string | null): number | undefined {
  if (!model) return undefined
  const base = model.trim().replace(/\[1m\]$/, '')
  if (!base) return undefined
  const models = gatewayModels()
  // Exact ids first (the model argument is trimmed, so keep the raw compare too). Then the
  // LAST `/` SEGMENT as a fallback — measured: transcripts written on a gateway session name
  // `GLM-5.3-Flash-NVFP4` while the catalogue carries `vllm/GLM-5.3-Flash-NVFP4`, so an
  // exact-only lookup missed exactly the models a gateway serves. Segment equality is still
  // equality, not a guess.
  for (const entry of models) {
    const gid = entry.id.trim().replace(/\[1m\]$/, '')
    const win = entry.contextWindow
    if ((gid === base || entry.id === model) && validWindow(win)) return win
  }
  for (const entry of models) {
    const gid = entry.id.trim().replace(/\[1m\]$/, '')
    const win = entry.contextWindow
    if (gid.split('/').pop() === base.split('/').pop() && validWindow(win)) return win
  }
  return undefined
}

function validWindow(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** Context window for a model id: 1M for opus/sonnet/fable/[1m], 200k for haiku/unknown. */
export function staticWindowFor(model: string | null): number {
  if (model) {
    for (const [re, win] of STATIC) if (re.test(model)) return win
  }
  return DEFAULT_WINDOW
}

/**
 * Synchronous best guess for the model's window — the LARGER of the discovered window (when
 * this core has been told one) and the family inference. MAX, not "discovered wins": a proxy
 * cataloguing an Anthropic model through the OpenAI convention often reports the
 * capability-API 200k for a 1M-eligible model, and the family rule exists precisely because
 * the id alone cannot witness that. The meter's job is the true denominator; taking the
 * larger never SHRINKS a number either source asserts, and a truth below the guess only
 * under-reports fill (conservative), never over-reports it. The autocompact env does not
 * flow through here — it reads the catalogue directly (`gatewayModelsForCurrent`), so this
 * rule never widens what the CLI compacts against.
 */
export function cachedWindowFor(model: string | null): number {
  const discovered = gatewayWindowFor(model)
  // When discovery MATCHES the id, compute the family floor on the SUFFIX-STRIPPED base: the
  // `[1m]` marker is how a launcher advertises a large window, and the discovered record is a
  // better witness than that marker — escalation from it would disagree with the
  // CLAUDE_CODE_AUTO_COMPACT_WINDOW the CLI actually compacts against. Stripping only under a
  // known record preserves the never-shrink rule (an Anthropic id catalogued at 200k still
  // floors at its family 1M) while dropping the marker's escalation. WITHOUT a matching
  // record the raw id feeds the family table unchanged.
  const family = staticWindowFor(discovered !== undefined && model ? model.replace(/\[1m\]$/, '') : model)
  return discovered !== undefined ? Math.max(discovered, family) : family
}

// ---------------------------------------------------------------------------------------------
// Gemini. Its transcript states no window, so the model id is the only signal — but gemini does
// not need a guess, because the CLI's own resolver is a FAMILY rule with a catch-all default.
// Mirrored from the shipped bundle rather than restated as a per-model table:
//   gemini-cli 0.54.4, bundle/chunk-BS6BSLZD.js:331674-331686
//     var DEFAULT_TOKEN_LIMIT = 1048576
//     var GEMMA_4_TOKEN_LIMIT = 256e3
//     function tokenLimit(model) { switch (model) {
//       case GEMMA_4_31B_IT_MODEL: case GEMMA_4_26B_A4B_IT_MODEL:  return GEMMA_4_TOKEN_LIMIT
//       case PREVIEW_GEMINI_MODEL: … case DEFAULT_GEMINI_FLASH_LITE_MODEL: return 1048576
//       default: return DEFAULT_TOKEN_LIMIT } }
// Because that `default:` is 1M, the five named 1M cases are redundant and copying them would only
// create something to go stale: an unknown or newly released gemini model gets the RIGHT answer
// from the default, which is exactly what a per-model allowlist would get wrong (silently, with a
// confident wrong denominator). So the two gemma models are the only special case here, as they
// are there. The transcript we measured names `gemini-3.5-flash`, which is in neither list and
// lands on the default — evidence the default branch is the one that carries the feature.
const GEMINI_DEFAULT_TOKEN_LIMIT = 1_048_576
const GEMINI_GEMMA_4_TOKEN_LIMIT = 256_000
// GEMMA_4_31B_IT_MODEL / GEMMA_4_26B_A4B_IT_MODEL (bundle/chunk-QXLHAGLO.js:279469-279470)
const GEMMA_4_MODELS = new Set(['gemma-4-31b-it', 'gemma-4-26b-a4b-it'])

/**
 * Context window for a gemini model id, per gemini's own `tokenLimit`. `null` only when there is no
 * model at all — a transcript that never named one tells us nothing, and the meter then stays
 * hidden rather than dividing by a number we invented.
 */
export function geminiWindowFor(model: string | null): number | null {
  if (!model) return null
  return GEMMA_4_MODELS.has(model) ? GEMINI_GEMMA_4_TOKEN_LIMIT : GEMINI_DEFAULT_TOKEN_LIMIT
}

/**
 * Kept only for call-site compatibility with context-tail.ts. Window resolution is fully
 * synchronous via cachedWindowFor/staticWindowFor, so there is nothing to resolve — no-op.
 */
export async function resolveModelWindow(_model: string | null): Promise<void> {
  // intentional no-op
}

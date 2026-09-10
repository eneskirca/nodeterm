// The brand marks, and the decision of when one of them IS an agent's working indicator.
//
// This module is deliberately REACT-FREE, like lib/grokMark.ts and lib/mascot.ts: the notch HUD
// (hud/main.ts) builds its DOM imperatively and must not pull React into its bundle, yet it needs
// the exact same answer the canvas badge needs. So the decision lives here as a pure function, and
// each surface keeps its own thin renderer on top of it (`BrandPulse` in agentIcons.tsx for React,
// `workingMascot` in hud/main.ts for plain DOM).

import type { AgentId } from '@shared/agents/config'
import claudeIcon from '../assets/claude.svg'
import codexIcon from '../assets/codex-color.svg'
import devinIcon from '../assets/devin.svg'
import geminiIcon from '../assets/gemini-color.svg'
import opencodeIcon from '../assets/opencode.svg'

// Brand logo per builtin agent; custom/unknown agents have none (callers fall back to the terminal
// glyph, or to the plain pulsing dot).
//
// These asset marks carry their own fills and are loaded as an `<img src>` /
// `background-image` (Vite hands us a URL). An SVG loaded that way is an isolated document —
// `currentColor` has nothing to inherit there, which is why none of these assets uses it. Grok is
// the exception: its mark is monochrome, so it is inlined from lib/grokMark.ts instead, and is
// therefore NOT in this map.
export const AGENT_LOGO: Partial<Record<string, string>> = {
  claude: claudeIcon,
  codex: codexIcon,
  devin: devinIcon,
  gemini: geminiIcon,
  opencode: opencodeIcon
}

/**
 * This agent's brand asset, or undefined — the ONE way to read AGENT_LOGO.
 *
 * `Object.hasOwn`, never `agentId in AGENT_LOGO` and never a bare `AGENT_LOGO[agentId]`: `AgentId` is
 * open and `data.agentId` comes from hand-editable `.nodeterm/project.json`, so a node carrying
 * `"agentId": "constructor"` makes `in` answer true and the index hand back **`Function`** — which
 * then reached an `<img src>` / a CSS `url()` as a stringified function body.
 */
export const brandLogoSrc = (agentId: AgentId): string | undefined =>
  Object.hasOwn(AGENT_LOGO, agentId) ? AGENT_LOGO[agentId] : undefined

/** Does this agent have a brand mark to draw? grok is inlined rather than an asset, so it is not in
 *  AGENT_LOGO — ask through here rather than testing that map directly. */
export const INLINE_MARK_AGENTS = ['grok', 'copilot'] as const
export type InlineMark = (typeof INLINE_MARK_AGENTS)[number]
export const inlineMarkFor = (agentId: AgentId): InlineMark | null =>
  (INLINE_MARK_AGENTS as readonly string[]).includes(agentId) ? (agentId as InlineMark) : null

export const hasBrandLogo = (agentId: AgentId): boolean =>
  inlineMarkFor(agentId) !== null || brandLogoSrc(agentId) !== undefined

/** Canvas RUNNING-badge class (styles.css). */
export const BRAND_PULSE_CLASS = 'term-node__mascot--pulse'
/** Notch-strip class (hud/hud.css) — the sprite base class plus the pulse. */
export const HUD_BRAND_PULSE_CLASS = 'mascot mascot--pulse'

/**
 * How to draw an agent's mark as its working indicator: `inline` = an SVG element built from
 * lib/grokMark.ts (monochrome, painted in `currentColor`), `asset` = the brand file at `src`.
 */
export type BrandPulsePlan =
  | { kind: 'inline'; mark: InlineMark; size: number }
  | { kind: 'asset'; src: string; size: number }

/**
 * An agent's own brand mark as its working indicator — pulsing with a bloom instead of walking.
 *
 * This is the pattern grok arrived at after a hand-drawn quadrant critter was rejected: standing
 * next to two real mascots (claude's painted blob, codex's pet) an invented creature read as
 * neither, so the glyph the agent actually has is what animates. gemini and opencode were falling
 * through to the plain dot, which says "something is happening" but not WHO.
 *
 * Returns null when the agent has no mark (custom agents, plain terminals), so the caller falls back
 * to that dot rather than rendering an empty box. It does NOT know which agents have mascot art:
 * claude and codex have marks too, and their sprite branches come FIRST in each surface's
 * dispatcher, next to the spritesheet geometry they need.
 *
 * A caveat worth knowing: the bloom is a `drop-shadow` of the element's `color`, which is exactly
 * right for a MONOCHROME mark painted in `currentColor` (grok) and approximate for the multi-colour
 * assets — gemini's gradient mark and codex's white one bloom in the label colour, not their own
 * ink. That is accepted: the halo reads as a glow either way, and per-mark bloom colours would mean
 * an ink table.
 */
export function brandPulsePlan(agentId: AgentId | undefined, size: number): BrandPulsePlan | null {
  if (!agentId || !hasBrandLogo(agentId)) return null
  const mark = inlineMarkFor(agentId)
  if (mark) return { kind: 'inline', mark, size }
  const src = brandLogoSrc(agentId)
  return src ? { kind: 'asset', src, size } : null
}

/**
 * An asset mark as a CSS `background-image` value, for the surface that paints instead of using an
 * `<img>` (the notch HUD).
 *
 * The quotes are load-bearing, and measured: Vite INLINES these small brand SVGs as
 * `data:image/svg+xml,…` URIs, and the encoded markup carries literal `'` (every mark) and literal
 * `(`/`)` (gemini, opencode, codex — `url(%23mask…)` for their gradient/clip refs). An unquoted
 * `url(…)` therefore terminates at the first inner `)`, the whole declaration is REJECTED, and the
 * indicator silently paints nothing at all. The React path is unaffected — an `<img src>` is an
 * attribute, not a CSS value — so this trap only exists here.
 */
export const brandPulseBackground = (src: string): string => `url("${src}")`

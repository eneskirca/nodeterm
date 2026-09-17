import type { CSSProperties } from 'react'
import type { AgentId } from '@shared/agents/config'
import { CLAUDE_MASCOT, CODEX_MASCOT } from '../lib/mascot'
import { BrandPulse, hasBrandLogo } from '../lib/agentIcons'
import codexPet from '../assets/pet-codex.webp'

/** Brand-mark glyph height, matched to CLAUDE_FRAME_HEIGHT so every indicator sits on one baseline. */
const BRAND_BADGE_SIZE = 16

/**
 * The walking mascot shown inside the RUNNING badge (docs/mascot-sprites.md):
 * - claude → the runtime-drawn coral pixel critter (data-URI spritesheet; the walk is CSS
 *   `steps(1)` over three keyframes, NOT `steps(2)` — see .term-node__mascot--claude).
 * - codex  → pet-codex.webp, first-row walk cycle (CSS `steps(8)`).
 * - grok / gemini / opencode / copilot / devin → their own BRAND MARK, pulsing and blooming rather than walking. Grok
 *   had a quadrant critter first; a hand-drawn creature next to two real mascots read as neither, so
 *   the glyph the agent actually has is what animates. gemini and opencode used to fall through to
 *   the plain dot, which says "something is happening" but not WHO. The decision and the bloom's
 *   caveat live in lib/brandPulse.ts, which the notch HUD shares.
 * - anything else (custom agents, plain terminals) → the plain pulsing dot, unchanged.
 *
 * Animation is pure CSS (see .term-node__mascot* in styles.css) — no JS timers, so a canvas
 * full of RUNNING terminals costs nothing per node. Dimensions come from lib/mascot.ts so the
 * CSS scaling and the geometry can never desync.
 */
export function AgentMascot({ agentId }: { agentId?: AgentId }): React.JSX.Element {
  if (agentId === 'claude' && CLAUDE_MASCOT.src) {
    const style = {
      '--mascot-w': `${CLAUDE_MASCOT.frameWidth}px`,
      '--mascot-h': `${CLAUDE_MASCOT.frameHeight}px`,
      backgroundImage: `url(${CLAUDE_MASCOT.src})`
    } as CSSProperties
    return <span className="term-node__mascot term-node__mascot--claude" style={style} aria-hidden />
  }

  if (agentId === 'codex') {
    const style = {
      '--cmascot-w': `${CODEX_MASCOT.frameWidth}px`,
      '--cmascot-h': `${CODEX_MASCOT.frameHeight}px`,
      '--cmascot-sheet-w': `${CODEX_MASCOT.frameWidth * CODEX_MASCOT.cols}px`,
      '--cmascot-sheet-h': `${CODEX_MASCOT.frameHeight * CODEX_MASCOT.rows}px`,
      backgroundImage: `url(${codexPet})`
    } as CSSProperties
    return <span className="term-node__mascot term-node__mascot--codex" style={style} aria-hidden />
  }

  // The mascot-less builtins pulse their own brand mark instead of a critter. Sprites are matched
  // first, above: claude and codex have marks too, and their art wins. Gated on the predicate rather
  // than on `<BrandPulse/> !== null`, because a JSX element is truthy even for a component that
  // renders nothing.
  //
  // Note the one knock-on: claude's branch needs a runtime-drawn spritesheet, and when that cannot be
  // built (no `document` — SSR/tests) it now lands HERE, on claude's own mark, instead of on the bare
  // dot. That is a strictly better fallback and never happens in the real renderer.
  if (agentId && hasBrandLogo(agentId)) {
    return <BrandPulse agentId={agentId} size={BRAND_BADGE_SIZE} />
  }

  // Custom agents and plain terminals have no mark: the original pulsing dot, unchanged.
  return <span className="term-node__status-dot" />
}

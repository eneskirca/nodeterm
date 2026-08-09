import type { CSSProperties } from 'react'
import type { AgentId } from '@shared/agents/config'
import { CLAUDE_MASCOT, CODEX_MASCOT, GROK_MASCOT } from '../lib/mascot'
import codexPet from '../assets/pet-codex.webp'

/**
 * The walking mascot shown inside the RUNNING badge (docs/mascot-sprites.md):
 * - claude → the runtime-drawn coral pixel critter (data-URI spritesheet; the walk is CSS
 *   `steps(1)` over three keyframes, NOT `steps(2)` — see .term-node__mascot--claude).
 * - grok   → its own slate critter, same quadrant machinery and walk geometry.
 * - codex  → pet-codex.webp, first-row walk cycle (CSS `steps(8)`).
 * - anything else (gemini/opencode/custom/plain) → the plain pulsing dot, unchanged.
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

  if (agentId === 'grok' && GROK_MASCOT.src) {
    const style = {
      '--mascot-w': `${GROK_MASCOT.frameWidth}px`,
      '--mascot-h': `${GROK_MASCOT.frameHeight}px`,
      backgroundImage: `url(${GROK_MASCOT.src})`
    } as CSSProperties
    return <span className="term-node__mascot term-node__mascot--grok" style={style} aria-hidden />
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

  // Every other agent keeps the original pulsing dot.
  return <span className="term-node__status-dot" />
}

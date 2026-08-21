import { capabilityAgentId, type AgentId, type BuiltinAgentId } from '@shared/agents/config'
import { IconTerminal } from '../components/icons'
import { BRAND_PULSE_CLASS, brandLogoSrc, brandPulsePlan } from './brandPulse'
import { GROK_MARK_PATH, GROK_MARK_VIEWBOX } from './grokMark'
import { COPILOT_MARK_PATHS, COPILOT_MARK_VIEWBOX } from './copilotMark'

// The logo map itself lives in the REACT-FREE lib/brandPulse.ts, because the notch HUD needs the
// same assets and must not import React. Re-exported here so React callers have one import for
// "which agents have a mark" beside the components that draw them.
export { hasBrandLogo } from './brandPulse'

/**
 * The official Grok mark (xAI), inlined rather than shipped as an asset — geometry from
 * `lib/grokMark.ts`, which the notch HUD's imperative renderer shares.
 *
 * `className` is how the RUNNING badge reuses this exact glyph as its "working" indicator (it
 * pulses and blooms instead of walking — grok has no critter; see AgentMascot).
 */
export function GrokMark({
  size,
  className
}: {
  size: number
  className?: string
}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox={GROK_MARK_VIEWBOX}
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className={className}
      style={{ display: 'block' }}
    >
      <path fillRule="evenodd" clipRule="evenodd" d={GROK_MARK_PATH} />
    </svg>
  )
}

/**
 * The RUNNING-badge indicator for an agent that has a brand mark but no mascot art: the mark
 * itself, pulsing with a `currentColor` bloom. See `brandPulsePlan` for why (and for the bloom's
 * one caveat on the multi-colour assets); `null` here means "no mark — fall back to the dot".
 *
 * A thin renderer on purpose: every decision is in the pure plan, which the notch HUD shares.
 */
/**
 * The official GitHub Copilot mark, inlined rather than shipped as an asset — geometry from
 * `lib/copilotMark.ts`, which the notch HUD's imperative renderer shares. Monochrome, so
 * `currentColor` lets it follow the theme (the asset's fixed #f0f6fc was invisible on light).
 */
export function CopilotMark({
  size,
  className
}: {
  size: number
  className?: string
}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox={COPILOT_MARK_VIEWBOX}
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className={className}
      style={{ display: 'block' }}
    >
      {COPILOT_MARK_PATHS.map((d) => (
        <path key={d.slice(0, 12)} d={d} />
      ))}
    </svg>
  )
}

export function BrandPulse({ agentId, size }: { agentId?: AgentId; size: number }): React.JSX.Element | null {
  const plan = brandPulsePlan(agentId, size)
  if (!plan) return null
  // Grok keeps carrying the class on the <svg> itself — no wrapper — so its `currentColor` fill and
  // its drop-shadow bloom resolve exactly as they did before the class was generalized.
  if (plan.kind === 'inline')
    return plan.mark === 'copilot' ? (
      <CopilotMark size={plan.size} className={BRAND_PULSE_CLASS} />
    ) : (
      <GrokMark size={plan.size} className={BRAND_PULSE_CLASS} />
    )
  return (
    <span className={BRAND_PULSE_CLASS} aria-hidden style={{ display: 'block', lineHeight: 0 }}>
      <img src={plan.src} width={plan.size} height={plan.size} alt="" style={{ display: 'block' }} />
    </span>
  )
}

export function AgentIcon({
  agentId,
  agentBaseId,
  size = 16
}: {
  agentId: AgentId
  /** Node-persisted harness snapshot; wins when the custom-agent definition no longer exists. */
  agentBaseId?: BuiltinAgentId
  size?: number
}): React.JSX.Element {
  // A custom agent with `baseAgent` speaks that harness's protocol and should carry its visual
  // identity too. The renderer registers a live custom-id resolver at boot, so settings edits are
  // reflected on the next render without duplicating custom-agent lookup logic in every menu.
  const iconAgentId = agentBaseId ?? capabilityAgentId(agentId)
  if (iconAgentId === 'grok') return <GrokMark size={size} />
  if (iconAgentId === 'copilot') return <CopilotMark size={size} />
  // `brandLogoSrc`, not `AGENT_LOGO[iconAgentId]`: the id can be anything a hand-edited
  // project.json says, and a prototype key ('constructor') would hand back a Function as the image
  // source.
  const src = brandLogoSrc(iconAgentId)
  if (src) {
    return <img src={src} width={size} height={size} alt="" style={{ display: 'block' }} />
  }
  return <IconTerminal />
}

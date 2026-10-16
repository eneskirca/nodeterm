import { useEffect, useRef, useState } from 'react'
import { useContextUsage } from '../state/contextWindow'
import { useSettings } from '../state/settings'
import { capabilityAgentId } from '@shared/agents/config'
import { isHidden } from '../lib/ui-visibility'
import { barFillPercent, contextFillColor, contextPillText, formatModelLabel, formatTimeAgo, formatTokensShort, percentText } from '../lib/usageFormat'

/**
 * Per-Claude-node context-window meter. A small header pill (mini-bar + "NN%") that toggles
 * a popover with token figures and model. Renders nothing until the session has usage data.
 */
export function ContextMeter({ sessionId, nodeId, remote = false, agentId, fromLaunchId = false }: {
  sessionId: string | null
  nodeId?: string
  remote?: boolean
  agentId?: string
  /** `sessionId` is the node's persisted launch id, not a hook-confirmed one
   *  (lib/transcriptSession.ts): the popover says so, since it may be an older session. */
  fromLaunchId?: boolean
}): JSX.Element | null {
  const scoped = remote && !!agentId && capabilityAgentId(agentId) === 'codex'
  // A copied rollout has the same session id on two hosts. SSH Codex observations belong
  // to the node that requested them; never fall back to a local/session-only snapshot.
  const usage = useContextUsage({ sessionId, nodeId, scoped })
  const percentMode = useSettings((s) => s.settings.usagePercentMode)
  // Issue #1141: hideable from Settings → Appearance (same list as the header buttons). Read here
  // rather than at the three call sites so the header, the card and the modal cannot disagree.
  const hiddenByUser = useSettings((s) => isHidden('context-meter', s.settings.hiddenHeaderButtons))
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  if (!usage || hiddenByUser) return null
  // The NUMBER honours the used/remaining/tokens display setting; the bar and its color stay
  // keyed to context FILL, so the severity colors keep meaning the same thing in every mode
  // (issue #78).
  const pillText = contextPillText(usage.usedTokens, usage.windowTokens, usage.usedPercent, percentMode)
  const color = contextFillColor(usage.usedPercent)
  const estimated = usage.windowSource === 'estimate'
  const modelLabel = formatModelLabel(usage.model)

  return (
    <div className="ctx-meter nodrag" ref={ref}>
      {open && (
        <div className="ctx-popover">
          <div className="ctx-popover__title">Context{estimated ? ' (estimated window)' : ''}</div>
          <div className="ctx-bar">
            <div className="ctx-bar__fill" style={{ width: `${barFillPercent(usage.usedPercent, percentMode)}%`, background: color }} />
          </div>
          <div className="ctx-popover__meta">
            ~{formatTokensShort(usage.usedTokens)} / {formatTokensShort(usage.windowTokens)} tokens
          </div>
          <div className="ctx-popover__sub">
            {/* No model read ⇒ say nothing. This used to fall back to the literal 'claude', which
                was harmless while the meter was claude-only and became a mislabel once codex and
                gemini joined USAGE_CAPABLE — a codex popover would have claimed to be claude. */}
            {usage.model ? `${usage.model} · ` : ''}Updated {formatTimeAgo(usage.updatedAt)}
          </div>
          {fromLaunchId && (
            <div className="ctx-popover__sub">From the session this node was started with.</div>
          )}
        </div>
      )}
      <button
        className="ctx-pill"
        title={`${estimated ? 'Estimated context window' : 'Context window'} — ${percentText(usage.usedPercent, percentMode)}`}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
      >
        {modelLabel && <span className="ctx-pill__model">{modelLabel}</span>}
        <span className="ctx-pill__bar">
          <span className="ctx-pill__fill" style={{ width: `${barFillPercent(usage.usedPercent, percentMode)}%`, background: color }} />
        </span>
        <span className="ctx-pill__num">{estimated ? '~' : ''}{pillText}</span>
      </button>
    </div>
  )
}

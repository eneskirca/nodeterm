import { useEffect, useRef, useState } from 'react'
import { useContextWindow } from '../state/contextWindow'
import { useSettings } from '../state/settings'
import { barFillPercent, contextFillColor, contextPillText, formatModelLabel, formatTimeAgo, formatTokensShort, percentText } from '../lib/usageFormat'
import { contextMeterModel, contextMeterUsage } from '../lib/contextMeterModel'

/**
 * Per-Claude-node context-window meter. A small header pill (mini-bar + "NN%") that toggles
 * a popover with token figures and model. Renders nothing until the session has usage data.
 */
export function ContextMeter({
  sessionId,
  nodeModel,
  nodeContextWindow
}: {
  sessionId: string | null
  nodeModel?: string
  /** Context window baked into this node's launch environment. */
  nodeContextWindow?: number
}): JSX.Element | null {
  const usage = useContextWindow((s) => (sessionId ? s.bySessionId[sessionId] : undefined))
  const percentMode = useSettings((s) => s.settings.usagePercentMode)
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

  if (!usage) return null
  // The NUMBER honours the used/remaining/tokens display setting; the bar and its color stay
  // keyed to context FILL, so the severity colors keep meaning the same thing in every mode
  // (issue #78).
  const { windowTokens, usedPercent } = contextMeterUsage(
    usage.usedTokens,
    usage.windowTokens,
    nodeContextWindow
  )
  const pillText = contextPillText(usage.usedTokens, windowTokens, usedPercent, percentMode)
  const color = contextFillColor(usedPercent)
  // ONE precedence rule for every ContextMeter surface. The transcript is what the CLI ECHOS,
  // but it lags a switch: a resumed transcript replays pre-switch rows, so its label can name a
  // model the process no longer runs (the "GLM-5.2 under the context %" the launch record
  // disproves). The node's launch record outranks it there; a hand-`claude`'d terminal has no
  // record, and the transcript keeps its job. The used-token count stays transcript-owned; the
  // persisted launch window owns the denominator when present.
  const model = contextMeterModel(usage.model, nodeModel)
  const modelLabel = formatModelLabel(model)

  return (
    <div className="ctx-meter nodrag" ref={ref}>
      {open && (
        <div className="ctx-popover">
          <div className="ctx-popover__title">Context</div>
          <div className="ctx-bar">
            <div className="ctx-bar__fill" style={{ width: `${barFillPercent(usedPercent, percentMode)}%`, background: color }} />
          </div>
          <div className="ctx-popover__meta">
            ~{formatTokensShort(usage.usedTokens)} / {formatTokensShort(windowTokens)} tokens
          </div>
          <div className="ctx-popover__sub">
            {/* No model read ⇒ say nothing. This used to fall back to the literal 'claude', which
                was harmless while the meter was claude-only and became a mislabel once codex and
                gemini joined USAGE_CAPABLE — a codex popover would have claimed to be claude. */}
            {model ? `${model} · ` : ''}Updated {formatTimeAgo(usage.updatedAt)}
          </div>
        </div>
      )}
      <button
        className="ctx-pill"
        title={`Context window — ${percentText(usedPercent, percentMode)}`}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
      >
        {modelLabel && <span className="ctx-pill__model">{modelLabel}</span>}
        <span className="ctx-pill__bar">
          <span className="ctx-pill__fill" style={{ width: `${barFillPercent(usedPercent, percentMode)}%`, background: color }} />
        </span>
        <span className="ctx-pill__num">{pillText}</span>
      </button>
    </div>
  )
}

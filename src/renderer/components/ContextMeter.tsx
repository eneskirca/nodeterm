import { useEffect, useRef, useState } from 'react'
import { useContextWindow } from '../state/contextWindow'
import { useSettings } from '../state/settings'
import { barFillPercent, contextFillColor, contextPillText, formatModelLabel, formatTimeAgo, formatTokensShort, percentText } from '../lib/usageFormat'

/**
 * Per-agent context-window meter. A small header pill (mini-bar + "NN%") that toggles a popover
 * with token figures and model. Renders nothing until the session has usage data.
 *
 * `modelOverride` is the node's explicit launch selection. Transcript usage necessarily trails a
 * model switch until the replacement model writes its first assistant turn, so the selected model
 * owns the label immediately while the measured transcript remains authoritative for token usage.
 * Nodes with no explicit selection continue to show the model reported by the transcript.
 */
export function ContextMeter({
  sessionId,
  modelOverride
}: {
  sessionId: string | null
  modelOverride?: string | null
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
  const pillText = contextPillText(usage.usedTokens, usage.windowTokens, usage.usedPercent, percentMode)
  const color = contextFillColor(usage.usedPercent)
  const displayModel = modelOverride?.trim() || usage.model
  const modelLabel = formatModelLabel(displayModel)

  return (
    <div className="ctx-meter nodrag" ref={ref}>
      {open && (
        <div className="ctx-popover">
          <div className="ctx-popover__title">Context</div>
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
            {displayModel ? `${displayModel} · ` : ''}Updated {formatTimeAgo(usage.updatedAt)}
          </div>
        </div>
      )}
      <button
        className="ctx-pill"
        title={`Context window — ${percentText(usage.usedPercent, percentMode)}`}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
      >
        {modelLabel && <span className="ctx-pill__model">{modelLabel}</span>}
        <span className="ctx-pill__bar">
          <span className="ctx-pill__fill" style={{ width: `${barFillPercent(usage.usedPercent, percentMode)}%`, background: color }} />
        </span>
        <span className="ctx-pill__num">{pillText}</span>
      </button>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { useContextWindow } from '../state/contextWindow'
import { useSettings } from '../state/settings'
import { activeSessionApi } from '../session/session'
import { barFillPercent, contextFillColor, contextPillText, formatModelLabel, formatTimeAgo, formatTokensShort, percentText } from '../lib/usageFormat'
import type { PtyEnvInfo } from '@shared/types'

/**
 * Per-Claude-node context-window meter. A small header pill (mini-bar + "NN%") that toggles
 * a popover with token figures and model. Renders nothing until the session has usage data.
 */
export function ContextMeter({
  sessionId,
  nodeId
}: {
  sessionId: string | null
  nodeId?: string
}): JSX.Element | null {
  const usage = useContextWindow((s) => (sessionId ? s.bySessionId[sessionId] : undefined))
  const percentMode = useSettings((s) => s.settings.usagePercentMode)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const [envResult, setEnvResult] = useState<{ nodeId: string; info: PtyEnvInfo } | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  useEffect(() => {
    if (!open || !nodeId) {
      setEnvResult(null)
      return
    }
    let cancelled = false
    setEnvResult(null)
    activeSessionApi()
      .pty.envInfo(nodeId)
      .then((info) => {
        if (!cancelled) setEnvResult({ nodeId, info })
      })
      .catch(() => {
        if (!cancelled) {
          setEnvResult({ nodeId, info: { source: 'unavailable', vars: [] } })
        }
      })
    return () => {
      cancelled = true
    }
  }, [open, nodeId])

  if (!usage) return null
  const env = envResult && envResult.nodeId === nodeId ? envResult.info : null
  // The NUMBER honours the used/remaining/tokens display setting; the bar and its color stay
  // keyed to context FILL, so the severity colors keep meaning the same thing in every mode
  // (issue #78).
  const pillText = contextPillText(usage.usedTokens, usage.windowTokens, usage.usedPercent, percentMode)
  const color = contextFillColor(usage.usedPercent)
  const modelLabel = formatModelLabel(usage.model)

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
            {usage.model ? `${usage.model} · ` : ''}Updated {formatTimeAgo(usage.updatedAt)}
          </div>
          {nodeId && (
            <div className="ctx-env">
              <div className="ctx-env__title">Spawn environment</div>
              {env?.source === 'unavailable' && (
                <div className="ctx-env__empty">Not available for this session.</div>
              )}
              {env && env.source !== 'unavailable' && (
                <>
                  <div className="ctx-env__sub">
                    {env.source === 'spawn'
                      ? 'captured when this session started'
                      : 'read from the tmux session'}
                  </div>
                  <div className="ctx-env__vars">
                    {env.vars.map((variable) => (
                      <div
                        className={`ctx-env__var${variable.secret ? ' ctx-env__var--secret' : ''}`}
                        key={variable.key}
                      >
                        <code className="ctx-env__key">{variable.key}</code>
                        <code
                          className="ctx-env__value"
                          title={variable.secret ? 'masked credential' : variable.value}
                        >
                          {variable.value}
                        </code>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
      <button
        className="ctx-pill"
        title={`Context window — ${percentText(usage.usedPercent, percentMode)}`}
        onClick={(e) => {
          e.stopPropagation()
          setEnvResult(null)
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

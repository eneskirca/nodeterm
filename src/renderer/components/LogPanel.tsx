import { useEffect, useMemo, useRef, useState } from 'react'
import { IconClose } from './icons'
import { createPortal } from 'react-dom'
import type { LogRecord } from '@shared/types'

export interface LogPanelProps {
  onClose: () => void
}

const LEVELS = ['debug', 'info', 'warn', 'error'] as const
type Level = (typeof LEVELS)[number]

/** Mirror cap — same as the main-process ring, so the panel can never outgrow its source. */
const MIRROR_CAP = 2000

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * Live debug log viewer (issue #78). The main process's ring is the source of truth: mount
 * snapshots it, then batched pushes stream in — both dedupe by `seq`, so the overlap around the
 * subscribe edge is harmless. Everything here is view state; closing the panel loses nothing.
 */
export function LogPanel({ onClose }: LogPanelProps) {
  const [entries, setEntries] = useState<LogRecord[]>([])
  const [levels, setLevels] = useState<Set<Level>>(() => new Set(LEVELS))
  const [query, setQuery] = useState('')
  const feedRef = useRef<HTMLDivElement>(null)
  // Stick to the bottom while the user is AT the bottom; a manual scroll up pins the view so a
  // chatty subsystem can't yank the line being read out from under the pointer.
  const stickRef = useRef(true)

  useEffect(() => {
    let dead = false
    const append = (batch: LogRecord[]): void => {
      if (dead || batch.length === 0) return
      setEntries((prev) => {
        const last = prev.length ? prev[prev.length - 1].seq : 0
        const fresh = batch.filter((r) => r.seq > last)
        if (fresh.length === 0) return prev
        const next = [...prev, ...fresh]
        return next.length > MIRROR_CAP ? next.slice(next.length - MIRROR_CAP) : next
      })
    }
    void window.nodeTerminal.logs.snapshot().then((snap) => {
      if (!dead) setEntries(snap)
    })
    const unsub = window.nodeTerminal.logs.onBatch(append)
    return () => {
      dead = true
      unsub()
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return entries.filter(
      (r) =>
        levels.has(r.level) &&
        (!q || r.msg.toLowerCase().includes(q) || r.tag.toLowerCase().includes(q))
    )
  }, [entries, levels, query])

  // Auto-scroll after each render while stuck to the bottom.
  useEffect(() => {
    const el = feedRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [filtered])

  const toggleLevel = (l: Level): void => {
    setLevels((prev) => {
      const next = new Set(prev)
      if (next.has(l)) next.delete(l)
      else next.add(l)
      return next
    })
  }

  const copyAll = (): void => {
    const text = filtered
      .map((r) => `${fmtTime(r.ts)} ${r.level.toUpperCase().padEnd(5)} ${r.tag ? `[${r.tag}] ` : ''}${r.msg}`)
      .join('\n')
    void navigator.clipboard.writeText(text)
  }

  const clear = (): void => {
    window.nodeTerminal.logs.clear()
    setEntries([])
  }

  return createPortal(
    <div className="sc-overlay" onClick={onClose}>
      <div className="logpanel" onClick={(e) => e.stopPropagation()}>
        <div className="logpanel__head">
          <h2>Debug log</h2>
          <div className="logpanel__chips">
            {LEVELS.map((l) => (
              <button
                key={l}
                className={`logpanel__chip logpanel__chip--${l}${levels.has(l) ? ' is-on' : ''}`}
                onClick={() => toggleLevel(l)}
              >
                {l}
              </button>
            ))}
          </div>
          <input
            className="logpanel__filter"
            placeholder="Filter…"
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="logpanel__act" title="Copy the filtered lines" onClick={copyAll}>
            Copy
          </button>
          <button className="logpanel__act" title="Empty the ring" onClick={clear}>
            Clear
          </button>
          <button className="drawer__close" aria-label="Close" onClick={onClose}>
            <IconClose />
          </button>
        </div>
        <div
          className="logpanel__feed"
          ref={feedRef}
          onScroll={(e) => {
            const el = e.currentTarget
            stickRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8
          }}
        >
          {filtered.length === 0 ? (
            <div className="logpanel__empty">
              Nothing captured{query || levels.size < LEVELS.length ? ' matching the filter' : ' yet'}.
            </div>
          ) : (
            filtered.map((r) => (
              <div key={r.seq} className={`logpanel__row logpanel__row--${r.level}`}>
                <span className="logpanel__time">{fmtTime(r.ts)}</span>
                <span className={`logpanel__level logpanel__level--${r.level}`}>{r.level}</span>
                {r.tag && <span className="logpanel__tag">[{r.tag}]</span>}
                <span className="logpanel__msg">{r.msg}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

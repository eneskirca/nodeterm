import { useEffect, useRef } from 'react'
import { IconArrowDown, IconArrowUp, IconClose } from './icons'

/** Identical shape to SearchSnippet in useTerminalSearch.ts (imported by the consumer). */
export interface FindBarSnippet {
  source: 'terminal' | 'claude'
  role?: 'user' | 'assistant' | 'tool'
  text: string
}

interface Props {
  query: string
  onQueryChange: (q: string) => void
  matchIndex: number // 1-based; 0 when no matches
  matchCount: number
  current: FindBarSnippet | null
  onNext: () => void
  onPrev: () => void
  onClose: () => void
}

export function FindBar({
  query,
  onQueryChange,
  matchIndex,
  matchCount,
  current,
  onNext,
  onPrev,
  onClose
}: Props): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  return (
    <div className="term-node__find nodrag nowheel" onMouseDown={(e) => e.stopPropagation()}>
      <div className="term-node__find-row">
        <input
          ref={inputRef}
          className="term-node__find-input"
          placeholder="Find…"
          value={query}
          spellCheck={false}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              if (e.shiftKey) onPrev()
              else onNext()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            }
          }}
        />
        <span className="term-node__find-count">{matchCount ? `${matchIndex} / ${matchCount}` : '0 / 0'}</span>
        <button
          type="button"
          className="term-node__find-btn"
          title="Previous (Shift+Enter)"
          aria-label="Previous match"
          onClick={onPrev}
          disabled={!matchCount}
        >
          <IconArrowUp />
        </button>
        <button
          type="button"
          className="term-node__find-btn"
          title="Next (Enter)"
          aria-label="Next match"
          onClick={onNext}
          disabled={!matchCount}
        >
          <IconArrowDown />
        </button>
        <button
          type="button"
          className="term-node__find-btn"
          title="Close (Esc)"
          aria-label="Close search"
          onClick={onClose}
        >
          <IconClose />
        </button>
      </div>
      {current && (
        <div className="term-node__find-snippet">
          <span className={`term-node__find-tag term-node__find-tag--${current.source}`}>
            {current.source === 'claude' ? current.role ?? 'claude' : 'terminal'}
          </span>
          <span className="term-node__find-snippet-text">{current.text.trim() || '(empty line)'}</span>
        </div>
      )}
    </div>
  )
}

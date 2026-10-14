import { useEffect, useState } from 'react'
import { IconCheck, IconCopy } from '../components/icons'

/**
 * The ⌘M chat view's one copy control: a quiet icon button that turns into a check + "Copied" for
 * 1.5 s. Shared by the per-turn Copy (ChatTurnActions) and the code-block Copy (CodeBlockCopy), so
 * the two look and behave the same.
 */
export function ChatCopyButton({
  text,
  label,
  title,
  className
}: {
  /** Read at click time, so a code block's current contents are copied. */
  text: () => string
  /** The accessible name ("Copy message", "Copy code"). */
  label: string
  /** The tooltip before copying; "Copied" after. */
  title: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <button
      type="button"
      className={`term-chat__action${className !== undefined ? ` ${className}` : ''}`}
      aria-label={label}
      title={copied ? 'Copied' : title}
      data-copied={copied ? '' : undefined}
      onClick={() => {
        // The app's own clipboard channel, not `navigator.clipboard`: it never rejects, and the
        // Server Edition bridge falls back to execCommand and raises its own banner on failure.
        window.nodeTerminal.clipboard.writeText(text())
        setCopied(true)
      }}
    >
      {copied ? <IconCheck /> : <IconCopy />}
      {copied && <span className="term-chat__action-note">Copied</span>}
    </button>
  )
}

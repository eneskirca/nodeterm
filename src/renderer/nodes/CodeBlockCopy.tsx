import { useLayoutEffect, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { preText } from '../lib/codeBlockCopy'
import { ChatCopyButton } from './ChatCopyButton'

interface CodeBlock {
  pre: HTMLPreElement
  host: HTMLElement
}

/**
 * A Copy button in the top-right corner of every code block in a rendered-Markdown container of the
 * ⌘M chat view — the same control as the per-turn Copy (ChatCopyButton).
 *
 * The Markdown arrives as an HTML string set as the container's inner HTML, so the blocks are found in
 * the DOM after each render of a new string: each `<pre>` is wrapped in a positioned
 * `.term-chat__code` (the button cannot live inside the `<pre>`, which scrolls sideways and would
 * carry it along) and the button is portalled into a host beside it. React replaces the container's
 * children when the HTML string changes, which drops the old wrappers; this runs again for the new
 * ones. Wrapping is idempotent, so a re-run on the same DOM adds nothing.
 */
export function useCodeBlockCopy(container: RefObject<HTMLElement | null>, html: string): React.ReactNode {
  const [blocks, setBlocks] = useState<CodeBlock[]>([])

  useLayoutEffect(() => {
    const root = container.current
    if (root === null) return
    const found: CodeBlock[] = []
    for (const pre of Array.from(root.querySelectorAll('pre'))) {
      let wrap = pre.parentElement
      if (wrap === null || !wrap.classList.contains('term-chat__code')) {
        wrap = document.createElement('div')
        wrap.className = 'term-chat__code'
        pre.replaceWith(wrap)
        wrap.appendChild(pre)
      }
      let host = wrap.querySelector<HTMLElement>(':scope > .term-chat__code-copy-host')
      if (host === null) {
        host = document.createElement('span')
        host.className = 'term-chat__code-copy-host'
        wrap.appendChild(host)
      }
      found.push({ pre, host })
    }
    setBlocks(found)
  }, [container, html])

  return blocks.map(({ pre, host }, i) =>
    createPortal(
      <ChatCopyButton
        text={() => preText(pre)}
        label="Copy code"
        title="Copy code"
        className="term-chat__code-copy"
      />,
      host,
      String(i)
    )
  )
}

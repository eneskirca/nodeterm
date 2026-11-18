import type { MouseEvent } from 'react'

/**
 * "Add to chat" over a terminal's bottom-right corner, offered for a moment after a copy
 * (`useQuoteOffer`). Shared by BOTH terminal surfaces — the canvas node and the kanban card modal's
 * live viewer — like the copy receipt it sits beside, so one session seen twice offers the same
 * thing in the same place.
 *
 * Bottom-RIGHT like the receipt, never bottom-left: every agent CLI writes its input line there.
 * Unlike the receipt it takes the click (`pointer-events: auto`), and `nodrag nowheel` keep React
 * Flow from moving the node or panning the canvas through it. A press does not take the keyboard
 * (`preventDefault` on mousedown): after the quote is typed at the prompt, the person's next keys
 * still reach the terminal.
 *
 * `raised` puts it one notch up, clear of the copy receipt's slot. The caller passes it for a
 * terminal whose receipt is ON, whether or not the receipt is showing at the moment: the receipt
 * lasts 1.6 s and the offer 6 s, and a pill that dropped into the freed slot would move under the
 * pointer reaching for it.
 */
export interface QuotePillProps {
  /** The copied text this pill offers (handed to `onAdd` as is). */
  text: string
  onAdd(text: string): void
  onDismiss(): void
  raised?: boolean
}

export function QuotePill({ text, onAdd, onDismiss, raised = false }: QuotePillProps) {
  const keepFocus = (e: MouseEvent): void => e.preventDefault()
  return (
    <div className={`term-quote-pill nodrag nowheel${raised ? ' term-quote-pill--raised' : ''}`}>
      <button
        type="button"
        className="term-quote-pill__add"
        title="Add the copied text to the agent's message as a quote"
        onMouseDown={keepFocus}
        onClick={() => onAdd(text)}
      >
        Add to chat
      </button>
      <button
        type="button"
        className="term-quote-pill__dismiss"
        aria-label="Dismiss"
        title="Dismiss"
        onMouseDown={keepFocus}
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  )
}

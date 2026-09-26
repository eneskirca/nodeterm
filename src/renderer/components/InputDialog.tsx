import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDialogStack } from './dialog-stack'

interface InputDialogProps {
  message: string
  initialValue?: string
  placeholder?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Longest value the field accepts (the HTML attribute: typing and pasting stop there). */
  maxLength?: number
  onSubmit: (value: string) => void
  onCancel: () => void
}

/**
 * A small themed text-input dialog — the in-app replacement for `window.prompt`, which Electron
 * does not support (it throws "prompt() is and will not be supported"). Enter submits, Esc cancels.
 * Reuses the `.confirm*` shell styles; usually driven via the `promptDialog()` singleton helper.
 */
export function InputDialog({
  message,
  initialValue = '',
  placeholder,
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  maxLength,
  onSubmit,
  onCancel
}: InputDialogProps) {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement>(null)
  // Registered in the modal stack so a ConfirmDialog underneath does not ALSO answer the Enter /
  // Escape typed into this input (its own listener is on `window`). The keys here are handled on
  // the input element itself, so nothing else is needed.
  useDialogStack()

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  return createPortal(
    <div className="confirm-overlay" onClick={onCancel}>
      <div className="confirm" onClick={(e) => e.stopPropagation()}>
        <p className="confirm__msg">{message}</p>
        <input
          ref={inputRef}
          className="confirm__input"
          value={value}
          placeholder={placeholder}
          maxLength={maxLength}
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onSubmit(value)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onCancel()
            }
          }}
        />
        <div className="confirm__actions">
          <button className="confirm__btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button className="confirm__btn primary" onClick={() => onSubmit(value)}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

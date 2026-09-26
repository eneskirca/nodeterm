import { create } from 'zustand'
import { InputDialog } from './InputDialog'

// Promise-based, singleton in-app replacement for window.prompt (unsupported in Electron).
// Call `promptDialog({ message })` and await a `string` (submitted) or `null` (cancelled).
// Render <PromptDialogHost/> once near the app root so any component can call the helper.

interface PromptOptions {
  message: string
  initialValue?: string
  placeholder?: string
  confirmLabel?: string
  maxLength?: number
}

interface PromptState {
  current: (PromptOptions & { resolve: (value: string | null) => void }) | null
  submit: (value: string) => void
  cancel: () => void
}

const usePromptStore = create<PromptState>((set, get) => ({
  current: null,
  submit: (value) => {
    const c = get().current
    if (c) {
      set({ current: null })
      c.resolve(value)
    }
  },
  cancel: () => {
    const c = get().current
    if (c) {
      set({ current: null })
      c.resolve(null)
    }
  }
}))

/** Show the input dialog and resolve with the entered string, or null if cancelled. */
export function promptDialog(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    // Only one dialog at a time: cancel any pending one (resolve null) before opening the next.
    const prev = usePromptStore.getState().current
    if (prev) {
      usePromptStore.setState({ current: null })
      prev.resolve(null)
    }
    usePromptStore.setState({ current: { ...options, resolve } })
  })
}

/** Mount once (app root). Renders the active prompt dialog, if any. */
export function PromptDialogHost() {
  const current = usePromptStore((s) => s.current)
  const submit = usePromptStore((s) => s.submit)
  const cancel = usePromptStore((s) => s.cancel)
  if (!current) return null
  return (
    <InputDialog
      message={current.message}
      initialValue={current.initialValue}
      placeholder={current.placeholder}
      confirmLabel={current.confirmLabel}
      maxLength={current.maxLength}
      onSubmit={submit}
      onCancel={cancel}
    />
  )
}

// The paste window's page (src/main/secret-entry-window.ts): one masked field. Plain DOM, no app
// code: this page imports nothing but its stylesheet, and talks only to its own preload.
import './secret-entry.css'

// Local mirror of the preload's contract (src/preload/secret-entry.ts), kept self-contained so this
// entry has no cross-project type dependency (the HUD entry does the same).
interface SecretEntryApi {
  onInit(cb: (init: { projectName: string; env: string; replacing?: boolean }) => void): void
  onError(cb: (message: string) => void): void
  submit(value: string): void
  cancel(): void
}

declare global {
  interface Window {
    secretEntry: SecretEntryApi
  }
}

const api = window.secretEntry
const form = document.getElementById('entry') as HTMLFormElement
const input = document.getElementById('value') as HTMLInputElement
const save = document.getElementById('save') as HTMLButtonElement
const cancel = document.getElementById('cancel') as HTMLButtonElement
const error = document.getElementById('error') as HTMLParagraphElement
const envEl = document.getElementById('env') as HTMLElement
const lead = document.getElementById('lead') as HTMLParagraphElement

api.onInit(({ projectName, env, replacing }) => {
  envEl.textContent = env
  lead.textContent =
    `for the agents of “${projectName}”.` +
    (replacing ? ' It replaces the value held now; Cancel keeps that one.' : '')
  input.focus()
})

api.onError((message) => {
  error.textContent = `Not kept: ${message}. Paste it again.`
  save.disabled = input.value.length === 0
  input.focus()
})

// A password field silently REMOVES line breaks from inserted text, so a multi-line paste would be
// kept as a different, joined value. Every way text can arrive is checked BEFORE the field sees it:
// `beforeinput` covers paste (Ctrl+V, Win+V clipboard history), drop and replacement text; `paste`
// and `drop` are checked too in case an insertion reports no text there. Line endings at the ends
// are fine (main removes them). Unicode line and paragraph separators count as line breaks.
const LINE_BREAK = /[\r\n\v\f\u0085\u2028\u2029]/
const EDGE_BREAKS = /^[\r\n]+|[\r\n]+$/g
function refuses(text: string | null | undefined): boolean {
  return !!text && LINE_BREAK.test(text.replace(EDGE_BREAKS, ''))
}
function refuse(e: Event): void {
  e.preventDefault()
  e.stopImmediatePropagation()
  error.textContent = 'Not pasted: the text has more than one line. A secret here is one line.'
}
input.addEventListener('beforeinput', (e) => {
  if (!e.inputType.startsWith('insertFrom') && e.inputType !== 'insertReplacementText') return
  if (refuses(e.dataTransfer?.getData('text/plain') ?? e.data)) refuse(e)
})
input.addEventListener('paste', (e) => {
  if (refuses(e.clipboardData?.getData('text/plain'))) refuse(e)
})
input.addEventListener('drop', (e) => {
  if (refuses(e.dataTransfer?.getData('text/plain'))) refuse(e)
})

input.addEventListener('input', () => {
  save.disabled = input.value.length === 0
  error.textContent = ''
})

form.addEventListener('submit', (e) => {
  e.preventDefault()
  if (!input.value) return
  const value = input.value
  // The field is emptied at once: a refused value is pasted again, never left on screen.
  input.value = ''
  save.disabled = true
  api.submit(value)
})

cancel.addEventListener('click', () => api.cancel())
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault()
    api.cancel()
  }
})

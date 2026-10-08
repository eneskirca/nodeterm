/** Explicit composer submission. Ordinary keys, terminal reports and wheels remain raw input. */
export type ComposedInput =
  | { kind: 'paste'; text: string; enter: boolean }
  | { kind: 'control'; text: string; enter: false }

export interface ComposedInputResult {
  status: 'delivered' | 'refused' | 'uncertain'
  message?: string
}

export const COMPOSED_INPUT_MAX_BYTES = 262_144
/** Give paste-aware composers time to settle before a separate Enter, matching the input bar. */
export const COMPOSED_ENTER_DELAY_MS = 150
export const COMPOSED_INPUT_UNCERTAIN = 'The text may already have reached the terminal. Inspect it before sending again.'
export const COMPOSED_INPUT_UNSUPPORTED = 'Composed Send is unavailable for this terminal. Update nodeterm on the computer or use its terminal.'

/** Validate untrusted RPC input before resolving or touching a terminal. */
export function parseComposedInput(value: unknown): ComposedInput | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.text !== 'string' || typeof v.enter !== 'boolean') return null
  if (v.kind === 'control') {
    // eslint-disable-next-line no-control-regex
    return v.enter === false && /^[\x00-\x1f\x7f]$/.test(v.text)
      ? { kind: 'control', text: v.text, enter: false } : null
  }
  return v.kind === 'paste' && !v.text.includes('\x00') && v.text.length <= COMPOSED_INPUT_MAX_BYTES &&
    new TextEncoder().encode(v.text).length <= COMPOSED_INPUT_MAX_BYTES
    ? { kind: 'paste', text: v.text, enter: v.enter } : null
}

/** xterm's paste line endings, with ESC/C1 removed so content cannot close the paste frame. */
export function normalizeComposedPaste(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x1b\u009b]/g, '').replace(/\r?\n/g, '\r')
}

import type { Terminal } from '@xterm/xterm'

/** xterm 5.5's input fallback can emit the same text as its deferred composition
 * finalizer when keyup precedes input. Let the composition helper be the sole
 * writer while it owns the textarea. Do NOT deduplicate strings: repeated input
 * is legitimate. Revalidate this private adapter against xterm when upgrading. */
export function installImeGuard(term: Terminal): void {
  type Core = {
    _inputEvent: (event: InputEvent) => boolean
    _compositionHelper?: { isComposing: boolean; _isSendingComposition: boolean }
  }
  const core = (term as unknown as { _core: Core })._core
  if (guarded.has(core)) return
  const input = core._inputEvent
  if (typeof input !== 'function') throw new Error('Unsupported xterm input API')
  core._inputEvent = function (event) {
    const helper = this._compositionHelper
    if (event.inputType === 'insertText' &&
        (helper?.isComposing || helper?._isSendingComposition)) return false
    return input.call(this, event)
  }
  guarded.add(core)
}

const guarded = new WeakSet<object>()

import type { Terminal } from '@xterm/xterm'

type CompositionHelper = {
  isComposing: boolean
  keydown(event: KeyboardEvent): boolean
}
const patched = new WeakSet<CompositionHelper>()

/** xterm 5.5 treats Caps Lock as a commit key and sends the composition immediately. A
 * following native compositionend sends the same text again. Let that event own the commit:
 * Caps Lock changes input mode, it is not terminal input. Enter and ordinary keys keep xterm's
 * existing finalize-before-key ordering. Install after open(), including in the board modal.
 * This is a version-bound adapter, like scale-fix; the test executes xterm's actual helper. */
export function patchImeModeSwitch(term: Terminal): void {
  const helper = (term as unknown as { _core?: { _compositionHelper?: CompositionHelper } })._core?._compositionHelper
  if (!helper || patched.has(helper)) return
  const keydown = helper.keydown.bind(helper)
  helper.keydown = (event) => {
    if (helper.isComposing && (event.key === 'CapsLock' || event.keyCode === 20)) return false
    return keydown(event)
  }
  patched.add(helper)
}

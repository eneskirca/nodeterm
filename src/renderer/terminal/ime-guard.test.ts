import { describe, expect, it, vi } from 'vitest'
import { installImeGuard } from './ime-guard'

describe('xterm composition input ownership', () => {
  it('blocks only the input fallback while composition owns the textarea', () => {
    const input = vi.fn((_event: InputEvent) => true)
    const helper = { isComposing: true, _isSendingComposition: false }
    const core = { _compositionHelper: helper, _inputEvent: input }
    const term = { _core: core }
    installImeGuard(term as never)
    installImeGuard(term as never) // parked terminal reattachment
    const text = { inputType: 'insertText', data: '你好' } as InputEvent
    expect(core._inputEvent(text)).toBe(false)
    helper.isComposing = false
    helper._isSendingComposition = true
    expect(core._inputEvent(text)).toBe(false)
    helper._isSendingComposition = false
    core._inputEvent(text)
    core._inputEvent(text) // intentional repeated text is never deduplicated
    expect(input).toHaveBeenCalledTimes(2)
    expect(input.mock.instances.every((self) => self === core)).toBe(true)
  })
})

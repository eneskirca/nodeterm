// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { chatEscInterrupts, chatInterruptRefusalText, type EscInterruptContext } from './chatEscInterrupt'

const ESC = { key: 'Escape', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, isComposing: false }
const WORKING: EscInterruptContext = { agentId: 'claude', state: 'working', draft: '', readOnly: false }

function composer(expanded = false): HTMLTextAreaElement {
  const ta = document.createElement('textarea')
  ta.className = 'term-chat__input term-chat__composer-input'
  if (expanded) ta.setAttribute('aria-expanded', 'true')
  return ta
}

describe('chatEscInterrupts', () => {
  it('interrupts a working claude from an empty composer', () => {
    const result = chatEscInterrupts(ESC, composer(), WORKING)

    expect(result).toBe(true)
  })

  it('interrupts from anywhere else in the panel that does not use Esc itself', () => {
    const result = chatEscInterrupts(ESC, document.createElement('div'), WORKING)

    expect(result).toBe(true)
  })

  it.each(['done', 'waiting', 'blocked', undefined])('does nothing while the state is %s', (state) => {
    const result = chatEscInterrupts(ESC, composer(), { ...WORKING, state })

    expect(result).toBe(false)
  })

  it('does nothing with a draft in the composer', () => {
    const result = chatEscInterrupts(ESC, composer(), { ...WORKING, draft: 'half a thought' })

    expect(result).toBe(false)
  })

  it('treats a whitespace-only draft as empty', () => {
    const result = chatEscInterrupts(ESC, composer(), { ...WORKING, draft: '  \n' })

    expect(result).toBe(true)
  })

  it('does nothing for an agent whose interrupt is not measured', () => {
    for (const agentId of ['codex', 'gemini', 'grok', 'custom:abc']) {
      expect(chatEscInterrupts(ESC, composer(), { ...WORKING, agentId })).toBe(false)
    }
  })

  it('does nothing in a read-only view', () => {
    const result = chatEscInterrupts(ESC, composer(), { ...WORKING, readOnly: true })

    expect(result).toBe(false)
  })

  it('leaves Esc to a control that uses it', () => {
    const other = document.createElement('input')
    const select = document.createElement('select')

    expect(chatEscInterrupts(ESC, other, WORKING)).toBe(false)
    expect(chatEscInterrupts(ESC, select, WORKING)).toBe(false)
    expect(chatEscInterrupts(ESC, composer(true), WORKING)).toBe(false)
  })

  it('ignores a modified Esc, an IME composition and other keys', () => {
    expect(chatEscInterrupts({ ...ESC, shiftKey: true }, composer(), WORKING)).toBe(false)
    expect(chatEscInterrupts({ ...ESC, metaKey: true }, composer(), WORKING)).toBe(false)
    expect(chatEscInterrupts({ ...ESC, isComposing: true }, composer(), WORKING)).toBe(false)
    expect(chatEscInterrupts({ ...ESC, key: 'Enter' }, composer(), WORKING)).toBe(false)
  })
})

describe('chatInterruptRefusalText', () => {
  it('points at the terminal when a dialog is up', () => {
    const text = chatInterruptRefusalText('dialog', 'Claude')

    expect(text).toMatch(/Claude is showing a prompt in the terminal/)
  })
})

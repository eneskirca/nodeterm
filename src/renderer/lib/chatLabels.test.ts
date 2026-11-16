import { describe, expect, it } from 'vitest'
import { newMessagesLabel } from './chatLabels'

describe('newMessagesLabel', () => {
  it('the pill label', () => {
    expect(newMessagesLabel(1)).toBe('1 new message')
    expect(newMessagesLabel(4)).toBe('4 new messages')
    expect(newMessagesLabel(140)).toBe('99+ new messages')
  })
})

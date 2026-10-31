import { describe, expect, it } from 'vitest'
import {
  CHAT_FOLLOW_THRESHOLD_PX,
  chatAgentLabel,
  chatKeyAction,
  isNearBottom,
  shouldFollowOnLoad,
  toolCardTitle,
  unseenAfter
} from './chatPanel'
import type { ChatMessage } from '@shared/types'

describe('chatKeyAction', () => {
  it('Enter sends', () => {
    expect(chatKeyAction({ key: 'Enter', shiftKey: false, isComposing: false })).toBe('send')
  })
  it('Shift+Enter inserts a newline (the textarea default), never sends', () => {
    expect(chatKeyAction({ key: 'Enter', shiftKey: true, isComposing: false })).toBe('newline')
  })
  it('an Enter that commits an IME composition is not a send', () => {
    expect(chatKeyAction({ key: 'Enter', shiftKey: false, isComposing: true })).toBe('none')
    expect(chatKeyAction({ key: 'Enter', shiftKey: true, isComposing: true })).toBe('none')
  })
  it('any other key is left alone', () => {
    expect(chatKeyAction({ key: 'a', shiftKey: false, isComposing: false })).toBe('none')
  })
})

describe('isNearBottom', () => {
  it('is true at the bottom and within the threshold', () => {
    expect(isNearBottom({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 })).toBe(true)
    expect(
      isNearBottom({ scrollTop: 600 - CHAT_FOLLOW_THRESHOLD_PX, scrollHeight: 1000, clientHeight: 400 })
    ).toBe(true)
  })
  it('is false once the user scrolled further up than the threshold', () => {
    expect(
      isNearBottom({ scrollTop: 600 - CHAT_FOLLOW_THRESHOLD_PX - 1, scrollHeight: 1000, clientHeight: 400 })
    ).toBe(false)
  })
  it('content shorter than the viewport counts as at the bottom', () => {
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 200, clientHeight: 400 })).toBe(true)
  })
})

describe('shouldFollowOnLoad', () => {
  it('follows when the user was at the bottom or just sent', () => {
    expect(shouldFollowOnLoad({ wasNearBottom: true, justSent: false })).toBe(true)
    expect(shouldFollowOnLoad({ wasNearBottom: false, justSent: true })).toBe(true)
  })
  it('keeps the position of a user reading history', () => {
    expect(shouldFollowOnLoad({ wasNearBottom: false, justSent: false })).toBe(false)
  })
})

describe('chatAgentLabel', () => {
  it('uses the builtin label', () => {
    expect(chatAgentLabel('claude', [])).toBe('Claude Code')
    expect(chatAgentLabel('grok', [])).toBe('Grok')
  })
  it('uses a custom agent label', () => {
    expect(chatAgentLabel('custom:1', [{ id: 'custom:1', label: 'My Proxy' }])).toBe('My Proxy')
  })
  it('falls back to a neutral word, never to Claude', () => {
    expect(chatAgentLabel('custom:gone', [])).toBe('Agent')
    expect(chatAgentLabel('custom:blank', [{ id: 'custom:blank', label: '  ' }])).toBe('Agent')
  })
})

describe('toolCardTitle', () => {
  it('names a plan and a question for what they are, anything else by its tool name', () => {
    expect(toolCardTitle('ExitPlanMode')).toBe('Plan')
    expect(toolCardTitle('AskUserQuestion')).toBe('Question')
    expect(toolCardTitle('SomeFutureTool')).toBe('SomeFutureTool')
  })
})

describe('unseenAfter', () => {
  const msg = (key?: number): ChatMessage => ({ role: 'assistant', key, parts: [{ kind: 'text', text: String(key) }] })

  it('counts the messages after the last one seen, found by key', () => {
    const seen = msg(20)
    const thread = [msg(10), msg(20), msg(30), msg(40)]

    const unseen = unseenAfter(thread, seen)

    expect(unseen).toBe(2)
  })

  it('finds an unkeyed message by identity', () => {
    const seen = msg()
    const thread = [msg(), seen, msg()]

    const unseen = unseenAfter(thread, seen)

    expect(unseen).toBe(1)
  })

  it('counts nothing when no message was seen or the thread was replaced', () => {
    const thread = [msg(10), msg(20)]

    const none = unseenAfter(thread, null)
    const gone = unseenAfter(thread, msg(99))

    expect(none).toBe(0)
    expect(gone).toBe(0)
  })
})

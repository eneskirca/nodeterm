import { describe, expect, it } from 'vitest'
import {
  CHAT_PAGE_DEFAULT_BYTES,
  CHAT_PAGE_MAX_BYTES,
  CHAT_PAGE_MIN_BYTES,
  normalizeChatPage
} from './chat-page'

describe('normalizeChatPage — the page arg arrives over IPC/WS and is untrusted', () => {
  it('absent (undefined / null) means the legacy, unpaged read', () => {
    expect(normalizeChatPage(undefined)).toBeNull()
    expect(normalizeChatPage(null)).toBeNull()
  })

  it('an empty page is the newest window at the default size', () => {
    expect(normalizeChatPage({})).toEqual({ before: null, maxBytes: CHAT_PAGE_DEFAULT_BYTES })
  })

  it('keeps `thinking` only as a literal true', () => {
    expect(normalizeChatPage({ thinking: true })).toEqual({ before: null, maxBytes: CHAT_PAGE_DEFAULT_BYTES, thinking: true })
    for (const thinking of [false, 'true', 1, {}]) {
      expect(normalizeChatPage({ thinking })).not.toHaveProperty('thinking')
    }
  })

  it('clamps maxBytes into [MIN, MAX] and floors fractions', () => {
    expect(normalizeChatPage({ maxBytes: 1 })!.maxBytes).toBe(CHAT_PAGE_MIN_BYTES)
    expect(normalizeChatPage({ maxBytes: 1e12 })!.maxBytes).toBe(CHAT_PAGE_MAX_BYTES)
    expect(normalizeChatPage({ maxBytes: CHAT_PAGE_MIN_BYTES + 0.5 })!.maxBytes).toBe(
      CHAT_PAGE_MIN_BYTES
    )
    expect(CHAT_PAGE_MAX_BYTES).toBe(5 * 1024 * 1024)
  })

  it.each([NaN, Infinity, -Infinity, '100000', {}, true])(
    'a non-numeric / non-finite maxBytes (%s) takes the default',
    (maxBytes) => {
      expect(normalizeChatPage({ maxBytes })!.maxBytes).toBe(CHAT_PAGE_DEFAULT_BYTES)
    }
  )

  it('accepts a non-negative safe integer `before`, including 0', () => {
    expect(normalizeChatPage({ before: 0 })!.before).toBe(0)
    expect(normalizeChatPage({ before: 123456 })!.before).toBe(123456)
  })

  it.each([-1, 1.5, NaN, Infinity, 2 ** 53, '10', '1; rm -rf ~'])(
    'refuses an invalid `before` (%s) instead of guessing a window',
    (before) => {
      expect(() => normalizeChatPage({ before })).toThrow(/Invalid transcript page/)
    }
  )

  it('refuses a page that is not an object', () => {
    expect(() => normalizeChatPage(42)).toThrow(/Invalid transcript page/)
    expect(() => normalizeChatPage('x')).toThrow(/Invalid transcript page/)
  })
})

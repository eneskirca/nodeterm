import { describe, it, expect, vi } from 'vitest'
import {
  browserCookies,
  COOKIES_NOT_RECORDED,
  COOKIES_NO_CURRENT_DOMAIN
} from './browser-cookies'
import type { Sendable } from './browser-actions'

/** A session that records every method sent, answers getCookies with `count` cookies, and reports a
 *  current URL for `--cookies current`. */
function fakeSession(opts: { count?: number; currentUrl?: string } = {}): { s: Sendable; sent: string[] } {
  const sent: string[] = []
  const s: Sendable = {
    async send(method) {
      sent.push(method)
      if (method === 'Network.getCookies') {
        return { cookies: Array.from({ length: opts.count ?? 0 }, (_, i) => ({ name: `c${i}` })) }
      }
      if (method === 'Page.getNavigationHistory') {
        return { currentIndex: 0, entries: [{ url: opts.currentUrl ?? 'https://x.test/' }] }
      }
      return {}
    }
  }
  return { s, sent }
}

describe('browserCookies — allowed, but LOUDLY traced (Task 9.3)', () => {
  it('the trace is appended BEFORE the read; if the append fails, the read does not happen', async () => {
    // Fail-closed, deliberately. A cookie read that happened but was not recorded is the one outcome
    // this section exists to prevent.
    const { s, sent } = fakeSession({ count: 4 })
    const recordTrace = vi.fn(async () => false) // no reachable log / write failed
    const r = await browserCookies(s, 'browser-3', 'github.com', { recordTrace })
    expect(r).toEqual({ ok: false, message: COOKIES_NOT_RECORDED })
    expect(recordTrace).toHaveBeenCalledWith('github.com')
    expect(sent).not.toContain('Network.getCookies') // the read NEVER happened
  })

  it('the trace runs strictly before the read (ordering, not just presence)', async () => {
    const order: string[] = []
    const { s } = ((): { s: Sendable } => {
      const sess: Sendable = {
        async send(method) {
          order.push(`send:${method}`)
          if (method === 'Network.getCookies') return { cookies: [] }
          return {}
        }
      }
      return { s: sess }
    })()
    const recordTrace = vi.fn(async () => {
      order.push('trace')
      return true
    })
    await browserCookies(s, 'browser-3', 'github.com', { recordTrace })
    expect(order).toEqual(['trace', 'send:Network.getCookies'])
  })

  it('the reply tells the agent it was recorded', async () => {
    const { s } = fakeSession({ count: 4 })
    const r = await browserCookies(s, 'browser-3', 'github.com', { recordTrace: async () => true })
    // An agent that knows it is being watched behaves better, and an agent that prints that line into
    // its transcript has told the user too.
    expect(r.message).toBe("read 4 cookies for github.com — this was recorded in the project's activity log.")
  })

  it('getAllCookies is unreachable — the read NAMES a domain (a SHAPE restriction, not a ban)', async () => {
    // One call that empties the jar for every site the profile has ever touched would name no domain,
    // so no useful trace line exists for it. This path only ever issues getCookies with an explicit,
    // single-domain url list.
    const { sent } = fakeSession({ count: 2 })
    const getCookiesParams: unknown[] = []
    const spy: Sendable = {
      async send(method, params) {
        sent.push(method)
        if (method === 'Network.getCookies') {
          getCookiesParams.push(params)
          return { cookies: [{}, {}] }
        }
        return {}
      }
    }
    await browserCookies(spy, 'browser-3', 'github.com', { recordTrace: async () => true })
    expect(sent).toContain('Network.getCookies')
    expect(sent).not.toContain('Network.getAllCookies')
    expect(getCookiesParams[0]).toEqual({ urls: ['https://github.com/', 'http://github.com/'] })
  })

  it('"current" reads the page\'s own domain', async () => {
    const { s } = fakeSession({ count: 1, currentUrl: 'https://mail.google.com/inbox' })
    const r = await browserCookies(s, 'browser-3', 'current', { recordTrace: async () => true })
    expect(r.message).toBe("read 1 cookie for mail.google.com — this was recorded in the project's activity log.")
  })

  it('"current" on a page with no http(s) origin is a named refusal, and never traces or reads', async () => {
    const { s, sent } = fakeSession({ currentUrl: 'about:blank' })
    const recordTrace = vi.fn(async () => true)
    const r = await browserCookies(s, 'browser-3', 'current', { recordTrace })
    expect(r).toEqual({ ok: false, message: COOKIES_NO_CURRENT_DOMAIN })
    expect(recordTrace).not.toHaveBeenCalled()
    expect(sent).not.toContain('Network.getCookies')
  })

  it('a non-host domain (a URL, a smuggled newline) is refused before any trace or read', async () => {
    const { s, sent } = fakeSession()
    const recordTrace = vi.fn(async () => true)
    const r = await browserCookies(s, 'browser-3', 'https://evil.test/@github.com', { recordTrace })
    expect(r.ok).toBe(false)
    expect(recordTrace).not.toHaveBeenCalled()
    expect(sent).not.toContain('Network.getCookies')

    const nl = await browserCookies(s, 'browser-3', 'github.com\nplanted', { recordTrace })
    expect(nl.ok).toBe(false)
  })
})

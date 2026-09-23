import { describe, it, expect } from 'vitest'
import {
  parseBrowserArgs,
  BROWSER_KEYS,
  BROWSER_READ_MODES,
  BROWSER_TIMEOUT_DEFAULT_MS,
  BROWSER_TIMEOUT_MAX_MS
} from './browser-verb'

describe('parseBrowserArgs — the whole flag table (design §2.2)', () => {
  // ── one case per action row ─────────────────────────────────────────────────────────────────
  it('--nav takes an http(s) URL and refuses non-http schemes', () => {
    expect(parseBrowserArgs({ node: 'b1', nav: 'https://x.test/' })).toMatchObject({
      action: { kind: 'nav', url: 'https://x.test/' }
    })
    expect(parseBrowserArgs({ node: 'b1', nav: 'javascript:alert(1)' })).toHaveProperty('error')
    expect(parseBrowserArgs({ node: 'b1', nav: 'file:///etc/passwd' })).toHaveProperty('error')
    expect(parseBrowserArgs({ node: 'b1', nav: 'data:text/html,x' })).toHaveProperty('error')
  })

  it('--read takes each of text|map|links|title', () => {
    for (const mode of BROWSER_READ_MODES) {
      expect(parseBrowserArgs({ node: 'b1', read: mode })).toMatchObject({
        action: { kind: 'read', mode }
      })
    }
  })

  it('--click / --wait take a ref or selector', () => {
    expect(parseBrowserArgs({ node: 'b1', click: '@7' })).toMatchObject({ action: { kind: 'click', target: '@7' } })
    expect(parseBrowserArgs({ node: 'b1', wait: '#results' })).toMatchObject({ action: { kind: 'wait', target: '#results' } })
    expect(parseBrowserArgs({ node: 'b1', click: '' })).toHaveProperty('error')
  })

  it('--type carries its text; --press carries a named key', () => {
    expect(parseBrowserArgs({ node: 'b1', type: 'hello' })).toMatchObject({ action: { kind: 'type', text: 'hello' } })
    expect(parseBrowserArgs({ node: 'b1', press: 'Enter' })).toMatchObject({ action: { kind: 'press', key: 'Enter' } })
  })

  it('--scroll takes a word or a signed pixel count, and refuses anything else', () => {
    for (const w of ['up', 'down', 'top', 'bottom']) {
      expect(parseBrowserArgs({ node: 'b1', scroll: w })).toMatchObject({ action: { kind: 'scroll', where: w } })
    }
    expect(parseBrowserArgs({ node: 'b1', scroll: '-600' })).toMatchObject({ action: { kind: 'scroll', where: '-600' } })
    expect(parseBrowserArgs({ node: 'b1', scroll: 'sideways' })).toHaveProperty('error')
  })

  it('--screenshot takes a path; --cookies takes a domain', () => {
    expect(parseBrowserArgs({ node: 'b1', screenshot: 'shot.png' })).toMatchObject({ action: { kind: 'screenshot', path: 'shot.png' } })
    expect(parseBrowserArgs({ node: 'b1', cookies: 'github.com' })).toMatchObject({ action: { kind: 'cookies', domain: 'github.com' } })
    expect(parseBrowserArgs({ node: 'b1', cookies: '' })).toEqual({
      error: 'browser: --cookies takes one domain (use "current" for the page\'s own)'
    })
  })

  // ── the plan's explicit cases ───────────────────────────────────────────────────────────────
  it('refuses ZERO actions and refuses TWO — an ambiguous call must never guess', () => {
    expect(parseBrowserArgs({ node: 'b1' })).toEqual({ error: expect.stringContaining('one action') })
    expect(parseBrowserArgs({ node: 'b1', nav: 'https://x.test/', read: 'text' })).toEqual({
      error: expect.stringContaining('one action')
    })
  })

  it('--node is always required and never inferred', () => {
    expect(parseBrowserArgs({ nav: 'https://x.test/' })).toEqual({ error: expect.stringContaining('--node') })
  })

  it('every flag takes a value — there are no booleans and no bare switches', () => {
    expect(parseBrowserArgs({ node: 'b1', type: 'x', clear: 'true' })).toMatchObject({ clear: true })
    expect(parseBrowserArgs({ node: 'b1', type: 'x', clear: '' })).toMatchObject({ clear: false })
    expect(parseBrowserArgs({ node: 'b1', read: 'text', full: 'true' })).toMatchObject({ full: true })
    expect(parseBrowserArgs({ node: 'b1', read: 'text', full: '' })).toMatchObject({ full: false })
  })

  it('--timeout defaults to 15000 and is clamped to 60000', () => {
    expect(parseBrowserArgs({ node: 'b1', nav: 'https://x.test/' })).toMatchObject({ timeoutMs: BROWSER_TIMEOUT_DEFAULT_MS })
    expect(parseBrowserArgs({ node: 'b1', nav: 'https://x.test/', timeout: '999999' })).toMatchObject({
      timeoutMs: BROWSER_TIMEOUT_MAX_MS
    })
    // A zero/garbage timeout falls back to the default rather than hanging the route with 0.
    expect(parseBrowserArgs({ node: 'b1', nav: 'https://x.test/', timeout: '0' })).toMatchObject({ timeoutMs: 15_000 })
    expect(parseBrowserArgs({ node: 'b1', nav: 'https://x.test/', timeout: 'abc' })).toMatchObject({ timeoutMs: 15_000 })
    expect(parseBrowserArgs({ node: 'b1', nav: 'https://x.test/', timeout: '3000' })).toMatchObject({ timeoutMs: 3000 })
  })

  it('--read takes exactly title|map|links|text', () => {
    expect(parseBrowserArgs({ node: 'b1', read: 'html' })).toEqual({
      error: 'browser: --read takes text|map|links|title'
    })
  })

  it('--press takes only the named keys', () => {
    for (const k of BROWSER_KEYS) expect(parseBrowserArgs({ node: 'b1', press: k })).not.toHaveProperty('error')
    expect(parseBrowserArgs({ node: 'b1', press: 'F5' })).toHaveProperty('error')
    expect(parseBrowserArgs({ node: 'b1', press: 'a' })).toHaveProperty('error')
  })

  it('--node must satisfy isSafeNodeId BEFORE it indexes anything', () => {
    // Salvaged from S8's requiredTabId/requiredString: validate before a map lookup.
    expect(parseBrowserArgs({ node: '../x', read: 'title' })).toHaveProperty('error')
    expect(parseBrowserArgs({ node: 'a/b', read: 'title' })).toHaveProperty('error')
    // …and node safety is decided BEFORE the action count, so a bad node with a valid action still
    // reports the node.
    expect(parseBrowserArgs({ node: '../x', read: 'title' })).toEqual({
      error: expect.stringContaining('--node')
    })
  })

  it('carries the modifier flags through onto the call', () => {
    const call = parseBrowserArgs({ node: 'b1', type: 'hi', into: '@3', clear: 'true' })
    expect(call).toMatchObject({ into: '@3', clear: true, action: { kind: 'type', text: 'hi' } })
    const read = parseBrowserArgs({ node: 'b1', read: 'text', selector: 'main', max: '5000' })
    expect(read).toMatchObject({ selector: 'main', max: 5000 })
    const press = parseBrowserArgs({ node: 'b1', press: 'ArrowDown', times: '4' })
    expect(press).toMatchObject({ times: 4 })
  })
})

describe('issue 539 browser flags', () => {
  it.each(['+200', '-200', '200', '+0'])('accepts signed pixel count %s', (scroll) => {
    expect(parseBrowserArgs({ node: 'b1', scroll })).toMatchObject({ action: { kind: 'scroll', where: scroll } })
  })
  it.each(['width', 'height', 'viewport', 'size', 'preset', 'resize', 'ful'])('refuses unknown --%s', (key) => {
    expect(parseBrowserArgs({ node: 'b1', read: 'text', [key]: '123' })).toEqual({ error: `browser: unknown flag --${key}` })
  })
})

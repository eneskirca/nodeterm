import { describe, it, expect, vi } from 'vitest'
import { createOsc52Notice, handleOsc52Write, osc52BlockedMessage, osc52Decision, OSC52_NOTICE_INTERVAL_MS } from './osc52-policy'

function deps() {
  return { write: vi.fn(), notifyCopied: vi.fn(), shouldNotify: vi.fn(() => true), toast: vi.fn() }
}

describe('OSC 52 policy', () => {
  it('a LOCAL session (incl. SSH projects and the Server Edition) writes exactly as before', () => {
    const d = deps()
    expect(osc52Decision('local')).toBe('write')
    expect(handleOsc52Write('hi', 'local', d)).toBe(true)
    expect(d.write).toHaveBeenCalledWith('hi')
    expect(d.notifyCopied).toHaveBeenCalledWith('hi')
    expect(d.toast).not.toHaveBeenCalled()
  })
  it('a RELAY session never writes the clipboard, and says so', () => {
    const d = deps()
    expect(osc52Decision('relay')).toBe('block')
    expect(handleOsc52Write('rm -rf ~\n', 'relay', d)).toBe(false)
    expect(d.write).not.toHaveBeenCalled()
    expect(d.notifyCopied).not.toHaveBeenCalled()
    expect(d.toast).toHaveBeenCalledWith(osc52BlockedMessage())
  })
  it('the notice is throttled per terminal', () => {
    let t = 0
    const n = createOsc52Notice(() => t)
    expect(n()).toBe(true)
    t = OSC52_NOTICE_INTERVAL_MS - 1
    expect(n()).toBe(false)
    t = OSC52_NOTICE_INTERVAL_MS
    expect(n()).toBe(true)
  })
  it('names the platform escape', () => {
    expect(osc52BlockedMessage(true)).toContain('⌥')
    expect(osc52BlockedMessage(false)).toContain('Ctrl+Shift+C')
  })
})

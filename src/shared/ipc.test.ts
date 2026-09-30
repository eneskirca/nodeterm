import { describe, it, expect } from 'vitest'
import { IPC } from './ipc'

/** Resolve every IPC entry to its concrete channel string(s): plain strings pass through, and the
 *  per-id factory functions (e.g. `ptyData(sessionId)`) are invoked with a sample id. */
function allChannels(): string[] {
  const out: string[] = []
  for (const value of Object.values(IPC)) {
    if (typeof value === 'string') out.push(value)
    else if (typeof value === 'function') out.push((value as (...a: string[]) => string)('sample', 'sample'))
  }
  return out
}

describe('IPC channels', () => {
  it('every channel string is unique', () => {
    const channels = allChannels()
    expect(new Set(channels).size).toBe(channels.length)
  })

  it('exposes the new relay tunnel host channels (distinct from the legacy remote* dialect)', () => {
    expect(IPC.relayHostStart).toBe('relay:host:start')
    expect(IPC.relayHostStop).toBe('relay:host:stop')
    expect(IPC.relayHostPeerPending).toBe('relay:host:peer-pending')
    expect(IPC.relayHostConfirm).toBe('relay:host:confirm')
    expect(IPC.relayHostOpen).toBe('relay:host:open')
    expect(IPC.relayHostClosed).toBe('relay:host:closed')
    // The new tunnel MUST NOT reuse the legacy `remote:*` namespace (both coexist until Task 10).
    for (const ch of [
      IPC.relayHostStart,
      IPC.relayHostStop,
      IPC.relayHostPeerPending,
      IPC.relayHostConfirm,
      IPC.relayHostOpen,
      IPC.relayHostClosed
    ]) {
      expect(ch.startsWith('relay:')).toBe(true)
    }
  })

  it('exposes the new relay tunnel client channels, with per-id factories', () => {
    expect(IPC.relayClientConnect).toBe('relay:client:connect')
    expect(IPC.relayClientConfirm).toBe('relay:client:confirm')
    expect(IPC.relayClientSend).toBe('relay:client:send')
    expect(IPC.relayClientDisconnect).toBe('relay:client:disconnect')
    expect(IPC.relayClientSas('abc')).toBe('relay:client:sas:abc')
    expect(IPC.relayClientApproved('abc')).toBe('relay:client:approved:abc')
    expect(IPC.relayClientFrame('abc')).toBe('relay:client:frame:abc')
    expect(IPC.relayClientClosed('abc')).toBe('relay:client:closed:abc')
  })

  it('exposes the desktop-local hosted-team bookmark channels', () => {
    expect(IPC.relayHostedBookmarks).toBe('relay:hosted:bookmarks')
    expect(IPC.relayHostedBookmarkRemove).toBe('relay:hosted:bookmark-remove')
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { useTerminalFocus } from './terminalFocus'

afterEach(() => useTerminalFocus.setState({ nodeId: null, nonce: 0, ack: true, lastNodeId: null }))

describe('useTerminalFocus', () => {
  it('records the requested node and bumps the nonce each time', () => {
    useTerminalFocus.getState().request('node-a')
    expect(useTerminalFocus.getState().nodeId).toBe('node-a')
    const n1 = useTerminalFocus.getState().nonce

    // Re-requesting the SAME node still bumps the nonce — that is what a subscriber effect watches,
    // so a second sidebar click on an already-selected session re-focuses it.
    useTerminalFocus.getState().request('node-a')
    expect(useTerminalFocus.getState().nodeId).toBe('node-a')
    expect(useTerminalFocus.getState().nonce).toBeGreaterThan(n1)
  })

  it('is one-shot by convention: the consumer clears nodeId so a remount cannot re-grab focus', () => {
    useTerminalFocus.getState().request('node-b')
    expect(useTerminalFocus.getState().nodeId).toBe('node-b')

    // The target terminal clears the request after taking focus.
    useTerminalFocus.setState({ nodeId: null })
    expect(useTerminalFocus.getState().nodeId).toBeNull()
    // The nonce is untouched, so no node's `s.nodeId === id ? s.nonce : 0` selector fires again.
  })

  it('remembers the last focused terminal and keeps it across a one-shot request', () => {
    useTerminalFocus.getState().remember('node-a')
    expect(useTerminalFocus.getState().lastNodeId).toBe('node-a')
    useTerminalFocus.getState().request('node-a')
    useTerminalFocus.setState({ nodeId: null })
    // The consume clears the REQUEST, never the memory the window-activation restore reads.
    expect(useTerminalFocus.getState().lastNodeId).toBe('node-a')
  })

  it('acks by default and only skips the ack when the caller asks', () => {
    useTerminalFocus.getState().request('node-a')
    expect(useTerminalFocus.getState().ack).toBe(true)
    useTerminalFocus.getState().request('node-a', { ack: false })
    expect(useTerminalFocus.getState().ack).toBe(false)
    // A later request that says nothing acks again, so one silent restore cannot mute the next
    // deliberate jump to the same node.
    useTerminalFocus.getState().request('node-a')
    expect(useTerminalFocus.getState().ack).toBe(true)
  })
})

import { describe, it, expect } from 'vitest'
import {
  DEV_PORTS_MIN_GAP_MS,
  devPortsSig,
  parseDevPortsSig,
  pollIntervalMs,
  portRowLabel,
  portsChipLabel,
  shouldScan
} from './devPorts'

const p = (port: number, ephemeral = false, command = 'node') => ({ port, addresses: ['127.0.0.1'], command, ephemeral })

describe('cadence', () => {
  it('an explicit refresh always runs; automatic scans keep their distance', () => {
    expect(shouldScan('user', 1000, 999)).toBe(true)
    expect(shouldScan('poll', 1000, undefined)).toBe(true)
    expect(shouldScan('hook', 1000 + DEV_PORTS_MIN_GAP_MS - 1, 1000)).toBe(false)
    expect(shouldScan('focus', 1000 + DEV_PORTS_MIN_GAP_MS, 1000)).toBe(true)
  })
  it('an SSH host is polled more slowly than this machine', () => {
    expect(pollIntervalMs(true)).toBeGreaterThan(pollIntervalMs(false))
  })
})

describe('chip + rows', () => {
  it('counts only non-ephemeral ports', () => {
    expect(portsChipLabel([])).toBeNull()
    expect(portsChipLabel([p(41000, true)])).toBeNull()
    expect(portsChipLabel([p(5173), p(41000, true)])).toBe(':5173')
    expect(portsChipLabel([p(3000), p(5173)])).toBe('2 ports')
  })
  it('the signature round-trips and carries the forward', () => {
    const sig = devPortsSig([p(5173), p(41000, true, 'we|ird:cmd')], [{ nodeId: 'n', remotePort: 5173, localPort: 5174 }])
    expect(parseDevPortsSig(sig)).toEqual([
      { port: 5173, ephemeral: false, command: 'node', forwardedTo: 5174 },
      { port: 41000, ephemeral: true, command: 'we|ird:cmd' }
    ])
    expect(devPortsSig(undefined, undefined)).toBe('')
  })
  it('names a re-mapped forward, and only then', () => {
    expect(portRowLabel({ port: 5173, ephemeral: false, command: 'node' })).toBe(':5173 · node')
    expect(portRowLabel({ port: 5173, ephemeral: false, command: 'node', forwardedTo: 5173 })).toBe(':5173 · node')
    expect(portRowLabel({ port: 5173, ephemeral: false, command: '', forwardedTo: 5174 })).toBe(':5173 → localhost:5174')
  })
})

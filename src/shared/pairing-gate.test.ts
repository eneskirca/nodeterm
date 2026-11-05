import { describe, it, expect } from 'vitest'
import {
  pairingEndedMessage,
  pairingGate,
  pairingNetworkHint,
  relayGateMessage,
  relayOnlyExplanation
} from './pairing-gate'

describe('pairingGate', () => {
  it('gates an SSH host on sshd alone — the relay plan does not matter there', () => {
    for (const relayPlan of ['ok', 'dev', 'off', null] as const) {
      expect(pairingGate({ sshKey: true, sshOpen: true, relayPlan })).toBe('qr')
      expect(pairingGate({ sshKey: true, sshOpen: false, relayPlan })).toBe('ssh-off')
    }
  })

  it('gates a relay-only (Windows) host on the relay alone — sshd does not matter there', () => {
    for (const sshOpen of [true, false]) {
      expect(pairingGate({ sshKey: false, sshOpen, relayPlan: 'ok' })).toBe('qr')
      expect(pairingGate({ sshKey: false, sshOpen, relayPlan: 'off' })).toBe('relay-off')
      expect(pairingGate({ sshKey: false, sshOpen, relayPlan: null })).toBe('relay-off')
      expect(pairingGate({ sshKey: false, sshOpen, relayPlan: 'dev' })).toBe('relay-dev')
    }
  })
})

describe('copy', () => {
  it('names the toggle of the surface it is shown on', () => {
    expect(relayGateMessage('relay-off', 'Reach this PC from anywhere')).toContain('“Reach this PC from anywhere”')
  })

  it('explains the administrators key file only when detected', () => {
    expect(relayOnlyExplanation('administrators')).toContain('administrators_authorized_keys')
    expect(relayOnlyExplanation('profile')).not.toContain('administrators_authorized_keys')
    expect(relayOnlyExplanation(undefined)).not.toContain('administrators_authorized_keys')
  })

  it('says pairing needs the same network, and promises "anywhere" only with the relay on', () => {
    expect(pairingNetworkHint(true)).toMatch(/same Wi-Fi network/)
    expect(pairingNetworkHint(true)).toMatch(/connects from anywhere/)
    expect(pairingNetworkHint(false)).toMatch(/same Wi-Fi network/)
    expect(pairingNetworkHint(false)).not.toMatch(/anywhere/)
  })

  it('asks about the network before it blames the firewall', () => {
    const text = pairingEndedMessage({ reason: 'timeout', reached: false, windows: true })
    expect(text.indexOf('same Wi-Fi network')).toBeGreaterThan(-1)
    expect(text.indexOf('same Wi-Fi network')).toBeLessThan(text.indexOf('Firewall'))
  })

  it('blames the firewall only for a Windows timeout that nothing reached', () => {
    expect(pairingEndedMessage({ reason: 'timeout', reached: false, windows: true })).toMatch(/Firewall/)
    expect(pairingEndedMessage({ reason: 'timeout', reached: true, windows: true })).not.toMatch(/Firewall/)
    expect(pairingEndedMessage({ reason: 'timeout', reached: false, windows: false })).not.toMatch(/Firewall/)
    expect(pairingEndedMessage({ reason: 'relay-failed', reached: true, windows: true })).toMatch(/nothing was paired/)
  })
})

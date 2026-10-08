import { describe, expect, it } from 'vitest'
import { pairingNetworkChoices, pairingNetworkIPv4, type PairingInterfaces } from './pairing-network'

const interfaces: PairingInterfaces = {
  lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
  wg0: [{ address: '10.7.0.2', family: 'IPv4', internal: false }],
  wlan0: [{ address: '192.168.1.42', family: 'IPv4', internal: false }],
}

describe('phone pairing network choice', () => {
  it('does not let an earlier container or VPN adapter hide the physical LAN', () => {
    expect(pairingNetworkIPv4(interfaces)).toBe('192.168.1.42')
  })
  it('allows an explicit VPN choice, ahead of a default-route hint', () => {
    expect(pairingNetworkIPv4(interfaces, 'wg0', '192.168.1.42')).toBe('10.7.0.2')
  })
  it('keeps the selected adapter after its DHCP address changes', () => {
    const moved = { ...interfaces, wlan0: [{ address: '192.168.1.77', family: 4, internal: false }] }
    expect(pairingNetworkIPv4(moved, 'wlan0')).toBe('192.168.1.77')
  })
  it('does not silently switch after a selected adapter disappears', () => {
    expect(pairingNetworkIPv4({ docker0: interfaces.docker0 }, 'wlan0')).toBeNull()
  })
  it('keeps a virtual-only machine usable and lists its current choices', () => {
    const only = { wg0: interfaces.wg0, absent: undefined }
    expect(pairingNetworkIPv4(only)).toBe('10.7.0.2')
    expect(pairingNetworkChoices(only)).toEqual([{ interfaceName: 'wg0', address: '10.7.0.2' }])
  })
  it('admits a route hint only when it names a current address, including a secondary address', () => {
    const multi = { ...interfaces, wlan0: [...interfaces.wlan0!, { address: '192.168.1.99', family: 4, internal: false }] }
    expect(pairingNetworkIPv4(multi, '', '192.168.1.99')).toBe('192.168.1.99')
    expect(pairingNetworkIPv4(multi, '', '203.0.113.8')).toBe('192.168.1.42')
  })
  it.each(['br-1234', 'veth1234', 'virbr0', 'utun3', 'tun0', 'tap0', 'Tailscale', 'vEthernet (WSL)', 'ppp0'])('prefers LAN ahead of automatic %s', (name) => {
    expect(pairingNetworkIPv4({ [name]: interfaces.wg0, en0: interfaces.wlan0 })).toBe('192.168.1.42')
  })
  it.each(['0.0.0.0', '127.0.0.2', '169.254.1.8', '224.0.0.1', '255.255.255.255', '10.0.0.999', '010.0.0.1', 'host.example', '10.0.0.1\n'])('never advertises invalid or excluded address %s', (address) => {
    const bad = { selected: [{ address, family: 'IPv4', internal: false }], ...interfaces }
    expect(pairingNetworkIPv4(bad, 'selected')).toBeNull()
    expect(pairingNetworkChoices(bad).some((choice) => choice.interfaceName === 'selected')).toBe(false)
  })
  it('requires IPv4 and non-internal metadata and does not guess malformed settings', () => {
    const bad = { selected: [{ address: '10.0.0.8', family: 'IPv6', internal: false }] }
    expect(pairingNetworkIPv4(bad, 'selected')).toBeNull()
    expect(pairingNetworkIPv4(interfaces, 42)).toBeNull()
    expect(pairingNetworkIPv4(interfaces, 'missing')).toBeNull()
  })
})

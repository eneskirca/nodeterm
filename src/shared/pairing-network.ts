/** Addresses reported by the computer's own OS, never by a phone or an SSH viewer. */
export interface PairingNetworkAddress {
  address: string
  family: string | number
  internal: boolean
}

export type PairingInterfaces = Record<string, PairingNetworkAddress[] | undefined>

export interface PairingNetworkChoice {
  interfaceName: string
  address: string
}

// Prefer a physical LAN adapter for automatic pairing. A VPN can be selected explicitly;
// virtual-only machines keep a fallback rather than pretending they have no network.
const VIRTUAL_INTERFACE = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Loopback|Tailscale|ZeroTier|Npcap|TAP-|Docker|^(?:br-|veth|virbr|tun\d|tap\d|utun\d|wg\d|zt\w|ppp\d)/i

function unicastIPv4(address: unknown): address is string {
  if (typeof address !== 'string' || !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(address)) return false
  const octets = address.split('.').map(Number)
  return octets.every((n) => n <= 255) && octets[0] > 0 && octets[0] < 224 &&
    octets[0] !== 127 && !(octets[0] === 169 && octets[1] === 254)
}

/** One current IPv4 per adapter. This lists addresses, not proof that a phone can reach them. */
export function pairingNetworkChoices(interfaces: PairingInterfaces): PairingNetworkChoice[] {
  const choices: PairingNetworkChoice[] = []
  for (const [interfaceName, addresses] of Object.entries(interfaces)) {
    if (!interfaceName || !Array.isArray(addresses)) continue
    const current = addresses.find((entry) => entry && !entry.internal &&
      (entry.family === 'IPv4' || entry.family === 4) && unicastIPv4(entry.address))
    if (current) choices.push({ interfaceName, address: current.address })
  }
  return choices
}

/**
 * An explicit adapter stays selected across DHCP changes. If it disappears, there is no
 * address to advertise; silently switching to a different VPN/LAN would undo the choice.
 * Automatic prefers a physical adapter, falling back to the first valid virtual adapter.
 * Windows may supply its existing OS default-route hint; it must belong to a current adapter.
 */
export function pairingNetworkIPv4(
  interfaces: PairingInterfaces,
  preferredInterface: unknown = '',
  routeAddress: string | null = null
): string | null {
  const choices = pairingNetworkChoices(interfaces)
  if (preferredInterface !== '' && preferredInterface !== null && preferredInterface !== undefined) {
    if (typeof preferredInterface !== 'string') return null
    return choices.find((choice) => choice.interfaceName === preferredInterface)?.address ?? null
  }
  if (routeAddress) {
    for (const addresses of Object.values(interfaces)) {
      if (addresses?.some((entry) => entry && !entry.internal &&
        (entry.family === 'IPv4' || entry.family === 4) && unicastIPv4(entry.address) &&
        entry.address === routeAddress)) return routeAddress
    }
  }
  return choices.find((choice) => !VIRTUAL_INTERFACE.test(choice.interfaceName))?.address ?? choices[0]?.address ?? null
}

import { describe, it, expect } from 'vitest'
import { encodePairQr, PAIR_URL_PREFIX } from '@shared/pair-qr'
import {
  buildPairingPayload,
  DEVICE_KEY_COMMENT_PREFIX,
  LEGACY_DEVICE_KEY_COMMENT_PREFIX,
  deviceCommentFor,
  deviceCommentsFor,
  DEVICE_NAME_MAX,
  IOS_APP_KEY_COMMENT,
  keyCommentOf,
  filterAuthorizedKeys,
  holdsPairedRelayKey,
  isValidEd25519PublicKey,
  normalizeAuthorizedKeysLine,
  normalizeDeviceName,
  pickLanIPv4,
  pickPairingIPv4,
  readDevices,
  removeDevice,
  rewriteKeyComment,
  toPublicDevices,
  upsertDevice,
  type DeviceEntry
} from './pairing-core'

// A real Ed25519 public key blob (32 zero bytes) wrapped in the OpenSSH wire format:
// uint32(len "ssh-ed25519") + "ssh-ed25519" + uint32(32) + 32 bytes.
function makeEd25519Blob(): string {
  const name = Buffer.from('ssh-ed25519', 'ascii')
  const key = Buffer.alloc(32)
  const buf = Buffer.concat([
    u32(name.length),
    name,
    u32(key.length),
    key
  ])
  return buf.toString('base64')
}
function u32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n, 0)
  return b
}

describe('buildPairingPayload', () => {
  it('emits single-line JSON with the fixed key order and defaults', () => {
    const json = buildPairingPayload({
      host: '192.168.1.5',
      user: 'enes',
      token: 'tok123',
      pairPort: 54321,
      name: 'MacBook'
    })
    expect(json).toBe(
      '{"v":1,"host":"192.168.1.5","port":22,"user":"enes","token":"tok123","pairPort":54321,"nodeterm":true,"name":"MacBook"}'
    )
    expect(json).not.toContain('\n')
    expect(JSON.parse(json)).toMatchObject({ v: 1, port: 22, nodeterm: true })
  })

  it('honors an explicit port override', () => {
    const json = buildPairingPayload({
      host: 'h',
      port: 2222,
      user: 'u',
      token: 't',
      pairPort: 1,
      name: 'n'
    })
    expect(JSON.parse(json).port).toBe(2222)
  })

  it('omits the relay block when absent (byte-for-byte legacy LAN-only shape)', () => {
    const json = buildPairingPayload({
      host: 'h',
      user: 'u',
      token: 't',
      pairPort: 1,
      name: 'n'
    })
    expect(json).not.toContain('relay')
    expect(JSON.parse(json)).not.toHaveProperty('relay')
  })

  it('appends hostKey after name when supplied (no relay)', () => {
    const json = buildPairingPayload({
      host: '192.168.1.5',
      user: 'enes',
      token: 'tok',
      pairPort: 5,
      name: 'Mac',
      hostKey: 'AAAAhostpub'
    })
    expect(json).toBe(
      '{"v":1,"host":"192.168.1.5","port":22,"user":"enes","token":"tok","pairPort":5,"nodeterm":true,"name":"Mac","hostKey":"AAAAhostpub"}'
    )
    expect(JSON.parse(json).hostKey).toBe('AAAAhostpub')
  })

  it('places hostKey before the relay block when both are supplied', () => {
    const relay = {
      hostId: 'abcABC012_-def012ghij',
      hostPublicKeyB64: 'AAAAhostpub',
      relayEndpoint: 'wss://relay.nodeterm.dev'
    }
    const json = buildPairingPayload({
      host: '192.168.1.5',
      user: 'enes',
      token: 'tok',
      pairPort: 5,
      name: 'Mac',
      hostKey: 'AAAAhostpub',
      relay
    })
    expect(json).toBe(
      '{"v":1,"host":"192.168.1.5","port":22,"user":"enes","token":"tok","pairPort":5,"nodeterm":true,"name":"Mac","hostKey":"AAAAhostpub","relay":{"hostId":"abcABC012_-def012ghij","hostPublicKeyB64":"AAAAhostpub","relayEndpoint":"wss://relay.nodeterm.dev"}}'
    )
    expect(JSON.parse(json)).toMatchObject({ hostKey: 'AAAAhostpub', relay })
  })

  it('omits hostKey when absent (byte-for-byte legacy shape)', () => {
    const json = buildPairingPayload({
      host: 'h',
      user: 'u',
      token: 't',
      pairPort: 1,
      name: 'n'
    })
    expect(json).not.toContain('hostKey')
    expect(JSON.parse(json)).not.toHaveProperty('hostKey')
  })

  it('appends the relay block after name when supplied', () => {
    const relay = {
      hostId: 'abcABC012_-def012ghij',
      hostPublicKeyB64: 'AAAA',
      relayEndpoint: 'wss://relay.nodeterm.dev'
    }
    const json = buildPairingPayload({
      host: '192.168.1.5',
      user: 'enes',
      token: 'tok',
      pairPort: 5,
      name: 'Mac',
      relay
    })
    expect(json).toBe(
      '{"v":1,"host":"192.168.1.5","port":22,"user":"enes","token":"tok","pairPort":5,"nodeterm":true,"name":"Mac","relay":{"hostId":"abcABC012_-def012ghij","hostPublicKeyB64":"AAAA","relayEndpoint":"wss://relay.nodeterm.dev"}}'
    )
    expect(JSON.parse(json).relay).toEqual(relay)
  })
})

describe('isValidEd25519PublicKey', () => {
  const blob = makeEd25519Blob()

  it('accepts a well-formed ssh-ed25519 line with a comment', () => {
    expect(isValidEd25519PublicKey(`ssh-ed25519 ${blob} phone@nodeterm`)).toBe(true)
  })

  it('accepts a line without a comment', () => {
    expect(isValidEd25519PublicKey(`ssh-ed25519 ${blob}`)).toBe(true)
  })

  it('rejects a non-ed25519 key type', () => {
    expect(isValidEd25519PublicKey(`ssh-rsa ${blob} x`)).toBe(false)
  })

  it('rejects a spoofed prefix with a garbage blob', () => {
    expect(isValidEd25519PublicKey('ssh-ed25519 not-base64!!!')).toBe(false)
  })

  it('rejects an ed25519 prefix whose embedded name disagrees', () => {
    // Base64 blob whose wire-format name is "ssh-rsa" but prefixed textually as ed25519.
    const name = Buffer.from('ssh-rsa', 'ascii')
    const fake = Buffer.concat([u32(name.length), name, u32(0)]).toString('base64')
    expect(isValidEd25519PublicKey(`ssh-ed25519 ${fake}`)).toBe(false)
  })

  it('rejects empty / malformed lines', () => {
    expect(isValidEd25519PublicKey('')).toBe(false)
    expect(isValidEd25519PublicKey('ssh-ed25519')).toBe(false)
  })
})

describe('normalizeAuthorizedKeysLine', () => {
  it('trims and collapses whitespace to a single line', () => {
    expect(normalizeAuthorizedKeysLine('  ssh-ed25519   AAAA   phone\n')).toBe(
      'ssh-ed25519 AAAA phone'
    )
  })
})

describe('deviceCommentFor', () => {
  it('stamps new keys with the platform-neutral nodeterm-mobile-<id> token', () => {
    expect(deviceCommentFor('abc-123')).toBe('nodeterm-mobile-abc-123')
    expect(DEVICE_KEY_COMMENT_PREFIX).toBe('nodeterm-mobile-')
  })
})

describe('deviceCommentsFor', () => {
  it('names the current AND the legacy iOS-era comment, current first', () => {
    // Every iPhone paired before the Android app existed carries `nodeterm-ios-<id>`; a revoke
    // that only knew the new prefix would report "removed" and leave that phone's SSH key live.
    expect(LEGACY_DEVICE_KEY_COMMENT_PREFIX).toBe('nodeterm-ios-')
    expect(deviceCommentsFor('abc')).toEqual(['nodeterm-mobile-abc', 'nodeterm-ios-abc'])
  })
})

describe('rewriteKeyComment', () => {
  it('replaces the phone-sent comment with nodeterm-mobile-<deviceId>, keeping type+blob', () => {
    expect(rewriteKeyComment('ssh-ed25519 AAAAB3 phone@my-iphone', 'dev1')).toBe(
      'ssh-ed25519 AAAAB3 nodeterm-mobile-dev1'
    )
  })

  it('rewrites the iOS app’s own `nodeterm-ios` comment too (the phone does not choose it)', () => {
    expect(rewriteKeyComment('ssh-ed25519 AAAAB3 nodeterm-ios', 'dev3')).toBe(
      'ssh-ed25519 AAAAB3 nodeterm-mobile-dev3'
    )
  })

  it('adds a comment when the key had none', () => {
    expect(rewriteKeyComment('ssh-ed25519 AAAAB3', 'dev2')).toBe(
      'ssh-ed25519 AAAAB3 nodeterm-mobile-dev2'
    )
  })

  it('collapses extra whitespace and multi-word comments', () => {
    expect(rewriteKeyComment('  ssh-ed25519   AAAAB3   some long comment\n', 'd')).toBe(
      'ssh-ed25519 AAAAB3 nodeterm-mobile-d'
    )
  })
})

describe('filterAuthorizedKeys', () => {
  it('removes only lines whose comment is exactly nodeterm-mobile-<id>', () => {
    const content = [
      'ssh-ed25519 AAAAother laptop@work',
      'ssh-ed25519 AAAAtarget nodeterm-mobile-dev1',
      'ssh-rsa AAAArsa other-key'
    ].join('\n')
    expect(filterAuthorizedKeys(content, 'dev1')).toBe(
      'ssh-ed25519 AAAAother laptop@work\nssh-rsa AAAArsa other-key'
    )
  })

  it('still removes a LEGACY nodeterm-ios-<id> line (iPhones paired before the rename)', () => {
    const content = [
      'ssh-ed25519 AAAAother laptop@work',
      'ssh-ed25519 AAAAlegacy nodeterm-ios-dev1',
      'ssh-rsa AAAArsa other-key'
    ].join('\n')
    expect(filterAuthorizedKeys(content, 'dev1')).toBe(
      'ssh-ed25519 AAAAother laptop@work\nssh-rsa AAAArsa other-key'
    )
  })

  it('removes both forms in one pass when a file somehow holds both for the same id', () => {
    const content = 'ssh-ed25519 AAAAa nodeterm-ios-x\nssh-ed25519 AAAAb nodeterm-mobile-x\nkeep k me\n'
    expect(filterAuthorizedKeys(content, 'x')).toBe('keep k me\n')
  })

  it('preserves blank lines and the trailing newline of untouched files', () => {
    const content = 'ssh-ed25519 AAAAa keep-me\n\nssh-ed25519 AAAAb nodeterm-mobile-x\n'
    expect(filterAuthorizedKeys(content, 'x')).toBe('ssh-ed25519 AAAAa keep-me\n\n')
  })

  it('does not match a different device id or a substring, in either form', () => {
    const content = 'ssh-ed25519 AAAAb nodeterm-mobile-dev10\nssh-ed25519 AAAAc nodeterm-ios-dev10'
    expect(filterAuthorizedKeys(content, 'dev1')).toBe(content)
  })

  it('does not treat the bare phone-sent `nodeterm-ios` comment as a device stamp', () => {
    const content = 'ssh-ed25519 AAAAb nodeterm-ios'
    expect(filterAuthorizedKeys(content, '')).toBe(content)
  })

  it('returns content unchanged when nothing matches', () => {
    const content = 'ssh-ed25519 AAAAb some@comment\n'
    expect(filterAuthorizedKeys(content, 'nope')).toBe(content)
  })
})

describe('keyCommentOf', () => {
  it('returns everything after type + blob, whitespace-collapsed', () => {
    expect(keyCommentOf('ssh-ed25519 AAAA nodeterm-ios')).toBe('nodeterm-ios')
    expect(keyCommentOf('  ssh-ed25519   AAAA   a  b \n')).toBe('a b')
    expect(keyCommentOf('ssh-ed25519 AAAA')).toBe('')
    expect(keyCommentOf('')).toBe('')
  })
})

describe('normalizeDeviceName', () => {
  it('honours the name the phone sends, trimmed', () => {
    expect(normalizeDeviceName("  Enes's iPhone  ")).toBe("Enes's iPhone")
    expect(normalizeDeviceName('Android', 'ssh-ed25519 AAAA nodeterm-android')).toBe('Android')
    expect(normalizeDeviceName('Pixel 9 Pro', 'ssh-ed25519 AAAA nodeterm-ios')).toBe('Pixel 9 Pro')
  })

  it('falls back to the neutral "Phone" for missing / blank / non-string names', () => {
    expect(normalizeDeviceName(undefined)).toBe('Phone')
    expect(normalizeDeviceName('   ')).toBe('Phone')
    expect(normalizeDeviceName(42)).toBe('Phone')
    expect(normalizeDeviceName(undefined, 'ssh-ed25519 AAAA nodeterm-android')).toBe('Phone')
  })

  it('keeps "iPhone" for the iOS app, which sends no name but always the nodeterm-ios comment', () => {
    expect(IOS_APP_KEY_COMMENT).toBe('nodeterm-ios')
    expect(normalizeDeviceName(undefined, 'ssh-ed25519 AAAA nodeterm-ios')).toBe('iPhone')
    expect(normalizeDeviceName('  ', '  ssh-ed25519   AAAA   nodeterm-ios\n')).toBe('iPhone')
    // Exact match only: a different or extended comment is not the iOS app.
    expect(normalizeDeviceName(undefined, 'ssh-ed25519 AAAA nodeterm-ios-x')).toBe('Phone')
    expect(normalizeDeviceName(undefined, 'ssh-ed25519 AAAA phone@ios')).toBe('Phone')
  })

  it('flattens control characters and newlines into single spaces', () => {
    expect(normalizeDeviceName('My\nPhone\t\u0007 2')).toBe('My Phone 2')
    expect(normalizeDeviceName('\u0000\u001b')).toBe('Phone')
  })

  it(`caps at ${64} code points without splitting a surrogate pair`, () => {
    expect(DEVICE_NAME_MAX).toBe(64)
    expect(normalizeDeviceName('x'.repeat(5000))).toBe('x'.repeat(64))
    const emoji = '📱'.repeat(70)
    const out = normalizeDeviceName(emoji)
    expect(Array.from(out)).toHaveLength(64)
    expect(out).toBe('📱'.repeat(64))
  })

  it('treats a name of only invisible / bidi characters as no name', () => {
    expect(normalizeDeviceName('\u200B')).toBe('Phone')
    // nodeterm-ios key
    expect(normalizeDeviceName('\u202E\u200F', 'ssh-ed25519 AAAA nodeterm-ios')).toBe('iPhone')
    expect(normalizeDeviceName('\u200D')).toBe('Phone')
  })

  it('strips zero-width and bidi characters from inside a name', () => {
    expect(normalizeDeviceName('Pix\u200Bel\u202E 8')).toBe('Pixel 8')
  })

  it('caps by grapheme: a ZWJ emoji at the boundary is kept whole or cut whole, never dangling', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'
    expect(normalizeDeviceName('a'.repeat(63) + family + 'b')).toBe('a'.repeat(63) + family)
    expect(normalizeDeviceName('a'.repeat(64) + '\u{1F468}\u200D\u{1F469}')).toBe('a'.repeat(64))
  })
})

describe('device registry helpers', () => {
  const dev = (id: string, name = id): DeviceEntry => ({
    id,
    name,
    token: `tok-${id}`,
    pairedAt: 1000,
    lastSeenAt: 0
  })

  it('readDevices returns [] for missing / malformed devices (back-compat with {v,port,token})', () => {
    expect(readDevices(undefined)).toEqual([])
    expect(readDevices({ v: 1, port: 8080, token: 'abc' })).toEqual([])
    expect(readDevices({ devices: 'nope' })).toEqual([])
    expect(readDevices({ devices: [dev('a')] })).toEqual([dev('a')])
  })

  it('upsertDevice appends a new device', () => {
    expect(upsertDevice([dev('a')], dev('b'))).toEqual([dev('a'), dev('b')])
  })

  it('upsertDevice replaces an existing device by id (keeps position at end)', () => {
    const updated = { ...dev('a'), name: 'renamed' }
    expect(upsertDevice([dev('a'), dev('b')], updated)).toEqual([dev('b'), updated])
  })

  it('removeDevice drops the matching id and is a no-op otherwise', () => {
    expect(removeDevice([dev('a'), dev('b')], 'a')).toEqual([dev('b')])
    expect(removeDevice([dev('a')], 'zzz')).toEqual([dev('a')])
  })

  it('toPublicDevices strips the token', () => {
    expect(toPublicDevices([dev('a')])).toEqual([
      { id: 'a', name: 'a', pairedAt: 1000, lastSeenAt: 0 }
    ])
    expect(toPublicDevices([dev('a')])[0]).not.toHaveProperty('token')
  })
})

describe('holdsPairedRelayKey (audit A07-late)', () => {
  // What the standing host asks before pinning a phone it has not pinned: did a pairing that is
  // still listed record this key from its sealed body?
  const dev = (id: string, relayBoxKey?: string): DeviceEntry => ({
    id,
    name: id,
    token: `tok-${id}`,
    pairedAt: 1,
    lastSeenAt: 0,
    ...(relayBoxKey ? { relayBoxKey } : {})
  })

  it('matches only a key a listed pairing recorded, exactly', () => {
    const devices = [dev('a', 'KEY-A'), dev('b'), dev('c', 'KEY-C')]
    expect(holdsPairedRelayKey(devices, 'KEY-A')).toBe(true)
    expect(holdsPairedRelayKey(devices, 'KEY-C')).toBe(true)
    expect(holdsPairedRelayKey(devices, 'KEY-B')).toBe(false)
    expect(holdsPairedRelayKey(devices, 'key-a')).toBe(false)
    expect(holdsPairedRelayKey(removeDevice(devices, 'a'), 'KEY-A')).toBe(false)
  })

  it('an empty key never matches, not even a pairing that recorded none', () => {
    expect(holdsPairedRelayKey([dev('a'), { ...dev('b'), relayBoxKey: '' }], '')).toBe(false)
    expect(holdsPairedRelayKey([], 'KEY-A')).toBe(false)
  })
})

describe('DeviceEntry.relayDeviceId', () => {
  // The desktop mints its OWN device id (it stamps the authorized_keys comment) and the phone
  // sends its own — and only the phone's is what the server keys `relay_devices` on. Keeping
  // just the local one made a paired device unnameable to the server, so a removal could never
  // say WHICH row to revoke.
  const entry: DeviceEntry = {
    id: 'local-uuid',
    name: 'iPhone',
    token: 'agent-token',
    pairedAt: 1,
    lastSeenAt: 0,
    relayDeviceId: 'phone-1'
  }

  it('round-trips through upsertDevice (it is persisted, not derived)', () => {
    expect(upsertDevice([], entry)[0].relayDeviceId).toBe('phone-1')
    const replaced = upsertDevice([{ ...entry, relayDeviceId: 'stale' }], entry)
    expect(replaced).toEqual([entry])
  })

  it('is exposed to the renderer (an id, not a secret) while the token still is not', () => {
    const [pub] = toPublicDevices([entry])
    expect(pub.relayDeviceId).toBe('phone-1')
    // Whole shape, not a subset: a mapper that spread the record would satisfy the line above
    // AND leak `token`. Both assertions below fail on `devices.map((d) => ({ ...d }))`.
    expect(pub).toEqual({
      id: 'local-uuid',
      name: 'iPhone',
      pairedAt: 1,
      lastSeenAt: 0,
      relayDeviceId: 'phone-1'
    })
    expect(Object.keys(pub).sort()).toEqual([
      'id',
      'lastSeenAt',
      'name',
      'pairedAt',
      'relayDeviceId'
    ])
    expect((pub as Record<string, unknown>).token).toBeUndefined()
  })

  it('is optional — a device paired before the field existed still maps, with no id and no token', () => {
    const legacy: DeviceEntry = {
      id: 'old',
      name: 'Old Phone',
      token: 'agent-token',
      pairedAt: 1,
      lastSeenAt: 0
    }
    expect(readDevices({ devices: [legacy] })).toEqual([legacy])
    const [pub] = toPublicDevices([legacy])
    expect(pub.relayDeviceId).toBeUndefined()
    expect(Object.keys(pub)).not.toContain('token')
  })
})

describe('pickLanIPv4', () => {
  it('picks the first non-internal, non-link-local IPv4', () => {
    const picked = pickLanIPv4({
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      en0: [
        { address: 'fe80::1', family: 'IPv6', internal: false },
        { address: '169.254.10.1', family: 'IPv4', internal: false },
        { address: '192.168.1.42', family: 'IPv4', internal: false }
      ]
    })
    expect(picked).toBe('192.168.1.42')
  })

  it('shares automatic physical-adapter preference and strict address rejection with QR/LAN refresh', () => {
    expect(pickLanIPv4({
      docker0: [{ address: '172.17.0.1', family: 4, internal: false }],
      wg0: [{ address: '10.7.0.2', family: 4, internal: false }],
      wlan0: [{ address: '192.168.1.42', family: 4, internal: false }],
    })).toBe('192.168.1.42')
    expect(pickLanIPv4({ en0: [
      { address: '999.1.2.3', family: 4, internal: false },
      { address: '127.0.0.2', family: 4, internal: false },
      { address: '224.1.2.3', family: 4, internal: false },
    ] })).toBeNull()
  })

  it('accepts the numeric family form (family: 4)', () => {
    expect(
      pickLanIPv4({ en0: [{ address: '10.0.0.2', family: 4, internal: false }] })
    ).toBe('10.0.0.2')
  })

  it('returns null when nothing suitable exists', () => {
    expect(
      pickLanIPv4({
        lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
        en0: [{ address: '169.254.1.1', family: 'IPv4', internal: false }]
      })
    ).toBe(null)
  })
})

// The QR ENVELOPE (src/shared/pair-qr.ts) composed with the real payload builder. The encoder's
// own edge cases are covered there; this pins the one thing only this project can check — that
// what the builder emits survives the URL wrapping byte-for-byte (eneskirca/nodeterm#745).
describe('encodePairQr over a built payload', () => {
  const payload = buildPairingPayload({
    host: '192.168.1.5',
    port: 22,
    user: 'enes',
    token: 'tok',
    pairPort: 5,
    name: 'Mac',
    hostKey: 'AAAAhostpub',
    relay: {
      hostId: 'abcABC012_-def012ghij',
      hostPublicKeyB64: 'AAAAhostpub',
      relayEndpoint: 'wss://relay.nodeterm.dev'
    }
  })

  it('leaves the payload untouched in the default (json) form', () => {
    expect(encodePairQr(payload)).toBe(payload)
  })

  it('round-trips the built payload through the url form', () => {
    const url = encodePairQr(payload, 'url')
    expect(url.startsWith(PAIR_URL_PREFIX)).toBe(true)
    const code = url.slice(PAIR_URL_PREFIX.length)
    expect(Buffer.from(code, 'base64url').toString('utf-8')).toBe(payload)
  })
})

describe('ssh:false in the pairing payload', () => {
  const input = { host: 'h', user: 'u', token: 't', pairPort: 1, name: 'n' }
  it('is appended last on a relay-only host', () => {
    expect(buildPairingPayload({ ...input, ssh: false })).toBe(
      '{"v":1,"host":"h","port":22,"user":"u","token":"t","pairPort":1,"nodeterm":true,"name":"n","ssh":false}'
    )
  })
  it('leaves every other payload byte-identical', () => {
    expect(buildPairingPayload(input)).not.toContain('ssh')
  })
})

describe('pickPairingIPv4', () => {
  const nic = (address: string, internal = false) => ({ address, family: 'IPv4', internal })
  const ifaces = {
    'vEthernet (WSL)': [nic('172.20.48.1')],
    'Ethernet 2': [nic('169.254.3.3')],
    'Wi-Fi': [nic('192.168.1.42')]
  }
  it('takes the default-route address when this machine owns it', () => {
    expect(pickPairingIPv4(ifaces, '172.20.48.1')).toBe('172.20.48.1')
  })
  it('ignores a route address that is not one of ours, and skips virtual adapters', () => {
    expect(pickPairingIPv4(ifaces, '10.9.9.9')).toBe('192.168.1.42')
    expect(pickPairingIPv4(ifaces, null)).toBe('192.168.1.42')
  })
  it('accepts a current secondary adapter address as a hint, but rejects malformed/non-unicast hints', () => {
    const current = { docker0: [nic('172.17.0.1'), nic('172.17.0.2')], wlan0: [nic('192.168.1.42')] }
    expect(pickPairingIPv4(current, '172.17.0.2')).toBe('172.17.0.2')
    expect(pickPairingIPv4({ bad: [nic('999.1.2.3')], wlan0: [nic('192.168.1.42')] }, '999.1.2.3')).toBe('192.168.1.42')
  })

  it('keeps a valid fallback when only virtual adapters exist', () => {
    expect(pickPairingIPv4({ 'vEthernet (WSL)': [nic('172.20.48.1')] }, null)).toBe('172.20.48.1')
  })
})

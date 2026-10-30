import { describe, it, expect, afterEach } from 'vitest'
import {
  machineHashOf,
  parseIoregUuid,
  parseRegMachineGuid,
  readMachineHash,
  readMachineHashWith,
  setMachineIdDepsForTests,
  type MachineIdDeps
} from './machine-id'

// Output shapes as the OS tools print them (values replaced with made-up ids — never a real one).
// `ioreg -rd1 -c IOPlatformExpertDevice` on macOS: one device block, `"key" = value` per line, and
// the serial number sits right beside the UUID, so the parser must take the UUID key only.
const IOREG_SAMPLE = `+-o MacBookPro18,3  <class IOPlatformExpertDevice, id 0x100000258, registered, matched, active, busy 0 (124 ms), retain 39>
    {
      "IOPolledInterface" = "AppleARMWatchdogTimerHibernateHandler is not serializable"
      "#address-cells" = <02000000>
      "AAPL,phandle" = <01000000>
      "serial-number" = <433032585858585858585858000000000000000000000000000000000000000000>
      "IOBusyInterest" = "IOCommand is not serializable"
      "target-type" = <"J314s">
      "model" = <"MacBookPro18,3">
      "IOPlatformSerialNumber" = "C02XXXXXXXXX"
      "IOPlatformUUID" = "C0FFEE00-1234-4ABC-9DEF-0123456789AB"
      "IOPlatformArgs" = <00000000000000000000000000000000000000000000000000000000000000000>
      "name" = <"device-tree">
      "IORegistryEntryName" = "J314sAP"
    }
`

// `reg query HKLM\SOFTWARE\Microsoft\Cryptography /v MachineGuid` on Windows: CRLF line endings,
// four-space column separators, a blank line before and after.
const REG_SAMPLE =
  '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n' +
  '    MachineGuid    REG_SZ    3f2504e0-4f89-11d3-9a0c-0305e82c3301\r\n\r\n'

const MACHINE_ID_FILE = '0123456789abcdef0123456789abcdef\n'

const HEX64 = /^[0-9a-f]{64}$/

describe('parseIoregUuid', () => {
  it('reads IOPlatformUUID, not the serial number beside it', () => {
    expect(parseIoregUuid(IOREG_SAMPLE)).toBe('C0FFEE00-1234-4ABC-9DEF-0123456789AB')
  })

  it.each([
    ['empty output', ''],
    ['an unrelated device', '+-o Root  <class IORegistryEntry, id 0x100000100>\n  {\n  }\n'],
    ['an empty UUID', '      "IOPlatformUUID" = ""\n'],
    ['a value that is not a UUID', '      "IOPlatformUUID" = "not-a-uuid"\n'],
    ['a key without a value', '      "IOPlatformUUID" =\n']
  ])('returns null for %s', (_label, out) => {
    expect(parseIoregUuid(out)).toBeNull()
  })
})

describe('parseRegMachineGuid', () => {
  it('reads the MachineGuid value from reg query output', () => {
    expect(parseRegMachineGuid(REG_SAMPLE)).toBe('3f2504e0-4f89-11d3-9a0c-0305e82c3301')
  })

  it('accepts LF line endings too', () => {
    expect(parseRegMachineGuid(REG_SAMPLE.replace(/\r\n/g, '\n'))).toBe('3f2504e0-4f89-11d3-9a0c-0305e82c3301')
  })

  it.each([
    ['empty output', ''],
    ['the error reg prints for a missing value', 'ERROR: The system was unable to find the specified registry key or value.\r\n'],
    ['a different value name', '    ProductId    REG_SZ    00330-80000-00000-AA000\r\n'],
    ['a non-string type', '    MachineGuid    REG_DWORD    0x1\r\n'],
    ['a value that is not a GUID', '    MachineGuid    REG_SZ    hello\r\n']
  ])('returns null for %s', (_label, out) => {
    expect(parseRegMachineGuid(out)).toBeNull()
  })
})

describe('machineHashOf', () => {
  it('is the salted SHA-256 of the trimmed, lowercased raw id (known answer)', () => {
    // printf '%s' 'nodeterm-project-allowance-v1:abc' | sha256sum
    expect(machineHashOf('abc')).toBe('12a1c1fb12b529d1033c5b047de17fc665f00755cf31668f5e3d38c8d1acf348')
  })

  it('ignores surrounding whitespace and case', () => {
    expect(machineHashOf(' ABC ')).toBe(machineHashOf('abc'))
    expect(machineHashOf(' ABC ')).toMatch(HEX64)
  })
})

/** A fake OS: records every call; any command or file not in the tables fails like a missing tool. */
function fakeOs(
  platform: NodeJS.Platform,
  opts: { exec?: Record<string, string>; files?: Record<string, string>; hostname?: string } = {}
) {
  const calls: string[] = []
  const deps: MachineIdDeps = {
    platform,
    exec: async (cmd, args) => {
      const key = [cmd, ...args].join(' ')
      calls.push(`exec ${key}`)
      const out = opts.exec?.[key]
      if (out === undefined) throw new Error(`spawn ${cmd} ENOENT`)
      return out
    },
    readFile: async (file) => {
      calls.push(`read ${file}`)
      const out = opts.files?.[file]
      if (out === undefined) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' })
      return out
    },
    hostname: () => opts.hostname ?? 'test-host'
  }
  return { deps, calls }
}

describe('readMachineHashWith', () => {
  it('darwin: hashes the IOPlatformUUID from ioreg', async () => {
    const { deps, calls } = fakeOs('darwin', {
      exec: { 'ioreg -rd1 -c IOPlatformExpertDevice': IOREG_SAMPLE }
    })
    await expect(readMachineHashWith(deps)).resolves.toBe(machineHashOf('C0FFEE00-1234-4ABC-9DEF-0123456789AB'))
    expect(calls).toEqual(['exec ioreg -rd1 -c IOPlatformExpertDevice'])
  })

  it('win32: hashes the MachineGuid from reg query', async () => {
    const { deps, calls } = fakeOs('win32', {
      exec: { 'reg query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid': REG_SAMPLE }
    })
    await expect(readMachineHashWith(deps)).resolves.toBe(machineHashOf('3f2504e0-4f89-11d3-9a0c-0305e82c3301'))
    expect(calls).toEqual(['exec reg query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid'])
  })

  it('linux: hashes /etc/machine-id', async () => {
    const { deps, calls } = fakeOs('linux', { files: { '/etc/machine-id': MACHINE_ID_FILE } })
    await expect(readMachineHashWith(deps)).resolves.toBe(machineHashOf('0123456789abcdef0123456789abcdef'))
    expect(calls).toEqual(['read /etc/machine-id'])
  })

  it('linux: falls back to the dbus machine-id when /etc/machine-id is missing', async () => {
    const { deps, calls } = fakeOs('linux', {
      files: { '/var/lib/dbus/machine-id': 'fedcba9876543210fedcba9876543210\n' }
    })
    await expect(readMachineHashWith(deps)).resolves.toBe(machineHashOf('fedcba9876543210fedcba9876543210'))
    expect(calls).toEqual(['read /etc/machine-id', 'read /var/lib/dbus/machine-id'])
  })

  it.each([
    ['empty', ''],
    ['systemd first-boot placeholder', 'uninitialized\n']
  ])('linux: an %s /etc/machine-id is not an id', async (_label, content) => {
    const { deps } = fakeOs('linux', {
      files: { '/etc/machine-id': content, '/var/lib/dbus/machine-id': 'fedcba9876543210fedcba9876543210\n' }
    })
    await expect(readMachineHashWith(deps)).resolves.toBe(machineHashOf('fedcba9876543210fedcba9876543210'))
  })

  it.each([
    ['darwin, ioreg missing', fakeOs('darwin', { hostname: 'Mac-Studio.local' })],
    ['darwin, ioreg without a UUID', fakeOs('darwin', { exec: { 'ioreg -rd1 -c IOPlatformExpertDevice': '' }, hostname: 'Mac-Studio.local' })],
    ['win32, reg fails', fakeOs('win32', { hostname: 'Mac-Studio.local' })],
    ['linux, both files missing', fakeOs('linux', { hostname: 'Mac-Studio.local' })],
    ['an unknown platform', fakeOs('freebsd', { hostname: 'Mac-Studio.local' })]
  ])('%s: hashes host:<hostname>, never returns the raw fallback', async (_label, { deps }) => {
    const hash = await readMachineHashWith(deps)
    expect(hash).toBe(machineHashOf('host:Mac-Studio.local'))
    expect(hash).toMatch(HEX64)
  })
})

describe('readMachineHash', () => {
  afterEach(() => setMachineIdDepsForTests(null))

  it('reads the OS once and memoizes the promise', async () => {
    const { deps, calls } = fakeOs('linux', { files: { '/etc/machine-id': MACHINE_ID_FILE } })
    setMachineIdDepsForTests(deps)
    const first = readMachineHash()
    expect(readMachineHash()).toBe(first)
    await expect(first).resolves.toBe(machineHashOf('0123456789abcdef0123456789abcdef'))
    await readMachineHash()
    expect(calls).toEqual(['read /etc/machine-id'])
  })
})

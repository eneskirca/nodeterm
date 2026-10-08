// Actual advertisement writer/remover with a synthetic OS-home boundary, not a standing relay host.
// HOME is inherited unchanged. Only initialization sees the private home; the original homedir
// function is restored before either production operation runs. No credentials, mint or relay socket.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import type { RelayAdvertisement } from '../../../../../src/main/remote/relay-advertise'

const emit = (value: unknown): void => { process.stdout.write(JSON.stringify(value) + '\n') }

async function main(): Promise<void> {
  const home = process.env.FIXTURE_HOME
  const nonce = process.env.FIXTURE_NONCE
  const realHomedir = os.homedir
  const originalHome = realHomedir()
  if (process.argv[2] !== 'relay-advertisement' || !home || !path.isAbsolute(home) ||
      home === originalHome || !nonce || !/^[a-f0-9]{32}$/.test(nonce)) throw new Error('Private fixture home missing')
  const stat = await fs.lstat(home)
  const markerPath = path.join(home, '.relay-advertisement-fixture')
  const marker = await fs.lstat(markerPath)
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(home) !== home ||
      stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700 ||
      !marker.isFile() || marker.isSymbolicLink() || marker.uid !== stat.uid ||
      (marker.mode & 0o777) !== 0o600 || marker.size !== 32 || await fs.readFile(markerPath, 'utf8') !== nonce) {
    throw new Error('Private fixture ownership changed')
  }
  // relay-advertise's FILE is initialized once. Adapt only that explicit OS fact in this fresh child.
  let producer: typeof import('../../../../../src/main/remote/relay-advertise')
  try {
    os.homedir = () => home
    producer = await import('../../../../../src/main/remote/relay-advertise')
  } finally {
    os.homedir = realHomedir
  }
  if (os.homedir !== realHomedir || os.homedir() !== originalHome) throw new Error('OS home adapter not restored')
  emit({ ready: true, homeRestored: true, boundary: 'actual writer/remover; synthetic OS home; no relay host or adoption' })
  const lines = readline.createInterface({ input: process.stdin })
  for await (const line of lines) {
    if (line === 'remove') {
      await producer.removeRelayAdvertisement()
      emit({ event: 'removed' })
    } else if (line.startsWith('write ') && Buffer.byteLength(line, 'utf8') <= 4096) {
      const value: RelayAdvertisement = JSON.parse(line.slice(6))
      if (value.v !== 1 || ['hostId', 'hostPublicKeyB64', 'relayEndpoint', 'hostDeviceId']
          .some(key => typeof value[key as keyof RelayAdvertisement] !== 'string')) throw new Error('Public fixture fields missing')
      await producer.writeRelayAdvertisement(value)
      emit({ event: 'written' })
    } else {
      throw new Error('Unknown fixture command')
    }
  }
}

void main().catch(error => { emit({ event: 'fatal', message: String(error) }); process.exitCode = 1 })

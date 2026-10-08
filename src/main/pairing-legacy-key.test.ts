import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, symlinkSync, renameSync } from 'fs'
import os from 'os'
import path from 'path'
let duringRead: (() => void) | null = null
let foreignOwner = false
let duringNamed: (() => void) | null = null
let namedReads = 0
vi.mock('fs', async original => {
  const fs = await original<typeof import('fs')>()
  return { ...fs, lstatSync: (file: Parameters<typeof fs.lstatSync>[0]) => {
    if (duringNamed && String(file).endsWith('authorized_keys') && ++namedReads === 2) {
      const effect = duringNamed; duringNamed = null; effect()
    }
    const value = fs.lstatSync(file)
    if (foreignOwner && String(file).endsWith('authorized_keys')) value.uid += 1
    return value
  }, readSync: (...args: Parameters<typeof fs.readSync>) => {
    const result = fs.readSync(...args)
    duringRead?.(); duringRead = null
    return result
  } }
})
import { readLegacyPairingKey, LEGACY_AUTHORIZED_KEYS_LIMIT } from './pairing-legacy-key'
const id = '11111111-1111-4111-8111-111111111111'
const raw = Buffer.alloc(32, 4)
const blob = Buffer.concat([Buffer.from('0000000b7373682d6564323535313900000020', 'hex'), raw]).toString('base64')
const line = `ssh-ed25519 ${blob} nodeterm-ios-${id}\n`
const homes: string[] = []
function file(text = line): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nt-legacy-public-')); homes.push(dir)
  chmodSync(dir, 0o700)
  const target = path.join(dir, 'authorized_keys'); writeFileSync(target, text, { mode: 0o600 }); return target
}
afterEach(() => { duringRead = null; duringNamed = null; namedReads = 0; foreignOwner = false;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })
describe('exact attributed public SSH key', () => {
  it('reads only the exact pairing, preserving other public lines', () => {
    expect(readLegacyPairingKey(file('# comment\nssh-rsa AAAA untouched\n' + line), id)).toBe(raw.toString('base64'))
    expect(readLegacyPairingKey(file(line), '22222222-2222-4222-8222-222222222222')).toBeNull()
  })
  it.each([line + line, line + line.replace('ssh-ed25519 ', 'restrict ssh-ed25519 '),
    line + `from="one two" ${line}`, line.trimEnd() + '-suffix\n', line.replace('ssh-ed25519 ', 'restrict ssh-ed25519 '),
    `ssh-ed25519 ${Buffer.from('0000000b7373682d65643235353139', 'hex').toString('base64')} nodeterm-ios-${id}\n`,
    line.replace(blob, Buffer.concat([Buffer.from('0000000b7373682d656432353531390000001f', 'hex'), raw]).toString('base64'))])(
    'refuses duplicate, inexact, options or malformed attribution %#', text => expect(readLegacyPairingKey(file(text), id)).toBeNull())
  it('refuses a leaf link and a linked parent', () => {
    const target = file(); const linked = target + '.link'; symlinkSync(target, linked)
    expect(readLegacyPairingKey(linked, id)).toBeNull()
    const parent = path.dirname(target) + '-link'; homes.push(parent); symlinkSync(path.dirname(target), parent)
    expect(readLegacyPairingKey(path.join(parent, 'authorized_keys'), id)).toBeNull()
  })
  it('refuses directories, oversized files and writable files/directories', () => {
    const target = file(); expect(readLegacyPairingKey(path.dirname(target), id)).toBeNull()
    const oversized = Buffer.alloc(LEGACY_AUTHORIZED_KEYS_LIMIT + 1, 35); Buffer.from(line).copy(oversized)
    writeFileSync(target, oversized); expect(readLegacyPairingKey(target, id)).toBeNull()
    writeFileSync(target, line); chmodSync(target, 0o666); expect(readLegacyPairingKey(target, id)).toBeNull()
    chmodSync(target, 0o600); chmodSync(path.dirname(target), 0o777); expect(readLegacyPairingKey(target, id)).toBeNull()
  })
  it('refuses a different named inode even when the opened file remains readable', () => {
    const target = file(); const replacement = target + '.new'; writeFileSync(replacement, line, { mode: 0o600 })
    // Replace after the final descriptor metadata snapshot, immediately before the pathname
    // snapshot. Actual rename semantics apply; only that scheduling boundary is controlled.
    duringNamed = () => renameSync(replacement, target)
    expect(readLegacyPairingKey(target, id)).toBeNull()
  })
  it('refuses foreign ownership even when the public file can be read', () => {
    const target = file(); foreignOwner = true
    expect(readLegacyPairingKey(target, id)).toBeNull()
  })
  it('refuses growth of the actual opened file during a capped read', () => {
    const target = file()
    duringRead = () => writeFileSync(target, line + line)
    expect(readLegacyPairingKey(target, id)).toBeNull()
  })
})

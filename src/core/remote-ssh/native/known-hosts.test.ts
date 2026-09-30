import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHmac, randomBytes } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  acceptNewHostKey,
  hostPatternsMatch,
  keyTypeOfBlob,
  knownHostsName,
  verifyHostKey
} from './known-hosts'
import { parseSshG, expandHomePath } from './ssh-config'

/** A wire-format public key blob: string keytype, then opaque key material. */
function blob(type: string, fill: number): Buffer {
  const t = Buffer.from(type)
  const len = Buffer.alloc(4)
  len.writeUInt32BE(t.length)
  return Buffer.concat([len, t, Buffer.alloc(32, fill)])
}
const ED_A = blob('ssh-ed25519', 1)
const ED_B = blob('ssh-ed25519', 2)
const RSA = blob('ssh-rsa', 3)
const line = (hosts: string, b: Buffer, marker = ''): string =>
  `${marker ? marker + ' ' : ''}${hosts} ${keyTypeOfBlob(b)} ${b.toString('base64')}`
const hashed = (name: string): string => {
  const salt = randomBytes(20)
  return `|1|${salt.toString('base64')}|${createHmac('sha1', salt).update(name).digest('base64')}`
}

describe('known_hosts matching (OpenSSH semantics)', () => {
  it('names a non-22 port the way ssh records it', () => {
    expect(knownHostsName('h', 22)).toBe('h')
    expect(knownHostsName('h', 2222)).toBe('[h]:2222')
  })

  it('matches plain, wildcard, negated and hashed patterns', () => {
    expect(hostPatternsMatch('a.example,b.example', 'b.example')).toBe(true)
    expect(hostPatternsMatch('*.example', 'x.example')).toBe(true)
    expect(hostPatternsMatch('*.example,!bad.example', 'bad.example')).toBe(false)
    expect(hostPatternsMatch(hashed('[h]:2222'), '[h]:2222')).toBe(true)
    expect(hostPatternsMatch(hashed('[h]:2222'), 'h')).toBe(false)
  })

  it('match / mismatch / unknown / revoked', () => {
    const file = [line('h', ED_A), line(hashed('[k]:22022'), RSA)].join('\n')
    expect(verifyHostKey([file], 'h', ED_A)).toBe('match')
    expect(verifyHostKey([file], 'h', ED_B)).toBe('mismatch')
    // A different key TYPE for a known host is not a mismatch (hosts serve several types).
    expect(verifyHostKey([file], 'h', RSA)).toBe('unknown')
    expect(verifyHostKey([file], 'other', ED_A)).toBe('unknown')
    expect(verifyHostKey([file], '[k]:22022', RSA)).toBe('match')
    const revoked = [file, line('*', ED_A, '@revoked')].join('\n')
    expect(verifyHostKey([revoked], 'h', ED_A)).toBe('revoked')
  })

  it('ignores @cert-authority lines — they can only leave a host unknown', () => {
    expect(verifyHostKey([line('*', ED_A, '@cert-authority')], 'h', ED_A)).toBe('unknown')
  })
})

describe('acceptNewHostKey (StrictHostKeyChecking=accept-new)', () => {
  let dir: string
  let user: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-kh-'))
    user = path.join(dir, 'sub', 'known_hosts')
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('records a first-seen host and accepts it; a changed key is then refused', () => {
    const policy = { userFiles: [user], globalFiles: [] }
    expect(acceptNewHostKey(policy, 'h', 2222, ED_A)).toEqual({ accept: true, verdict: 'unknown' })
    expect(fs.readFileSync(user, 'utf8')).toBe(`[h]:2222 ssh-ed25519 ${ED_A.toString('base64')}\n`)
    expect(acceptNewHostKey(policy, 'h', 2222, ED_A)).toEqual({ accept: true, verdict: 'match' })
    expect(acceptNewHostKey(policy, 'h', 2222, ED_B)).toEqual({ accept: false, verdict: 'mismatch' })
  })

  it('appends without rewriting what another ssh wrote', () => {
    fs.mkdirSync(path.dirname(user), { recursive: true })
    fs.writeFileSync(user, 'x ssh-ed25519 AAAA') // no trailing newline
    acceptNewHostKey({ userFiles: [user], globalFiles: [] }, 'h', 22, ED_A)
    expect(fs.readFileSync(user, 'utf8').split('\n')).toEqual([
      'x ssh-ed25519 AAAA',
      `h ssh-ed25519 ${ED_A.toString('base64')}`,
      ''
    ])
  })

  it('a global file counts as known', () => {
    const global = path.join(dir, 'global')
    fs.writeFileSync(global, line('h', ED_A) + '\n')
    expect(acceptNewHostKey({ userFiles: [user], globalFiles: [global] }, 'h', 22, ED_B).verdict).toBe('mismatch')
  })
})

describe('parseSshG', () => {
  it('reads the fields the transport needs, expanding ~', () => {
    const out = [
      'user root',
      'hostname 95.217.38.239',
      'port 22',
      'identitiesonly no',
      'stricthostkeychecking ask',
      'identityfile ~/.ssh/id_rsa',
      'identityfile ~/.ssh/id_ed25519',
      'userknownhostsfile ~/.ssh/known_hosts ~/.ssh/known_hosts2',
      'globalknownhostsfile /etc/ssh/ssh_known_hosts',
      'proxyjump none',
      'connecttimeout none',
      'identityagent SSH_AUTH_SOCK'
    ].join('\n')
    const r = parseSshG(out, '/home/me')
    expect(r).toMatchObject({
      hostname: '95.217.38.239',
      user: 'root',
      port: 22,
      identitiesOnly: false,
      identityFiles: [path.join('/home/me', '.ssh/id_rsa'), path.join('/home/me', '.ssh/id_ed25519')],
      userKnownHostsFiles: [path.join('/home/me', '.ssh/known_hosts'), path.join('/home/me', '.ssh/known_hosts2')],
      globalKnownHostsFiles: ['/etc/ssh/ssh_known_hosts'],
      identityAgent: 'SSH_AUTH_SOCK'
    })
    expect(r.proxyJump).toBeUndefined()
    expect(r.connectTimeout).toBeUndefined()
  })

  it('refuses output with no host/user', () => {
    expect(() => parseSshG('port 22')).toThrow()
  })

  it('expands a Windows-style home prefix too', () => {
    expect(expandHomePath('~\\.ssh\\id', 'C:\\Users\\me')).toBe(path.join('C:\\Users\\me', '.ssh\\id'))
  })
})

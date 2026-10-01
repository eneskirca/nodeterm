// The add-identity encoder against a fake agent that DECODES the message and rebuilds the private
// key from it (a sign/verify round trip, so a field in the wrong order or an mpint with a lost sign
// byte fails), plus the reply handling, and — where the platform has one — a real OpenSSH agent.

import { describe, it, expect, afterEach } from 'vitest'
import net from 'net'
import os from 'os'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { spawn, type ChildProcess } from 'child_process'
import { utils, createAgent, type ParsedKey } from 'ssh2'
import {
  addKeyToAgent,
  addIdentityRequest,
  removeIdentityRequest,
  sendAgentRequest,
  sshMpint,
  parseAddKeysToAgent,
  decideAgentAdd,
  SSH2_AGENTC_ADD_IDENTITY,
  SSH2_AGENTC_ADD_ID_CONSTRAINED,
  SSH_AGENT_CONSTRAIN_LIFETIME,
  SSH_AGENT_FAILURE,
  SSH_AGENT_SUCCESS
} from './agent-add'
import { findExecutableSync } from '../../exec-path'

function parsed(k: string, pass?: string): ParsedKey {
  const p = utils.parseKey(k, pass)
  const one = Array.isArray(p) ? p[0] : p
  if (one instanceof Error) throw one
  return one
}

const PASS = 'pw'
const KEYS: Record<string, ParsedKey> = {
  ed25519: parsed(utils.generateKeyPairSync('ed25519', { passphrase: PASS, cipher: 'aes256-ctr', rounds: 4 }).private, PASS),
  ecdsa256: parsed(utils.generateKeyPairSync('ecdsa', { bits: 256, passphrase: PASS, cipher: 'aes256-ctr', rounds: 4 }).private, PASS),
  ecdsa384: parsed(utils.generateKeyPairSync('ecdsa', { bits: 384 }).private),
  ecdsa521: parsed(utils.generateKeyPairSync('ecdsa', { bits: 521 }).private),
  rsa: parsed(utils.generateKeyPairSync('rsa', { bits: 2048, passphrase: PASS, cipher: 'aes256-ctr', rounds: 4 }).private, PASS)
}

/** A cursor over an SSH-encoded buffer. */
function reader(b: Buffer) {
  let o = 0
  return {
    byte: () => b[o++],
    u32: () => {
      const v = b.readUInt32BE(o)
      o += 4
      return v
    },
    str(): Buffer {
      const n = this.u32()
      const s = b.subarray(o, o + n)
      o += n
      return s
    },
    rest: () => b.subarray(o)
  }
}

/** mpint → unsigned magnitude, asserting the encoding is canonical (minimal, non-negative). */
function mp(s: Buffer): Buffer {
  if (s.length === 0) return s
  expect(s[0] & 0x80).toBe(0)
  if (s[0] === 0) expect(s[1] & 0x80).not.toBe(0)
  return s[0] === 0 ? s.subarray(1) : s
}

const u = (b: Buffer): string => b.toString('base64url')

/** Rebuild a node private key from a decoded add-identity body and prove it signs as `key`. */
function decodeAndCheck(body: Buffer, key: ParsedKey): { type: number; comment: string; constraints: Buffer } {
  const r = reader(body)
  const type = r.byte()
  const keyType = r.str().toString()
  expect(keyType).toBe(key.type)
  let jwk: crypto.webcrypto.JsonWebKey
  if (keyType === 'ssh-ed25519') {
    const a = r.str()
    const ka = r.str()
    expect(a.length).toBe(32)
    expect(ka.length).toBe(64)
    expect(ka.subarray(32).equals(a)).toBe(true)
    jwk = { kty: 'OKP', crv: 'Ed25519', x: u(a), d: u(ka.subarray(0, 32)) }
  } else if (keyType.startsWith('ecdsa-')) {
    const curve = r.str().toString()
    expect(keyType).toBe(`ecdsa-sha2-${curve}`)
    const q = r.str()
    expect(q[0]).toBe(4)
    const w = (q.length - 1) / 2
    const d = mp(r.str())
    const crv = { nistp256: 'P-256', nistp384: 'P-384', nistp521: 'P-521' }[curve] as string
    jwk = { kty: 'EC', crv, x: u(q.subarray(1, 1 + w)), y: u(q.subarray(1 + w)), d: u(Buffer.concat([Buffer.alloc(w - d.length), d])) }
  } else {
    const [n, e, d, iqmp, p, q] = [r.str(), r.str(), r.str(), r.str(), r.str(), r.str()].map(mp)
    const bn = (b: Buffer): bigint => BigInt('0x' + (b.toString('hex') || '0'))
    const hex = (v: bigint): Buffer => {
      const h = v.toString(16)
      return Buffer.from(h.length % 2 ? '0' + h : h, 'hex')
    }
    // iqmp must be q^-1 mod p (OpenSSH's definition), i.e. q * iqmp ≡ 1 (mod p).
    expect((bn(q) * bn(iqmp)) % bn(p)).toBe(1n)
    jwk = {
      kty: 'RSA', n: u(n), e: u(e), d: u(d), p: u(p), q: u(q), qi: u(iqmp),
      dp: u(hex(bn(d) % (bn(p) - 1n))), dq: u(hex(bn(d) % (bn(q) - 1n)))
    }
  }
  const priv = crypto.createPrivateKey({ key: jwk, format: 'jwk' })
  const data = Buffer.from('nodeterm agent add round trip')
  const algo = keyType === 'ssh-ed25519' ? null : 'sha256'
  const sig = crypto.sign(algo, data, priv)
  expect(crypto.verify(algo, data, crypto.createPublicKey(key.getPublicPEM()), sig)).toBe(true)
  const comment = r.str().toString()
  return { type, comment, constraints: r.rest() }
}

function unframe(req: Buffer): Buffer {
  const len = req.readUInt32BE(0)
  expect(req.length).toBe(4 + len)
  return req.subarray(4)
}

describe('sshMpint', () => {
  it('encodes minimally and keeps the value non-negative', () => {
    expect(sshMpint(Buffer.from([])).equals(Buffer.from([0, 0, 0, 0]))).toBe(true)
    expect(sshMpint(Buffer.from([0, 0])).equals(Buffer.from([0, 0, 0, 0]))).toBe(true)
    expect(sshMpint(Buffer.from([0x7f])).equals(Buffer.from([0, 0, 0, 1, 0x7f]))).toBe(true)
    expect(sshMpint(Buffer.from([0x80])).equals(Buffer.from([0, 0, 0, 2, 0, 0x80]))).toBe(true)
    expect(sshMpint(Buffer.from([0, 0, 0x81, 1])).equals(Buffer.from([0, 0, 0, 3, 0, 0x81, 1]))).toBe(true)
  })
})

describe('parseAddKeysToAgent (ssh -G spellings, measured on Windows 9.5p2 and macOS 10.3p1)', () => {
  it('reads true, a lifetime in seconds, and treats everything else as no', () => {
    expect(parseAddKeysToAgent('true')).toEqual({ add: true })
    expect(parseAddKeysToAgent('yes')).toEqual({ add: true })
    expect(parseAddKeysToAgent('3600')).toEqual({ add: true, lifetimeSec: 3600 })
    for (const v of ['false', 'no', 'ask', 'confirm', 'confirm 1800', '0', '-5', '1h', '', undefined, 'TRUEISH']) {
      expect(parseAddKeysToAgent(v)).toEqual({ add: false })
    }
  })
})

describe('decideAgentAdd', () => {
  const WIN = '\\\\.\\pipe\\openssh-ssh-agent'
  it('adds nothing by default — the Windows agent keeps keys until removed', () => {
    expect(decideAgentAdd({ agentPath: WIN, addKeysToAgent: 'false', windowsAgentOptIn: false })).toBeNull()
    expect(decideAgentAdd({ agentPath: WIN, addKeysToAgent: undefined, windowsAgentOptIn: false })).toBeNull()
  })
  it('the machine opt-in applies to the Windows agent pipe only', () => {
    expect(decideAgentAdd({ agentPath: WIN, addKeysToAgent: 'false', windowsAgentOptIn: true })).toEqual({})
    expect(decideAgentAdd({ agentPath: WIN.toUpperCase(), addKeysToAgent: 'false', windowsAgentOptIn: true })).toEqual({})
    expect(decideAgentAdd({ agentPath: '\\\\.\\pipe\\pageant.x', addKeysToAgent: 'false', windowsAgentOptIn: true })).toBeNull()
    expect(decideAgentAdd({ agentPath: '/tmp/agent.sock', addKeysToAgent: 'false', windowsAgentOptIn: true })).toBeNull()
  })
  it("the host's own AddKeysToAgent is honoured on any agent, a lifetime kept as a constraint", () => {
    expect(decideAgentAdd({ agentPath: WIN, addKeysToAgent: 'true', windowsAgentOptIn: false })).toEqual({})
    expect(decideAgentAdd({ agentPath: '/tmp/agent.sock', addKeysToAgent: 'true', windowsAgentOptIn: false })).toEqual({})
    // A lifetime wins over the opt-in's unconstrained add: Windows refuses it and stores NOTHING.
    expect(decideAgentAdd({ agentPath: WIN, addKeysToAgent: '600', windowsAgentOptIn: true })).toEqual({ lifetimeSec: 600 })
  })
})

describe('addIdentityRequest', () => {
  for (const [name, key] of Object.entries(KEYS)) {
    it(`${name}: an unconstrained add carries a key that signs as the original`, () => {
      const req = addIdentityRequest(key, `C:\\Users\\me\\.ssh\\id_${name}`)
      expect(req).not.toBeNull()
      const m = decodeAndCheck(unframe(req as Buffer), key)
      expect(m.type).toBe(SSH2_AGENTC_ADD_IDENTITY)
      expect(m.comment).toBe(`C:\\Users\\me\\.ssh\\id_${name}`)
      expect(m.constraints.length).toBe(0)
    })
  }

  it('a lifetime makes it ADD_ID_CONSTRAINED with one lifetime constraint', () => {
    const m = decodeAndCheck(unframe(addIdentityRequest(KEYS.ed25519, 'k', { lifetimeSec: 3600 }) as Buffer), KEYS.ed25519)
    expect(m.type).toBe(SSH2_AGENTC_ADD_ID_CONSTRAINED)
    expect(m.constraints.equals(Buffer.from([SSH_AGENT_CONSTRAIN_LIFETIME, 0, 0, 0x0e, 0x10]))).toBe(true)
  })

  it('refuses a nonsense lifetime instead of sending an unbounded add', () => {
    for (const lifetimeSec of [0, -1, 1.5, NaN]) expect(addIdentityRequest(KEYS.ed25519, 'k', { lifetimeSec })).toBeNull()
  })

  it('refuses a key type it does not encode', () => {
    const odd = { ...KEYS.rsa, type: 'ssh-dss', getPrivatePEM: () => KEYS.rsa.getPrivatePEM() } as unknown as ParsedKey
    expect(addIdentityRequest(odd, 'k')).toBeNull()
    const broken = { type: 'ssh-ed25519', getPrivatePEM: () => 'not a pem' } as unknown as ParsedKey
    expect(addIdentityRequest(broken, 'k')).toBeNull()
  })
})

describe('addKeyToAgent against a fake agent', () => {
  let server: net.Server | null = null
  let sockPath = ''
  const tmps: string[] = []
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
    server = null
    for (const t of tmps.splice(0)) fs.rmSync(t, { recursive: true, force: true })
  })

  async function fakeAgent(reply: (req: Buffer, sock: net.Socket) => void): Promise<string> {
    if (process.platform === 'win32') {
      sockPath = `\\\\.\\pipe\\nodeterm-agent-add-test-${crypto.randomUUID()}`
    } else {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-aa-'))
      tmps.push(tmp)
      sockPath = path.join(tmp, 's')
    }
    server = net.createServer((sock) => {
      let buf = Buffer.alloc(0)
      sock.on('data', (d: Buffer) => {
        buf = Buffer.concat([buf, d])
        if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) reply(buf, sock)
      })
      sock.on('error', () => {})
    })
    await new Promise<void>((r) => server?.listen(sockPath, () => r()))
    return sockPath
  }

  const answer = (type: number) => (_req: Buffer, sock: net.Socket) => sock.write(Buffer.from([0, 0, 0, 1, type]))

  it('reports SUCCESS as added, and the agent received the whole key', async () => {
    let got: Buffer | null = null
    const p = await fakeAgent((req, sock) => {
      got = req
      answer(SSH_AGENT_SUCCESS)(req, sock)
    })
    expect(await addKeyToAgent(p, KEYS.rsa, 'id_rsa')).toBe('added')
    expect(decodeAndCheck(unframe(got as unknown as Buffer), KEYS.rsa).comment).toBe('id_rsa')
  })

  it('reports FAILURE as refused', async () => {
    const p = await fakeAgent(answer(SSH_AGENT_FAILURE))
    expect(await addKeyToAgent(p, KEYS.ed25519, 'k', { lifetimeSec: 60 })).toBe('refused')
  })

  it('an agent that hangs up, stays silent or answers garbage is an error, never a throw', async () => {
    let p = await fakeAgent((_r, sock) => sock.destroy())
    expect(await addKeyToAgent(p, KEYS.ed25519, 'k')).toBe('error')
    await new Promise<void>((r) => server?.close(() => r()))
    p = await fakeAgent(() => {})
    expect(await addKeyToAgent(p, KEYS.ed25519, 'k', { timeoutMs: 150 })).toBe('error')
    await new Promise<void>((r) => server?.close(() => r()))
    p = await fakeAgent((_r, sock) => sock.write(Buffer.from([0xff, 0xff, 0xff, 0xff, 6])))
    expect(await addKeyToAgent(p, KEYS.ed25519, 'k')).toBe('error')
  })

  it('no agent at the path is an error', async () => {
    const missing = process.platform === 'win32' ? `\\\\.\\pipe\\nodeterm-missing-${crypto.randomUUID()}` : path.join(os.tmpdir(), `nt-missing-${crypto.randomUUID()}`)
    expect(await addKeyToAgent(missing, KEYS.ed25519, 'k')).toBe('error')
  })

  it('an unsupported key never touches the agent', async () => {
    let calls = 0
    const p = await fakeAgent((req, sock) => {
      calls++
      answer(SSH_AGENT_SUCCESS)(req, sock)
    })
    const odd = { type: 'ssh-dss', getPrivatePEM: () => '' } as unknown as ParsedKey
    expect(await addKeyToAgent(p, odd, 'k')).toBe('unsupported-key')
    expect(calls).toBe(0)
  })
})

// A REAL agent: OpenSSH's own ssh-agent where the platform ships one (macOS, Linux). Proves the
// agent accepts every encoded type, honours the lifetime, and can SIGN with what it received.
const sshAgentBin = process.platform === 'win32' ? null : findExecutableSync('ssh-agent', ['/usr/bin/ssh-agent'])

describe.skipIf(!sshAgentBin)('addKeyToAgent against OpenSSH ssh-agent', () => {
  let child: ChildProcess | null = null
  let tmp = ''
  afterEach(() => {
    child?.kill()
    child = null
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  async function startAgent(): Promise<string | null> {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-ag-'))
    const sock = path.join(tmp, 'a')
    if (Buffer.byteLength(sock) > 100) return null // sun_path; the sandbox dir may be deep
    child = spawn(sshAgentBin as string, ['-D', '-a', sock], { stdio: 'ignore' })
    for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 50))
    return fs.existsSync(sock) ? sock : null
  }

  const identities = (sock: string): Promise<string[]> =>
    new Promise((res, rej) =>
      createAgent(sock).getIdentities((e, ks) => (e ? rej(e) : res((ks ?? []).map((k) => (k as ParsedKey).comment))))
    )

  it('adds every key type, signs with it, and drops a constrained key at its lifetime', async (ctx) => {
    const sock = await startAgent()
    if (!sock) return ctx.skip()
    for (const [name, key] of Object.entries(KEYS)) expect(await addKeyToAgent(sock, key, name)).toBe('added')
    expect((await identities(sock)).sort()).toEqual(Object.keys(KEYS).sort())
    // Sign through the agent with a key it only knows from our message.
    const sig = await new Promise<Buffer>((res, rej) =>
      createAgent(sock).sign(KEYS.ed25519, Buffer.from('x'), {}, (e, s) => (e ? rej(e) : res(s as Buffer)))
    )
    expect(KEYS.ed25519.verify(Buffer.from('x'), sig)).toBe(true)
    const rsaSig = await new Promise<Buffer>((res, rej) =>
      createAgent(sock).sign(KEYS.rsa, Buffer.from('x'), { hash: 'sha256' }, (e, s) => (e ? rej(e) : res(s as Buffer)))
    )
    expect(KEYS.rsa.verify(Buffer.from('x'), rsaSig, 'sha256')).toBe(true)
    for (const key of Object.values(KEYS)) expect(await sendAgentRequest(sock, removeIdentityRequest(key))).toBe('added')
    expect(await identities(sock)).toEqual([])
    expect(await addKeyToAgent(sock, KEYS.rsa, 'short', { lifetimeSec: 1 })).toBe('added')
    expect(await identities(sock)).toEqual(['short'])
    await new Promise((r) => setTimeout(r, 2200))
    expect(await identities(sock)).toEqual([])
  }, 15_000)
})

// The REAL Windows OpenSSH agent service. Runs on the windows-latest CI leg, which starts the
// service first (ci.yml); skipped where the pipe does not exist. Pins the measurement the policy
// rests on: a constrained add is REFUSED, an unconstrained one is stored and signs.
const WINDOWS_PIPE = '\\\\.\\pipe\\openssh-ssh-agent'
const windowsAgentUp = process.platform === 'win32' && (() => {
  try {
    return fs.existsSync(WINDOWS_PIPE)
  } catch {
    return false
  }
})()

describe.skipIf(!windowsAgentUp)('addKeyToAgent against the Windows OpenSSH agent service', () => {
  afterEach(async () => {
    for (const key of Object.values(KEYS)) await sendAgentRequest(WINDOWS_PIPE, removeIdentityRequest(key))
  })

  const comments = (): Promise<string[]> =>
    new Promise((res, rej) =>
      createAgent(WINDOWS_PIPE).getIdentities((e, ks) => (e ? rej(e) : res((ks ?? []).map((k) => (k as ParsedKey).comment))))
    )

  it('refuses a lifetime constraint for every key type, and stores nothing', async () => {
    for (const [name, key] of Object.entries(KEYS)) {
      expect(await addKeyToAgent(WINDOWS_PIPE, key, `nt-test-${name}`, { lifetimeSec: 60 })).toBe('refused')
    }
    expect((await comments()).filter((c) => c.startsWith('nt-test-'))).toEqual([])
  })

  it('stores an unconstrained key of every type, signs with it, and removes it', async () => {
    for (const [name, key] of Object.entries(KEYS)) expect(await addKeyToAgent(WINDOWS_PIPE, key, `nt-test-${name}`)).toBe('added')
    expect((await comments()).filter((c) => c.startsWith('nt-test-')).sort()).toEqual(Object.keys(KEYS).map((n) => `nt-test-${n}`).sort())
    const sig = await new Promise<Buffer>((res, rej) =>
      createAgent(WINDOWS_PIPE).sign(KEYS.rsa, Buffer.from('x'), { hash: 'sha256' }, (e, s) => (e ? rej(e) : res(s as Buffer)))
    )
    expect(KEYS.rsa.verify(Buffer.from('x'), sig, 'sha256')).toBe(true)
    for (const key of Object.values(KEYS)) expect(await sendAgentRequest(WINDOWS_PIPE, removeIdentityRequest(key))).toBe('added')
    expect((await comments()).filter((c) => c.startsWith('nt-test-'))).toEqual([])
  }, 20_000)
})

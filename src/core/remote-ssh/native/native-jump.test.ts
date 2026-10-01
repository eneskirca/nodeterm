// ProxyJump over the native transport, against REAL SSH protocol peers: ssh2's own Server,
// in-process, on loopback — a target and two jump hosts, each with its own host key and its own
// accepted client key. The jumps answer direct-tcpip (what `ssh -W` asks a bastion for) by dialing
// the destination, so the whole chain is the real protocol end to end, on every OS the CI runs.

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import net, { type AddressInfo } from 'net'
import { Server, utils, type Connection } from 'ssh2'
import { NativeMux } from './native-mux'
import { parseSshArgv } from './ssh-argv'
import { childArgs } from '../control-master'
import { parseProxyJump, sshGArgs, type HostQuery, type ResolvedHost } from './ssh-config'
import type { SshConnection } from '../../../shared/ssh'

const clientKey = utils.generateKeyPairSync('ed25519') // the target accepts only this
const jumpKey = utils.generateKeyPairSync('ed25519') // the jumps accept only this
const strangerKey = utils.generateKeyPairSync('ed25519')

interface Peer {
  name: string
  server: Server
  port: number
  hostKey: { private: string; public: string }
  logins: number
  live: Connection[]
  /** direct-tcpip destinations this peer was asked for (`host:port`). */
  forwards: string[]
  /** Sessions allowed per connection (MaxSessions); Infinity = no limit. */
  limit: number
}

function pubMatches(offered: { algo: string; data: Buffer }, pub: string): boolean {
  const k = utils.parseKey(pub)
  const one = Array.isArray(k) ? k[0] : k
  return !(one instanceof Error) && offered.algo === one.type && offered.data.equals(one.getPublicSSH())
}

function startPeer(name: string, acceptKey: string, isJump: boolean): Promise<Peer> {
  const hostKey = utils.generateKeyPairSync('ed25519')
  const peer: Peer = { name, server: null as unknown as Server, port: 0, hostKey, logins: 0, live: [], forwards: [], limit: Infinity }
  peer.server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    peer.live.push(client)
    let open = 0
    client.on('authentication', (ctx) => {
      if (ctx.method !== 'publickey' || !pubMatches(ctx.key, acceptKey)) return ctx.reject(['publickey'])
      ctx.accept()
    })
    client.on('ready', () => {
      peer.logins++
      if (isJump) {
        client.on('tcpip', (accept, reject, info) => {
          peer.forwards.push(`${info.destIP}:${info.destPort}`)
          const up = net.connect(info.destPort, info.destIP)
          up.once('error', () => reject?.())
          up.once('connect', () => {
            const ch = accept()
            ch.on('close', () => up.destroy())
            up.on('close', () => ch.close())
            ch.pipe(up).pipe(ch)
          })
        })
      }
      client.on('session', (accept, reject) => {
        if (open >= peer.limit) return reject()
        open++
        const session = accept()
        session.on('close', () => open--)
        session.on('exec', (a, _r, info) => {
          const ch = a()
          if (info.command.startsWith('hang') || info.command.startsWith('hold')) return
          ch.write(`${name} ran: ${info.command}\n`)
          ch.exit(0)
          ch.end()
        })
      })
    })
    client.on('error', () => {})
  })
  return new Promise((r) =>
    peer.server.listen(0, '127.0.0.1', () => {
      peer.port = (peer.server.address() as AddressInfo).port
      r(peer)
    })
  )
}

let dir: string
let target: Peer
let jump1: Peer
let jump2: Peer
/** `ssh -G` per name — what each alias resolves to. Tests edit it. */
let config: Record<string, Partial<ResolvedHost>>
let asked: HostQuery[]

const kh = (): string => path.join(dir, 'known_hosts')

function base(port: number, user: string, id: string): ResolvedHost {
  return {
    hostname: '127.0.0.1',
    port,
    user,
    identityFiles: [path.join(dir, id)],
    identitiesOnly: true,
    userKnownHostsFiles: [kh()],
    globalKnownHostsFiles: [],
    strictHostKeyChecking: 'ask'
  }
}

function mux(): NativeMux {
  const m = new NativeMux({
    defaultAgent: () => undefined,
    resolveHost: async (q) => {
      asked.push(q)
      const c = config[q.host]
      if (!c) throw new Error(`no config for ${q.host}`)
      return { ...(c as ResolvedHost), ...(q.user ? { user: q.user } : {}), ...(q.port ? { port: q.port } : {}) }
    }
  })
  muxes.push(m)
  return m
}

const conn = (): SshConnection => ({ user: 'dev', host: 'target.test', port: target.port, identityFile: path.join(dir, 'id') })
const CP = (): string => path.join(dir, 'cm.sock')
const exec = (cmd: string) => {
  const p = parseSshArgv(childArgs(conn(), CP(), cmd))
  if (p.kind !== 'exec') throw new Error('not exec')
  return p
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-native-jump-'))
  fs.writeFileSync(path.join(dir, 'id'), clientKey.private)
  fs.writeFileSync(path.join(dir, 'jump_id'), jumpKey.private)
  fs.writeFileSync(path.join(dir, 'stranger_id'), strangerKey.private)
  target = await startPeer('target', clientKey.public, false)
  jump1 = await startPeer('jump1', jumpKey.public, true)
  jump2 = await startPeer('jump2', jumpKey.public, true)
})
afterAll(() => {
  for (const p of [target, jump1, jump2]) p.server.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
const muxes: NativeMux[] = []
beforeEach(() => {
  fs.rmSync(kh(), { force: true })
  asked = []
  for (const p of [target, jump1, jump2]) {
    p.logins = 0
    p.forwards = []
    p.limit = Infinity
  }
  config = {
    'target.test': { ...base(target.port, 'dev', 'id'), proxyJump: 'ops@jump1' },
    jump1: base(jump1.port, 'ops', 'jump_id'),
    jump2: base(jump2.port, 'ops', 'jump_id')
  }
})
afterEach(() => {
  for (const m of muxes.splice(0)) m.exitAll()
  for (const p of [target, jump1, jump2]) for (const c of p.live.splice(0)) c.end()
})

describe('NativeMux over a ProxyJump chain', () => {
  it('reaches the target through the jump, each hop with its own identity and host key', async () => {
    const m = mux()
    const r = await m.exec(exec('echo hi'))
    expect(r.stderr.toString()).toBe('')
    expect(r.stdout.toString()).toBe('target ran: echo hi\n')
    expect(jump1.forwards).toEqual([`127.0.0.1:${target.port}`])
    expect(jump1.logins).toBe(1)
    // The hop was resolved by its own `ssh -G`, with only what the spec named — never the
    // target's -i (OpenSSH does not pass it to its jump ssh either).
    expect(asked.find((q) => q.host === 'jump1')).toEqual({ user: 'ops', host: 'jump1', port: undefined })
    // Both host keys were recorded, each under its own port.
    const known = fs.readFileSync(kh(), 'utf8')
    expect(known).toContain(`[127.0.0.1]:${jump1.port} ssh-ed25519`)
    expect(known).toContain(`[127.0.0.1]:${target.port} ssh-ed25519`)
    // Shared, like any master: a second command neither logs in again nor re-crosses the jump.
    await m.exec(exec('echo again'))
    expect(jump1.logins).toBe(1)
    expect(jump1.forwards).toHaveLength(1)
  })

  it('refuses a CHANGED host key on the jump, before the target is ever reached', async () => {
    fs.writeFileSync(kh(), `[127.0.0.1]:${jump1.port} ${utils.generateKeyPairSync('ed25519').public}\n`)
    const r = await mux().exec(exec('echo hi'))
    expect(r.code).toBe(255)
    expect(r.stderr.toString()).toMatch(/jump host jump1: .*REMOTE HOST IDENTIFICATION HAS CHANGED/)
    expect(target.logins).toBe(0)
    expect(jump1.forwards).toEqual([])
  })

  it('reports an auth failure on the jump as the jump\'s', async () => {
    config.jump1 = base(jump1.port, 'ops', 'stranger_id')
    const r = await mux().exec(exec('echo hi'))
    expect(r.code).toBe(255)
    expect(r.stderr.toString()).toMatch(/jump host jump1: ops@jump1: Permission denied \(publickey\)/)
    expect(target.logins).toBe(0)
  })

  it('a jump that drops ends the target\'s channels with 255', async () => {
    const m = mux()
    const pending = m.exec(exec('hang'))
    await new Promise((r) => setTimeout(r, 150))
    expect(m.check(CP())).toBe(true)
    for (const c of jump1.live) c.end()
    const d = await pending
    expect(d.code).toBe(255)
    await new Promise((r) => setTimeout(r, 50))
    expect(m.check(CP())).toBe(false)
  })

  it('crosses a 2-hop chain in order, and ignores a LATER hop\'s own ProxyJump (as OpenSSH -J does)', async () => {
    config['target.test'].proxyJump = 'jump1,ops@[127.0.0.1]:' + jump2.port
    config['127.0.0.1'] = { ...base(jump2.port, 'ops', 'jump_id'), proxyJump: 'jump2' } // would loop if followed
    const r = await mux().exec(exec('echo two'))
    expect(r.stdout.toString()).toBe('target ran: echo two\n')
    expect(jump1.forwards).toEqual([`127.0.0.1:${jump2.port}`])
    expect(jump2.forwards).toEqual([`127.0.0.1:${target.port}`])
    expect(jump2.logins).toBe(1)
  })

  it('follows the FIRST hop\'s own ProxyJump, and refuses a loop', async () => {
    config['target.test'].proxyJump = 'jump2'
    config.jump2 = { ...base(jump2.port, 'ops', 'jump_id'), proxyJump: 'jump1' }
    const r = await mux().exec(exec('echo nested'))
    expect(r.stdout.toString()).toBe('target ran: echo nested\n')
    expect(jump1.forwards).toEqual([`127.0.0.1:${jump2.port}`])
    expect(jump2.forwards).toEqual([`127.0.0.1:${target.port}`])

    config.jump1 = { ...base(jump1.port, 'ops', 'jump_id'), proxyJump: 'jump2' }
    const loop = await mux().exec(exec('echo loop'))
    expect(loop.code).toBe(255)
    expect(loop.stderr.toString()).toMatch(/ProxyJump loop/)
  })

  it('refuses a ProxyCommand on a jump by name', async () => {
    config.jump1 = { ...base(jump1.port, 'ops', 'jump_id'), proxyCommand: 'nc %h %p' }
    const r = await mux().exec(exec('echo hi'))
    expect(r.code).toBe(255)
    expect(r.stderr.toString()).toMatch(/ProxyCommand is not supported .*jump host jump1/)
  })

  it('overflow connections (MaxSessions spill) reuse the primary\'s jump chain', async () => {
    target.limit = 1
    const m = mux()
    const a = await m.channel(exec('hold a'))
    const b = await m.channel(exec('hold b'))
    expect(m.connectionCount(CP())).toBe(2)
    expect(target.logins).toBe(2)
    expect(jump1.logins).toBe(1) // one bastion login, two forwards over it
    expect(jump1.forwards).toHaveLength(2)
    a.close()
    b.close()
  })
})

describe('parseProxyJump', () => {
  it('reads the forms OpenSSH accepts and `ssh -G` prints', () => {
    expect(parseProxyJump('bastion')).toEqual([{ user: undefined, host: 'bastion', port: undefined }])
    expect(parseProxyJump('ops@bastion:2222,[10.0.0.5]:22')).toEqual([
      { user: 'ops', host: 'bastion', port: 2222 },
      { user: undefined, host: '10.0.0.5', port: 22 }
    ])
    expect(parseProxyJump('ssh://me@[::1]:22')).toEqual([{ user: 'me', host: '::1', port: 22 }])
    expect(parseProxyJump('a@b@host')).toEqual([{ user: 'a@b', host: 'host', port: undefined }])
  })

  it('refuses what it cannot read rather than guessing', () => {
    for (const bad of ['', 'a,,b', 'host:0', 'host:99999', 'host:x', '::1', '[::1', '-oProxyCommand=x', 'ssh://h/path', '@host']) {
      expect(() => parseProxyJump(bad), bad).toThrow(/invalid ProxyJump/)
    }
  })

  it('a hop is asked of `ssh -G` with only what its spec named', () => {
    expect(sshGArgs({ host: 'bastion' })).toEqual(['-G', 'bastion'])
    expect(sshGArgs({ user: 'ops', host: 'bastion', port: 2222 })).toEqual(['-G', '-p', '2222', '-l', 'ops', 'bastion'])
    expect(() => sshGArgs({ host: '-oProxyCommand=x' })).toThrow()
  })
})

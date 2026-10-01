// The native transport against a REAL SSH protocol peer: ssh2's own Server, in-process, on
// loopback. No sshd, no Docker, so it runs identically on the macOS, Linux and windows-latest CI
// legs — which is the point: this transport exists for Windows.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { AddressInfo } from 'net'
import { Server, utils, type Connection } from 'ssh2'
import { NativeMux, noMasterMessage } from './native-mux'
import { parseSshArgv } from './ssh-argv'
import { childArgs, masterRoundTripArgs, remoteTmuxPtyArgs } from '../control-master'
import type { ResolvedHost } from './ssh-config'
import type { SshConnection } from '../../../shared/ssh'

const hostKey = utils.generateKeyPairSync('ed25519')
const otherHostKey = utils.generateKeyPairSync('ed25519')
const clientKey = utils.generateKeyPairSync('ed25519')
const lockedKey = utils.generateKeyPairSync('ed25519', { passphrase: 'open sesame', cipher: 'aes256-cbc', rounds: 4 })

let dir: string
let server: Server
let port: number
let connections = 0
let live: Connection[] = []
let serverHostKey = hostKey.private

function pubMatches(offered: { algo: string; data: Buffer }, pub: string): boolean {
  const k = utils.parseKey(pub)
  const one = Array.isArray(k) ? k[0] : k
  return !(one instanceof Error) && offered.algo === one.type && offered.data.equals(one.getPublicSSH())
}

function startServer(): Promise<void> {
  server = new Server({ hostKeys: [serverHostKey] }, (client) => {
    connections++
    live.push(client)
    client.on('authentication', (ctx) => {
      if (ctx.method !== 'publickey') return ctx.reject(['publickey'])
      const ok = pubMatches(ctx.key, clientKey.public) || pubMatches(ctx.key, lockedKey.public)
      if (!ok) return ctx.reject(['publickey'])
      if (!ctx.signature) return ctx.accept() // key-ok probe
      ctx.accept()
    })
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        let ptyInfo: { cols: number; rows: number } | undefined
        session.on('pty', (acceptPty, _reject, info) => {
          ptyInfo = { cols: info.cols, rows: info.rows }
          acceptPty?.()
        })
        session.on('exec', (acceptExec, _reject, info) => {
          const ch = acceptExec()
          const cmd = info.command
          if (cmd === 'cat') {
            const chunks: Buffer[] = []
            ch.on('data', (d: Buffer) => chunks.push(d))
            ch.on('end', () => {
              ch.write(Buffer.concat(chunks))
              ch.exit(0)
              ch.end()
            })
            return
          }
          if (cmd === 'hang') return // never answers
          if (cmd.startsWith('fail ')) {
            ch.stderr.write('boom\n')
            ch.exit(Number(cmd.slice(5)))
            return ch.end()
          }
          if (ptyInfo) ch.write(`pty ${ptyInfo.cols}x${ptyInfo.rows}\r\n`)
          ch.write(`ran: ${cmd}\n`)
          ch.exit(0)
          ch.end()
        })
      })
    })
    client.on('error', () => {})
  })
  return new Promise((r) =>
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port
      r()
    })
  )
}

function host(): ResolvedHost {
  return {
    hostname: '127.0.0.1',
    port,
    user: 'dev',
    identityFiles: [path.join(dir, 'id')],
    identitiesOnly: true,
    userKnownHostsFiles: [path.join(dir, 'known_hosts')],
    globalKnownHostsFiles: [],
    strictHostKeyChecking: 'ask'
  }
}

function mux(extra: Partial<ConstructorParameters<typeof NativeMux>[0]> = {}): NativeMux {
  return new NativeMux({ resolveHost: async () => host(), defaultAgent: () => undefined, ...extra })
}

const conn = (): SshConnection => ({ user: 'dev', host: '127.0.0.1', port, identityFile: path.join(dir, 'id') })
const CP = (): string => path.join(dir, 'cm.sock')
const exec = (cmd: string) => {
  const p = parseSshArgv(childArgs(conn(), CP(), cmd))
  if (p.kind !== 'exec') throw new Error('not exec')
  return p
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-native-'))
  fs.writeFileSync(path.join(dir, 'id'), clientKey.private)
  await startServer()
})
afterAll(() => {
  server.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
const muxes: NativeMux[] = []
afterEach(() => {
  for (const m of muxes.splice(0)) m.exitAll()
  for (const c of live.splice(0)) c.end()
})
const track = (m: NativeMux): NativeMux => (muxes.push(m), m)

describe('NativeMux over a real SSH protocol peer', () => {
  it('shares ONE connection across many commands (ControlMaster=auto)', async () => {
    const m = track(mux())
    const before = connections
    const results = await Promise.all([1, 2, 3, 4, 5].map((i) => m.exec(exec(`echo ${i}`))))
    expect(results.map((r) => r.stdout.toString())).toEqual([1, 2, 3, 4, 5].map((i) => `ran: echo ${i}\n`))
    expect(results.every((r) => r.code === 0)).toBe(true)
    expect(connections - before).toBe(1)
    expect(m.check(CP())).toBe(true)
  })

  it('pipes stdin, and reports exit code and stderr', async () => {
    const m = track(mux())
    const r = await m.exec(exec('cat'), { stdin: 'hello\nworld' })
    expect(r.stdout.toString()).toBe('hello\nworld')
    const f = await m.exec(exec('fail 3'))
    expect(f.code).toBe(3)
    expect(f.stderr.toString()).toBe('boom\n')
  })

  it('-O exit closes it; ControlMaster=no then never re-creates the shared one', async () => {
    const m = track(mux())
    await m.exec(exec('echo up'))
    expect(await m.exit(CP())).toBe(true)
    expect(m.check(CP())).toBe(false)
    const rt = parseSshArgv(masterRoundTripArgs(conn(), CP()))
    if (rt.kind !== 'exec') throw new Error()
    const r = await m.exec(rt)
    // One-off connection, like OpenSSH's direct fallback — and still no shared master afterwards.
    expect(r.code).toBe(0)
    expect(m.check(CP())).toBe(false)
  })

  it('times a command out like execFile, and a dropped connection ends channels with 255', async () => {
    const m = track(mux())
    const t = await m.exec(exec('hang'), { timeoutMs: 300 })
    expect(t.timedOut).toBe(true)
    const pending = m.exec(exec('hang'))
    await new Promise((r) => setTimeout(r, 100))
    for (const c of live) c.end()
    const d = await pending
    expect(d.code).toBe(255)
    expect(m.check(CP())).toBe(false)
  })

  it('opens a pty channel with the requested size', async () => {
    const m = track(mux())
    const p = parseSshArgv(remoteTmuxPtyArgs(conn(), CP(), 'nt-x', '~'))
    if (p.kind !== 'exec') throw new Error()
    const ch = await m.shell(p, { cols: 132, rows: 43 })
    const out = await new Promise<string>((resolve) => {
      let s = ''
      ch.on('data', (d: Buffer) => (s += d.toString()))
      ch.on('close', () => resolve(s))
    })
    expect(out).toContain('pty 132x43')
  })

  it('records a first-seen host key, then refuses a CHANGED one', async () => {
    const m = track(mux())
    await m.exec(exec('echo a'))
    expect(fs.readFileSync(path.join(dir, 'known_hosts'), 'utf8')).toContain(`[127.0.0.1]:${port} ssh-ed25519`)
    m.exitAll()
    server.close()
    serverHostKey = otherHostKey.private
    await startServer() // new port → rewrite the known_hosts entry under the new port name
    const kh = path.join(dir, 'known_hosts')
    const text = fs.readFileSync(kh, 'utf8').replace(/\[127\.0\.0\.1\]:\d+/, `[127.0.0.1]:${port}`)
    fs.writeFileSync(kh, text)
    const r = await track(mux()).exec(exec('echo b'))
    expect(r.code).toBe(255)
    expect(r.stderr.toString()).toMatch(/REMOTE HOST IDENTIFICATION HAS CHANGED/)
  })

  it('asks for a passphrase for an encrypted key — but never in BatchMode', async () => {
    fs.rmSync(path.join(dir, 'known_hosts'), { force: true })
    fs.writeFileSync(path.join(dir, 'id'), lockedKey.private)
    try {
      const asked: string[] = []
      const m = track(
        mux({
          askPassphrase: async (f) => {
            asked.push(f)
            return asked.length === 1 ? 'wrong' : 'open sesame'
          }
        })
      )
      const r = await m.exec(exec('echo locked'))
      expect(r.stdout.toString()).toBe('ran: echo locked\n')
      expect(asked).toHaveLength(2)

      const batch = track(mux({ askPassphrase: async () => 'open sesame' }))
      const rt = parseSshArgv(masterRoundTripArgs(conn(), path.join(dir, 'other.sock')))
      if (rt.kind !== 'exec') throw new Error()
      const b = await batch.exec(rt)
      expect(b.code).toBe(255)
      expect(b.stderr.toString()).toMatch(/Permission denied/)
    } finally {
      fs.writeFileSync(path.join(dir, 'id'), clientKey.private)
    }
  })

  it('offers a freshly unlocked key to the agent AFTER it authenticated — once, fail-open', async () => {
    fs.rmSync(path.join(dir, 'known_hosts'), { force: true })
    fs.writeFileSync(path.join(dir, 'id'), lockedKey.private)
    try {
      const asked: { agentPath: string; identityFile: string }[] = []
      const added: { agentPath: string; type: string; comment: string; lifetimeSec?: number }[] = []
      // IdentitiesOnly with no id.pub: the agent step is skipped (nothing to filter to), so the
      // key file is what authenticates — the case the add exists for.
      const m = track(
        mux({
          defaultAgent: () => '/fake/agent.sock',
          askPassphrase: async () => 'open sesame',
          agentAdd: (req) => {
            asked.push({ agentPath: req.agentPath, identityFile: req.identityFile })
            return { lifetimeSec: 600 }
          },
          addKeyToAgent: async (agentPath, key, comment, opts) => {
            added.push({ agentPath, type: key.type, comment, lifetimeSec: opts?.lifetimeSec })
            return 'added'
          }
        })
      )
      expect((await m.exec(exec('echo one'))).code).toBe(0)
      expect((await m.exec(exec('echo two'))).code).toBe(0)
      await new Promise((r) => setTimeout(r, 20))
      expect(asked).toEqual([{ agentPath: '/fake/agent.sock', identityFile: path.join(dir, 'id') }])
      expect(added).toEqual([{ agentPath: '/fake/agent.sock', type: 'ssh-ed25519', comment: path.join(dir, 'id'), lifetimeSec: 600 }])

      // A policy that says no adds nothing; an agent that throws costs the connection nothing.
      const noAdd = track(
        mux({
          defaultAgent: () => '/fake/agent.sock',
          askPassphrase: async () => 'open sesame',
          agentAdd: () => null,
          addKeyToAgent: async () => {
            throw new Error('must not be called')
          }
        })
      )
      expect((await noAdd.exec(exec('echo three'))).code).toBe(0)
      const logs: string[] = []
      const broken = track(
        mux({
          defaultAgent: () => '/fake/agent.sock',
          askPassphrase: async () => 'open sesame',
          log: (l) => logs.push(l),
          agentAdd: () => {
            throw new Error('policy exploded')
          }
        })
      )
      expect((await broken.exec(exec('echo four'))).code).toBe(0)
      const failing = track(
        mux({
          defaultAgent: () => '/fake/agent.sock',
          askPassphrase: async () => 'open sesame',
          log: (l) => logs.push(l),
          agentAdd: () => ({}),
          addKeyToAgent: async () => {
            throw new Error('agent exploded')
          }
        })
      )
      expect((await failing.exec(exec('echo five'))).code).toBe(0)
      await new Promise((r) => setTimeout(r, 20))
      expect(logs.some((l) => /could not add .* to the ssh agent \(error\)/.test(l))).toBe(true)
    } finally {
      fs.writeFileSync(path.join(dir, 'id'), clientKey.private)
    }
  })

  it('never offers a key that needed no passphrase', async () => {
    let consulted = 0
    const m = track(
      mux({
        defaultAgent: () => '/fake/agent.sock',
        agentAdd: () => {
          consulted++
          return {}
        }
      })
    )
    expect((await m.exec(exec('echo plain'))).code).toBe(0)
    expect(consulted).toBe(0)
  })

  it('forward on a path with no connection fails the way ssh does', async () => {
    const m = track(mux())
    await expect(
      m.forward(CP(), { remoteSocket: '/r.sock', localHost: '127.0.0.1', localPort: 1 })
    ).rejects.toThrow(noMasterMessage(CP()))
  })
})

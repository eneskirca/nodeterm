import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AddressInfo } from 'net'
import { Server, utils, type Connection, type ServerChannel } from 'ssh2'
import { NativeMux } from './native-mux'
import { NativeSshPty } from './native-pty'
import { remoteTmuxPtyArgs } from '../control-master'
import type { SshConnection } from '../../../shared/ssh'

const hostKey = utils.generateKeyPairSync('ed25519')
const clientKey = utils.generateKeyPairSync('ed25519')
let dir: string
let server: Server
let port: number
let clients: Connection[] = []
/** The server side of the last pty channel, and the window sizes it was told. */
let serverCh: ServerChannel | null = null
const windows: string[] = []

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-native-pty-'))
  fs.writeFileSync(path.join(dir, 'id'), clientKey.private)
  server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    clients.push(client)
    client.on('authentication', (ctx) => (ctx.method === 'publickey' ? ctx.accept() : ctx.reject(['publickey'])))
    client.on('ready', () =>
      client.on('session', (accept) => {
        const session = accept()
        session.on('pty', (a, _r, info) => {
          windows.push(`${info.cols}x${info.rows}`)
          a?.()
        })
        session.on('window-change', (a, _r, info) => {
          windows.push(`${info.cols}x${info.rows}`)
          a?.()
        })
        session.on('exec', (a) => {
          const ch = a()
          serverCh = ch
          ch.write('ready\r\n')
          ch.on('data', (d: Buffer) => {
            const s = d.toString()
            if (s.includes('exit')) {
              ch.exit(7)
              ch.end()
            } else ch.write(`echo:${s}`)
          })
        })
      })
    )
    client.on('error', () => {})
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  port = (server.address() as AddressInfo).port
})
afterAll(() => {
  server.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
const muxes: NativeMux[] = []
afterEach(() => {
  for (const m of muxes.splice(0)) m.exitAll()
  for (const c of clients.splice(0)) c.end()
  windows.length = 0
  serverCh = null
})

function mux(): NativeMux {
  const m = new NativeMux({
    defaultAgent: () => undefined,
    resolveHost: async () => ({
      hostname: '127.0.0.1',
      port,
      user: 'dev',
      identityFiles: [path.join(dir, 'id')],
      identitiesOnly: true,
      userKnownHostsFiles: [path.join(dir, 'known_hosts')],
      globalKnownHostsFiles: [],
      strictHostKeyChecking: 'ask'
    })
  })
  muxes.push(m)
  return m
}
const conn = (): SshConnection => ({ user: 'dev', host: '127.0.0.1', port, identityFile: path.join(dir, 'id') })
const argv = (): string[] => remoteTmuxPtyArgs(conn(), path.join(dir, 'cm.sock'), 'nt-x', '~')
const until = async (f: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10))
}

describe('NativeSshPty (the IPty PtyManager holds for a remote terminal)', () => {
  it('queues writes made before the channel opens, relays both ways, resizes, and exits with the remote status', async () => {
    const p = new NativeSshPty(mux(), argv(), { cols: 100, rows: 30 })
    let out = ''
    let exit: number | null = null
    p.onData((d) => (out += d))
    p.onExit((e) => (exit = e.exitCode))
    p.write('early') // before the channel is open
    await until(() => out.includes('echo:early'))
    expect(out).toContain('ready')
    expect(out).toContain('echo:early')
    p.resize(120, 40)
    await until(() => windows.includes('120x40'))
    expect(windows[0]).toBe('100x30')
    expect(windows).toContain('120x40')
    p.write('exit')
    await until(() => exit !== null)
    expect(exit).toBe(7)
  })

  it('a dropped connection exits 255 — what SshReconnector reads as a transport drop', async () => {
    const p = new NativeSshPty(mux(), argv(), { cols: 80, rows: 24 })
    let exit: number | null = null
    p.onExit((e) => (exit = e.exitCode))
    await until(() => serverCh !== null)
    for (const c of clients) c.end()
    await until(() => exit !== null)
    expect(exit).toBe(255)
  })

  it('a connection that cannot come up prints the reason into the terminal and exits 255', async () => {
    const m = new NativeMux({
      defaultAgent: () => undefined,
      resolveHost: async () => {
        throw new Error('ssh -G failed for dev@nowhere: boom')
      }
    })
    muxes.push(m)
    const p = new NativeSshPty(m, argv(), { cols: 80, rows: 24 })
    let out = ''
    let exit: number | null = null
    p.onData((d) => (out += d))
    p.onExit((e) => (exit = e.exitCode))
    await until(() => exit !== null)
    expect(exit).toBe(255)
    expect(out).toMatch(/ssh -G failed/)
  })

  it('decodes a multi-byte character split across packets', async () => {
    const p = new NativeSshPty(mux(), argv(), { cols: 80, rows: 24 })
    let out = ''
    p.onData((d) => (out += d))
    await until(() => serverCh !== null && out.includes('ready'))
    const bytes = Buffer.from('ğ', 'utf8')
    serverCh!.write(bytes.subarray(0, 1))
    await new Promise((r) => setTimeout(r, 20))
    serverCh!.write(bytes.subarray(1))
    await until(() => out.includes('ğ'))
    expect(out).toContain('ğ')
    expect(out).not.toContain('�')
  })
})

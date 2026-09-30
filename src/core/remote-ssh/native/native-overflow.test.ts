// A server that refuses channels past a per-connection limit (sshd's MaxSessions — 10 on a stock
// host). MEASURED against a real host (MaxSessions 64): channel 65 onwards is answered at once with
// `(SSH) Channel open failure: open failed`. On the first live run of the native transport those
// terminals sat blank; OpenSSH answers the same refusal by logging in again per refused client.
// The transport now spills onto another connection instead — and is bounded.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AddressInfo } from 'net'
import { Server, utils, type Connection } from 'ssh2'
import { NativeMux } from './native-mux'
import { parseSshArgv } from './ssh-argv'
import { childArgs, remoteTmuxPtyArgs } from '../control-master'
import type { SshConnection } from '../../../shared/ssh'

const LIMIT = 3
const hostKey = utils.generateKeyPairSync('ed25519')
const clientKey = utils.generateKeyPairSync('ed25519')
let dir: string
let server: Server
let port: number
let logins = 0
const clients: Connection[] = []

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-native-ovf-'))
  fs.writeFileSync(path.join(dir, 'id'), clientKey.private)
  server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    clients.push(client)
    let open = 0
    client.on('authentication', (ctx) => (ctx.method === 'publickey' ? ctx.accept() : ctx.reject(['publickey'])))
    client.on('ready', () => {
      logins++
      client.on('session', (accept, reject) => {
        if (open >= LIMIT) return reject()
        open++
        const session = accept()
        session.on('close', () => open--)
        session.on('pty', (a) => a?.())
        session.on('exec', (a, _r, info) => {
          const ch = a()
          if (info.command.startsWith('hold')) {
            ch.write('held\r\n') // a terminal: stays open until the client ends
            return
          }
          ch.write(`ran: ${info.command}\n`)
          ch.exit(0)
          ch.end()
        })
      })
    })
    client.on('error', () => {})
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  port = (server.address() as AddressInfo).port
})
afterAll(() => {
  server.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
let m: NativeMux | null = null
afterEach(() => {
  m?.exitAll()
  m = null
  for (const c of clients.splice(0)) c.end()
})

function mux(): NativeMux {
  m = new NativeMux({
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
  return m
}
const conn = (): SshConnection => ({ user: 'dev', host: '127.0.0.1', port, identityFile: path.join(dir, 'id') })
const CP = (): string => path.join(dir, 'cm.sock')

describe('channels past the server MaxSessions spill onto more connections', () => {
  it('9 terminals on a limit-3 server all open, on 3 connections, and commands still run', async () => {
    const x = mux()
    logins = 0
    const pty = parseSshArgv(remoteTmuxPtyArgs(conn(), CP(), 'nt-a', '~'))
    if (pty.kind !== 'exec') throw new Error()
    const holdPty = { ...pty, command: 'hold' }
    const chans = await Promise.all(Array.from({ length: 9 }, () => x.shell(holdPty, { cols: 80, rows: 24 })))
    chans.forEach((c) => c.resume())
    expect(chans).toHaveLength(9)
    expect(x.connectionCount(CP())).toBe(3)
    // Every connection is full of terminals: a command must still run (a 4th connection).
    const p = parseSshArgv(childArgs(conn(), CP(), 'uname'))
    if (p.kind !== 'exec') throw new Error()
    const r = await x.exec(p)
    expect(r.code).toBe(0)
    expect(r.stdout.toString()).toBe('ran: uname\n')
    expect(x.connectionCount(CP())).toBe(4)
    expect(logins).toBe(4)
  })

  it('a closed channel frees its connection for the next open (no extra login)', async () => {
    const x = mux()
    const pty = parseSshArgv(remoteTmuxPtyArgs(conn(), CP(), 'nt-b', '~'))
    if (pty.kind !== 'exec') throw new Error()
    const hold = { ...pty, command: 'hold' }
    const chans = await Promise.all(Array.from({ length: LIMIT }, () => x.shell(hold, { cols: 80, rows: 24 })))
    // Consume, as NativeSshPty always does: a paused stream never emits 'close'.
    chans.forEach((c) => c.resume())
    expect(x.connectionCount(CP())).toBe(1)
    const closed = new Promise((r) => chans[0].once('close', r))
    chans[0].close()
    await closed
    const before = logins
    ;(await x.shell(hold, { cols: 80, rows: 24 })).resume()
    expect(x.connectionCount(CP())).toBe(1)
    expect(logins).toBe(before)
  })

  it('the overflow connections end with the primary (-O exit), as mux clients die with their master', async () => {
    const x = mux()
    const pty = parseSshArgv(remoteTmuxPtyArgs(conn(), CP(), 'nt-c', '~'))
    if (pty.kind !== 'exec') throw new Error()
    const hold = { ...pty, command: 'hold' }
    const chans = await Promise.all(Array.from({ length: 5 }, () => x.shell(hold, { cols: 80, rows: 24 })))
    // Consume, as NativeSshPty always does: a paused stream never emits 'close'.
    chans.forEach((c) => c.resume())
    expect(x.connectionCount(CP())).toBe(2)
    const allClosed = Promise.all(chans.map((c) => new Promise((r) => c.once('close', r))))
    await x.exit(CP())
    await allClosed
    expect(x.connectionCount(CP())).toBe(0)
  })
})

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import net, { type AddressInfo } from 'net'
import path from 'path'
import { Server, utils, type Connection } from 'ssh2'
import { NativeMux } from './native-mux'
import { runSshArgv, spawnSshArgvStream, startNativeMaster, useNativeSsh } from './native-invoke'
import {
  checkMasterArgs,
  childArgs,
  exitMasterArgs,
  hookForwardArgs,
  hookForwardCancelArgs,
  masterArgs
} from '../control-master'
import type { SshConnection } from '../../../shared/ssh'

const hostKey = utils.generateKeyPairSync('ed25519')
const clientKey = utils.generateKeyPairSync('ed25519')

let dir: string
let server: Server
let port: number
let clients: Connection[] = []
/** Remote socket path → the server-side client that asked for it (to push a connection back). */
const streamForwards = new Map<string, Connection>()

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-native-inv-'))
  fs.writeFileSync(path.join(dir, 'id'), clientKey.private)
  server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    clients.push(client)
    client.on('authentication', (ctx) => (ctx.method === 'publickey' ? ctx.accept() : ctx.reject(['publickey'])))
    client.on('ready', () => {
      // @types/ssh2 only types the tcpip names, but the server does emit the OpenSSH streamlocal ones.
      client.on('request', (accept, reject, rawName, info) => {
        const name = rawName as string
        const socketPath = (info as unknown as { socketPath?: string }).socketPath
        if (name === 'streamlocal-forward@openssh.com' && socketPath) {
          streamForwards.set(socketPath, client)
          return accept?.()
        }
        if (name === 'cancel-streamlocal-forward@openssh.com' && socketPath) {
          streamForwards.delete(socketPath)
          return accept?.()
        }
        reject?.()
      })
      client.on('session', (accept) => {
        accept().on('exec', (a, _r, info) => {
          const ch = a()
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
const muxes: NativeMux[] = []
afterEach(() => {
  for (const m of muxes.splice(0)) m.exitAll()
  for (const c of clients.splice(0)) c.end()
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
const CP = (): string => path.join(dir, 'cm.sock')

describe('native-invoke', () => {
  it('useNativeSsh: always on win32, opt-in elsewhere, opt-out anywhere', () => {
    expect(useNativeSsh('win32', {})).toBe(true)
    expect(useNativeSsh('darwin', {})).toBe(false)
    expect(useNativeSsh('linux', { NODETERM_NATIVE_SSH: '1' })).toBe(true)
    expect(useNativeSsh('win32', { NODETERM_NATIVE_SSH: '0' })).toBe(false)
  })

  it('a master pseudo-process: -O check answers once it is up, -O exit ends it and it "exits"', async () => {
    const m = mux()
    expect((await runSshArgv(m, checkMasterArgs(conn(), CP()))).code).toBe(255)
    const master = startNativeMaster(m, masterArgs(conn(), CP()))
    const exitCode = new Promise<number | null>((r) => master.on('exit', (c) => r(c as number | null)))
    for (let i = 0; i < 100 && (await runSshArgv(m, checkMasterArgs(conn(), CP()))).code !== 0; i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    const check = await runSshArgv(m, checkMasterArgs(conn(), CP()))
    expect(check.code).toBe(0)
    expect(check.stderr.toString()).toMatch(/Master running/)
    const r = await runSshArgv(m, childArgs(conn(), CP(), 'uname'))
    expect(r.stdout.toString()).toBe('ran: uname\n')
    expect((await runSshArgv(m, exitMasterArgs(conn(), CP()))).code).toBe(0)
    expect(await exitCode).toBe(255)
    expect(master.exited()).toBe(true)
  })

  it('a master that cannot authenticate exits with the reason on stderr', async () => {
    const m = mux()
    const bad: SshConnection = { ...conn(), identityFile: path.join(dir, 'missing') }
    const master = startNativeMaster(m, masterArgs(bad, CP()))
    await new Promise<void>((r) => master.on('exit', () => r()))
    expect(master.stderr()).toMatch(/Permission denied/)
  })

  it('-O forward carries a remote unix-socket connection to the local TCP port; -O cancel removes it', async () => {
    const got: string[] = []
    const local = net.createServer((s) => s.on('data', (d) => got.push(d.toString())))
    await new Promise<void>((r) => local.listen(0, '127.0.0.1', () => r()))
    const localPort = (local.address() as AddressInfo).port
    try {
      const m = mux()
      await runSshArgv(m, childArgs(conn(), CP(), 'true')) // bring the shared connection up
      const remoteSock = '/home/dev/.nodeterm/hook-test.sock'
      expect((await runSshArgv(m, hookForwardArgs(conn(), CP(), remoteSock, localPort))).code).toBe(0)
      const srv = streamForwards.get(remoteSock)
      expect(srv).toBeDefined()
      await new Promise<void>((resolve, reject) =>
        srv!.openssh_forwardOutStreamLocal(remoteSock, (err, ch) => {
          if (err) return reject(err)
          ch.end('POST /hook')
          resolve()
        })
      )
      for (let i = 0; i < 50 && got.join('') !== 'POST /hook'; i++) await new Promise((r) => setTimeout(r, 20))
      expect(got.join('')).toBe('POST /hook')
      expect((await runSshArgv(m, hookForwardCancelArgs(conn(), CP(), remoteSock, localPort))).code).toBe(0)
      expect(streamForwards.has(remoteSock)).toBe(false)
    } finally {
      local.close()
    }
  })

  it('a streaming child (the setup runner): output as it arrives, then close with the status', async () => {
    const child = spawnSshArgvStream(mux(), childArgs(conn(), CP(), 'setup.sh'))
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    const code = await new Promise<number>((r) => child.on('close', r))
    expect(err).toBe('')
    expect(code).toBe(0)
    expect(out).toBe('ran: setup.sh\n')
  })

  it('a streaming child killed before it opens closes with 255 and runs nothing', async () => {
    const child = spawnSshArgvStream(mux(), childArgs(conn(), CP(), 'setup.sh'))
    child.kill('SIGKILL')
    const code = await new Promise<number>((r) => child.on('close', r))
    expect(code).toBe(255)
  })

  it('a streaming child killed before its open FAILS never writes to its ended pipes', async () => {
    // CI caught this as an uncaught ERR_STREAM_WRITE_AFTER_END: kill() closed the child, then the
    // connection failed and the error path wrote to the ended stderr.
    const failing = new NativeMux({
      defaultAgent: () => undefined,
      resolveHost: () => new Promise((_r, reject) => setTimeout(() => reject(new Error('late failure')), 30))
    })
    muxes.push(failing)
    const uncaught: unknown[] = []
    const onErr = (e: unknown): void => void uncaught.push(e)
    process.on('uncaughtException', onErr)
    try {
      const child = spawnSshArgvStream(failing, childArgs(conn(), path.join(dir, 'late.sock'), 'x'))
      child.kill('SIGKILL')
      expect(await new Promise<number>((r) => child.on('close', r))).toBe(255)
      await new Promise((r) => setTimeout(r, 80)) // past the late failure
      expect(uncaught).toEqual([])
    } finally {
      process.off('uncaughtException', onErr)
    }
  })

  it('an argv the parser refuses is a named exit 255, not a guess', async () => {
    const r = await runSshArgv(mux(), ['-L', '1:h:2', 'dev@127.0.0.1'])
    expect(r.code).toBe(255)
    expect(r.stderr.toString()).toMatch(/unsupported ssh argument -L/)
  })
})

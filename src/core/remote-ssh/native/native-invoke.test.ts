import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import net, { type AddressInfo } from 'net'
import path from 'path'
import { Server, type Connection } from 'ssh2'
import { NativeMux } from './native-mux'
import { download, runSshArgv, spawnSshArgvStream, startNativeMaster, useNativeSsh } from './native-invoke'
import {
  checkMasterArgs,
  childArgs,
  exitMasterArgs,
  hookForwardArgs,
  hookForwardCancelArgs,
  localForwardArgs,
  localForwardCancelArgs,
  masterArgs
} from '../control-master'
import type { SshConnection } from '../../../shared/ssh'
import { ed25519KeyPair } from './test-keys'

const hostKey = ed25519KeyPair()
const clientKey = ed25519KeyPair()

let dir: string
let server: Server
let port: number
let clients: Connection[] = []
/** Remote socket path → the server-side client that asked for it (to push a connection back). */
const streamForwards = new Map<string, Connection>()
/** Every direct-tcpip open the server saw, as `addr:port`. */
const tcpipOpens: string[] = []

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
      // direct-tcpip (`-L`): dial the destination on this loopback "host" and splice.
      client.on('tcpip', (accept, reject, info) => {
        tcpipOpens.push(`${info.destIP}:${info.destPort}`)
        const out = net.connect({ host: info.destIP, port: info.destPort })
        out.once('error', () => reject?.())
        out.once('connect', () => {
          const ch = accept()
          ch.on('error', () => out.destroy())
          ch.pipe(out).pipe(ch)
        })
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

  describe('-O forward -L (dev-server port forwarding)', () => {
    const echo = (): Promise<{ srv: net.Server; port: number }> =>
      new Promise((r) => {
        const srv = net.createServer((s) => s.pipe(s))
        srv.listen(0, '127.0.0.1', () => r({ srv, port: (srv.address() as AddressInfo).port }))
      })
    const freePort = (): Promise<number> =>
      new Promise((r) => {
        const s = net.createServer()
        s.listen(0, '127.0.0.1', () => {
          const p = (s.address() as AddressInfo).port
          s.close(() => r(p))
        })
      })
    const roundTrip = (lport: number, text: string): Promise<string> =>
      new Promise((resolve, reject) => {
        const c = net.connect({ host: '127.0.0.1', port: lport })
        let got = ''
        c.on('data', (d) => {
          got += d.toString()
          if (got.length >= text.length) {
            c.end()
            resolve(got)
          }
        })
        c.on('error', reject)
        c.write(text)
      })
    const canListen = (p: number): Promise<boolean> =>
      new Promise((r) => {
        const s = net.createServer()
        s.once('error', () => r(false))
        s.listen(p, '127.0.0.1', () => s.close(() => r(true)))
      })

    it('carries a local loopback connection to the host port, built and parsed by the real builders', async () => {
      const { srv, port: remotePort } = await echo()
      try {
        const m = mux()
        await runSshArgv(m, childArgs(conn(), CP(), 'true'))
        const lport = await freePort()
        const fwd = await runSshArgv(m, localForwardArgs(conn(), CP(), lport, '127.0.0.1', remotePort))
        expect(fwd.code).toBe(0)
        expect(await roundTrip(lport, 'hello dev server')).toBe('hello dev server')
        expect(tcpipOpens).toContain(`127.0.0.1:${remotePort}`)
        // A duplicate is acknowledged again (the registry's 'maybe-ours' adoption depends on it).
        expect((await runSshArgv(m, localForwardArgs(conn(), CP(), lport, '127.0.0.1', remotePort))).code).toBe(0)
        expect(await canListen(lport)).toBe(false)
        // Cancel frees the port; a cancel of what is not held is not an error.
        expect((await runSshArgv(m, localForwardCancelArgs(conn(), CP(), lport, '127.0.0.1', remotePort))).code).toBe(0)
        expect(await canListen(lport)).toBe(true)
        expect((await runSshArgv(m, localForwardCancelArgs(conn(), CP(), lport, '127.0.0.1', remotePort))).code).toBe(0)
      } finally {
        srv.close()
      }
    })

    it('two concurrent requests for one spec are both acknowledged (one listener, not a self-race)', async () => {
      const { srv, port: remotePort } = await echo()
      try {
        const m = mux()
        await runSshArgv(m, childArgs(conn(), CP(), 'true'))
        const lport = await freePort()
        const args = localForwardArgs(conn(), CP(), lport, '127.0.0.1', remotePort)
        const [a, b] = await Promise.all([runSshArgv(m, args), runSshArgv(m, args)])
        expect([a.code, b.code]).toEqual([0, 0])
        expect(await roundTrip(lport, 'both')).toBe('both')
        expect((await runSshArgv(m, localForwardCancelArgs(conn(), CP(), lport, '127.0.0.1', remotePort))).code).toBe(0)
        expect(await canListen(lport)).toBe(true)
      } finally {
        srv.close()
      }
    })

    it('a port someone else holds is OpenSSH\'s "Port forwarding failed", exit 255', async () => {
      const m = mux()
      await runSshArgv(m, childArgs(conn(), CP(), 'true'))
      const foreign = net.createServer()
      await new Promise<void>((r) => foreign.listen(0, '127.0.0.1', () => r()))
      const busy = (foreign.address() as AddressInfo).port
      try {
        const r = await runSshArgv(m, localForwardArgs(conn(), CP(), busy, '127.0.0.1', 1))
        expect(r.code).toBe(255)
        expect(r.stderr.toString()).toMatch(/Port forwarding failed/)
      } finally {
        foreign.close()
      }
    })

    it('without a master it fails like ssh; a dropped or exited master releases its listeners', async () => {
      const m = mux()
      const lport = await freePort()
      const none = await runSshArgv(m, localForwardArgs(conn(), CP(), lport, '127.0.0.1', 1))
      expect(none.code).toBe(255)
      expect(none.stderr.toString()).toMatch(/Control socket connect/)

      await runSshArgv(m, childArgs(conn(), CP(), 'true'))
      expect((await runSshArgv(m, localForwardArgs(conn(), CP(), lport, '127.0.0.1', 1))).code).toBe(0)
      expect(await canListen(lport)).toBe(false)
      for (const c of clients) c.end() // the host drops the connection
      for (let i = 0; i < 50 && !(await canListen(lport)); i++) await new Promise((r) => setTimeout(r, 20))
      expect(await canListen(lport)).toBe(true)

      const lport2 = await freePort()
      await runSshArgv(m, childArgs(conn(), CP(), 'true'))
      expect((await runSshArgv(m, localForwardArgs(conn(), CP(), lport2, '127.0.0.1', 1))).code).toBe(0)
      expect((await runSshArgv(m, exitMasterArgs(conn(), CP()))).code).toBe(0)
      expect(await canListen(lport2)).toBe(true)
    })
  })

  it('an argv the parser refuses is a named exit 255, not a guess', async () => {
    const r = await runSshArgv(mux(), ['-L', '1:h:2', 'dev@127.0.0.1'])
    expect(r.code).toBe(255)
    expect(r.stderr.toString()).toMatch(/unsupported ssh argument -L/)
  })
})

describe('download() — a remote tree onto a Windows filesystem', () => {
  // A fake SFTP over an in-memory POSIX tree: names Windows cannot hold, and two that collide.
  const tree: Record<string, string[] | string> = {
    '/r': ['.', '..', 'a:b', 'a_b', 'CON', 'notes. ', 'sub'],
    '/r/a:b': 'colon',
    '/r/a_b': 'underscore',
    '/r/CON': 'device',
    '/r/notes. ': 'dots',
    '/r/sub': ['Foo', 'foo', 'ok.txt'],
    '/r/sub/Foo': 'upper',
    '/r/sub/foo': 'lower',
    '/r/sub/ok.txt': 'fine'
  }
  type Cb<T> = (err: Error | undefined, v: T) => void
  const sftp = {
    stat: (p: string, cb: Cb<{ isDirectory(): boolean }>) =>
      p in tree ? cb(undefined, { isDirectory: () => Array.isArray(tree[p]) }) : cb(new Error(`no ${p}`), undefined as never),
    readdir: (p: string, cb: Cb<{ filename: string }[]>) => cb(undefined, (tree[p] as string[]).map((filename) => ({ filename }))),
    fastGet: (r: string, l: string, cb: (err?: Error) => void) => {
      fs.writeFileSync(l, tree[r] as string)
      cb()
    }
  } as unknown as Parameters<typeof download>[0]

  const files = (root: string): Record<string, string> => {
    const out: Record<string, string> = {}
    const walk = (d: string, rel: string): void => {
      // The entry's type comes from the listing itself (no stat-then-read on the path — CodeQL
      // js/file-system-race), which is also what a test over a temp tree needs.
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name)
        if (e.isDirectory()) walk(full, `${rel}${e.name}/`)
        else out[`${rel}${e.name}`] = fs.readFileSync(full, 'utf8')
      }
    }
    walk(root, '')
    return out
  }

  it('win32: every child gets a legal, unique name, and the renames are counted', async () => {
    const local = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-dl-'))
    try {
      const renamed = { count: 0 }
      await download(sftp, '/r', path.join(local, 'r'), true, 'win32', renamed)
      expect(files(path.join(local, 'r'))).toEqual({
        a_b: 'colon',
        'a_b (2)': 'underscore',
        _CON: 'device',
        notes: 'dots',
        'sub/Foo': 'upper',
        'sub/foo (2)': 'lower',
        'sub/ok.txt': 'fine'
      })
      // a:b, a_b (displaced), CON, `notes. `, foo.
      expect(renamed.count).toBe(5)
    } finally {
      fs.rmSync(local, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('POSIX: the tree lands byte-for-byte as named', async () => {
    // Not runnable on Windows: the point is names that Windows cannot create.
    const local = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-dl-'))
    try {
      const renamed = { count: 0 }
      await download(sftp, '/r', path.join(local, 'r'), true, 'linux', renamed)
      expect(Object.keys(files(path.join(local, 'r'))).sort()).toEqual(
        ['CON', 'a:b', 'a_b', 'notes. ', 'sub/Foo', 'sub/foo', 'sub/ok.txt'].sort()
      )
      expect(renamed.count).toBe(0)
    } finally {
      fs.rmSync(local, { recursive: true, force: true })
    }
  })
})

import { describe, it, expect } from 'vitest'
import net, { type AddressInfo } from 'net'
import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { expandProxyTokens, proxyCommandArgv, proxyCommandSocket, windowsCmdExePath, type ProxySpawn } from './proxy-command'

const T = { hostname: '10.0.0.5', port: 2222, user: 'dev', originalHost: 'box', hostKeyAlias: undefined }

describe('expandProxyTokens', () => {
  it.each([
    ['nc %h %p', 'nc 10.0.0.5 2222'],
    ['ssh -W %h:%p %r@bastion', 'ssh -W 10.0.0.5:2222 dev@bastion'],
    ['connect %n', 'connect box'],
    ['echo %k', 'echo box'],
    ['printf 100%%', 'printf 100%']
  ])('%s', (cmd, want) => {
    expect(expandProxyTokens(cmd, T)).toBe(want)
  })
  it('%k is HostKeyAlias when one is set', () => {
    expect(expandProxyTokens('x %k', { ...T, hostKeyAlias: 'alias' })).toBe('x alias')
  })
  it.each([
    ['%h', { hostname: 'a&calc' }],
    ['%h', { hostname: 'a;rm -rf ~' }],
    ['%n', { originalHost: 'box|x' }],
    ['%n', { originalHost: '$(id)' }],
    ['%r', { user: 'dev`id`' }],
    ['%r', { user: '-oProxyCommand=x' }],
    ['%k', { hostKeyAlias: 'a^b' }],
    ['%h', { hostname: '100%x' }]
  ])('a %s value carrying a shell/cmd metacharacter is refused, never interpolated', (tok, over) => {
    expect(() => expandProxyTokens(`nc ${tok} %p`, { ...T, ...over })).toThrow(/not allowed in a host or user name/)
  })
  it('ordinary values (IPv6, dotted names, user with dot/underscore) still expand', () => {
    expect(expandProxyTokens('nc %h %p %r', { ...T, hostname: 'fe80::1', user: 'first.last_x' })).toBe('nc fe80::1 2222 first.last_x')
  })
  it('an unknown token is an error by name, never passed through', () => {
    expect(() => expandProxyTokens('nc %h %C', T)).toThrow(/unknown token %C/)
    expect(() => expandProxyTokens('trailing %', T)).toThrow(/unknown token %/)
  })
})

describe('proxyCommandArgv', () => {
  it('POSIX: sh -c exec, as OpenSSH runs it', () => {
    expect(proxyCommandArgv('nc a 22', 'linux')).toEqual({ file: '/bin/sh', args: ['-c', 'exec nc a 22'], verbatim: false })
  })
  it('Windows: cmd.exe /d /s /c with the line quoted verbatim', () => {
    expect(proxyCommandArgv('ncat a 22', 'win32', { SystemRoot: 'C:\\Windows' })).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', '"ncat a 22"'],
      verbatim: true
    })
  })
  it('Windows: the interpreter never comes from ComSpec', () => {
    const env = { ComSpec: 'C:\\Users\\x\\evil.exe', COMSPEC: '\\\\attacker\\share\\cmd.exe', SystemRoot: 'C:\\Windows' }
    expect(proxyCommandArgv('ncat a 22', 'win32', env).file).toBe('C:\\Windows\\System32\\cmd.exe')
  })
})

describe('windowsCmdExePath', () => {
  it('takes only the system drive from SystemRoot / WINDIR', () => {
    expect(windowsCmdExePath({ SystemRoot: 'D:\\WINDOWS' })).toBe('D:\\Windows\\System32\\cmd.exe')
    expect(windowsCmdExePath({ WINDIR: 'e:\\windows\\' })).toBe('E:\\Windows\\System32\\cmd.exe')
  })
  it('falls back to C: for anything that is not exactly <letter>:\\Windows', () => {
    for (const root of ['', 'C:\\Windows\\..\\Users\\x', '\\\\host\\share\\Windows', 'D:\\WINNT', 'Windows', 'C:\\Windows" & calc']) {
      expect(windowsCmdExePath({ SystemRoot: root })).toBe('C:\\Windows\\System32\\cmd.exe')
    }
    expect(windowsCmdExePath({})).toBe('C:\\Windows\\System32\\cmd.exe')
  })
})

/** A ProxySpawn that ignores the shell and runs `node -e <script>` instead (portable on every leg). */
const nodeSpawn = (script: string, seen?: { file: string; args: string[] }[]): ProxySpawn => (file, args) => {
  seen?.push({ file, args })
  return spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] })
}

describe('proxyCommandSocket', () => {
  it('speaks over the proxy\'s stdio (a node stdio↔TCP pipe), both ways', async () => {
    // The echo server's accepted socket is the peer of the proxy child's TCP connection. Tearing
    // the stream down KILLS that child, and on Windows the killed peer reads as `read ECONNRESET`
    // on this socket — an async 'error' event that, unlisted, was an uncaught exception failing the
    // whole run (reported against whichever test ran next). Every server-side socket and the server
    // itself get a listener; a peer reset/broken pipe is the expected teardown, anything else fails.
    const conns = new Set<net.Socket>()
    const peerErrors: NodeJS.ErrnoException[] = []
    const echo = net.createServer((s) => {
      conns.add(s)
      s.on('error', (e: NodeJS.ErrnoException) => peerErrors.push(e))
      s.on('close', () => conns.delete(s))
      s.pipe(s)
    })
    echo.on('error', (e: NodeJS.ErrnoException) => peerErrors.push(e))
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()))
    const port = (echo.address() as AddressInfo).port
    const pipe = `const s=require('net').connect(${port},'127.0.0.1');process.stdin.pipe(s).pipe(process.stdout)`
    const seen: { file: string; args: string[] }[] = []
    const sock = proxyCommandSocket('ignored %h', { timeoutMs: 5000, spawn: nodeSpawn(pipe, seen), platform: 'linux' })
    try {
      const got = await new Promise<string>((resolve, reject) => {
        sock.on('error', reject)
        sock.on('data', (d: Buffer) => resolve(d.toString()))
        sock.write('ping')
      })
      expect(got).toBe('ping')
      expect(seen[0]).toEqual({ file: '/bin/sh', args: ['-c', 'exec ignored %h'] })
    } finally {
      sock.destroy()
      // Close the server and every accepted socket, and WAIT for it: nothing from this test may
      // still be open (and able to reset) while the next one runs.
      for (const c of conns) c.destroy()
      await new Promise<void>((r) => echo.close(() => r()))
    }
    expect(peerErrors.filter((e) => e.code !== 'ECONNRESET' && e.code !== 'EPIPE')).toEqual([])
  })

  it('an early exit is an error carrying the proxy\'s stderr', async () => {
    const sock = proxyCommandSocket('x', {
      timeoutMs: 5000,
      spawn: nodeSpawn(`process.stderr.write('ncat: Connection refused.\\n');process.exit(1)`)
    })
    const err = await new Promise<Error>((r) => sock.on('error', r))
    expect(err.message).toMatch(/ProxyCommand exited \(code 1\) before the connection was up: ncat: Connection refused\./)
  })

  it('a proxy that never answers times out (ConnectTimeout) and is killed', async () => {
    const children: import('child_process').ChildProcess[] = []
    const sock = proxyCommandSocket('x', {
      timeoutMs: 200,
      spawn: (f, a, o) => {
        const c = nodeSpawn('setInterval(()=>{},1000)')(f, a, o)
        children.push(c)
        return c
      }
    })
    const err = await new Promise<Error>((r) => sock.on('error', r))
    expect(err.message).toMatch(/timed out/)
    await new Promise<void>((r) => (children[0].exitCode !== null || children[0].signalCode !== null ? r() : children[0].once('exit', () => r())))
    expect(children[0].signalCode ?? children[0].exitCode).not.toBeNull()
  })

  it('destroying the stream kills the proxy', async () => {
    const children: import('child_process').ChildProcess[] = []
    const sock = proxyCommandSocket('x', {
      timeoutMs: 5000,
      spawn: (f, a, o) => {
        const c = nodeSpawn(`process.stdout.write('SSH-2.0-x\\r\\n');setInterval(()=>{},1000)`)(f, a, o)
        children.push(c)
        return c
      }
    })
    await new Promise((r) => sock.once('data', r))
    const exited = new Promise((r) => children[0].once('exit', r))
    sock.destroy()
    await exited
  })

  it('Windows: destroying the stream kills the whole TREE (cmd.exe and the proxy under it)', async () => {
    const children: import('child_process').ChildProcess[] = []
    const killed: number[] = []
    const sock = proxyCommandSocket('x', {
      timeoutMs: 5000,
      platform: 'win32',
      env: { ComSpec: 'cmd.exe' },
      killTree: (pid) => {
        killed.push(pid)
        children[0].kill()
      },
      spawn: (f, a, o) => {
        const c = nodeSpawn(`process.stdout.write('SSH-2.0-x\\r\\n');setInterval(()=>{},1000)`)(f, a, o)
        children.push(c)
        return c
      }
    })
    await new Promise((r) => sock.once('data', r))
    const exited = new Promise((r) => children[0].once('exit', r))
    sock.destroy()
    await exited
    expect(killed).toEqual([children[0].pid])
  })

  it('a spawn that fails is an error, not a hang', async () => {
    const sock = proxyCommandSocket('x', {
      timeoutMs: 5000,
      spawn: () => {
        throw new Error('spawn ENOENT')
      }
    })
    const err = await new Promise<Error>((r) => sock.on('error', r))
    expect(err.message).toMatch(/could not be started \(spawn ENOENT\)/)
  })

  it.skipIf(process.platform === 'win32')('the real /bin/sh form runs the expanded command', async () => {
    // POSIX-only: the default spawn runs `/bin/sh -c 'exec …'`.
    const sock = proxyCommandSocket(`printf 'hello'`, { timeoutMs: 5000 })
    const got = await new Promise<string>((resolve, reject) => {
      let s = ''
      sock.on('data', (d: Buffer) => (s += d.toString()))
      sock.on('end', () => resolve(s))
      sock.on('error', reject)
      sock.resume()
    })
    expect(got).toBe('hello')
  })
})

/** A ChildProcess stand-in whose stdio pipes the test can fail at will (Windows reports a proxy
 *  that already exited as `read ECONNRESET` on its pipes — reproducible on any OS this way). */
function fakeChild(): ChildProcess & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough } {
  const c = new EventEmitter() as ChildProcess & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough }
  Object.assign(c, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 4242,
    exitCode: null,
    signalCode: null,
    kill: () => true
  })
  return c
}

const reset = (): NodeJS.ErrnoException => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', errno: -4077 })

describe('proxyCommandSocket — stdio pipe errors (Windows ECONNRESET from an exited proxy)', () => {
  it('a pipe error before the first byte is handled, and the exit still carries the stderr reason', async () => {
    const c = fakeChild()
    const sock = proxyCommandSocket('x', { timeoutMs: 5000, platform: 'linux', spawn: () => c })
    const errs: Error[] = []
    sock.on('error', (e) => errs.push(e))
    c.stderr.write('ncat: Connection refused.\n')
    await new Promise((r) => setImmediate(r))
    // No listener would make each of these an unhandled 'error' event — a synchronous throw here.
    for (const pipe of [c.stdin, c.stdout, c.stderr]) expect(() => pipe.emit('error', reset())).not.toThrow()
    expect(sock.destroyed).toBe(false)
    c.emit('close', 1, null)
    await new Promise((r) => setImmediate(r))
    expect(errs).toHaveLength(1)
    expect(errs[0].message).toMatch(/ProxyCommand exited \(code 1\) before the connection was up: ncat: Connection refused\./)
  })

  it('a pipe error after the connection was up surfaces as the proxy failure', async () => {
    const c = fakeChild()
    const sock = proxyCommandSocket('x', { timeoutMs: 5000, platform: 'linux', spawn: () => c })
    const err = new Promise<Error>((r) => sock.on('error', r))
    sock.on('data', () => {})
    c.stdout.write('SSH-2.0-x\r\n')
    await new Promise((r) => setImmediate(r))
    expect(() => c.stdout.emit('error', reset())).not.toThrow()
    expect((await err).message).toMatch(/ProxyCommand connection failed \(read ECONNRESET\)/)
    // Later errors on the other pipes (the stream is already destroyed) stay handled too.
    expect(() => c.stdin.emit('error', reset())).not.toThrow()
    expect(() => c.stderr.emit('error', reset())).not.toThrow()
  })
})

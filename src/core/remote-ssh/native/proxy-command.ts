// `ProxyCommand` for the in-process transport: run the user's command and speak SSH over its
// stdin/stdout, exactly what OpenSSH does (sshconnect.c `ssh_proxy_connect`).
//
// Trust: the command comes from the user's own ~/.ssh/config (via `ssh -G`), the same trust level
// it has for OpenSSH on a Mac. Nothing nodeterm controls is interpolated into it except the token
// VALUES OpenSSH itself substitutes (%h %p %r %n %k), and those come from the same validated
// destination `sshGArgs` refuses a leading `-` in. An unknown `%x` is an error by name, as it is
// for OpenSSH (percent_expand is fatal on an unknown key) — never passed through as a guess.
//
// `ProxyUseFdpass yes` (the proxy hands back a connected fd over a unix socket) cannot be served
// from Node and is refused by name by the caller.

import { execFile, spawn as nodeSpawn, type ChildProcess } from 'child_process'
import { Duplex } from 'stream'
import { windowsSystemDrive } from '../../win32-powershell'

/** The values OpenSSH substitutes into a ProxyCommand (sshconnect.c `expand_proxy_command`). */
export interface ProxyTokens {
  /** %h — the real host name (HostName, after alias resolution). */
  hostname: string
  /** %p */
  port: number
  /** %r — the remote user. */
  user: string
  /** %n — the host as the user named it (alias). */
  originalHost: string
  /** %k — HostKeyAlias when set, else the host as named. */
  hostKeyAlias?: string
}

/**
 * Characters a substituted VALUE may not carry: the expanded line is handed to `/bin/sh -c` or
 * `cmd.exe /c`, so a host or user holding a shell or cmd metacharacter would run as a command.
 * OpenSSH >= 9.6 refuses the same class for user/host (CVE-2023-51385); Windows ships 9.5, and the
 * no-binary path never asks OpenSSH at all — so the check lives here, at the interpolation site.
 */
const UNSAFE_TOKEN_VALUE = /[\s'"`$\\;&<>|(){}^%!*?[\]\x00-\x1f\x7f]/

function safeValue(k: string, v: string): string {
  if (!v || v.startsWith('-') || UNSAFE_TOKEN_VALUE.test(v)) {
    throw new Error(`ssh: ProxyCommand: %${k} value ${JSON.stringify(v)} contains characters that are not allowed in a host or user name`)
  }
  return v
}

/** Expand `%h %p %r %n %k %%`; throws on any other `%x`, naming it, and on an unsafe value. */
export function expandProxyTokens(cmd: string, t: ProxyTokens): string {
  return cmd.replace(/%(.?)/g, (_m, k: string) => {
    switch (k) {
      case '%':
        return '%'
      case 'h':
        return safeValue(k, t.hostname)
      case 'p':
        return String(t.port)
      case 'r':
        return safeValue(k, t.user)
      case 'n':
        return safeValue(k, t.originalHost)
      case 'k':
        return safeValue(k, t.hostKeyAlias ?? t.originalHost)
      default:
        throw new Error(`ssh: ProxyCommand: unknown token %${k} in "${cmd}"`)
    }
  })
}

/**
 * The Windows command processor that runs a ProxyCommand: `<drive>:\Windows\System32\cmd.exe`.
 *
 * NOT `%ComSpec%`. The shell is the one thing in the line nodeterm chooses (the command is the
 * user's own ssh_config), and an inherited environment variable is not a trusted place to choose an
 * executable from — whoever can set `ComSpec` for the app would pick the program every proxied
 * connection runs (CodeQL js/indirect-command-line-injection). Only the system DRIVE is taken from
 * `SystemRoot`/`WINDIR`, and only when that value is exactly `<letter>:\Windows` (every supported
 * Windows install); it selects a letter from a constant table, so no environment text reaches the
 * path. Anything else falls back to `C:`. POSIX is untouched: `/bin/sh` was always a fixed path.
 */
export function windowsCmdExePath(env: NodeJS.ProcessEnv = process.env): string {
  return `${windowsSystemDrive(env)}:\\Windows\\System32\\cmd.exe`
}

/** argv for a ProxyCommand on this platform: POSIX `sh -c 'exec …'` (OpenSSH's own form);
 *  Windows `cmd.exe /d /s /c "…"`, which is how a command line is run there without a POSIX shell.
 *  Both interpreters are fixed absolute paths (see `windowsCmdExePath`). */
export function proxyCommandArgv(
  cmd: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): { file: string; args: string[]; verbatim: boolean } {
  if (platform === 'win32') {
    return { file: windowsCmdExePath(env), args: ['/d', '/s', '/c', `"${cmd}"`], verbatim: true }
  }
  return { file: '/bin/sh', args: ['-c', `exec ${cmd}`], verbatim: false }
}

/** What the transport needs of a spawned proxy (a ChildProcess with piped stdio). */
export type ProxySpawn = (file: string, args: string[], opts: { verbatim: boolean }) => ChildProcess

const defaultSpawn: ProxySpawn = (file, args, opts) =>
  nodeSpawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: opts.verbatim })

/** `taskkill /t /f` — the same tree kill project-setup-runner-local.ts uses. Best-effort. */
function defaultKillTree(pid: number): void {
  execFile('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true }, () => {
    // ENOENT / "not found": it already exited.
  })
}

/** How much of the proxy's stderr is kept for an error message. */
const STDERR_KEEP = 4096

/**
 * Spawn the proxy and return a Duplex over its stdio (stdout readable, stdin writable). The child
 * is killed when the stream is destroyed. If it exits — or nothing arrives from it within
 * `timeoutMs` (OpenSSH's ConnectTimeout, which for a proxy covers the wait for the server's banner)
 * — the stream errors with the reason and the proxy's last stderr, which the handshake reports.
 */
export function proxyCommandSocket(
  cmd: string,
  opts: {
    timeoutMs: number
    platform?: NodeJS.Platform
    spawn?: ProxySpawn
    env?: NodeJS.ProcessEnv
    /** Test seam: kill a Windows process TREE by pid (default `taskkill /pid <pid> /t /f`). */
    killTree?: (pid: number) => void
  }
): Duplex {
  const platform = opts.platform ?? process.platform
  const { file, args, verbatim } = proxyCommandArgv(cmd, platform, opts.env)
  let stderr = ''
  let gotData = false
  let child: ChildProcess | null = null
  const kill = (): void => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    // Windows: the child is cmd.exe, and the proxy (ncat, ssh -W, …) is ITS child — killing cmd.exe
    // alone orphans the proxy holding the connection. POSIX needs no tree: `exec` replaced the sh.
    if (platform === 'win32' && child.pid) {
      ;(opts.killTree ?? defaultKillTree)(child.pid)
      return
    }
    child.kill()
  }
  const why = (msg: string): Error => {
    const tail = stderr.trim().split(/\r?\n/).pop()
    return new Error(`ProxyCommand ${msg}${tail ? `: ${tail}` : ''}`)
  }
  const stream = new Duplex({
    read() {
      child?.stdout?.resume()
    },
    write(chunk: Buffer, _enc, cb) {
      if (!child?.stdin || child.stdin.destroyed) return cb(why('is not running'))
      child.stdin.write(chunk, (e) => cb(e ?? null))
    },
    final(cb) {
      child?.stdin?.end()
      cb()
    },
    destroy(err, cb) {
      clearTimeout(timer)
      kill()
      cb(err)
    }
  })
  const timer = setTimeout(() => {
    if (!gotData) stream.destroy(why(`timed out after ${Math.round(opts.timeoutMs / 1000)}s`))
  }, opts.timeoutMs)
  try {
    child = (opts.spawn ?? defaultSpawn)(file, args, { verbatim })
  } catch (e) {
    queueMicrotask(() => stream.destroy(why(`could not be started (${(e as Error).message})`)))
    return stream
  }
  const c = child
  c.on('error', (e) => stream.destroy(why(`could not be started (${e.message})`)))
  c.stderr?.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString('utf8')).slice(-STDERR_KEEP)
  })
  // EVERY stdio pipe gets an 'error' listener: a pipe failure is an async EVENT, and an unhandled
  // one is an uncaught exception that takes down the whole process. On Windows a proxy that has
  // already exited (the ordinary "Connection refused" case) surfaces as `read ECONNRESET` on its
  // stdout/stderr pipes and `EPIPE`/`ECONNRESET` on stdin. Before the first byte that error says
  // nothing the exit does not say better — the 'close' handler below reports the exit code and the
  // proxy's own stderr — so it is left to that. After the connection was up, a broken pipe IS the
  // connection failing: surface it as the proxy failure instead of hanging on an 'end' that a reset
  // pipe never emits. (A stdin error also reaches the pending write's callback.)
  const onStdioError = (e: Error): void => {
    if (stream.destroyed || !gotData) return
    clearTimeout(timer)
    stream.destroy(why(`connection failed (${e.message})`))
  }
  c.stdin?.on('error', onStdioError)
  c.stdout?.on('error', onStdioError)
  c.stderr?.on('error', onStdioError)
  c.stdout?.on('data', (d: Buffer) => {
    if (!gotData) {
      gotData = true
      clearTimeout(timer)
    }
    if (!stream.push(d)) c.stdout?.pause()
  })
  // An EOF before any byte waits for the process's own exit: that is where the reason is (an EOF
  // handed on now would surface as ssh2's bare "Connection lost before handshake").
  c.stdout?.on('end', () => {
    if (gotData) stream.push(null)
  })
  // 'close', not 'exit': stdout may still hold the banner when the process has already exited.
  c.on('close', (code, signal) => {
    clearTimeout(timer)
    if (stream.destroyed) return
    // Before any byte: the proxy never reached the server. After: the connection simply ended.
    if (!gotData) stream.destroy(why(`exited (${signal ?? `code ${code}`}) before the connection was up`))
  })
  return stream
}

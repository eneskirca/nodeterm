// The one NativeMux of this process, and the helpers every runner uses to reach it.
//
// ONE instance for the whole process for the same reason SshChildGate and remotePtySpawnGate are
// module-level: every seam (SshProjectManager's runners, pty-manager's execs, remote-git, the
// setup runner, the terminal adapter) addresses a project's connection by its ControlPath, and two
// instances would mean two connections to one host — the thing this transport exists to prevent.

import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { findExecutableSync, shellPathNow } from '../../exec-path'
import { NativeMux, type ExecResult } from './native-mux'
import { defaultHostFromQuery, parseSshG, sshGArgs, type HostQuery, type ResolvedHost } from './ssh-config'
import { WINDOWS_OPENSSH_AGENT_PIPE, pickWindowsAgent } from './windows-agent-discovery'
import { runSshArgv, useNativeSsh } from './native-invoke'
import { decideAgentAdd } from './agent-add'

export { useNativeSsh }

let instance: NativeMux | null = null
type PassphrasePrompt = (identityFile: string, req: { retry: boolean; target: string }) => Promise<string | null>
let passphrasePrompt: PassphrasePrompt | null = null

/** Main installs its passphrase dialog here (the same one the askpass relay raises on POSIX). */
export function setNativePassphrasePrompt(fn: PassphrasePrompt | null): void {
  passphrasePrompt = fn
}

let windowsAgentOptIn: () => boolean = () => false

/** Main installs the `settings.windowsSshAgentAddKeys` reader here (read at each unlock). */
export function setNativeWindowsAgentOptIn(fn: () => boolean): void {
  windowsAgentOptIn = fn
}

const POSIX_SSH_FALLBACKS = ['/usr/bin/ssh', '/usr/local/bin/ssh', '/opt/homebrew/bin/ssh']

/** Where an ssh binary may live off PATH: the usual POSIX locations, and on Windows the OpenSSH
 *  Client feature's own directory (GUI apps there can start with a PATH that lacks it). */
export function sshFallbacks(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform !== 'win32') return POSIX_SSH_FALLBACKS
  return [path.win32.join(env.SystemRoot || env.WINDIR || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')]
}

let cachedSshBinary: string | null | undefined

/**
 * The ssh BINARY, or null. The one lookup every module used to keep a private copy of. GUI apps do
 * not inherit the shell PATH, so this walks the cached login-shell PATH (exec-path.ts) then the
 * fallbacks; a MISS is only memoized once that async PATH probe has settled, so an early call
 * cannot cache a custom-location ssh away forever.
 */
export function findSshBinary(): string | null {
  if (cachedSshBinary !== undefined) return cachedSshBinary
  const found = findExecutableSync('ssh', sshFallbacks())
  if (found || shellPathNow() !== undefined) cachedSshBinary = found
  return found
}

/**
 * The ssh PROGRAM a runner should name: the binary when there is one, else — only where the native
 * transport carries every ssh call (Windows, or NODETERM_NATIVE_SSH=1) — the bare sentinel `ssh`.
 * `isSshProgram('ssh')` is true, so every runner that checks `isSshProgram && useNativeSsh` routes
 * it to NativeMux and never spawns it: a Windows machine without the OpenSSH Client feature can
 * still open SSH projects. Never memoized itself (`useNativeSsh` is read at call time).
 */
export function resolveSshProgram(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  binary: () => string | null = findSshBinary
): string | null {
  return binary() ?? (useNativeSsh(platform, env) ? 'ssh' : null)
}

/** The ssh binary, used only for `ssh -G` (config evaluation), never as a transport here. */
function sshForConfig(): string {
  return findSshBinary() ?? (process.platform === 'win32' ? sshFallbacks()[0] : 'ssh')
}

type ExecFileLike = (
  file: string,
  args: string[],
  opts: { timeout: number; windowsHide: boolean },
  cb: (err: (Error & { code?: unknown }) | null, stdout: string) => void
) => void

/**
 * `ssh -G` for a destination. With NO ssh binary at all (ENOENT — Windows without the OpenSSH
 * Client feature) the host resolves to OpenSSH's no-config defaults instead of failing the connect,
 * and the log says once per host that ~/.ssh/config was not evaluated. Any other failure rejects.
 */
export function makeResolveHost(deps: {
  execFile?: ExecFileLike
  ssh?: () => string
  log?: (line: string) => void
  home?: string
  user?: () => string
} = {}): (t: HostQuery) => Promise<ResolvedHost> {
  const run: ExecFileLike = deps.execFile ?? ((f, a, o, cb) => void execFile(f, a, o, (e, out) => cb(e, String(out ?? ''))))
  const warned = new Set<string>()
  return (t) =>
    new Promise<ResolvedHost>((resolve, reject) => {
      let args: string[]
      try {
        args = sshGArgs(t)
      } catch (e) {
        return reject(e)
      }
      run((deps.ssh ?? sshForConfig)(), args, { timeout: 5_000, windowsHide: true }, (err, stdout) => {
        if (err && !stdout) {
          if (err.code === 'ENOENT') {
            if (!warned.has(t.host)) {
              warned.add(t.host)
              ;(deps.log ?? console.warn)(`[native-ssh] ssh.exe not found; ~/.ssh/config was not evaluated for ${t.host}`)
            }
            let user: string
            try {
              user = deps.user ? deps.user() : os.userInfo().username
            } catch {
              return reject(new Error(`ssh: no user for ${t.host} (and no ssh binary to read ~/.ssh/config with)`))
            }
            return resolve(defaultHostFromQuery(t, deps.home ?? os.homedir(), user))
          }
          return reject(new Error(`ssh -G failed for ${t.user ? `${t.user}@` : ''}${t.host}: ${err.message}`))
        }
        try {
          resolve(parseSshG(stdout))
        } catch (e) {
          reject(e)
        }
      })
    })
}

/** Windows: the names under `\\.\pipe\` (empty when the directory cannot be listed). */
function listWindowsPipes(): string[] {
  try {
    return fs.readdirSync('\\\\.\\pipe\\')
  } catch {
    return []
  }
}

/**
 * Windows: the OpenSSH agent service's pipe, else the user's Pageant / KeeAgent pipe
 * (windows-agent-discovery.ts). POSIX: the app agent, else the ambient one.
 */
function defaultAgent(): string | undefined {
  if (process.platform === 'win32') {
    const pipes = listWindowsPipes()
    let user: string | undefined
    try {
      user = os.userInfo().username
    } catch {
      user = undefined
    }
    const picked = pickWindowsAgent({ pipes, user })
    if (picked) return picked
    try {
      // A pipe directory we could not list: the service pipe may still be there.
      return !pipes.length && fs.existsSync(WINDOWS_OPENSSH_AGENT_PIPE) ? WINDOWS_OPENSSH_AGENT_PIPE : undefined
    } catch {
      return undefined
    }
  }
  return process.env.NODETERM_APP_AGENT_SOCK || process.env.SSH_AUTH_SOCK || undefined
}

export function nativeMux(): NativeMux {
  if (!instance) {
    instance = new NativeMux({
      resolveHost: makeResolveHost(),
      defaultAgent,
      listWindowsPipes,
      askPassphrase: (f, req) => (passphrasePrompt ? passphrasePrompt(f, req) : Promise.resolve(null)),
      agentAdd: ({ agentPath, host }) => {
        let optIn = false
        try {
          optIn = windowsAgentOptIn() === true
        } catch {
          optIn = false
        }
        return decideAgentAdd({ agentPath, addKeysToAgent: host.addKeysToAgent, windowsAgentOptIn: optIn })
      },
      log: (line) => console.warn(line)
    })
  }
  return instance
}

/** Test-only: forget the instance (and its connections). */
export function resetNativeMuxForTests(): void {
  instance?.exitAll()
  instance = null
}

/** Is this program the ssh client (as every runner resolves it: absolute path or bare name)? */
export function isSshProgram(file: string): boolean {
  const base = path.basename(file).toLowerCase()
  return base === 'ssh' || base === 'ssh.exe'
}

/** execFile's error shape for a non-zero native result, so callers' catch blocks read it unchanged. */
export class NativeExecError extends Error {
  code: number | null
  signal: string | null
  killed: boolean
  stdout: string
  stderr: string
  constructor(r: ExecResult, argv: readonly string[]) {
    const stderr = r.stderr.toString('utf8')
    super(`Command failed: ssh ${argv.join(' ')}\n${stderr}`)
    this.code = r.code
    this.signal = r.signal
    this.killed = r.timedOut
    this.stdout = r.stdout.toString('utf8')
    this.stderr = stderr
  }
}

/**
 * `execFileAsync(ssh, args, opts)` over the native transport: resolves `{stdout, stderr}` on exit
 * 0, rejects a NativeExecError otherwise — the contract every promisified-execFile caller has.
 */
export async function nativeExecFileAsync(
  args: readonly string[],
  opts: { timeout?: number; input?: string | Buffer } = {}
): Promise<{ stdout: string; stderr: string }> {
  const r = await runSshArgv(nativeMux(), [...args], { stdin: opts.input, timeoutMs: opts.timeout })
  if (r.code === 0 && !r.timedOut) return { stdout: r.stdout.toString('utf8'), stderr: r.stderr.toString('utf8') }
  throw new NativeExecError(r, args)
}

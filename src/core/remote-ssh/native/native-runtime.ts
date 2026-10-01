// The one NativeMux of this process, and the helpers every runner uses to reach it.
//
// ONE instance for the whole process for the same reason SshChildGate and remotePtySpawnGate are
// module-level: every seam (SshProjectManager's runners, pty-manager's execs, remote-git, the
// setup runner, the terminal adapter) addresses a project's connection by its ControlPath, and two
// instances would mean two connections to one host — the thing this transport exists to prevent.

import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import { findExecutableSync } from '../../exec-path'
import { NativeMux, WINDOWS_OPENSSH_AGENT_PIPE, type ExecResult } from './native-mux'
import { parseSshG, sshGArgs, type HostQuery } from './ssh-config'
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

/** The ssh binary, used only for `ssh -G` (config evaluation), never as a transport here. */
function sshForConfig(): string {
  return (
    findExecutableSync('ssh', ['/usr/bin/ssh', '/usr/local/bin/ssh', '/opt/homebrew/bin/ssh']) ??
    (process.platform === 'win32'
      ? path.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
      : 'ssh')
  )
}

function resolveHost(t: HostQuery) {
  return new Promise<ReturnType<typeof parseSshG>>((resolve, reject) => {
    let args: string[]
    try {
      args = sshGArgs(t)
    } catch (e) {
      return reject(e)
    }
    execFile(sshForConfig(), args, { timeout: 5_000, windowsHide: true }, (err, stdout) => {
      if (err && !stdout) {
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

/** Windows: the OpenSSH agent service's pipe when it exists. POSIX: the app agent, else the ambient one. */
function defaultAgent(): string | undefined {
  if (process.platform === 'win32') {
    try {
      return fs.existsSync(WINDOWS_OPENSSH_AGENT_PIPE) ? WINDOWS_OPENSSH_AGENT_PIPE : undefined
    } catch {
      return undefined
    }
  }
  return process.env.NODETERM_APP_AGENT_SOCK || process.env.SSH_AUTH_SOCK || undefined
}

export function nativeMux(): NativeMux {
  if (!instance) {
    instance = new NativeMux({
      resolveHost,
      defaultAgent,
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

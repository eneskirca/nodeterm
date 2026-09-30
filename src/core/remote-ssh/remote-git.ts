// Run git over an SSH project's ControlMaster. The pure builder composes `cd <cwd> && git <args>`
// (cwd tilde-expands via quoteRemotePath; every arg posixQuote'd so a ref/branch/message can't
// inject into the remote shell). runRemoteGit returns the SAME { ok, out, err } shape as the local
// git() helper so callers are transport-agnostic. A module-level resolver registry lets both
// git-service.ts and commit-message.ts route the same way without threading a ref through every op.
import { execFile } from 'child_process'
import { promisify } from 'util'
import { childArgs } from './control-master'
import { nativeExecFileAsync, useNativeSsh } from './native/native-runtime'
import { findExecutableSync, shellPathNow } from '../exec-path'
import { posixQuote, quoteRemotePath, type SshConnection } from '../../shared/ssh'

const run = promisify(execFile)

export interface GitRemoteRef {
  conn: SshConnection
  controlPath: string
}

export function remoteGitArgs(conn: SshConnection, controlPath: string, cwd: string, args: string[]): string[] {
  const remote = `cd ${quoteRemotePath(cwd)} && git ${args.map(posixQuote).join(' ')}`
  return childArgs(conn, controlPath, remote)
}

let sshPath: string | null | undefined
function findSsh(): string | null {
  if (sshPath !== undefined) return sshPath
  // GUI apps don't inherit the shell PATH. Subprocess-free (was a sync login-shell probe plus
  // an `ssh -V` spawn per candidate, blocking the main thread): walk the cached login-shell
  // PATH from exec-path.ts, then the hardcoded locations. A MISS is only memoized once the
  // async PATH probe has settled, so a custom-location ssh isn't cached away forever.
  const found = findExecutableSync('ssh', [
    '/usr/bin/ssh',
    '/usr/local/bin/ssh',
    '/opt/homebrew/bin/ssh'
  ])
  if (found || shellPathNow() !== undefined) sshPath = found
  return found
}

/** Run a git command on the remote over the master. Returns the same shape as the local git() helper. */
export async function runRemoteGit(
  ref: GitRemoteRef,
  cwd: string,
  args: string[],
  maxBuffer: number
): Promise<{ ok: boolean; out: string; err: string }> {
  const ssh = findSsh()
  if (!ssh) return { ok: false, out: '', err: 'ssh not found' }
  try {
    // With the master down, `ControlMaster=auto` makes this child authenticate for real; point it
    // at the app-private ssh-agent (published via env by main's ssh-agent.ts, which core cannot
    // import) so the unlocked key is found there and never sought in the user's login agent.
    const env = process.env.NODETERM_APP_AGENT_SOCK
      ? { ...process.env, SSH_AUTH_SOCK: process.env.NODETERM_APP_AGENT_SOCK }
      : process.env
    const argv = remoteGitArgs(ref.conn, ref.controlPath, cwd, args)
    // Native transport (Windows): the project's one connection, not an ssh that cannot multiplex.
    const { stdout } = useNativeSsh()
      ? await nativeExecFileAsync(argv, { timeout: 60_000 })
      : await run(ssh, argv, { maxBuffer, env })
    return { ok: true, out: stdout.replace(/\n$/, ''), err: '' }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, out: (err.stdout ?? '').trim(), err: (err.stderr || err.message || '').trim() }
  }
}

let resolver: ((cwd: string) => GitRemoteRef | undefined) | null = null
export function setGitRemoteResolver(fn: ((cwd: string) => GitRemoteRef | undefined) | null): void {
  resolver = fn
}
export function resolveGitRemote(cwd: string): GitRemoteRef | undefined {
  return resolver ? resolver(cwd) : undefined
}

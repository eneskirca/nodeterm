// The seam between "an ssh/scp argv this app built" and the in-process transport. Every runner
// that used to hand an argv to the ssh binary can hand it here instead and get the answer in the
// shape it already handles: `-O` ops answer like OpenSSH's control client, a command answers like
// execFile, a master looks like the spawned master process the manager watches.
//
// WHEN it is used is one decision, `useNativeSsh()`: always on Windows (where OpenSSH cannot
// multiplex — see native-mux.ts), and on POSIX only when NODETERM_NATIVE_SSH=1 asks for it, which
// exists so the transport can be exercised end to end against a real host from a Mac or Linux
// desktop. It is read at call time, never cached, so a test can flip it.

import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import fs from 'fs'
import path from 'path'
import type { SFTPWrapper } from 'ssh2'
import { NativeMux, channelExit, noMasterMessage, type ExecResult } from './native-mux'
import { parseScpArgv, parseSshArgv, type ParsedSsh } from './ssh-argv'

export function useNativeSsh(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (env.NODETERM_NATIVE_SSH === '0') return false
  return platform === 'win32' || env.NODETERM_NATIVE_SSH === '1'
}

/**
 * Run any non-master ssh argv: `-O check|exit|forward|cancel` or a command. Never throws; an
 * argv the parser refuses is exit 255 with the reason on stderr, so a new flag in a builder shows
 * up as a named failure rather than as a command run with a different meaning.
 */
export async function runSshArgv(
  mux: NativeMux,
  argv: string[],
  io: { stdin?: string | Buffer; timeoutMs?: number } = {}
): Promise<ExecResult> {
  let p: ParsedSsh
  try {
    p = parseSshArgv(argv)
  } catch (e) {
    return result(255, '', `${(e as Error).message}\n`)
  }
  if (p.kind === 'master') {
    return result(255, '', 'native ssh transport: a master is started with startNativeMaster, not run\n')
  }
  if (p.kind === 'exec') return mux.exec(p, io)
  const cp = p.options.controlPath
  if (!cp) return result(255, '', 'native ssh transport: -O without a ControlPath\n')
  switch (p.op) {
    case 'check':
      return mux.check(cp) ? result(0, '', 'Master running (pid=0)\n') : result(255, '', `${noMasterMessage(cp)}\n`)
    case 'exit':
      return (await mux.exit(cp)) ? result(0, '', 'Exit request sent.\n') : result(255, '', `${noMasterMessage(cp)}\n`)
    case 'forward':
      try {
        await mux.forward(cp, p.forward)
        return result(0, '', '')
      } catch (e) {
        return result(255, '', `${(e as Error).message}\n`)
      }
    case 'cancel':
      await mux.cancel(cp, p.forward)
      return result(0, '', '')
  }
}

/** What SshProjectManager watches for a spawned master process (Runners.spawnMaster). */
export interface NativeMasterHandle {
  kill(): void
  on(event: string, cb: (...a: unknown[]) => void): void
  stderr(): string
  exited(): boolean
  pid(): number | undefined
}

/**
 * `ssh -M -N …` as a pseudo-process: "exits" when the connection fails to come up or later drops,
 * with the reason on stderr (the manager reads its last line as the user-facing error, exactly as
 * it reads a real master's). `-O check` answers true from the moment it is authenticated.
 */
export function startNativeMaster(mux: NativeMux, argv: string[]): NativeMasterHandle {
  const events = new EventEmitter()
  let stderr = ''
  let exited = false
  const finish = (code: number | null, why: string): void => {
    if (exited) return
    exited = true
    if (why) stderr += why.endsWith('\n') ? why : `${why}\n`
    events.emit('exit', code)
  }
  let controlPath: string | undefined
  try {
    const p = parseSshArgv(argv)
    if (p.kind !== 'master' || !p.options.controlPath) throw new Error('native ssh transport: not a master argv')
    controlPath = p.options.controlPath
    mux.master(controlPath, p.target, p.options).then(
      ({ closed }) => void closed.then((why) => finish(255, why)),
      (e: Error) => finish(255, e.message)
    )
  } catch (e) {
    // Report on the next tick, as a failed spawn does, so the caller's listeners are attached.
    queueMicrotask(() => finish(255, (e as Error).message))
  }
  return {
    kill: () => {
      if (controlPath) void mux.exit(controlPath)
    },
    on: (ev, cb) => {
      if (ev === 'exit') events.on('exit', cb)
    },
    stderr: () => stderr,
    exited: () => exited,
    // No OS process. The manager only uses the pid to correlate askpass prompts, which the native
    // transport raises itself.
    pid: () => undefined
  }
}

/**
 * The scp argv scpArgs / scpDownArgs build, over SFTP on the shared connection. Files and (for a
 * download) directory trees; a recursive UPLOAD is not something any builder produces.
 */
export async function runScpArgv(mux: NativeMux, argv: string[]): Promise<{ code: number; stderr: string }> {
  let p: ReturnType<typeof parseScpArgv>
  try {
    p = parseScpArgv(argv)
  } catch (e) {
    return { code: 1, stderr: (e as Error).message }
  }
  const cp = p.options.controlPath
  try {
    const sftp = await mux.sftp(cp, p.target, p.options)
    try {
      const remote = await realRemotePath(sftp, p.remotePath)
      if (p.direction === 'up') {
        if (p.recursive) throw new Error('scp: recursive upload is not supported')
        await promisify<void>((cb) => sftp.fastPut(p.localPath, remote, cb))
      } else {
        await download(sftp, remote, p.localPath, p.recursive)
      }
      return { code: 0, stderr: '' }
    } finally {
      sftp.end()
    }
  } catch (e) {
    return { code: 1, stderr: (e as Error).message }
  }
}

/** scp's remote path semantics: relative to the login directory (remoteScpPath already turned `~/x` into `x`). */
async function realRemotePath(sftp: SFTPWrapper, p: string): Promise<string> {
  if (p.startsWith('/')) return p
  const home = await promisify<string>((cb) => sftp.realpath('.', cb))
  return p === '' || p === '.' ? home : `${home.replace(/\/$/, '')}/${p}`
}

async function download(sftp: SFTPWrapper, remote: string, local: string, recursive: boolean): Promise<void> {
  const st = await promisify<{ isDirectory(): boolean }>((cb) => sftp.stat(remote, cb))
  if (!st.isDirectory()) {
    await promisify<void>((cb) => sftp.fastGet(remote, local, cb))
    return
  }
  if (!recursive) throw new Error(`scp: ${remote}: not a regular file`)
  fs.mkdirSync(local, { recursive: true })
  const entries = await promisify<{ filename: string }[]>((cb) => sftp.readdir(remote, cb))
  for (const e of entries) {
    if (e.filename === '.' || e.filename === '..') continue
    await download(sftp, `${remote}/${e.filename}`, path.join(local, e.filename), true)
  }
}

function promisify<T>(fn: (cb: (err: Error | null | undefined, v: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))))
}

function result(code: number, stdout: string, stderr: string): ExecResult {
  return { code, signal: null, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), timedOut: false }
}

/** What a streaming caller uses of a ChildProcess (the setup runner): pipes, `close`, `error`, kill. */
export interface NativeStreamChild extends EventEmitter {
  stdout: PassThrough
  stderr: PassThrough
  kill(signal?: string): boolean
}

/**
 * `spawn(ssh, argv, {stdio: ['ignore','pipe','pipe']})` over the native transport. Emits `close`
 * with the remote exit status (255 when the channel is cut off or cannot be opened, ssh's code);
 * `kill` closes the channel — the same thing killing the local mux client did.
 */
export function spawnSshArgvStream(mux: NativeMux, argv: string[]): NativeStreamChild {
  const child = new EventEmitter() as NativeStreamChild
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  let closeChannel: (() => void) | null = null
  let killed = false
  let done = false
  const finish = (code: number): void => {
    if (done) return
    done = true
    child.stdout.end()
    child.stderr.end()
    child.emit('close', code)
  }
  child.kill = () => {
    killed = true
    // Asynchronously, as a real child reports its exit: a caller may attach 'close' after kill().
    if (closeChannel) closeChannel()
    else queueMicrotask(() => finish(255))
    return true
  }
  let p: ParsedSsh
  try {
    p = parseSshArgv(argv)
    if (p.kind !== 'exec') throw new Error('native ssh transport: not a command argv')
  } catch (e) {
    queueMicrotask(() => {
      if (done) return
      child.stderr.write(`${(e as Error).message}\n`)
      finish(255)
    })
    return child
  }
  mux.channel(p).then(
    (ch) => {
      if (killed) {
        ch.close()
        return
      }
      closeChannel = () => ch.close()
      ch.pipe(child.stdout, { end: false })
      ch.stderr.pipe(child.stderr, { end: false })
      ch.on('close', () => finish(channelExit(ch).code ?? 255))
      if (channelExit(ch).closed) queueMicrotask(() => finish(channelExit(ch).code ?? 255))
      ch.on('error', () => {})
      ch.end()
    },
    (e: Error) => {
      // Killed before the open failed: the child already closed and its pipes are ended. A write
      // here would throw ERR_STREAM_WRITE_AFTER_END as an uncaught exception in main.
      if (done) return
      child.stderr.write(`${e.message}\n`)
      finish(255)
    }
  )
  return child
}

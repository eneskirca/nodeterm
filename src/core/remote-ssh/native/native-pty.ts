// A remote terminal over the native transport, shaped like the node-pty IPty PtyManager holds.
//
// On POSIX a remote terminal is `ssh -t … tmux …` run as a local pty program, and the local pty
// only relays bytes. Over the native transport there is no ssh process: the pty is a channel on
// the project's one connection (the remote side allocates the tty), and this adapter is the object
// PtyManager keeps in `session.proc`. The same precedent as SessionHostPty: PtyManager uses only
// onData / onExit / write / resize / kill / pause / resume.
//
// Behaviour is the ssh client's, so nothing downstream learns a new failure shape:
//  - bytes written before the channel is open are queued, not dropped (a node types its launch
//    line as soon as create() resolves);
//  - a connection that cannot be brought up prints ssh's reason into the terminal and exits 255;
//  - the channel closing (remote exit, dropped connection) exits with the remote status, else 255 —
//    the code SshReconnector reads as "the transport dropped".

import { EventEmitter } from 'events'
import { StringDecoder } from 'string_decoder'
import type { ClientChannel } from 'ssh2'
import { channelExit, type NativeMux } from './native-mux'
import { parseSshArgv } from './ssh-argv'

interface Disposable {
  dispose(): void
}

export class NativeSshPty {
  readonly pid = 0
  readonly process = 'ssh'
  handleFlowControl = false
  cols: number
  rows: number
  private events = new EventEmitter()
  private channel: ClientChannel | null = null
  private queue: (string | Buffer)[] = []
  private exited = false
  private killed = false
  private paused = false

  constructor(mux: NativeMux, argv: string[], opts: { cols: number; rows: number; name?: string }) {
    this.cols = opts.cols
    this.rows = opts.rows
    let parsed
    try {
      parsed = parseSshArgv(argv)
      if (parsed.kind !== 'exec' || !parsed.tty) throw new Error('native ssh transport: not a pty argv')
    } catch (e) {
      queueMicrotask(() => this.fail((e as Error).message))
      return
    }
    mux.shell(parsed, { cols: this.cols, rows: this.rows, term: opts.name }).then(
      (ch) => {
        if (this.killed) {
          ch.close()
          return
        }
        this.channel = ch
        // One decoder per stream: a multi-byte character split across two packets must not become
        // two replacement characters.
        const out = new StringDecoder('utf8')
        const err = new StringDecoder('utf8')
        ch.on('data', (d: Buffer) => this.emitData(out.write(d)))
        ch.stderr.on('data', (d: Buffer) => this.emitData(err.write(d)))
        ch.on('close', () => this.exit(channelExit(ch).code ?? 255))
        // Closed before we got here (a remote side that exited at once): report it now.
        if (channelExit(ch).closed) queueMicrotask(() => this.exit(channelExit(ch).code ?? 255))
        ch.on('error', () => {})
        if (this.paused) ch.pause()
        for (const q of this.queue.splice(0)) ch.write(q)
        // A resize that arrived while the channel was opening.
        ch.setWindow(this.rows, this.cols, 0, 0)
      },
      (e: Error) => this.fail(e.message)
    )
  }

  onData(listener: (data: string) => void): Disposable {
    this.events.on('data', listener)
    return { dispose: () => this.events.off('data', listener) }
  }

  onExit(listener: (e: { exitCode: number; signal?: number }) => void): Disposable {
    this.events.on('exit', listener)
    return { dispose: () => this.events.off('exit', listener) }
  }

  write(data: string | Buffer): void {
    if (this.exited) return
    if (this.channel) this.channel.write(data)
    else this.queue.push(data)
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    this.channel?.setWindow(rows, cols, 0, 0)
  }

  kill(): void {
    this.killed = true
    if (this.channel) this.channel.close()
    else this.exit(255)
  }

  pause(): void {
    this.paused = true
    this.channel?.pause()
  }

  resume(): void {
    this.paused = false
    this.channel?.resume()
  }

  clear(): void {}

  private emitData(s: string): void {
    if (s) this.events.emit('data', s)
  }

  private fail(message: string): void {
    this.events.emit('data', `${message}\r\n`)
    this.exit(255)
  }

  private exit(code: number): void {
    if (this.exited) return
    this.exited = true
    this.events.emit('exit', { exitCode: code })
  }
}

// A tmux control-mode (`-C`) client over plain pipes: process lifecycle + command/reply correlation
// on top of the pure codec in tmux-control.ts. The point of the whole exercise is the pty device it
// does NOT hold — `tmux -C attach-session` streams a session's bytes and accepts `send-keys` while
// allocating zero pty devices, which is what lets an unwatched session stay observable for free.
//
// Electron-free by design (src/core is shared with the server edition): the only host dependency is
// `child_process.spawn`, and it sits behind the `ControlSpawn` seam so tests drive a fake instead.

import { spawn as nodeSpawn } from 'child_process'
import { StringDecoder } from 'string_decoder'
import { createControlDecoder, encodeSendKeysHex, type ControlEvent } from './tmux-control'

/**
 * The child-process seam. Deliberately the smallest surface the client needs — stdout is handed over
 * as raw Buffers (NEVER a utf8-decoded string; see the ENCODING note in tmux-control.ts) and stderr
 * is not part of the contract at all.
 */
export interface ControlSpawn {
  spawn(
    bin: string,
    args: string[]
  ): {
    stdin: { write(s: string): void }
    stdout: { on(ev: 'data', cb: (b: Buffer) => void): void }
    on(ev: 'exit', cb: (code: number | null) => void): void
    kill(): void
  }
}

/**
 * How much stream we accept without the codec completing a single event before we declare the peer
 * broken. The codec buffers a partial line, and an open `%begin` block's body, without bound — a
 * tmux that never sends the matching `%end` (or a wedged pipe that never sends a newline) would grow
 * the heap until the app dies. 8 MiB is orders of magnitude past any reply we issue, so hitting it
 * means "wedged", not "busy": we tear the client down exactly as if the process had exited.
 */
export const MAX_PENDING_BYTES = 8 * 1024 * 1024

/** Real `child_process` wiring. stderr is dropped: nothing reads it, and an unread pipe can block. */
const realSpawner: ControlSpawn = {
  spawn(bin, args) {
    const cp = nodeSpawn(bin, args, { stdio: ['pipe', 'pipe', 'ignore'] })
    // An unhandled 'error' on a child or its pipes THROWS. Both are reachable in normal operation —
    // a missing/unrunnable tmux binary (ENOENT), and an EPIPE from writing to a client that just
    // died — and neither may take the app down. The child's 'error' doubles as an exit report,
    // because Node does not promise an 'exit' event for a process that never spawned.
    cp.stdin?.on('error', () => {})
    cp.stdout?.on('error', () => {})
    return {
      // Commands are ASCII, but latin1 keeps the write path byte-exact for anything that is not.
      stdin: { write: (s: string) => void cp.stdin?.write(s, 'latin1') },
      stdout: { on: (_ev, cb) => void cp.stdout?.on('data', cb) },
      on: (_ev, cb) => {
        cp.on('exit', cb)
        cp.on('error', () => cb(null))
      },
      kill: () => void cp.kill()
    }
  }
}

interface Pending {
  resolve(r: { ok: boolean; body: string[] }): void
  reject(e: Error): void
}

export interface ControlModeClientOpts {
  tmuxBin: string
  socket: string
  sessionName: string
  /** Pane bytes, UTF-8 decoded and re-assembled across chunk/line boundaries. */
  onOutput(data: string): void
  /** The client died on its own (process exit, `%exit`, or wedged peer). Never fires after dispose. */
  onExit(): void
  spawner?: ControlSpawn
}

export class ControlModeClient {
  private readonly opts: ControlModeClientOpts
  private readonly spawner: ControlSpawn
  private readonly decoder = createControlDecoder()
  /** One UTF-8 decoder per pane: interleaving panes through a shared one would split characters. */
  private readonly utf8 = new Map<string, StringDecoder>()
  /** Control mode answers commands IN ORDER, so arrival order is the only correlation there is. */
  private readonly pending: Pending[] = []
  private proc: ReturnType<ControlSpawn['spawn']> | null = null
  private pendingBytes = 0
  private gone = false
  private disposed = false

  constructor(opts: ControlModeClientOpts) {
    this.opts = opts
    this.spawner = opts.spawner ?? realSpawner
  }

  /** True between `start()` and the client's death or disposal. */
  get alive(): boolean {
    return this.proc !== null && !this.gone && !this.disposed
  }

  /** Attach: `tmux -L <socket> -C attach-session -t <session>`. Calling twice is a no-op. */
  start(): void {
    if (this.proc || this.disposed) return
    const args = ['-L', this.opts.socket, '-C', 'attach-session', '-t', this.opts.sessionName]
    this.proc = this.spawner.spawn(this.opts.tmuxBin, args)
    this.proc.stdout.on('data', (b) => this.onChunk(b))
    this.proc.on('exit', () => this.die('control-mode client exited'))
  }

  /** Type `data` into `target` (default: our own session). Resolves false when tmux says `%error`. */
  async sendKeys(data: string, target = this.opts.sessionName): Promise<boolean> {
    const { ok } = await this.command(encodeSendKeysHex(target, data))
    return ok
  }

  /**
   * Run ONE control-mode command line. Every failure arrives as a rejected promise (this class never
   * throws at the caller): a `line` that is not a single line, a client that is not running, or a
   * client that dies while the reply is outstanding.
   */
  command(line: string): Promise<{ ok: boolean; body: string[] }> {
    if (/[\r\n]/.test(line)) {
      // The protocol is one command per line and this call queues exactly ONE resolver, so a line
      // carrying its own newline would run two commands, draw two replies, and pair every later
      // reply with the wrong caller — permanently, because positional correlation has no timer to
      // notice. Refusing the input is what keeps that state unreachable.
      return Promise.reject(new Error('tmux control-mode command must not contain a newline'))
    }
    if (!this.alive || !this.proc) {
      return Promise.reject(new Error('tmux control-mode client is not running'))
    }
    const proc = this.proc
    return new Promise((resolve, reject) => {
      // Write BEFORE queueing: a throwing write rejects this promise, and a resolver left in the
      // FIFO for a command tmux never saw would pair every later reply with the wrong caller.
      // (Safe ordering — the reply cannot arrive before this synchronous block ends.)
      proc.stdin.write(`${line}\n`)
      this.pending.push({ resolve, reject })
    })
  }

  /** Detach politely, then kill. Idempotent, and never reports an exit the caller asked for. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const proc = this.proc
    if (proc && !this.gone) {
      // `detach-client` lets tmux drop the client cleanly; the kill is the backstop, not the plan.
      try {
        proc.stdin.write('detach-client\n')
      } catch {
        /* pipe already gone — the kill below is what matters */
      }
      try {
        proc.kill()
      } catch {
        /* already dead */
      }
    }
    this.rejectPending(new Error('tmux control-mode client was disposed'))
  }

  private onChunk(chunk: Buffer): void {
    if (!this.alive) return
    // latin1 is byte-exact: tmux escapes only bytes < 0x20 and the backslash, so anything >= 0x80
    // travels raw and a utf8 decode HERE would mangle it beyond recovery.
    const text = chunk.toString('latin1')
    this.pendingBytes += text.length
    if (this.pendingBytes > MAX_PENDING_BYTES) {
      this.die(`tmux control-mode client wedged (${MAX_PENDING_BYTES} bytes, no complete event)`)
      return
    }
    const events = this.decoder.push(text)
    if (events.length > 0) this.pendingBytes = 0
    for (const ev of events) {
      this.dispatch(ev)
      if (!this.alive) return
    }
  }

  private dispatch(ev: ControlEvent): void {
    if (ev.kind === 'output') {
      // The codec hands back one CHAR per byte; re-assemble to a Buffer and decode UTF-8 with a
      // streaming decoder so a character split across %output lines survives.
      let dec = this.utf8.get(ev.paneId)
      if (!dec) this.utf8.set(ev.paneId, (dec = new StringDecoder('utf8')))
      const text = dec.write(Buffer.from(ev.data, 'latin1'))
      if (text) this.opts.onOutput(text)
    } else if (ev.kind === 'reply') {
      this.pending.shift()?.resolve({ ok: ev.ok, body: ev.body })
    } else if (ev.kind === 'exited') {
      this.die('tmux control-mode client exited')
    }
    // 'other' notifications (%session-changed, %window-add, …) carry nothing this client acts on.
  }

  /** The client died on us: notify once, fail everyone waiting, and make sure the process is gone. */
  private die(why: string): void {
    if (this.gone || this.disposed) return
    this.gone = true
    try {
      this.proc?.kill()
    } catch {
      /* already dead */
    }
    this.rejectPending(new Error(why))
    this.opts.onExit()
  }

  private rejectPending(err: Error): void {
    while (this.pending.length > 0) this.pending.shift()?.reject(err)
  }
}

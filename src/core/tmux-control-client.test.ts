import { describe, it, expect, vi } from 'vitest'
import { ControlModeClient, MAX_PENDING_BYTES, type ControlSpawn } from './tmux-control-client'

/**
 * The client is the only place that owns a tmux control-mode PROCESS, so everything worth asserting
 * here is a lifecycle promise: what gets spawned, that bytes arrive undamaged, that replies pair with
 * the right command, and that a dead or wedged peer never leaves a caller hanging forever.
 */

/** One fake child per spawn: tests drive stdout with `feed`, then read back what was written. */
interface FakeChild {
  writes: string[]
  killed: number
  exit(code: number | null): void
  feed(latin1: string): void
}

class FakeControlSpawn implements ControlSpawn {
  calls: Array<{ bin: string; args: string[] }> = []
  children: FakeChild[] = []
  spawn(bin: string, args: string[]) {
    this.calls.push({ bin, args })
    let onData: ((b: Buffer) => void) | undefined
    let onExit: ((code: number | null) => void) | undefined
    const child: FakeChild = {
      writes: [],
      killed: 0,
      exit: (code) => onExit?.(code),
      // Buffer.from(s, 'latin1') is the byte-exact transport the real spawner hands us.
      feed: (s) => onData?.(Buffer.from(s, 'latin1'))
    }
    this.children.push(child)
    return {
      stdin: {
        write: (s: string) => {
          child.writes.push(s)
        }
      },
      stdout: {
        on: (_ev: 'data', cb: (b: Buffer) => void) => {
          onData = cb
        }
      },
      on: (_ev: 'exit', cb: (code: number | null) => void) => {
        onExit = cb
      },
      kill: () => {
        child.killed++
      }
    }
  }
  get only(): FakeChild {
    return this.children[0]
  }
}

/** A started client plus its fake, wired with recording callbacks — the shape every test needs. */
function makeClient(over: Partial<{ onOutput: (d: string) => void; onExit: () => void }> = {}) {
  const spawner = new FakeControlSpawn()
  const out: string[] = []
  const exits: number[] = []
  const client = new ControlModeClient({
    tmuxBin: '/opt/homebrew/bin/tmux',
    socket: 'node-terminal',
    sessionName: 'nt-term-1',
    onOutput: over.onOutput ?? ((d) => out.push(d)),
    onExit: over.onExit ?? (() => exits.push(1)),
    spawner
  })
  client.start()
  return { client, spawner, out, exits, child: spawner.only }
}

/** tmux answers `%begin/%end`; ts and num must repeat in the terminator or the codec keeps the block open. */
function reply(num: number, body: string[] = [], ok = true): string {
  const term = ok ? '%end' : '%error'
  return [`%begin 1700 ${num} 0`, ...body, `${term} 1700 ${num} 0`, ''].join('\n')
}

describe('ControlModeClient.start', () => {
  it('spawns tmux in control mode on the session socket', () => {
    const { spawner } = makeClient()
    expect(spawner.calls).toEqual([
      {
        bin: '/opt/homebrew/bin/tmux',
        args: ['-L', 'node-terminal', '-C', 'attach-session', '-t', 'nt-term-1']
      }
    ])
  })
  it('is alive once started and not before', () => {
    const spawner = new FakeControlSpawn()
    const client = new ControlModeClient({
      tmuxBin: 'tmux',
      socket: 's',
      sessionName: 'nt-term-1',
      onOutput: () => {},
      onExit: () => {},
      spawner
    })
    expect(client.alive).toBe(false)
    client.start()
    expect(client.alive).toBe(true)
  })
})

describe('ControlModeClient output', () => {
  it('delivers %output payloads to onOutput with the octal escapes decoded', () => {
    const { child, out } = makeClient()
    child.feed('%output %1 hi\\015\\012')
    child.feed('there\\012\n')
    expect(out).toEqual(['hi\r\nthere\n'])
  })
  it('re-assembles a UTF-8 character split across two %output lines', () => {
    // The transport is latin1 (bytes >= 0x80 ride RAW and unescaped), so `ç` arrives as the two
    // chars \xc3 \xa7 — possibly in different lines. A per-byte utf8 decode would emit two U+FFFDs.
    const { child, out } = makeClient()
    child.feed('%output %1 \xc3\n')
    child.feed('%output %1 \xa7\n')
    expect(out.join('')).toBe('ç')
  })
  it('ignores notifications that are neither output nor replies', () => {
    const { child, out } = makeClient()
    child.feed('%session-changed $0 nt-term-1\n%window-add @2\n')
    expect(out).toEqual([])
  })
})

describe('ControlModeClient.sendKeys', () => {
  it('writes the hex send-keys line and resolves true on an ok reply', async () => {
    const { client, child } = makeClient()
    const p = client.sendKeys('ls\n')
    expect(child.writes).toEqual(['send-keys -t nt-term-1 -H 6c 73 0a\n'])
    child.feed(reply(1))
    await expect(p).resolves.toBe(true)
  })
  it('resolves false when tmux answers %error', async () => {
    const { client, child } = makeClient()
    const p = client.sendKeys('x')
    child.feed(reply(1, ["can't find pane"], false))
    await expect(p).resolves.toBe(false)
  })
  it('can target another session on the same server', async () => {
    const { client, child } = makeClient()
    const p = client.sendKeys('x', 'nt-term-9')
    expect(child.writes).toEqual(['send-keys -t nt-term-9 -H 78\n'])
    child.feed(reply(1))
    await expect(p).resolves.toBe(true)
  })
})

describe('ControlModeClient.command', () => {
  it('resolves with the reply body', async () => {
    const { client, child } = makeClient()
    const p = client.command('list-panes')
    expect(child.writes).toEqual(['list-panes\n'])
    child.feed(reply(1, ['%1: [80x24]']))
    await expect(p).resolves.toEqual({ ok: true, body: ['%1: [80x24]'] })
  })
  it('pairs overlapping commands with replies in FIFO arrival order', async () => {
    // Control mode answers in order and the reply carries no correlation to the command text, so
    // arrival order IS the correlation. Getting this wrong silently swaps two callers' answers.
    const { client, child } = makeClient()
    const first = client.command('display -p #{pane_width}')
    const second = client.command('display -p #{pane_height}')
    expect(child.writes).toEqual(['display -p #{pane_width}\n', 'display -p #{pane_height}\n'])
    child.feed(reply(1, ['80']))
    child.feed(reply(2, ['24']))
    expect(await first).toEqual({ ok: true, body: ['80'] })
    expect(await second).toEqual({ ok: true, body: ['24'] })
  })
  it('refuses a line with an embedded newline instead of desyncing the FIFO', async () => {
    // One `command()` call queues ONE resolver, so a line carrying its own newline would send TWO
    // commands, draw TWO replies, and pair every later reply with the wrong caller — forever, since
    // this layer has no timers to notice. Reject before anything is written or queued.
    const { client, child } = makeClient()
    const bad = client.command('display -p a\nkill-server')
    await expect(bad).rejects.toThrow(/newline/)
    expect(child.writes).toEqual([])
    const good = client.command('list-panes')
    child.feed(reply(1, ['still in phase']))
    await expect(good).resolves.toEqual({ ok: true, body: ['still in phase'] })
  })
  it('refuses a line with an embedded carriage return', async () => {
    const { client, child } = makeClient()
    await expect(client.command('display -p a\rkill-server')).rejects.toThrow(/newline/)
    expect(child.writes).toEqual([])
  })
  it('rejects instead of hanging when the client is not running', async () => {
    const spawner = new FakeControlSpawn()
    const client = new ControlModeClient({
      tmuxBin: 'tmux',
      socket: 's',
      sessionName: 'nt-term-1',
      onOutput: () => {},
      onExit: () => {},
      spawner
    })
    await expect(client.command('list-panes')).rejects.toThrow(/not running/)
  })
})

describe('ControlModeClient exit', () => {
  it('fires onExit once, rejects pending commands and stops being alive', async () => {
    const onExit = vi.fn()
    const { client, child } = makeClient({ onExit })
    const pending = client.command('list-panes')
    child.exit(0)
    child.exit(0) // a second exit event must not double-notify the owner
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(client.alive).toBe(false)
    await expect(pending).rejects.toThrow(/exited/)
  })
  it('treats a %exit notification as the end of the client', async () => {
    const onExit = vi.fn()
    const { client, child } = makeClient({ onExit })
    const pending = client.command('list-panes')
    child.feed('%exit server exited\n')
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(client.alive).toBe(false)
    expect(child.killed).toBe(1)
    await expect(pending).rejects.toThrow(/exited/)
  })
  it('kills a peer that floods the stream without ever completing an event', async () => {
    // The codec buffers an unterminated line and an unterminated %begin block FOREVER; a peer that
    // loses a terminator would grow the heap until the app dies. Past the cap we call it broken.
    const onExit = vi.fn()
    const { client, child } = makeClient({ onExit })
    const pending = client.command('list-panes')
    child.feed('%begin 1700 1 0\n')
    // Fed in realistic ~64KiB pipe chunks, each one complete lines and each far under the cap: what
    // must trip is the total accumulated SINCE THE LAST COMPLETED EVENT (no event can complete while
    // the block stays open), not any single chunk's length.
    const chunk = `${'x'.repeat(64 * 1024 - 1)}\n`
    const enough = Math.ceil(MAX_PENDING_BYTES / chunk.length) + 1
    for (let i = 0; i < enough && client.alive; i++) child.feed(chunk)
    expect(child.killed).toBe(1)
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(client.alive).toBe(false)
    await expect(pending).rejects.toThrow(/wedged|exited/)
  })
  it('does not count healthy traffic towards the flood cap', () => {
    const { client, child } = makeClient()
    const line = `%output %1 ${'x'.repeat(1000)}\n`
    for (let i = 0; i < Math.ceil(MAX_PENDING_BYTES / line.length) + 10; i++) child.feed(line)
    expect(client.alive).toBe(true)
    expect(child.killed).toBe(0)
  })
})

describe('ControlModeClient with the real child_process spawner', () => {
  it('reports a tmux binary that cannot be spawned as an exit', async () => {
    // The default spawner is otherwise untested, and ENOENT is its nastiest path: Node emits 'error'
    // (which THROWS if unhandled) and may never emit 'exit', so a client without that wiring would
    // both crash the app and stay "alive" with every command hanging forever.
    let resolveExit: () => void
    const exited = new Promise<void>((r) => (resolveExit = r))
    const client = new ControlModeClient({
      tmuxBin: '/nonexistent/tmux-does-not-exist',
      socket: 'node-terminal',
      sessionName: 'nt-term-1',
      onOutput: () => {},
      onExit: () => resolveExit()
    })
    client.start()
    await exited
    expect(client.alive).toBe(false)
    await expect(client.command('list-panes')).rejects.toThrow(/not running/)
  })
})

describe('ControlModeClient.dispose', () => {
  it('detaches politely, then kills', () => {
    const { client, child } = makeClient()
    client.dispose()
    expect(child.writes).toEqual(['detach-client\n'])
    expect(child.killed).toBe(1)
    expect(client.alive).toBe(false)
  })
  it('is idempotent', () => {
    const { client, child } = makeClient()
    client.dispose()
    client.dispose()
    expect(child.writes).toEqual(['detach-client\n'])
    expect(child.killed).toBe(1)
  })
  it('rejects pending commands but does not report an unexpected exit', async () => {
    // A swap-out (Task 3) disposes the shadow on purpose; onExit means "the client died on us" and
    // firing it here would make the owner re-attach the very shadow it just retired.
    const onExit = vi.fn()
    const { client, child } = makeClient({ onExit })
    const pending = client.command('list-panes')
    client.dispose()
    child.exit(0)
    expect(onExit).not.toHaveBeenCalled()
    await expect(pending).rejects.toThrow(/disposed/)
  })
  it('stops delivering output after disposal', () => {
    const { client, child, out } = makeClient()
    client.dispose()
    child.feed('%output %1 late\n')
    expect(out).toEqual([])
  })
})

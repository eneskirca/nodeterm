import { describe, it, expect } from 'vitest'
import { applyPhoneReadAck, sweepAckDir, createAckSweeper, type AckSweepFsLike } from './ack-sweep'

/**
 * In-memory fs double for the sweeper. `dir` is a flat map of name → content; `mtime` advances on
 * every mutation so `createAckSweeper`'s dir-mtime gate can be exercised. `rm` records deletions.
 */
function fakeFs(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial))
  let mtimeMs = 1
  const readErrors = new Set<string>()
  const fs: AckSweepFsLike = {
    readdirSync: (_dir) => [...files.keys()],
    readFileSync: (p, _e) => {
      const name = p.split('/').pop() as string
      if (readErrors.has(name)) throw new Error('EACCES')
      if (!files.has(name)) throw new Error('ENOENT')
      return files.get(name) as string
    },
    statSync: (_p) => ({ mtimeMs }),
    rmSync: (p, _o) => {
      const name = p.split('/').pop() as string
      if (files.delete(name)) mtimeMs++
    }
  }
  return {
    fs,
    files,
    setMtime: (n: number) => (mtimeMs = n),
    getMtime: () => mtimeMs,
    failRead: (name: string) => readErrors.add(name),
    clearReadError: (name: string) => readErrors.delete(name),
    add: (name: string, content: string) => {
      files.set(name, content)
      mtimeMs++
    }
  }
}

const DIR = '/home/u/.nodeterm/acks'

describe('sweepAckDir — consume + resolve + delete', () => {
  it('acks each node, clears its unread, and deletes the file', () => {
    const f = fakeFs({ 'nt-a.seen': 'evt-1', 'nt-b.seen': 'evt-2' })
    const acked: string[] = []
    const cleared: string[] = []
    const consumed = sweepAckDir(DIR, f.fs, {
      ackDone: (id) => acked.push(id),
      onUnreadClear: (id) => cleared.push(id)
    })
    expect(consumed.sort()).toEqual(['nt-a', 'nt-b'])
    expect(acked.sort()).toEqual(['nt-a', 'nt-b'])
    expect(cleared.sort()).toEqual(['nt-a', 'nt-b'])
    // Files are consumed exactly once — nothing left on disk.
    expect(f.files.size).toBe(0)
  })

  it('tolerates junk: ignores non-.seen files and empty-name entries', () => {
    const f = fakeFs({
      'nt-a.seen': 'evt-1',
      'README.txt': 'not an ack',
      '.seen': 'empty node id',
      'nt-b.other': 'wrong ext'
    })
    const acked: string[] = []
    const consumed = sweepAckDir(DIR, f.fs, {
      ackDone: (id) => acked.push(id),
      onUnreadClear: () => {}
    })
    expect(consumed).toEqual(['nt-a'])
    expect(acked).toEqual(['nt-a'])
    // Only the consumed .seen is deleted; junk is left untouched.
    expect([...f.files.keys()].sort()).toEqual(['.seen', 'README.txt', 'nt-b.other'])
  })

  it('skips an unreadable (mid-write) .seen and retries it next pass', () => {
    const f = fakeFs({ 'nt-a.seen': 'evt-1', 'nt-b.seen': 'evt-2' })
    f.failRead('nt-a.seen')
    const acked: string[] = []
    const first = sweepAckDir(DIR, f.fs, { ackDone: (id) => acked.push(id), onUnreadClear: () => {} })
    expect(first).toEqual(['nt-b']) // a was unreadable this pass, skipped (still on disk)
    expect(f.files.has('nt-a.seen')).toBe(true)
    // The write finishes (file readable) — next pass consumes it.
    f.clearReadError('nt-a.seen')
    const second = sweepAckDir(DIR, f.fs, { ackDone: (id) => acked.push(id), onUnreadClear: () => {} })
    expect(second).toEqual(['nt-a'])
    expect(acked.sort()).toEqual(['nt-a', 'nt-b'])
    expect(f.files.size).toBe(0)
  })

  it('a missing directory yields nothing (fail-open)', () => {
    const fs: AckSweepFsLike = {
      readdirSync: () => {
        throw new Error('ENOENT')
      },
      readFileSync: () => '',
      statSync: () => ({ mtimeMs: 1 }),
      rmSync: () => {}
    }
    expect(sweepAckDir(DIR, fs, { ackDone: () => {}, onUnreadClear: () => {} })).toEqual([])
  })

  it('a throwing ackDone still clears unread and deletes the file (never re-ack loop)', () => {
    const f = fakeFs({ 'nt-a.seen': 'evt-1' })
    const cleared: string[] = []
    const consumed = sweepAckDir(DIR, f.fs, {
      ackDone: () => {
        throw new Error('boom')
      },
      onUnreadClear: (id) => cleared.push(id)
    })
    expect(consumed).toEqual(['nt-a'])
    expect(cleared).toEqual(['nt-a'])
    expect(f.files.size).toBe(0)
  })
})

describe('createAckSweeper — dir-mtime gate + no re-ack loop', () => {
  it('consumes on the first drop, then does NOT re-process until a new drop lands', () => {
    const f = fakeFs({ 'nt-a.seen': 'evt-1' })
    const acked: string[] = []
    const cleared: string[] = []
    const sweeper = createAckSweeper({
      dir: DIR,
      fs: f.fs,
      handlers: { ackDone: (id) => acked.push(id), onUnreadClear: (id) => cleared.push(id) }
    })
    // First sweep: dir mtime (1) differs from the initial -1 → scan + consume.
    expect(sweeper.sweep()).toEqual(['nt-a'])
    expect(acked).toEqual(['nt-a'])
    // Second sweep with no new drop: mtime unchanged since our post-delete capture → skipped,
    // so the ack does NOT fire again (no re-ack loop).
    expect(sweeper.sweep()).toEqual([])
    expect(acked).toEqual(['nt-a'])
    // A new ack from the phone bumps the dir mtime → next sweep picks it up.
    f.add('nt-b.seen', 'evt-2')
    expect(sweeper.sweep()).toEqual(['nt-b'])
    expect(acked.sort()).toEqual(['nt-a', 'nt-b'])
    expect(cleared.sort()).toEqual(['nt-a', 'nt-b'])
  })

  it('start()/stop() are idempotent and drive sweeps on the interval', () => {
    const f = fakeFs({})
    const acked: string[] = []
    const sweeper = createAckSweeper({
      dir: DIR,
      fs: f.fs,
      intervalMs: 10,
      handlers: { ackDone: (id) => acked.push(id), onUnreadClear: () => {} }
    })
    sweeper.start()
    sweeper.start() // idempotent — no second timer
    sweeper.stop()
    expect(acked).toEqual([])
  })
})

// The relay's `inbox.ack` (relay-only hosts: no SSH to drop a `.seen` over) runs the same body.
describe('applyPhoneReadAck — the one read-ack body every arrival path shares', () => {
  it('acks then clears, once each, without re-acking', () => {
    const calls: string[] = []
    applyPhoneReadAck('n1', { ackDone: (id) => calls.push(`ack:${id}`), onUnreadClear: (id) => calls.push(`clear:${id}`) })
    expect(calls).toEqual(['ack:n1', 'clear:n1'])
  })
  it('a throwing ackDone still clears the unread dot', () => {
    const calls: string[] = []
    applyPhoneReadAck('n1', {
      ackDone: () => {
        throw new Error('boom')
      },
      onUnreadClear: (id) => calls.push(`clear:${id}`)
    })
    expect(calls).toEqual(['clear:n1'])
  })
})

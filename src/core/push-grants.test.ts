import { describe, it, expect } from 'vitest'
import path from 'path'
import {
  loadPushGrants,
  createGrantsAccessor,
  type GrantsFsLike
} from './push-grants'

const DIR = '/home/user/.nodeterm/push-grants'

interface FakeFile {
  content: string
  mtimeMs: number
}

/** In-memory fs standing in for the grant directory. Tracks a directory mtime that bumps on any
 *  add/remove (as a real filesystem does), and per-file mtimes the accessor's dead-mark keys on. */
class FakeFs {
  private files = new Map<string, FakeFile>()
  dirMtime = 1000
  readdirCalls = 0

  put(name: string, content: string, mtimeMs: number, bumpDir = true): void {
    this.files.set(path.join(DIR, name), { content, mtimeMs })
    if (bumpDir) this.dirMtime++
  }

  grant(name: string, grant: string, mtimeMs: number, extra: Record<string, unknown> = {}): void {
    this.put(name, JSON.stringify({ v: 1, grant, ...extra }), mtimeMs)
  }

  remove(name: string): void {
    this.files.delete(path.join(DIR, name))
    this.dirMtime++
  }

  fs(): GrantsFsLike {
    return {
      readdirSync: (d) => {
        this.readdirCalls++
        if (d !== DIR) throw new Error('ENOENT')
        return [...this.files.keys()].map((p) => path.basename(p))
      },
      readFileSync: (p) => {
        const f = this.files.get(p)
        if (!f) throw new Error('ENOENT')
        return f.content
      },
      statSync: (p) => {
        if (p === DIR) return { mtimeMs: this.dirMtime }
        const f = this.files.get(p)
        if (!f) throw new Error('ENOENT')
        return { mtimeMs: f.mtimeMs }
      }
    }
  }
}

describe('loadPushGrants', () => {
  it('reads valid *.grant files, parsing deviceId from filename + connectionId from body', () => {
    const ff = new FakeFs()
    ff.grant('dev-A.grant', 'tok-A', 10, { connectionId: 'conn-A' })
    ff.grant('dev-B.grant', 'tok-B', 20)
    const got = loadPushGrants(DIR, ff.fs())
    expect(got).toEqual([
      { deviceId: 'dev-A', grant: 'tok-A', connectionId: 'conn-A' },
      { deviceId: 'dev-B', grant: 'tok-B' }
    ])
  })

  it('is tolerant: skips non-.grant files, bad JSON, wrong version, and missing grant', () => {
    const ff = new FakeFs()
    ff.grant('good.grant', 'tok-good', 10)
    ff.put('notes.txt', 'ignore me', 10) // wrong extension
    ff.put('junk.grant', '{not json', 10) // unparseable (half-written)
    ff.put('v2.grant', JSON.stringify({ v: 2, grant: 'tok-v2' }), 10) // wrong schema version
    ff.put('nogrant.grant', JSON.stringify({ v: 1 }), 10) // no grant string
    ff.put('emptygrant.grant', JSON.stringify({ v: 1, grant: '' }), 10) // empty grant
    ff.put('array.grant', JSON.stringify([1, 2, 3]), 10) // not an object
    const got = loadPushGrants(DIR, ff.fs())
    expect(got).toEqual([{ deviceId: 'good', grant: 'tok-good' }])
  })

  it('returns [] for a missing directory (readdir throws)', () => {
    const fsi: GrantsFsLike = {
      readdirSync: () => {
        throw new Error('ENOENT')
      },
      readFileSync: () => '',
      statSync: () => ({ mtimeMs: 0 })
    }
    expect(loadPushGrants(DIR, fsi)).toEqual([])
  })
})

describe('createGrantsAccessor', () => {
  it('caches: no full re-scan while the dir mtime is unchanged and the TTL has not elapsed', () => {
    const ff = new FakeFs()
    ff.grant('dev-A.grant', 'tok-A', 10)
    let clock = 0
    const acc = createGrantsAccessor({ dir: DIR, fs: ff.fs(), now: () => clock, ttlMs: 1000 })
    expect(acc.get().map((g) => g.grant)).toEqual(['tok-A'])
    expect(ff.readdirCalls).toBe(1)
    // A second get() shortly after (dir mtime same) hits the cache — no readdir.
    clock = 500
    acc.get()
    expect(ff.readdirCalls).toBe(1)
  })

  it('re-scans when the dir mtime changes (a new grant dropped)', () => {
    const ff = new FakeFs()
    ff.grant('dev-A.grant', 'tok-A', 10)
    let clock = 0
    const acc = createGrantsAccessor({ dir: DIR, fs: ff.fs(), now: () => clock, ttlMs: 100000 })
    expect(acc.get().map((g) => g.grant)).toEqual(['tok-A'])
    // Still within TTL, but a new file bumps the dir mtime → cheap stat forces a rescan.
    clock = 10
    ff.grant('dev-B.grant', 'tok-B', 20)
    expect(acc.get().map((g) => g.grant).sort()).toEqual(['tok-A', 'tok-B'])
    expect(ff.readdirCalls).toBe(2)
  })

  it('re-scans once the TTL elapses even if the dir mtime never moved', () => {
    const ff = new FakeFs()
    ff.grant('dev-A.grant', 'tok-A', 10)
    let clock = 0
    const acc = createGrantsAccessor({ dir: DIR, fs: ff.fs(), now: () => clock, ttlMs: 1000 })
    acc.get()
    expect(ff.readdirCalls).toBe(1)
    // Add a file WITHOUT bumping the dir mtime (bumpDir:false) — only the TTL can surface it.
    ff.put('dev-B.grant', JSON.stringify({ v: 1, grant: 'tok-B' }), 20, false)
    clock = 500
    acc.get()
    expect(ff.readdirCalls).toBe(1) // TTL not elapsed, mtime unchanged → cached
    clock = 1500
    expect(acc.get().map((g) => g.grant).sort()).toEqual(['tok-A', 'tok-B'])
    expect(ff.readdirCalls).toBe(2)
  })

  describe('dead-mark lifecycle', () => {
    it('markDead drops a grant from get() until its file changes', () => {
      const ff = new FakeFs()
      ff.grant('dev-A.grant', 'tok-A', 10)
      ff.grant('dev-B.grant', 'tok-B', 20)
      let clock = 0
      const acc = createGrantsAccessor({ dir: DIR, fs: ff.fs(), now: () => clock, ttlMs: 100000 })
      expect(acc.get().map((g) => g.grant).sort()).toEqual(['tok-A', 'tok-B'])
      // A 401/403 for tok-A drops it.
      acc.markDead('tok-A')
      expect(acc.get().map((g) => g.grant)).toEqual(['tok-B'])
      // A rescan with the file UNCHANGED keeps it dead.
      clock = 10
      ff.grant('dev-C.grant', 'tok-C', 30) // bumps dir mtime → forces rescan
      expect(acc.get().map((g) => g.grant).sort()).toEqual(['tok-B', 'tok-C'])
    })

    it('a re-dropped grant file (new mtime) clears the dead mark', () => {
      const ff = new FakeFs()
      ff.grant('dev-A.grant', 'tok-A', 10)
      let clock = 0
      const acc = createGrantsAccessor({ dir: DIR, fs: ff.fs(), now: () => clock, ttlMs: 100000 })
      acc.get()
      acc.markDead('tok-A')
      expect(acc.get()).toEqual([])
      // The phone re-mints + re-drops: same file, new mtime (and it happens to carry a new token,
      // but even the same token with a changed mtime clears the mark).
      clock = 10
      ff.grant('dev-A.grant', 'tok-A', 99)
      expect(acc.get().map((g) => g.grant)).toEqual(['tok-A'])
    })

    it('a vanished grant file clears its dead mark (no leak)', () => {
      const ff = new FakeFs()
      ff.grant('dev-A.grant', 'tok-A', 10)
      let clock = 0
      const acc = createGrantsAccessor({ dir: DIR, fs: ff.fs(), now: () => clock, ttlMs: 100000 })
      acc.get()
      acc.markDead('tok-A')
      clock = 10
      ff.remove('dev-A.grant') // bumps dir mtime → rescan
      expect(acc.get()).toEqual([])
      // Re-drop with the same token: not dead-marked (the mark was cleared when the file vanished).
      clock = 20
      ff.grant('dev-A.grant', 'tok-A', 40)
      expect(acc.get().map((g) => g.grant)).toEqual(['tok-A'])
    })
  })

  it('fails open: a directory that never exists yields [] and never throws', () => {
    const acc = createGrantsAccessor({
      dir: DIR,
      fs: {
        readdirSync: () => {
          throw new Error('ENOENT')
        },
        readFileSync: () => {
          throw new Error('ENOENT')
        },
        statSync: () => {
          throw new Error('ENOENT')
        }
      },
      now: () => 0
    })
    expect(acc.get()).toEqual([])
    expect(() => acc.markDead('x')).not.toThrow()
  })
})

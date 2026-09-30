// "Could not check" must never read as "file not found". A dead ControlMaster, a rejected IPC, a
// permission error: none of them is evidence that a path is absent, and the Cmd/Ctrl+click toast
// must not tell the user a file sitting right there is gone.
import { describe, expect, it } from 'vitest'
import {
  fileMissMessage,
  findExistingForHit,
  findExistingPath,
  makeDirListingLookup,
  missingFileMessage,
  unverifiableFileMessage,
  type PathLookup,
  type PathResolution
} from './file-links'

type Entry = { name: string; dir: boolean }

describe('makeDirListingLookup — a failed listing is not an empty directory', () => {
  it('answers a throwing list as unverified, not as a verified miss', async () => {
    const lookup = makeDirListingLookup(() => Promise.reject(new Error('ssh: master is dead')))
    const r = await lookup('/proj/src/a.ts')
    expect(r.exists).toBe(false)
    expect(r.unverified).toBe('ssh: master is dead')
  })

  it('does not serve a failure from the cache as an empty directory on the next call', async () => {
    let t = 0
    let calls = 0
    const answers: Array<Entry[] | Error> = [new Error('timeout'), [{ name: 'a.ts', dir: false }]]
    const lookup = makeDirListingLookup(
      async () => {
        const a = answers[calls++]
        if (a instanceof Error) throw a
        return a
      },
      3000,
      () => ({}),
      { failureTtlMs: 500, now: () => t }
    )
    expect((await lookup('/proj/src/a.ts')).unverified).toBe('timeout')
    // Inside the short failure window the answer is still "could not check" — never `{exists:false}`.
    t = 100
    const again = await lookup('/proj/src/a.ts')
    expect(again.exists).toBe(false)
    expect(again.unverified).toBe('timeout')
    expect(calls).toBe(1)
    // Past it (and well inside the 3 s success TTL) the directory is asked again, and answers.
    t = 600
    expect(await lookup('/proj/src/a.ts')).toEqual({ exists: true, dir: false })
    expect(calls).toBe(2)
  })

  it('reads an EMPTY listing as unverified: FsApi is fail-open, and the parent of a real file is never empty', async () => {
    // `fs-ops.listDir` / `SshFs.listDir` end `catch { return [] }`, and the SSH IPC resolves `[]`
    // for a project whose master is down — so "listed nothing" is the dead-master case.
    const lookup = makeDirListingLookup(async () => [])
    const r = await lookup('/proj/src/a.ts')
    expect(r.exists).toBe(false)
    expect(r.unverified).toMatch(/\/proj\/src/)
  })

  it('still answers a verified miss when the listing has entries and ours is not among them', async () => {
    const lookup = makeDirListingLookup(async () => [{ name: 'b.ts', dir: false }])
    expect(await lookup('/proj/src/a.ts')).toEqual({ exists: false, dir: false })
  })

  it('never claims a `.git` entry is missing — both listing legs strip it', async () => {
    const lookup = makeDirListingLookup(async () => [{ name: 'src', dir: true }])
    const r = await lookup('/proj/.git')
    expect(r.exists).toBe(false)
    expect(r.unverified).toBeTruthy()
  })
})

const fake =
  (answers: Record<string, PathLookup | Error>) =>
  async (abs: string): Promise<PathLookup> => {
    const a = answers[abs]
    if (a instanceof Error) throw a
    return a ?? { exists: false, dir: false }
  }

describe('findExistingPath — three outcomes', () => {
  it('a throwing lookup gives unverifiable, not missing', async () => {
    const r = await findExistingPath(
      'a/b',
      {},
      { getCwd: () => '/one', lookup: fake({ '/one/a/b': new Error('ssh down') }) }
    )
    expect(r).toEqual({ found: false, tried: ['/one/a/b'], unverified: [{ abs: '/one/a/b', reason: 'ssh down' }] })
  })

  it('carries an unverified lookup answer through', async () => {
    const r = await findExistingPath(
      'a/b',
      {},
      { getCwd: () => '/one', lookup: fake({ '/one/a/b': { exists: false, dir: false, unverified: 'EACCES' } }) }
    )
    expect(r).toEqual({ found: false, tried: ['/one/a/b'], unverified: [{ abs: '/one/a/b', reason: 'EACCES' }] })
  })

  it('a found live-cwd candidate wins over an unverifiable launch-cwd one', async () => {
    const r = await findExistingPath(
      'var/x.sql',
      {},
      {
        getCwd: () => '/launch',
        getLiveCwd: async () => '/live',
        lookup: fake({
          '/launch/var/x.sql': new Error('permission denied'),
          '/live/var/x.sql': { exists: true, dir: false }
        })
      }
    )
    expect(r).toEqual({ found: true, abs: '/live/var/x.sql', dir: false })
  })

  it('stays unverifiable when one candidate is a verified miss and the other could not be checked', async () => {
    const r = await findExistingPath(
      'a/b',
      {},
      {
        getCwd: () => '/one',
        getLiveCwd: async () => '/two',
        lookup: fake({ '/two/a/b': { exists: false, dir: false, unverified: 'timeout' } })
      }
    )
    expect(r).toEqual({ found: false, tried: ['/one/a/b', '/two/a/b'], unverified: [{ abs: '/two/a/b', reason: 'timeout' }] })
  })

  it('a verified miss everywhere carries no `unverified` at all', async () => {
    const r = await findExistingPath('a/b', {}, { getCwd: () => '/one', getLiveCwd: async () => '/two', lookup: fake({}) })
    expect(r).toEqual({ found: false, tried: ['/one/a/b', '/two/a/b'] })
    expect('unverified' in r).toBe(false)
  })
})

describe('the Cmd/Ctrl+click toast', () => {
  it('never says "not found" about a path it could not check', () => {
    expect(unverifiableFileMessage('a/b', ['/one/a/b'], [{ abs: '/one/a/b', reason: 'ssh down' }])).toBe(
      "Couldn't check /one/a/b: ssh down"
    )
  })

  it('names the verified miss beside the unverified one without calling the file gone', () => {
    expect(
      unverifiableFileMessage('a/b', ['/one/a/b', '/two/a/b'], [{ abs: '/two/a/b', reason: 'timeout' }])
    ).toBe("Couldn't check /two/a/b: timeout (not found at /one/a/b)")
  })

  it('lists every unchecked candidate and each distinct reason once', () => {
    expect(
      unverifiableFileMessage(
        'a/b',
        ['/one/a/b', '/two/a/b'],
        [
          { abs: '/one/a/b', reason: 'ssh down' },
          { abs: '/two/a/b', reason: 'ssh down' }
        ]
      )
    ).toBe("Couldn't check a/b at /one/a/b or /two/a/b: ssh down")
  })

  it('fileMissMessage picks the honest sentence', () => {
    expect(fileMissMessage('a/b', { tried: ['/one/a/b'] })).toBe(missingFileMessage('a/b', ['/one/a/b']))
    expect(fileMissMessage('a/b', { tried: ['/one/a/b'], unverified: [] })).toBe('File not found: /one/a/b')
    expect(fileMissMessage('a/b', { tried: ['/one/a/b'], unverified: [{ abs: '/one/a/b', reason: 'x' }] })).toBe(
      "Couldn't check /one/a/b: x"
    )
  })
})

describe('findExistingForHit keeps an unchecked alternative unverified', () => {
  it('a miss where one reading could not be looked at is not a plain "not found"', async () => {
    const find = async (token: string): Promise<PathResolution> =>
      token === 'a b/c.ts'
        ? { found: false, tried: ['/p/a b/c.ts'], unverified: [{ abs: '/p/a b/c.ts', reason: 'ssh down' }] }
        : { found: false, tried: ['/p/' + token] }
    expect(await findExistingForHit(['a b/c.ts', 'b/c.ts'], find)).toEqual({
      found: false,
      tried: ['/p/a b/c.ts', '/p/b/c.ts'],
      unverified: [{ abs: '/p/a b/c.ts', reason: 'ssh down' }]
    })
  })

  it('a verified miss on every reading stays a plain miss', async () => {
    const find = async (token: string): Promise<PathResolution> => ({ found: false, tried: ['/p/' + token] })
    expect(await findExistingForHit(['x', 'y'], find)).toEqual({ found: false, tried: ['/p/x', '/p/y'] })
  })
})

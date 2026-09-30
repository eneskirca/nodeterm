import { describe, expect, it } from 'vitest'
import { cachedCwd, findExistingPath, matchFileTokens, missingFileMessage } from './file-links'

// A fake filesystem: exactly these absolute paths exist.
const fsWith =
  (...files: string[]) =>
  async (abs: string): Promise<{ exists: boolean; dir: boolean }> => ({ exists: files.includes(abs), dir: false })

describe('findExistingPath', () => {
  it('resolves against the launch cwd first and never asks the live cwd on a hit', async () => {
    let asked = 0
    const r = await findExistingPath(
      'var/x.sql',
      {},
      {
        getCwd: () => '/proj',
        getLiveCwd: async () => {
          asked++
          return '/elsewhere'
        },
        lookup: fsWith('/proj/var/x.sql', '/elsewhere/var/x.sql')
      }
    )
    expect(r).toEqual({ found: true, abs: '/proj/var/x.sql', dir: false })
    expect(asked).toBe(0)
  })

  it('falls back to the pane\'s live cwd when the launch cwd misses (the agent runs elsewhere)', async () => {
    const r = await findExistingPath(
      'var/otta-aktarim/1-OTTADA-CALISTIR.sql',
      {},
      {
        getCwd: () => '/Users/me',
        getLiveCwd: async () => '/Users/me/otta',
        lookup: fsWith('/Users/me/otta/var/otta-aktarim/1-OTTADA-CALISTIR.sql')
      }
    )
    expect(r).toEqual({ found: true, abs: '/Users/me/otta/var/otta-aktarim/1-OTTADA-CALISTIR.sql', dir: false })
  })

  it('anchors a relative token on the live cwd when the node has no cwd at all', async () => {
    const r = await findExistingPath('src/a.ts', {}, { getCwd: () => undefined, getLiveCwd: async () => '/w', lookup: fsWith('/w/src/a.ts') })
    expect(r).toEqual({ found: true, abs: '/w/src/a.ts', dir: false })
  })

  it('reports every path it tried, once each, when neither cwd holds the file', async () => {
    expect(
      await findExistingPath('a/b', {}, { getCwd: () => '/one', getLiveCwd: async () => '/two', lookup: fsWith() })
    ).toEqual({ found: false, tried: ['/one/a/b', '/two/a/b'] })
    // Same directory twice is one attempt.
    expect(
      await findExistingPath('a/b', {}, { getCwd: () => '/one', getLiveCwd: async () => '/one/', lookup: fsWith() })
    ).toEqual({ found: false, tried: ['/one/a/b'] })
  })

  it('does not re-anchor an absolute or home-relative token on the live cwd', async () => {
    let asked = 0
    const getLiveCwd = async (): Promise<string> => {
      asked++
      return '/two'
    }
    expect(await findExistingPath('/abs/x', {}, { getCwd: () => '/one', getLiveCwd, lookup: fsWith() })).toEqual({
      found: false,
      tried: ['/abs/x']
    })
    expect(await findExistingPath('~/x/y', {}, { getCwd: () => '/one', getLiveCwd, lookup: fsWith() })).toEqual({
      found: false,
      tried: ['~/x/y']
    })
    expect(asked).toBe(0)
  })

  it('reads a throwing lookup as unchecked (never a verified miss) and a throwing live-cwd read as unknown, never a rejection', async () => {
    const r = await findExistingPath(
      'a/b',
      {},
      {
        getCwd: () => '/one',
        getLiveCwd: () => Promise.reject(new Error('tmux gone')),
        lookup: () => Promise.reject(new Error('ssh down'))
      }
    )
    expect(r).toEqual({ found: false, tried: ['/one/a/b'], unverified: [{ abs: '/one/a/b', reason: 'ssh down' }] })
  })

  it('uses the Windows dialect for both candidates', async () => {
    const r = await findExistingPath(
      'src\\a.ts',
      { windows: true },
      { getCwd: () => 'C:\\one', getLiveCwd: async () => 'C:\\two', lookup: fsWith('C:/two/src/a.ts') }
    )
    expect(r).toEqual({ found: true, abs: 'C:/two/src/a.ts', dir: false })
  })
})

describe('the reported line', () => {
  it('matches the path inside an agent\'s `› [file] … (2.8KB)` line', () => {
    const line = '  › [file] var/otta-aktarim/1-OTTADA-CALISTIR.sql (2.8KB)'
    expect(matchFileTokens(line).map((t) => t.path)).toEqual(['var/otta-aktarim/1-OTTADA-CALISTIR.sql'])
  })
})

describe('cachedCwd', () => {
  it('coalesces concurrent reads and caches a value for the TTL', async () => {
    let t = 0
    let reads = 0
    const get = cachedCwd(
      async () => {
        reads++
        return '/w'
      },
      1000,
      () => t
    )
    expect(await Promise.all([get(), get(), get()])).toEqual(['/w', '/w', '/w'])
    expect(reads).toBe(1)
    t = 999
    await get()
    expect(reads).toBe(1)
    t = 1000
    await get()
    expect(reads).toBe(2)
  })

  it('does not cache an unknown answer or a failure', async () => {
    let reads = 0
    const answers: Array<string | null | Error> = [null, new Error('x'), '/w']
    const get = cachedCwd(async () => {
      const a = answers[reads++]
      if (a instanceof Error) throw a
      return a
    })
    expect(await get()).toBeUndefined()
    expect(await get()).toBeUndefined()
    expect(await get()).toBe('/w')
    expect(reads).toBe(3)
  })
})

describe('missingFileMessage', () => {
  it('names where it looked', () => {
    expect(missingFileMessage('a/b', ['/one/a/b'])).toBe('File not found: /one/a/b')
    expect(missingFileMessage('a/b', ['/one/a/b', '/two/a/b'])).toBe(
      'File not found: a/b — looked in /one/a/b and /two/a/b'
    )
    expect(missingFileMessage('a/b', [])).toBe('File not found: a/b (no working directory to resolve it against)')
  })
})

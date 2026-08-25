import { describe, it, expect } from 'vitest'
import { parseSubmoduleStatus } from './worktree'
import { listSubmodules, type GitExec } from './worktree-ops'

const ok = (out = ''): GitExec => ({ ok: true, out, err: '' })
const ko = (err = 'fail'): GitExec => ({ ok: false, out: '', err })

/** Fake git executor: returns a canned result keyed by `args.join(' ')`, records every call. */
function fakeGit(handlers: Record<string, GitExec>) {
  const calls: string[][] = []
  const git = async (_cwd: string, args: string[]): Promise<GitExec> => {
    calls.push(args)
    return handlers[args.join(' ')] ?? ok()
  }
  return { git, calls }
}

describe('parseSubmoduleStatus', () => {
  it('parses a clean checked-out submodule (leading space, with description)', () => {
    const out = ' a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 vendor/lib (1.2.3)'
    const e = parseSubmoduleStatus(out)
    expect(e).toHaveLength(1)
    expect(e[0]).toEqual({ path: 'vendor/lib', sha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0', prunable: false })
  })

  it('parses a submodule with no trailing description', () => {
    const out = ' a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 vendor/lib'
    const e = parseSubmoduleStatus(out)
    expect(e).toHaveLength(1)
    expect(e[0].path).toBe('vendor/lib')
    expect(e[0].prunable).toBe(false)
  })

  it('marks a `-` (uninitialized/absent) submodule as prunable', () => {
    const out = '-0000000000000000000000000000000000000000 vendor/missing'
    const e = parseSubmoduleStatus(out)
    expect(e).toHaveLength(1)
    expect(e[0]).toEqual({ path: 'vendor/missing', sha: '0000000000000000000000000000000000000000', prunable: true })
  })

  it('does NOT mark a `+` (SHA differs) submodule as prunable — the directory exists', () => {
    const out = '+a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 vendor/lib (1.2.3)'
    const e = parseSubmoduleStatus(out)
    expect(e[0].prunable).toBe(false)
  })

  it('handles a path containing spaces (no description)', () => {
    const out = ' a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 my sub module'
    const e = parseSubmoduleStatus(out)
    expect(e[0].path).toBe('my sub module')
  })

  it('parses multiple lines (recursive nesting)', () => {
    const out = [
      ' a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 outer/sub (v1)',
      ' b1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 outer/sub/inner'
    ].join('\n')
    const e = parseSubmoduleStatus(out)
    expect(e.map((x) => x.path)).toEqual(['outer/sub', 'outer/sub/inner'])
  })

  it('skips blank lines and lines without a 40-char SHA', () => {
    const out = '\n  not a submodule line\n a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 vendor/lib'
    const e = parseSubmoduleStatus(out)
    expect(e).toHaveLength(1)
    expect(e[0].path).toBe('vendor/lib')
  })
})

describe('listSubmodules (the ok:false rule, mirroring listWorktrees)', () => {
  const cleanSub = ' a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 vendor/lib (v1)'
  const absentSub = '-0000000000000000000000000000000000000000 vendor/gone'

  it('says ok:false when git itself fails — an empty list is NOT proof of absence', async () => {
    const { git } = fakeGit({ 'submodule status --recursive': ko('not a repo') })
    expect(await listSubmodules(git, '/repo', async () => false)).toEqual({ ok: false, entries: [] })
  })

  it('says ok:true for a repo that genuinely has no submodules', async () => {
    const { git } = fakeGit({ 'submodule status --recursive': ok('') })
    expect(await listSubmodules(git, '/repo')).toEqual({ ok: true, entries: [] })
  })

  it('says ok:false without calling git when there is no repo path', async () => {
    const { git, calls } = fakeGit({})
    expect(await listSubmodules(git, '')).toEqual({ ok: false, entries: [] })
    expect(calls.length).toBe(0)
  })

  it('ORs the `-` flag with the path stat so a directory git thinks is healthy is caught', async () => {
    // A clean (` `) submodule whose directory was deleted behind git's back — git says healthy, the
    // stat says gone. prunable must be true (the stat fallback, mirroring the worktree blindness).
    const { git } = fakeGit({ 'submodule status --recursive': ok(cleanSub) })
    const { entries } = await listSubmodules(git, '/repo', async (p) => p !== '/repo/vendor/lib')
    expect(entries[0]).toEqual({
      path: 'vendor/lib',
      sha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
      prunable: true
    })
  })

  it('keeps a clean submodule with a live directory as not prunable', async () => {
    const { git } = fakeGit({ 'submodule status --recursive': ok(cleanSub) })
    const { entries } = await listSubmodules(git, '/repo', async () => true)
    expect(entries[0].prunable).toBe(false)
  })

  it('joins the relative path against the repo root (trailing slash tolerated)', async () => {
    const { git, calls } = fakeGit({ 'submodule status --recursive': ok(cleanSub) })
    await listSubmodules(git, '/repo/', async (p) => {
      // The stat path is the repo root (slash-stripped) joined with the relative submodule path.
      expect(p).toBe('/repo/vendor/lib')
      return true
    })
    expect(calls[0]).toEqual(['submodule', 'status', '--recursive'])
  })

  it('reports an uninitialized (`-`) submodule as prunable even when the stat says it exists', async () => {
    // git's `-` already means absent; the OR keeps it prunable regardless of the stat.
    const { git } = fakeGit({ 'submodule status --recursive': ok(absentSub) })
    const { entries } = await listSubmodules(git, '/repo', async () => true)
    expect(entries[0].prunable).toBe(true)
  })
})

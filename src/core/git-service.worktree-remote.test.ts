// GitService's worktree ops hand the shared ops a `pathExists` — and the only one this process has
// is `fs.existsSync`, which answers about THIS MACHINE and nothing else. But the `git()` executor
// they run through transparently routes to a REMOTE git over the project's ControlMaster whenever
// `resolveGitRemote` claims the cwd. Pairing the two would make every worktree the host lists stat
// as missing here → `prunable: true` for all of them → every bound group struck as missing, and
// `worktreeRemove` answering `worktreeGone` (the renderer's proof that a directory is gone: it
// destroys the descendant terminals' tmux sessions and rewrites their persisted cwds) for a
// worktree that is alive and well on the host.
//
// So the ops REFUSE for a remote repo. These tests pin the refusal, and — because a refusal that
// leaked into the local path would silently kill the whole feature — pin that a LOCAL repo (no
// resolver claiming it) still goes through to real git.
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { GitService } from './git-service'
import { setGitRemoteResolver } from './remote-ssh/remote-git'

const svc = new GitService()

/** Make the resolver claim exactly `repoPath` — i.e. "this repo lives on an SSH host". */
function claimAsRemote(repoPath: string): void {
  setGitRemoteResolver((cwd) =>
    cwd === repoPath ? { conn: { host: 'h', user: 'u' }, controlPath: '/tmp/cm.sock' } : undefined
  )
}

let repo: string

beforeAll(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nt-wt-remote-')))
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  }
  git('init', '-b', 'main')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 't')
  git('commit', '--allow-empty', '-m', 'init')
})

afterAll(() => fs.rmSync(repo, { recursive: true, force: true }))
afterEach(() => setGitRemoteResolver(null))

describe('worktree ops on a LOCAL repo (no remote claims it)', () => {
  it('still reach real git — the remote guard does not swallow the local path', async () => {
    const listed = await svc.worktreeList(repo)
    expect(listed.ok).toBe(true)
    expect(listed.entries.map((e) => e.path)).toEqual([repo])
    // The main checkout is on disk, so the `pathExists` fallback must NOT call it prunable.
    expect(listed.entries[0].prunable).toBeFalsy()
  })

  it('a resolver that claims some OTHER cwd leaves this repo local', async () => {
    claimAsRemote('/somewhere/else')
    const listed = await svc.worktreeList(repo)
    expect(listed.ok).toBe(true)
    expect(listed.entries).toHaveLength(1)
  })
})

describe('submoduleList', () => {
  it('on a LOCAL repo reaches real git (the remote guard does not swallow the local path)', async () => {
    const listed = await svc.submoduleList(repo)
    // A fresh empty repo has no submodules — that is `ok: true` with no entries, NOT a failed read.
    expect(listed).toEqual({ ok: true, entries: [] })
  })

  it('on a REMOTE repo reports a FAILED READ, not an empty list', async () => {
    claimAsRemote(repo)
    const listed = await svc.submoduleList(repo)
    // Same rule as worktreeList: `{ ok: false }` so a caller cannot read an empty list as "no
    // submodules" and drop every auto-link on one bad read. The host's submodules live on the host.
    expect(listed).toEqual({ ok: false, entries: [] })
  })
})

describe('worktree ops on a REMOTE repo', () => {
  it('worktreeList reports a FAILED READ, not an empty list', async () => {
    claimAsRemote(repo)
    const listed = await svc.worktreeList(repo)
    // `{ ok: false }` is the whole point: an `entries: []` with `ok: true` is "there are no
    // worktrees", which the store would act on by striking every bound group as missing.
    expect(listed).toEqual({ ok: false, entries: [] })
  })

  it('worktreeAdd refuses (the path is computed from the LOCAL data dir)', async () => {
    claimAsRemote(repo)
    const r = await svc.worktreeAdd(repo, path.join(repo, '..', 'wt'), 'feat', 'main', true)
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/not supported in SSH projects/i)
  })

  it('worktreeMerge refuses', async () => {
    claimAsRemote(repo)
    const r = await svc.worktreeMerge(repo, 'feat', 'main', false)
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/not supported in SSH projects/i)
  })

  it('worktreeRemove refuses — and the refusal is NEVER dressed up as `worktreeGone`', async () => {
    claimAsRemote(repo)
    for (const pruneOnly of [false, true]) {
      const r = await svc.worktreeRemove(repo, path.join(repo, 'wt'), true, pruneOnly)
      expect(r.ok).toBe(false)
      expect(r.message).toMatch(/not supported in SSH projects/i)
      // The one field the renderer reads as proof a directory is gone (it then destroys the
      // descendant terminals' tmux sessions and rewrites their persisted cwds). A guess about
      // another machine's filesystem must never set it.
      expect(r.worktreeGone).toBeUndefined()
    }
  })

  it('refuses without touching git at all — nothing is created on disk', async () => {
    const wt = path.join(repo, 'wt-should-not-exist')
    claimAsRemote(repo)
    await svc.worktreeAdd(repo, wt, 'feat', 'main', true)
    expect(fs.existsSync(wt)).toBe(false)
    // …and the repo is untouched: still exactly one (local) worktree once the claim is dropped.
    setGitRemoteResolver(null)
    const listed = await svc.worktreeList(repo)
    expect(listed.entries.map((e) => e.path)).toEqual([repo])
  })
})

// history() was the ONE GitService op that bypassed the ssh-routing `git()` executor and ran
// LOCAL git directly against the scope cwd. For an SSH project that cwd is a REMOTE path, so the
// panel's commit history always failed ("Failed to load history") — and, worse in principle, a
// remote path that happens to exist locally would have served the WRONG machine's history.
describe('history routing', () => {
  it('a LOCAL repo lists its commits (the guard must not swallow the local path)', async () => {
    const r = await svc.history(repo)
    expect(r.items.map((i) => i.subject)).toContain('init')
  })

  it('a remote-claimed repo never gets LOCAL git run against its (remote) path', async () => {
    claimAsRemote(repo) // bogus master socket → the remote git fails
    // The invariant is "the local repo's commits are never served as if they were the host's".
    // With every remote call failing, the loader lands on its empty result (or throws) — either
    // reads as a failed load; what it must NOT contain is the LOCAL repo's history.
    const r = await svc.history(repo).catch(() => ({ items: [] }))
    expect(r.items.map((i) => i.subject)).not.toContain('init')
    expect(r.items).toHaveLength(0)
  })
})

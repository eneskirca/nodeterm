import { describe, it, expect } from 'vitest'
import { worktreeAdd, listWorktrees, worktreeMerge, worktreeRemove, type GitExec } from './worktree-ops'

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

describe('worktreeAdd', () => {
  it('uses --no-track -b and a -- separator for a new branch', async () => {
    const { git, calls } = fakeGit({})
    const r = await worktreeAdd(git, '/repo', '/wt/x', 'feature/x', 'main', true)
    expect(r.ok).toBe(true)
    expect(calls[0]).toEqual(['worktree', 'add', '--no-track', '-b', 'feature/x', '--', '/wt/x', 'main'])
  })
  it('uses a -- separator for an existing branch', async () => {
    const { git, calls } = fakeGit({})
    const r = await worktreeAdd(git, '/repo', '/wt/x', 'feature/x', 'main', false)
    expect(r.ok).toBe(true)
    expect(calls[0]).toEqual(['worktree', 'add', '--', '/wt/x', 'feature/x'])
  })
  it('rejects a flag-injecting branch name without calling git', async () => {
    const { git, calls } = fakeGit({})
    const r = await worktreeAdd(git, '/repo', '/wt/x', '--evil', 'main', true)
    expect(r.ok).toBe(false)
    expect(calls.length).toBe(0)
  })
  it('rejects a flag-injecting worktree path without calling git', async () => {
    const { git, calls } = fakeGit({})
    const r = await worktreeAdd(git, '/repo', '--evil', 'feature/x', 'main', true)
    expect(r.ok).toBe(false)
    expect(calls.length).toBe(0)
  })
})

describe('listWorktrees (the git < 2.36 blindness)', () => {
  // git only learned to print `prunable` in 2.36. Debian 11 / Ubuntu 20.04 — the Server Edition's
  // own target platform — ship 2.30, whose porcelain for a worktree whose directory was deleted
  // behind git's back is IDENTICAL to a healthy one (no tag at all). That is what these fixtures
  // are: the porcelain never says `prunable`; only the stat knows the truth.
  const oldGitPorcelain =
    'worktree /repo\nHEAD aaa\nbranch refs/heads/main\n\n' +
    'worktree /wt/gone\nHEAD bbb\nbranch refs/heads/feature/x\n'

  it('reports a deleted worktree as prunable even when git never tags it (old git)', async () => {
    const { git } = fakeGit({ 'worktree list --porcelain': ok(oldGitPorcelain) })
    const { entries } = await listWorktrees(git, '/repo', async (p) => p !== '/wt/gone')
    expect(entries.map((e) => [e.path, e.prunable])).toEqual([
      ['/repo', false],
      ['/wt/gone', true] // ← the stat fallback, not git
    ])
  })

  it('leaves a worktree whose directory exists alone (no false staleness)', async () => {
    const { git } = fakeGit({ 'worktree list --porcelain': ok(oldGitPorcelain) })
    const { entries } = await listWorktrees(git, '/repo', async () => true)
    expect(entries.every((e) => !e.prunable)).toBe(true)
  })

  it('still honours git´s own prunable tag (git ≥ 2.36) when the stat cannot answer', async () => {
    const modern =
      'worktree /repo\nHEAD aaa\nbranch refs/heads/main\n\n' +
      'worktree /wt/gone\nHEAD bbb\nbranch refs/heads/feature/x\nprunable gitdir file points to non-existent location\n'
    const { git } = fakeGit({ 'worktree list --porcelain': ok(modern) })
    // Default pathExists = "everything exists" — the conservative answer; git's tag must still win.
    const { entries } = await listWorktrees(git, '/repo')
    expect(entries.find((e) => e.path === '/wt/gone')?.prunable).toBe(true)
  })

  it('says ok:false when git itself fails — an empty list is NOT proof of absence', async () => {
    const { git } = fakeGit({ 'worktree list --porcelain': ko('not a repo') })
    // The entries are empty EITHER WAY; `ok` is the only thing that can tell the two apart, and it
    // is what stops one transient failure from marking every bound group missing.
    expect(await listWorktrees(git, '/repo', async () => false)).toEqual({ ok: false, entries: [] })
  })

  it('says ok:true for a repo that genuinely has no worktrees listed', async () => {
    const { git } = fakeGit({ 'worktree list --porcelain': ok('') })
    expect(await listWorktrees(git, '/repo')).toEqual({ ok: true, entries: [] })
  })

  it('says ok:false without calling git when there is no repo path', async () => {
    const { git, calls } = fakeGit({})
    expect(await listWorktrees(git, '')).toEqual({ ok: false, entries: [] })
    expect(calls.length).toBe(0)
  })
})

describe('worktreeMerge', () => {
  it('fetch-updates when base is not checked out (no merge call)', async () => {
    const list = 'worktree /wt/x\nHEAD aaa\nbranch refs/heads/feature/x\n'
    const { git, calls } = fakeGit({ 'worktree list --porcelain': ok(list) })
    const r = await worktreeMerge(git, '/repo', 'feature/x', 'main')
    expect(r.ok).toBe(true)
    expect(calls.some((c) => c[0] === 'fetch')).toBe(true)
    expect(calls.some((c) => c[0] === 'merge')).toBe(false)
  })
  it('merges in place and aborts on conflict', async () => {
    const list = 'worktree /repo\nHEAD aaa\nbranch refs/heads/main\n'
    const { git, calls } = fakeGit({
      'worktree list --porcelain': ok(list),
      'status --porcelain': ok(''), // base clean
      'merge --no-ff --no-edit feature/x': ko('CONFLICT')
    })
    const r = await worktreeMerge(git, '/repo', 'feature/x', 'main')
    expect(r.ok).toBe(false)
    expect(calls.some((c) => c.join(' ') === 'merge --abort')).toBe(true)
  })
  it('blocks when the base checkout is dirty', async () => {
    const list = 'worktree /repo\nHEAD aaa\nbranch refs/heads/main\n'
    const { git } = fakeGit({
      'worktree list --porcelain': ok(list),
      'status --porcelain': ok(' M file.ts') // dirty
    })
    const r = await worktreeMerge(git, '/repo', 'feature/x', 'main')
    expect(r.ok).toBe(false)
  })
  it('sends the user to the base checkout on an in-place merge conflict, not the worktree', async () => {
    // The base branch IS checked out and clean → merge-in-place → the conflict is in the BASE dir.
    const list = 'worktree /base\nHEAD aaa\nbranch refs/heads/main\n'
    const { git } = fakeGit({
      'worktree list --porcelain': ok(list),
      'status --porcelain': ok(''),
      'merge --no-ff --no-edit feature/x': ko('CONFLICT (content): Merge conflict in a.ts')
    })
    const r = await worktreeMerge(git, '/repo', 'feature/x', 'main')
    expect(r.ok).toBe(false)
    expect(r.message).toContain('/base')
    expect(r.message).not.toContain('worktree terminal')
  })

  // Without the `pathExists` seam, a base checkout deleted behind git's back is listed as healthy,
  // `decideMergeStrategy` picks merge-in-place, and the merge into a directory that is not there
  // fails — leaving the user chasing "a conflict" in a directory that does not exist.
  it('refuses honestly when the base checkout´s directory is gone (no phantom conflict)', async () => {
    const list = 'worktree /base\nHEAD aaa\nbranch refs/heads/main\n'
    const { git, calls } = fakeGit({ 'worktree list --porcelain': ok(list) })
    const r = await worktreeMerge(git, '/repo', 'feature/x', 'main', false, async (p) => p !== '/base')
    expect(r.ok).toBe(false)
    expect(r.message).toContain('/base')
    expect(r.message).toMatch(/missing/i)
    expect(r.message).not.toMatch(/conflict/i)
    // Nothing was attempted in the dead directory, and the ref was not advanced behind git's back.
    expect(calls.some((c) => c[0] === 'merge' || c[0] === 'fetch')).toBe(false)
  })

  // Same class of lie as the removal path's: a failed listing is not "the base is checked out
  // nowhere". Planning `fetch-update` on it would try to move a ref that IS checked out elsewhere
  // and fail with something obscure — decide nothing on a read that did not happen.
  it('refuses to plan a merge when the worktree listing itself failed', async () => {
    const { git, calls } = fakeGit({ 'worktree list --porcelain': ko('fatal: index file corrupt') })
    const r = await worktreeMerge(git, '/repo', 'feature/x', 'main', false, async () => true)
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/could not read/i)
    expect(calls.some((c) => c[0] === 'merge' || c[0] === 'fetch' || c[0] === 'push')).toBe(false)
  })
  it('still merges in place when the base checkout is really there (pathExists says so)', async () => {
    const list = 'worktree /base\nHEAD aaa\nbranch refs/heads/main\n'
    const { git, calls } = fakeGit({
      'worktree list --porcelain': ok(list),
      'status --porcelain': ok('')
    })
    const r = await worktreeMerge(git, '/repo', 'feature/x', 'main', false, async () => true)
    expect(r.ok).toBe(true)
    expect(calls.some((c) => c.join(' ') === 'merge --no-ff --no-edit feature/x')).toBe(true)
  })

  // The push is what the user is asked to consent to (Task 6): merging must NEVER publish to a
  // shared remote unless the caller explicitly said so.
  it('never pushes unless the caller asks for it', async () => {
    const list = 'worktree /wt/x\nHEAD aaa\nbranch refs/heads/feature/x\n'
    const { git, calls } = fakeGit({ 'worktree list --porcelain': ok(list), remote: ok('origin\n') })
    const r = await worktreeMerge(git, '/repo', 'feature/x', 'main')
    expect(r.ok).toBe(true)
    expect(calls.some((c) => c[0] === 'push')).toBe(false)
    expect(r.message).not.toMatch(/push/i)
  })
  it('pushes the base branch to origin when asked, and says so', async () => {
    const list = 'worktree /wt/x\nHEAD aaa\nbranch refs/heads/feature/x\n'
    const { git, calls } = fakeGit({ 'worktree list --porcelain': ok(list), remote: ok('origin\n') })
    const r = await worktreeMerge(git, '/repo', 'feature/x', 'main', true)
    expect(r.ok).toBe(true)
    expect(calls.some((c) => c.join(' ') === 'push origin main')).toBe(true)
    expect(r.message).toMatch(/pushed main to origin/i)
  })
  it('does not push when the repo has no remote (and does not claim it did)', async () => {
    const list = 'worktree /wt/x\nHEAD aaa\nbranch refs/heads/feature/x\n'
    const { git, calls } = fakeGit({ 'worktree list --porcelain': ok(list), remote: ok('') })
    const r = await worktreeMerge(git, '/repo', 'feature/x', 'main', true)
    expect(r.ok).toBe(true)
    expect(calls.some((c) => c[0] === 'push')).toBe(false)
    expect(r.message).not.toMatch(/push/i)
  })
  // A fork's only remote is often `upstream`. The push is `git push origin <base>`, so "a remote
  // exists" is not the question — `origin` itself has to exist, or the promise cannot be kept.
  it('does not push when the only remote is not origin (a fork with just `upstream`)', async () => {
    const list = 'worktree /wt/x\nHEAD aaa\nbranch refs/heads/feature/x\n'
    const { git, calls } = fakeGit({ 'worktree list --porcelain': ok(list), remote: ok('upstream\n') })
    const r = await worktreeMerge(git, '/repo', 'feature/x', 'main', true)
    expect(r.ok).toBe(true)
    expect(calls.some((c) => c[0] === 'push')).toBe(false)
    expect(r.message).not.toMatch(/push/i)
  })
  it('pushes when origin is one of several remotes', async () => {
    const list = 'worktree /wt/x\nHEAD aaa\nbranch refs/heads/feature/x\n'
    const { git, calls } = fakeGit({
      'worktree list --porcelain': ok(list),
      remote: ok('origin\nupstream\n')
    })
    const r = await worktreeMerge(git, '/repo', 'feature/x', 'main', true)
    expect(calls.some((c) => c.join(' ') === 'push origin main')).toBe(true)
    expect(r.message).toMatch(/pushed main to origin/i)
  })
  it('reports a failed push instead of swallowing it', async () => {
    const list = 'worktree /wt/x\nHEAD aaa\nbranch refs/heads/feature/x\n'
    const { git } = fakeGit({
      'worktree list --porcelain': ok(list),
      remote: ok('origin\n'),
      'push origin main': ko('rejected')
    })
    const r = await worktreeMerge(git, '/repo', 'feature/x', 'main', true)
    // The merge itself succeeded — only the publish failed, and the user must be told.
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/push.*failed/i)
  })
  it('does not merge again when only the push is requested — a failed merge never pushes', async () => {
    const list = 'worktree /base\nHEAD aaa\nbranch refs/heads/main\n'
    const { git, calls } = fakeGit({
      'worktree list --porcelain': ok(list),
      'status --porcelain': ok(''),
      'merge --no-ff --no-edit feature/x': ko('CONFLICT'),
      remote: ok('origin\n')
    })
    const r = await worktreeMerge(git, '/repo', 'feature/x', 'main', true)
    expect(r.ok).toBe(false)
    expect(calls.some((c) => c[0] === 'push')).toBe(false)
  })
})

describe('worktreeRemove', () => {
  it('refuses the repo path itself (no git call)', async () => {
    const { git, calls } = fakeGit({})
    const r = await worktreeRemove(git, '/repo', '/repo', '/home', true)
    expect(r.ok).toBe(false)
    expect(calls.length).toBe(0)
  })
  it('rejects a flag-injecting worktree path without calling git', async () => {
    const { git, calls } = fakeGit({})
    const r = await worktreeRemove(git, '/repo', '--evil', '/home', false)
    expect(r.ok).toBe(false)
    expect(calls.length).toBe(0)
  })
  it('refuses an unregistered worktree path', async () => {
    const { git } = fakeGit({ 'worktree list --porcelain': ok('worktree /repo\nbranch refs/heads/main\n') })
    const r = await worktreeRemove(git, '/repo', '/wt/ghost', '/home', false)
    expect(r.ok).toBe(false)
  })
  it('removes a registered worktree, prunes, and deletes the branch', async () => {
    const list = 'worktree /repo\nbranch refs/heads/main\n\nworktree /wt/x\nbranch refs/heads/feature/x\n'
    const { git, calls } = fakeGit({ 'worktree list --porcelain': ok(list) })
    const r = await worktreeRemove(git, '/repo', '/wt/x', '/home', true)
    expect(r.ok).toBe(true)
    expect(calls.some((c) => c.join(' ') === 'worktree remove --force -- /wt/x')).toBe(true)
    expect(calls.some((c) => c.join(' ') === 'worktree prune')).toBe(true)
    expect(calls.some((c) => c.join(' ') === 'branch -d feature/x')).toBe(true)
  })
  it('finds a Windows binding spelled with backslashes in git\'s forward-slash listing', async () => {
    const list = 'worktree C:/r\nbranch refs/heads/main\n\nworktree C:/r/wt\nbranch refs/heads/feat\n'
    const { git, calls } = fakeGit({ 'worktree list --porcelain': ok(list) })
    const r = await worktreeRemove(git, 'C:/r', 'C:\\r\\wt', 'C:\\Users\\me', false)
    expect(r.ok).toBe(true)
    expect(calls.some((c) => c.join(' ') === 'worktree remove --force -- C:\\r\\wt')).toBe(true)
  })
  it('keeps the branch when the caller does not own it', async () => {
    const list = 'worktree /repo\nbranch refs/heads/main\n\nworktree /wt/x\nbranch refs/heads/feature/x\n'
    const { git, calls } = fakeGit({ 'worktree list --porcelain': ok(list) })
    const r = await worktreeRemove(git, '/repo', '/wt/x', '/home', false)
    expect(r.ok).toBe(true)
    expect(calls.some((c) => c[0] === 'branch')).toBe(false)
  })
  // The confirm dialog promises the branch is deleted. `git branch -d` REFUSES an unmerged branch
  // (deliberately — we never escalate to -D), and that refusal used to be swallowed: the removal
  // reported plain "Worktree removed." and the user walked away believing a branch was gone while it
  // was still sitting in `git branch`. The result must report what git actually did.
  it('says the branch was deleted when git deletes it', async () => {
    const list = 'worktree /repo\nbranch refs/heads/main\n\nworktree /wt/x\nbranch refs/heads/feature/x\n'
    const { git } = fakeGit({ 'worktree list --porcelain': ok(list) })
    const r = await worktreeRemove(git, '/repo', '/wt/x', '/home', true)
    expect(r.ok).toBe(true)
    expect(r.message).toContain('Branch feature/x deleted.')
  })
  it('says the branch was KEPT when `git branch -d` refuses it, and never claims it was deleted', async () => {
    const list = 'worktree /repo\nbranch refs/heads/main\n\nworktree /wt/x\nbranch refs/heads/feature/x\n'
    const { git, calls } = fakeGit({
      'worktree list --porcelain': ok(list),
      'branch -d feature/x': ko('error: the branch is not fully merged')
    })
    const r = await worktreeRemove(git, '/repo', '/wt/x', '/home', true)
    // The worktree itself DID go — the failure is the branch's alone, and must not fail the removal.
    expect(r.ok).toBe(true)
    expect(r.message).toContain('kept')
    expect(r.message).not.toContain('Branch feature/x deleted.')
    // Never escalated to -D: an unmerged branch is unpublished work.
    expect(calls.some((c) => c.join(' ') === 'branch -D feature/x')).toBe(false)
  })
  it('reports the branch outcome on the already-gone path too', async () => {
    const list =
      'worktree /repo\nbranch refs/heads/main\n\nworktree /wt/x\nbranch refs/heads/feature/x\nprunable gitdir file points to non-existent location\n'
    const { git } = fakeGit({
      'worktree list --porcelain': ok(list),
      'branch -d feature/x': ko('error: the branch is not fully merged')
    })
    const r = await worktreeRemove(git, '/repo', '/wt/x', '/home', true)
    expect(r.message).toContain('kept')
  })
  it('says nothing about a branch it was never asked to delete', async () => {
    const list = 'worktree /repo\nbranch refs/heads/main\n\nworktree /wt/x\nbranch refs/heads/feature/x\n'
    const { git } = fakeGit({ 'worktree list --porcelain': ok(list) })
    const r = await worktreeRemove(git, '/repo', '/wt/x', '/home', false)
    expect(r.message).toBe('Worktree removed.')
  })
  it('prunes (and never removes) a worktree whose directory is already gone', async () => {
    const list =
      'worktree /repo\nbranch refs/heads/main\n\nworktree /wt/x\nbranch refs/heads/feature/x\nprunable gitdir file points to non-existent location\n'
    const { git, calls } = fakeGit({ 'worktree list --porcelain': ok(list) })
    const r = await worktreeRemove(git, '/repo', '/wt/x', '/home', true)
    expect(r.ok).toBe(true)
    expect(r.worktreeGone).toBe(true)
    expect(calls.some((c) => c[1] === 'remove')).toBe(false)
    expect(calls.some((c) => c.join(' ') === 'worktree prune')).toBe(true)
  })
  it('reports an unregistered worktree as gone (and prunes) so the caller can clear the binding', async () => {
    const { git, calls } = fakeGit({
      'worktree list --porcelain': ok('worktree /repo\nbranch refs/heads/main\n')
    })
    const r = await worktreeRemove(git, '/repo', '/wt/ghost', '/home', false, false, async () => false)
    expect(r.ok).toBe(false)
    expect(r.worktreeGone).toBe(true)
    expect(calls.some((c) => c.join(' ') === 'worktree prune')).toBe(true)
    expect(calls.some((c) => c[1] === 'remove')).toBe(false)
  })
  it('pruneOnly never touches a worktree directory that still exists', async () => {
    const list = 'worktree /repo\nbranch refs/heads/main\n\nworktree /wt/x\nbranch refs/heads/feature/x\n'
    const { git, calls } = fakeGit({ 'worktree list --porcelain': ok(list) })
    const r = await worktreeRemove(git, '/repo', '/wt/x', '/home', true, true)
    expect(r.ok).toBe(false)
    expect(calls.some((c) => c[1] === 'remove')).toBe(false)
    expect(calls.some((c) => c[0] === 'branch')).toBe(false)
    expect(calls.some((c) => c.join(' ') === 'worktree prune')).toBe(false)
  })
  it('prunes an unregistered path even in pruneOnly mode (pruning IS the mode)', async () => {
    const { git, calls } = fakeGit({
      'worktree list --porcelain': ok('worktree /repo\nbranch refs/heads/main\n')
    })
    const r = await worktreeRemove(git, '/repo', '/wt/ghost', '/home', false, true, async () => false)
    expect(r.worktreeGone).toBe(true)
    expect(calls.some((c) => c.join(' ') === 'worktree prune')).toBe(true)
  })
  // `worktreeGone` is what the renderer reads as "the removal got far enough": it then destroys
  // every displaced descendant's tmux session (ending running processes), resets their persisted
  // cwd, and drops the binding. So it may only ever be set on PROOF that the worktree is gone. A
  // git call that merely FAILED — spawn EAGAIN under load, an unmounted/NFS repo, a corrupt index —
  // is not proof of anything, and used to be indistinguishable from "git listed nothing".
  it('never reads a FAILED `worktree list` as "the worktree is gone"', async () => {
    const { git, calls } = fakeGit({ 'worktree list --porcelain': ko('fatal: not a git repository') })
    const r = await worktreeRemove(git, '/repo', '/wt/x', '/home', true, false, async () => true)
    expect(r.ok).toBe(false)
    expect(r.worktreeGone).toBeFalsy()
    expect(r.message).toMatch(/could not read/i)
    // …and nothing at all was touched: the only git call made was the failed listing.
    expect(calls.map((c) => c.join(' '))).toEqual(['worktree list --porcelain'])
  })
  it('never reads a failed list as gone in pruneOnly mode either', async () => {
    const { git, calls } = fakeGit({ 'worktree list --porcelain': ko('fatal: index file corrupt') })
    const r = await worktreeRemove(git, '/repo', '/wt/x', '/home', false, true, async () => false)
    expect(r.ok).toBe(false)
    expect(r.worktreeGone).toBeFalsy()
    expect(calls.some((c) => c.join(' ') === 'worktree prune')).toBe(false)
  })
  // git answered, and it does not list the path — but the DIRECTORY is still there. That is not a
  // dead worktree (it is a binding pointing at another repo's worktree, or a hand-edited one), and
  // the sessions living in it are healthy: nothing may declare them displaced.
  it('does not call an unregistered path gone while its directory still exists', async () => {
    const { git, calls } = fakeGit({
      'worktree list --porcelain': ok('worktree /repo\nbranch refs/heads/main\n')
    })
    const r = await worktreeRemove(git, '/repo', '/wt/ghost', '/home', false, false, async () => true)
    expect(r.ok).toBe(false)
    expect(r.worktreeGone).toBeFalsy()
    expect(calls.some((c) => c[1] === 'remove')).toBe(false)
  })
  // The conservative default ("everything exists") must never declare anything gone.
  it('declares nothing gone under the default pathExists', async () => {
    const { git } = fakeGit({
      'worktree list --porcelain': ok('worktree /repo\nbranch refs/heads/main\n')
    })
    const r = await worktreeRemove(git, '/repo', '/wt/ghost', '/home', false)
    expect(r.worktreeGone).toBeFalsy()
  })
  // git < 2.36 does not emit `prunable` in `worktree list --porcelain`, so a deleted directory
  // looks perfectly healthy in the listing. Stat the path instead of believing the flag.
  it('treats a missing directory as gone even when git never flagged it prunable', async () => {
    const list = 'worktree /repo\nbranch refs/heads/main\n\nworktree /wt/x\nbranch refs/heads/feature/x\n'
    const { git, calls } = fakeGit({ 'worktree list --porcelain': ok(list) })
    const r = await worktreeRemove(git, '/repo', '/wt/x', '/home', false, true, async () => false)
    expect(r.ok).toBe(true)
    expect(r.worktreeGone).toBe(true)
    expect(calls.some((c) => c.join(' ') === 'worktree prune')).toBe(true)
    expect(calls.some((c) => c[1] === 'remove')).toBe(false)
  })
  it('still refuses to prune a directory that exists (a wrongly-stale group cannot delete it)', async () => {
    const list = 'worktree /repo\nbranch refs/heads/main\n\nworktree /wt/x\nbranch refs/heads/feature/x\n'
    const { git, calls } = fakeGit({ 'worktree list --porcelain': ok(list) })
    const r = await worktreeRemove(git, '/repo', '/wt/x', '/home', false, true, async () => true)
    expect(r.ok).toBe(false)
    expect(calls.some((c) => c.join(' ') === 'worktree prune')).toBe(false)
  })
})

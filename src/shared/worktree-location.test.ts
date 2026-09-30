import { describe, expect, it } from 'vitest'
import { sharedBasePathOf, sharedWorktreeLocationRefusal, worktreeRedirectRefusal } from './worktree-location'
import { computeWorktreePath, effectiveWorktreeTemplate } from './worktree'

const REPO = '/home/u/code/repo'
/** The path a SHARED basePath produces for a branch — what every create path computes. */
const derived = (repoRoot: string, basePath: string, branch = 'issue-12-fix'): string =>
  computeWorktreePath(repoRoot, branch, effectiveWorktreeTemplate({ basePath }, undefined))
const judge = (basePath: string, repoRoot = REPO, branch = 'issue-12-fix'): string | null =>
  sharedWorktreeLocationRefusal({
    path: derived(repoRoot, basePath, branch),
    repoRoot,
    branch,
    sharedBasePath: basePath
  })

describe('sharedWorktreeLocationRefusal — a location from the git-shared settings file', () => {
  it.each([
    ['../../.claude/skills', 'climbs to ~/.claude/skills'],
    ['../../.codex/prompts', 'climbs to ~/.codex'],
    ['../../.ssh', 'climbs to ~/.ssh'],
    ['../../.config/nvim/pack/x/start', 'climbs into ~/.config'],
    ['../../../../etc/cron.d', 'leaves the holding folder'],
    ['/home/u/.claude/skills', 'absolute, hidden home folder'],
    ['/tmp/worktrees', 'absolute, outside the holding folder'],
    ['../../somewhere-else', 'a non-hidden folder above the holder'],
    ['.git', 'git\'s own folder'],
    ['.git/hooks', 'inside git\'s own folder'],
    ['../.hidden-worktrees', 'a hidden sibling of the repository']
  ])('refuses %j (%s)', (basePath) => {
    const reason = judge(basePath)
    expect(reason).toMatch(/shared settings \(\.nodeterm\/settings\.json/)
    expect(reason).toContain('Project Settings')
    expect(reason).toContain('Nothing was created')
  })

  it('refuses a hidden home folder when the repository sits directly in the home directory', () => {
    // The holder IS home here, so "inside the holder" alone would admit ~/.claude.
    expect(judge('../.claude/skills', '/home/u/repo')).not.toBeNull()
  })

  it.each([
    ['..'], // `../<branch>`: a plain sibling of the repository
    ['../worktrees'],
    ['../repo.worktrees'],
    ['.worktrees'], // nested inside the repository — its own content already applies to it
    ['wt'],
    ['../../code/wt'] // climbs out and back into the holding folder
  ])('allows %j, which stays beside or inside the repository', (basePath) => {
    expect(judge(basePath)).toBeNull()
  })

  it('judges only the location the shared setting produced — a typed or explicit path is the person\'s', () => {
    expect(
      sharedWorktreeLocationRefusal({
        path: '/tmp/my-own-choice',
        repoRoot: REPO,
        branch: 'issue-12-fix',
        sharedBasePath: '../../.claude/skills'
      })
    ).toBeNull()
  })

  it('does nothing for a local override or no setting', () => {
    const path = derived(REPO, '../../.claude/skills')
    expect(sharedWorktreeLocationRefusal({ path, repoRoot: REPO, branch: 'issue-12-fix', sharedBasePath: undefined })).toBeNull()
    expect(sharedWorktreeLocationRefusal({ path, repoRoot: REPO, branch: 'issue-12-fix', sharedBasePath: '  ' })).toBeNull()
  })

  it('refuses the same climb written with Windows separators', () => {
    expect(judge('..\\..\\.claude\\skills', 'C:\\Users\\u\\code\\repo')).not.toBeNull()
    expect(judge('..\\worktrees', 'C:\\Users\\u\\code\\repo')).toBeNull()
  })
})

describe('worktreeRedirectRefusal — the core backstop, on real paths', () => {
  const base = { home: '/home/u', realHome: '/home/u', realRepo: '/home/u/code/repo' }

  it('refuses a symlink that carries the checkout into a hidden home folder', () => {
    const reason = worktreeRedirectRefusal({
      ...base,
      requested: '/home/u/code/repo/tools/issue-1',
      real: '/home/u/.claude/skills/issue-1'
    })
    expect(reason).toContain('~/.claude')
    expect(reason).toContain('Nothing was created')
  })

  it('refuses anything inside the repository\'s .git folder', () => {
    expect(worktreeRedirectRefusal({ ...base, requested: '/x', real: '/home/u/code/repo/.git/x' })).not.toBeNull()
    expect(worktreeRedirectRefusal({ ...base, requested: '/x', real: '/home/u/code/repo/.git' })).not.toBeNull()
  })

  it('allows a hidden home folder the requested path names outright (a person\'s own template)', () => {
    expect(
      worktreeRedirectRefusal({ ...base, requested: '/home/u/.worktrees/x', real: '/home/u/.worktrees/x' })
    ).toBeNull()
  })

  it('allows ordinary locations, including symlinks that land somewhere ordinary (/tmp → /private/tmp)', () => {
    expect(
      worktreeRedirectRefusal({ ...base, requested: '/home/u/code/repo.worktrees/x', real: '/home/u/code/repo.worktrees/x' })
    ).toBeNull()
    expect(worktreeRedirectRefusal({ ...base, requested: '/tmp/wt/x', real: '/private/tmp/wt/x' })).toBeNull()
  })

  it('compares against the REAL home too (a home directory that is itself a link)', () => {
    expect(
      worktreeRedirectRefusal({
        home: '/home/u',
        realHome: '/data/home/u',
        realRepo: '/data/home/u/code/repo',
        requested: '/home/u/code/repo/tools/x',
        real: '/data/home/u/.codex/x'
      })
    ).toContain('~/.codex')
  })
})

describe('sharedBasePathOf', () => {
  it('answers the value only when it came from the shared file', () => {
    expect(sharedBasePathOf({ basePath: { value: '../../.claude', source: 'shared' } })).toBe('../../.claude')
    expect(sharedBasePathOf({ basePath: { value: '/mine', source: 'local' } })).toBeUndefined()
    expect(sharedBasePathOf({})).toBeUndefined()
    expect(sharedBasePathOf(undefined)).toBeUndefined()
  })
})

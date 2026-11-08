import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitService } from './git-service'

// Real git, a temp dir, a LOCAL bare repo as origin that holds `refs/pull/<n>/head` refs as GitHub
// does. Nothing here reaches a network.
let root = ''
const sh = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim()

/** origin: main, a same-repo PR #7 from fix/login, a fork PR #8 known only as pull/8/head. */
async function setup(): Promise<{ work: string; samePr: string; forkPr: string }> {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nodeterm-pull-wt-')))
  const origin = path.join(root, 'origin.git')
  sh(root, 'init', '-q', '--bare', '-b', 'main', origin)
  const seed = path.join(root, 'seed')
  sh(root, 'clone', '-q', origin, seed)
  sh(seed, 'config', 'user.email', 't@example.com')
  sh(seed, 'config', 'user.name', 'T')
  sh(seed, 'switch', '-q', '-c', 'main')
  await fs.writeFile(path.join(seed, 'a.txt'), 'a\n')
  sh(seed, 'add', '.')
  sh(seed, 'commit', '-q', '-m', 'a')
  sh(seed, 'push', '-q', 'origin', 'main')
  sh(seed, 'switch', '-q', '-c', 'fix/login')
  await fs.writeFile(path.join(seed, 'b.txt'), 'b\n')
  sh(seed, 'commit', '-qam', 'b', '--allow-empty')
  sh(seed, 'push', '-q', 'origin', 'fix/login', 'fix/login:refs/pull/7/head')
  const samePr = sh(seed, 'rev-parse', 'HEAD')
  sh(seed, 'switch', '-q', '--detach', 'main')
  sh(seed, 'commit', '-q', '--allow-empty', '-m', 'from a fork')
  const forkPr = sh(seed, 'rev-parse', 'HEAD')
  sh(seed, 'push', '-q', 'origin', `${forkPr}:refs/pull/8/head`)
  const work = path.join(root, 'work')
  sh(root, 'clone', '-q', origin, work)
  return { work, samePr, forkPr }
}

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true })
  root = ''
})

describe('GitService.pullWorktreeAdd', () => {
  it('same repository: fetches the head branch from origin and opens a fresh worktree on pr-<n>-<slug> at it', async () => {
    const { work, samePr } = await setup()
    const at = path.join(root, 'wt-7')
    const r = await new GitService().pullWorktreeAdd(work, at, { number: 7, headRef: 'fix/login', fork: false, branch: 'pr-7-fix-login' })
    expect(r.ok).toBe(true)
    expect(sh(at, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('pr-7-fix-login')
    expect(sh(at, 'rev-parse', 'HEAD')).toBe(samePr)
    expect(sh(work, 'rev-parse', 'origin/fix/login')).toBe(samePr)
  })

  it('fork: fetches pull/<n>/head into the new branch and checks it out', async () => {
    const { work, forkPr } = await setup()
    const at = path.join(root, 'wt-8')
    const r = await new GitService().pullWorktreeAdd(work, at, { number: 8, headRef: 'main', fork: true, branch: 'pr-8-main' })
    expect(r.ok).toBe(true)
    expect(sh(at, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('pr-8-main')
    expect(sh(at, 'rev-parse', 'HEAD')).toBe(forkPr)
  })

  it('never moves an existing branch: a taken name is refused and left exactly as it was', async () => {
    const { work } = await setup()
    sh(work, 'branch', 'pr-8-main', 'main')
    const before = sh(work, 'rev-parse', 'pr-8-main')
    const r = await new GitService().pullWorktreeAdd(work, path.join(root, 'wt'), { number: 8, headRef: 'main', fork: true, branch: 'pr-8-main' })
    expect(r).toEqual({ ok: false, message: 'The branch pr-8-main already exists. Nothing was created.' })
    expect(sh(work, 'rev-parse', 'pr-8-main')).toBe(before)
  })

  it('a worktree add that fails after a fork fetch removes the branch the fetch just made', async () => {
    const { work } = await setup()
    const at = path.join(root, 'taken')
    await fs.mkdir(at)
    await fs.writeFile(path.join(at, 'mine.txt'), 'keep\n')
    const r = await new GitService().pullWorktreeAdd(work, at, { number: 8, headRef: 'main', fork: true, branch: 'pr-8-main' })
    expect(r.ok).toBe(false)
    expect(() => sh(work, 'rev-parse', '--verify', '--quiet', 'refs/heads/pr-8-main')).toThrow()
    expect(await fs.readFile(path.join(at, 'mine.txt'), 'utf8')).toBe('keep\n')
  })

  it('refuses a request it did not plan (a branch not named pr-<n>, a hostile head ref) before running git', async () => {
    const { work } = await setup()
    const git = new GitService()
    const at = path.join(root, 'wt')
    expect((await git.pullWorktreeAdd(work, at, { number: 7, headRef: 'fix/login', fork: false, branch: 'main' })).ok).toBe(false)
    expect((await git.pullWorktreeAdd(work, at, { number: 7, headRef: '--upload-pack=x', fork: false, branch: 'pr-7-x' })).ok).toBe(false)
    expect(sh(work, 'branch', '--list')).toBe('* main')
  })
})

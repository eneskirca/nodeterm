// The core backstop, against a real filesystem and real git: a symlink committed into a repository
// (or sitting in its folder) must not carry a `git worktree add` into a hidden folder of the home
// directory, where agent CLIs load skills and configuration. The rule is lexical-proof only because
// it is judged on REAL paths — which is why it lives in core, beside git.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { realPathOf, worktreeTargetRefusal } from './worktree-target'
import { GitService } from './git-service'

let root: string
let home: string
let repo: string
const prevHome = process.env.HOME

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nt-wt-target-')))
  home = path.join(root, 'home')
  repo = path.join(home, 'code', 'repo')
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true })
  fs.mkdirSync(repo, { recursive: true })
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  }
  git('init', '-b', 'main')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 't')
  git('commit', '--allow-empty', '-m', 'init')
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
})

afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

describe('realPathOf', () => {
  it.skipIf(process.platform === 'win32')('resolves the deepest existing ancestor and re-appends the rest', () => {
    const link = path.join(repo, 'via-link')
    fs.symlinkSync(path.join(home, '.claude', 'skills'), link)
    try {
      expect(realPathOf(path.join(link, 'issue-1', 'deeper'))).toBe(
        path.join(home, '.claude', 'skills', 'issue-1', 'deeper')
      )
    } finally {
      fs.unlinkSync(link)
    }
  })
})

// Symlink creation needs Developer Mode or elevation on Windows; the rule itself is platform-neutral
// and covered by the pure tests in @shared/worktree-location.
describe.skipIf(process.platform === 'win32')('worktreeTargetRefusal + GitService.worktreeAdd', () => {
  it('refuses a target a symlink redirects into ~/.claude, and git never runs', async () => {
    const link = path.join(repo, 'tools')
    fs.symlinkSync(path.join(home, '.claude', 'skills'), link)
    try {
      const target = path.join(link, 'issue-1-x')
      expect(worktreeTargetRefusal(target, repo, home)).toContain('~/.claude')
      process.env.HOME = home
      const res = await new GitService().worktreeAdd(repo, target, 'issue-1-x', 'main', true)
      expect(res.ok).toBe(false)
      expect(res.message).toContain('~/.claude')
      expect(fs.existsSync(path.join(home, '.claude', 'skills', 'issue-1-x'))).toBe(false)
      const branches = execFileSync('git', ['branch', '--list', 'issue-1-x'], { cwd: repo, encoding: 'utf8' })
      expect(branches.trim()).toBe('')
    } finally {
      fs.unlinkSync(link)
    }
  })

  it('refuses a target inside the repository\'s .git folder', async () => {
    process.env.HOME = home
    const res = await new GitService().worktreeAdd(repo, path.join(repo, '.git', 'wt'), 'wt-git', 'main', true)
    expect(res.ok).toBe(false)
    expect(res.message).toContain('.git folder')
  })

  it('still creates an ordinary worktree beside the repository (the backstop is not a blanket refusal)', async () => {
    process.env.HOME = home
    const target = path.join(home, 'code', 'repo.worktrees', 'issue-2')
    const res = await new GitService().worktreeAdd(repo, target, 'issue-2', 'main', true)
    expect(res).toMatchObject({ ok: true })
    expect(fs.existsSync(path.join(target, '.git'))).toBe(true)
  })

  it('allows a hidden home folder the path names outright', () => {
    expect(worktreeTargetRefusal(path.join(home, '.worktrees', 'x'), repo, home)).toBeNull()
  })
})

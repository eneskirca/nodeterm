import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GitService } from './git-service'

const service = new GitService()
let repo = ''

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
}

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nt-stack-')))
  git('init', '-b', 'main')
  git('config', 'user.email', 'test@nodeterm.test')
  git('config', 'user.name', 'Nodeterm Test')
  git('commit', '--allow-empty', '-m', 'initial')
})

afterEach(() => fs.rmSync(repo, { recursive: true, force: true }))

describe('GitService stacked branches', () => {
  it('writes and removes the git-town parent convention, but rejects self-dependency', async () => {
    await expect(service.setBranchParent(repo, 'feature', 'feature')).resolves.toMatchObject({ ok: false })
    await expect(service.setBranchParent(repo, 'feature', 'main')).resolves.toMatchObject({ ok: true })
    expect(git('config', '--get', 'git-town-branch.feature.parent')).toBe('main')
    await expect(service.unsetBranchParent(repo, 'feature')).resolves.toMatchObject({ ok: true })
    expect(() => git('config', '--get', 'git-town-branch.feature.parent')).toThrow()
  })

  it('syncs only in the child branch owning worktree', async () => {
    git('branch', 'child')
    git('checkout', '-b', 'parent')
    git('commit', '--allow-empty', '-m', 'parent change')
    git('checkout', 'child')
    await service.setBranchParent(repo, 'child', 'parent')

    await expect(service.syncBranch(repo, 'child')).resolves.toMatchObject({ ok: true })
    expect(git('merge-base', '--is-ancestor', 'parent', 'child')).toBe('')

    git('checkout', 'main')
    await expect(service.syncBranch(repo, 'child')).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/owning worktree/i)
    })
  })

  it('ships only from the named parent branch owning worktree', async () => {
    git('checkout', '-b', 'parent')
    git('checkout', '-b', 'child')
    git('commit', '--allow-empty', '-m', 'child change')
    const childHead = git('rev-parse', 'child')

    git('checkout', 'main')
    await expect(service.shipBranch(repo, 'child', 'parent')).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/owning worktree/i)
    })

    git('checkout', 'parent')
    await expect(service.shipBranch(repo, 'child', 'parent')).resolves.toMatchObject({ ok: true })
    expect(git('rev-parse', 'parent')).toBe(childHead)
  })
})

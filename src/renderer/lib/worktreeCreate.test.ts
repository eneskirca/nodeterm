import { describe, expect, it, vi } from 'vitest'
import { createBoundWorktree, type CreateBoundWorktreeDeps, type WorktreeAttachTarget } from './worktreeCreate'
import type { WorktreeCreateValue } from '@shared/worktree'

const VALUE: WorktreeCreateValue = {
  repoPath: '/work/repo',
  mode: 'new',
  branch: 'issue-12-fix',
  baseRef: 'main',
  path: '/work/repo.worktrees/issue-12-fix'
}

function deps(over: Partial<CreateBoundWorktreeDeps> = {}): CreateBoundWorktreeDeps & {
  attach: ReturnType<typeof vi.fn>
  worktreeAdd: ReturnType<typeof vi.fn>
} {
  return {
    worktreeAdd: vi.fn(async () => ({ ok: true, message: 'Worktree ready.' })),
    activeProjectId: () => 'p1',
    attach: vi.fn(() => 'group-1'),
    ...over
  } as never
}

describe('createBoundWorktree', () => {
  it('creates the worktree, then binds a frame to it with createdByApp', async () => {
    const d = deps()
    const target: WorktreeAttachTarget = { groupId: null, at: { x: 1, y: 2 }, title: 'Issue #12' }
    const out = await createBoundWorktree(d, VALUE, { target: () => target, projectId: 'p1' })
    expect(d.worktreeAdd).toHaveBeenCalledWith(VALUE.repoPath, VALUE.path, VALUE.branch, VALUE.baseRef, true)
    expect(d.attach).toHaveBeenCalledWith(target, {
      repoPath: VALUE.repoPath,
      branch: VALUE.branch,
      baseRef: 'main',
      path: VALUE.path,
      createdByApp: true
    })
    expect(out).toMatchObject({ ok: true, groupId: 'group-1' })
  })

  it('checks out an EXISTING branch when the mode says so (isNew false)', async () => {
    const d = deps()
    await createBoundWorktree(d, { ...VALUE, mode: 'existing' }, { target: () => ({ groupId: null }) })
    expect(d.worktreeAdd.mock.calls[0][4]).toBe(false)
  })

  it('asks where the frame goes only AFTER git succeeded', async () => {
    const order: string[] = []
    const d = deps({
      worktreeAdd: vi.fn(async () => {
        order.push('git')
        return { ok: true, message: '' }
      })
    })
    await createBoundWorktree(d, VALUE, {
      target: () => {
        order.push('target')
        return { groupId: null }
      }
    })
    expect(order).toEqual(['git', 'target'])
  })

  it('reports a git failure with git\'s own message and binds nothing', async () => {
    const d = deps({ worktreeAdd: vi.fn(async () => ({ ok: false, message: 'fatal: a branch named x exists' })) })
    const target = vi.fn(() => ({ groupId: null }))
    const out = await createBoundWorktree(d, VALUE, { target })
    expect(out).toEqual({ ok: false, reason: 'git', message: 'fatal: a branch named x exists', rejected: false })
    expect(d.attach).not.toHaveBeenCalled()
    expect(target).not.toHaveBeenCalled()
  })

  it('turns a REJECTED call into a failure instead of throwing out of the caller', async () => {
    const d = deps({ worktreeAdd: vi.fn(async () => Promise.reject(new Error('E_DISCONNECTED'))) })
    const out = await createBoundWorktree(d, VALUE, { target: () => ({ groupId: null }) })
    expect(out).toEqual({ ok: false, reason: 'git', message: 'E_DISCONNECTED', rejected: true })
    expect(d.attach).not.toHaveBeenCalled()
  })

  it('leaves the worktree unbound when the canvas moved to another project during the await', async () => {
    let active = 'p1'
    const d = deps({
      activeProjectId: () => active,
      worktreeAdd: vi.fn(async () => {
        active = 'p2'
        return { ok: true, message: '' }
      })
    })
    const out = await createBoundWorktree(d, VALUE, { target: () => ({ groupId: null }), projectId: 'p1' })
    expect(out).toMatchObject({ ok: false, reason: 'project-changed', worktree: { branch: VALUE.branch } })
    expect(d.attach).not.toHaveBeenCalled()
  })

  it('without a projectId (the control verb) it binds whatever is on screen, as it always did', async () => {
    const d = deps({ activeProjectId: () => 'somewhere-else' })
    const out = await createBoundWorktree(d, VALUE, { target: () => ({ groupId: 'g' }) })
    expect(out.ok).toBe(true)
    expect(d.attach).toHaveBeenCalledTimes(1)
  })
})

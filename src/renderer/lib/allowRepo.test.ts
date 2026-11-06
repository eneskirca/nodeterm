import { describe, expect, it, vi } from 'vitest'
import type { GitHubControlView } from '@shared/github-issues'
import { allowProjectRepo } from './allowRepo'

const view = (repository: string | undefined, approved: boolean): GitHubControlView => ({
  control: { revision: 3, authProvider: 'gh' },
  auth: { selectedProvider: 'gh', activeProvider: null, ghAuthenticated: false, tokenPresent: false, storage: 'encrypted' },
  project: { projectId: 'p', ...(repository ? { repository } : {}), approved }
} as GitHubControlView)

describe('allowProjectRepo', () => {
  it('approves the project repository at the revision it read, and says it landed', async () => {
    const api = { status: vi.fn(async () => view('acme/app', false)), approve: vi.fn(async () => view('acme/app', true)) }
    expect(await allowProjectRepo(api, 'p', 'Acme/App')).toBe(true)
    expect(api.approve).toHaveBeenCalledWith({ projectId: 'p', repository: 'acme/app', expectedRevision: 3 })
  })

  it('writes nothing when it is already allowed', async () => {
    const api = { status: vi.fn(async () => view('acme/app', true)), approve: vi.fn() }
    expect(await allowProjectRepo(api, 'p', 'acme/app')).toBe(true)
    expect(api.approve).not.toHaveBeenCalled()
  })

  it('never approves a repository that is not the project one', async () => {
    for (const repository of ['other/app', undefined]) {
      const api = { status: vi.fn(async () => view(repository, false)), approve: vi.fn() }
      expect(await allowProjectRepo(api, 'p', 'acme/app')).toBe(false)
      expect(api.approve).not.toHaveBeenCalled()
    }
  })

  it('answers false when the approve did not land', async () => {
    const api = { status: vi.fn(async () => view('acme/app', false)), approve: vi.fn(async () => view('acme/app', false)) }
    expect(await allowProjectRepo(api, 'p', 'acme/app')).toBe(false)
  })
})

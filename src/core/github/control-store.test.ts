import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GitHubControlStore } from './control-store'

let userDataDir: string

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-github-control-'))
})

afterEach(async () => {
  await fs.rm(userDataDir, { recursive: true, force: true })
})

describe('GitHubControlStore', () => {
  it('persists an approval with a revision and mode 0600', async () => {
    const store = new GitHubControlStore(userDataDir)
    const state = await store.approve({
      expectedRevision: 0,
      localApprovalId: 'local-a',
      projectId: 'project-a',
      repository: 'nodeterm/nodeterm'
    })

    expect(state).toMatchObject({
      version: 1,
      revision: 1,
      approvals: [{
        localApprovalId: 'local-a',
        projectId: 'project-a',
        repository: 'nodeterm/nodeterm',
        enabled: true
      }]
    })
    const stat = await fs.stat(path.join(userDataDir, 'github-issues-control.json'))
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('does not let a stale client restore a revoked approval', async () => {
    const store = new GitHubControlStore(userDataDir)
    const approved = await store.approve({
      expectedRevision: 0,
      localApprovalId: 'local-a',
      projectId: 'project-a',
      repository: 'nodeterm/nodeterm'
    })
    const revoked = await store.revoke({
      expectedRevision: approved.revision,
      localApprovalId: 'local-a'
    })

    await expect(store.approve({
      expectedRevision: approved.revision,
      localApprovalId: 'local-a',
      projectId: 'project-a',
      repository: 'nodeterm/nodeterm'
    })).rejects.toMatchObject({ code: 'revision-conflict' })
    expect(revoked.approvals).toEqual([])
    expect((await store.load()).approvals).toEqual([])
  })

  it('requires the local identity and canonical repository', async () => {
    const store = new GitHubControlStore(userDataDir)
    await expect(store.approve({
      expectedRevision: 0,
      localApprovalId: '',
      projectId: 'project-a',
      repository: 'nodeterm/nodeterm'
    })).rejects.toMatchObject({ code: 'invalid-control-input' })
    await expect(store.approve({
      expectedRevision: 0,
      localApprovalId: 'local-a',
      projectId: 'project-a',
      repository: 'https://gitlab.com/a/b'
    })).rejects.toMatchObject({ code: 'invalid-control-input' })
  })

  it('changes provider without replacing approvals', async () => {
    const store = new GitHubControlStore(userDataDir)
    const approved = await store.approve({
      expectedRevision: 0,
      localApprovalId: 'local-a',
      projectId: 'project-a',
      repository: 'nodeterm/nodeterm'
    })
    const selected = await store.selectProvider({
      expectedRevision: approved.revision,
      provider: 'token'
    })
    expect(selected.authProvider).toBe('token')
    expect(selected.approvals).toEqual(approved.approvals)
  })

  it('treats a malformed file as empty instead of trusting its approvals', async () => {
    await fs.writeFile(path.join(userDataDir, 'github-issues-control.json'), JSON.stringify({
      version: 1,
      revision: 7,
      authProvider: 'auto',
      approvals: [{ localApprovalId: '', projectId: 'p', repository: 'o/r', enabled: true }]
    }))
    expect(await new GitHubControlStore(userDataDir).load()).toEqual({
      version: 1,
      revision: 0,
      authProvider: 'auto',
      approvals: []
    })
  })
})

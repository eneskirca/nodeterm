import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Project } from '../../shared/types'
import type { CorePlatform } from '../platform'
import { registerGitHubIntegration } from './integration'
import type { CommandRunner, GitHubSecretStore } from './credentials'

let userDataDir: string

const project: Project = {
  id: 'project-1',
  name: 'Test',
  color: '#8b5cf6',
  cwd: '/repo',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [],
  kanban: {
    columns: [
      { id: 'todo', title: 'Todo', color: '#2563eb' },
      { id: 'done', title: 'Done', color: '#16a34a' }
    ],
    assignments: [],
    github: {
      repository: 'owner/repo',
      columnMappings: [
        { columnId: 'todo', label: 'status:todo' },
        { columnId: 'done', label: 'status:done' }
      ],
      completionColumnId: 'done'
    }
  }
}

/** Only the four members registerGitHubIntegration touches. */
function fakePlatform(): CorePlatform {
  const noop = (): void => undefined
  return {
    handle: noop,
    on: noop,
    handleWithSender: noop,
    onWithSender: noop,
    sendTo: noop
  } as unknown as CorePlatform
}

let realFetch: typeof globalThis.fetch
let userRequests = 0

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-github-integration-'))
  // registerGitHubIntegration builds its own token validator against api.github.com. Stub the
  // transport rather than adding a production seam that exists only for this test.
  realFetch = globalThis.fetch
  userRequests = 0
  globalThis.fetch = (async () => {
    userRequests += 1
    return new Response(JSON.stringify({ id: 1, login: 'octocat' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }) as typeof globalThis.fetch
})

afterEach(async () => {
  globalThis.fetch = realFetch
  await fs.rm(userDataDir, { recursive: true, force: true })
})

describe('registerGitHubIntegration', () => {
  it('drops the memoised credential when the token changes, without waiting for its TTL', async () => {
    // The resolver memoises so the service's epoch re-checks stop spawning `gh` and spending a
    // /user request each. That memo must not outlive an in-app credential change: saving a token
    // and immediately reading a context has to see the NEW credential, not the cached old one.
    // Provider 'token' keeps the credential on the stored-token path, so clearing the token is a
    // real boundary move rather than something the gh path would paper over.
    const run: CommandRunner = async () => ({ ok: false, stdout: '', stderr: 'not logged in' })
    let stored: string | null = 'stored-token'
    const secret: GitHubSecretStore = {
      availability: 'encrypted',
      readForHost: async () => stored,
      save: async (value) => { stored = value },
      clear: async () => { stored = null }
    }

    const { controller } = registerGitHubIntegration({
      platform: fakePlatform(),
      userDataDir,
      project: async (id) => id === project.id
        ? { project, localApprovalId: 'local-1' }
        : null,
      detectRepository: async () => 'owner/repo',
      secret,
      run
    })

    const status = await controller.status('project-1')
    await controller.approve({
      projectId: 'project-1',
      repository: 'owner/repo',
      expectedRevision: status.control.revision
    })

    // Count the /user validations, since those are the requests the memo exists to stop — they
    // bypass the request coordinator entirely and so are never rate-limited or backed off.
    const before = userRequests
    await controller.contextForProject('project-1')
    expect(userRequests).toBe(before + 1)

    // Inside the TTL a second context reuses the memo, spending nothing.
    await controller.contextForProject('project-1')
    expect(userRequests).toBe(before + 1)

    // Clearing the saved token moves the credential boundary. Serving the stale memo here would
    // keep a revoked credential alive for the rest of the window.
    await controller.clearToken()
    await expect(controller.contextForProject('project-1')).rejects.toThrow('not-authenticated')
  })
})

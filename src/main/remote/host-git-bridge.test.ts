// The jailed core bridge for the PHONE vocabulary: typed `git.*` verbs and
// `projects.registerNode`, served only inside the shared roots — never free-form arguments
// (a `git.run` would be remote command execution). Deny-by-default: no injected dep ⇒ the verb
// is not served at all.
import { describe, expect, it, vi } from 'vitest'
import {
  createHostHandlers,
  type HostGitOps,
  type HostPtyManager,
  type HostRelaySocket
} from './host-service'

function makeFakes() {
  const responses: Array<{ id: string; ok: boolean; body: unknown }> = []
  const socket: HostRelaySocket = {
    respond: (id, ok, body) => responses.push({ id, ok, body }),
    sendFrame: () => true
  }
  const calls: Array<{ method: string; args: unknown[] }> = []
  const rec =
    (method: string, result: unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args })
      return result as never
    }
  const git: HostGitOps = {
    status: rec('status', { branch: 'main', files: [] }),
    diff: rec('diff', 'DIFF'),
    stage: rec('stage', { ok: true }),
    unstage: rec('unstage', { ok: true }),
    commit: rec('commit', { ok: true }),
    push: rec('push', { ok: true }),
    pull: rec('pull', { ok: true }),
    history: rec('history', { entries: [] })
  }
  const registerNode = vi.fn(async () => true)
  return { socket, responses, calls, git, registerNode }
}

const mk = (
  f: ReturnType<typeof makeFakes>,
  roots: string[] = ['/work'],
  opts: { git?: boolean; register?: boolean } = { git: true, register: true }
) =>
  createHostHandlers(
    {} as HostPtyManager,
    f.socket,
    undefined,
    () => roots,
    undefined,
    undefined,
    opts.git ? f.git : undefined,
    opts.register ? f.registerNode : undefined
  )

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('git.* verbs', () => {
  it('serves a jailed git.status and responds with the result body', async () => {
    const f = makeFakes()
    mk(f).onRpc({ id: '1', method: 'git.status', params: { cwd: '/work/app' } })
    await flush()
    expect(f.calls).toEqual([{ method: 'status', args: ['/work/app'] }])
    expect(f.responses).toEqual([{ id: '1', ok: true, body: { branch: 'main', files: [] } }])
  })

  it('denies a cwd outside the shared roots — explicit error, git never called', async () => {
    const f = makeFakes()
    mk(f).onRpc({ id: '1', method: 'git.status', params: { cwd: '/etc' } })
    await flush()
    expect(f.calls).toEqual([])
    expect(f.responses).toEqual([
      { id: '1', ok: false, body: { message: expect.stringContaining('outside') } }
    ])
  })

  it('no git dep injected ⇒ the verbs are not served (deny-by-default)', async () => {
    const f = makeFakes()
    mk(f, ['/work'], { git: false, register: true }).onRpc({
      id: '1',
      method: 'git.status',
      params: { cwd: '/work' }
    })
    await flush()
    expect(f.responses[0].ok).toBe(false)
  })

  it('stage/unstage pass only STRING paths through (hostile arrays sanitized)', async () => {
    const f = makeFakes()
    const h = mk(f)
    h.onRpc({
      id: '1',
      method: 'git.stage',
      params: { cwd: '/work', paths: ['a.ts', 5, null, { x: 1 }, 'b.ts'] }
    })
    await flush()
    expect(f.calls).toEqual([{ method: 'stage', args: ['/work', ['a.ts', 'b.ts']] }])
  })

  it('commit forwards the message; diff forwards path/staged/untracked', async () => {
    const f = makeFakes()
    const h = mk(f)
    h.onRpc({ id: '1', method: 'git.commit', params: { cwd: '/work', message: 'msg' } })
    h.onRpc({
      id: '2',
      method: 'git.diff',
      params: { cwd: '/work', path: 'a.ts', staged: true, untracked: false }
    })
    await flush()
    expect(f.calls).toEqual([
      { method: 'commit', args: ['/work', 'msg'] },
      { method: 'diff', args: ['/work', 'a.ts', true, false] }
    ])
  })

  it('push/pull/history are served jailed like the rest', async () => {
    const f = makeFakes()
    const h = mk(f)
    h.onRpc({ id: '1', method: 'git.push', params: { cwd: '/work' } })
    h.onRpc({ id: '2', method: 'git.pull', params: { cwd: '/etc' } }) // denied
    h.onRpc({ id: '3', method: 'git.history', params: { cwd: '/work' } })
    await flush()
    expect(f.calls.map((c) => c.method)).toEqual(['push', 'history'])
    expect(f.responses.find((r) => r.id === '2')?.ok).toBe(false)
  })
})

describe('projects.registerNode', () => {
  it('routes to the injected registrar and reports its outcome', async () => {
    const f = makeFakes()
    mk(f).onRpc({
      id: '1',
      method: 'projects.registerNode',
      params: { projectId: 'p1', node: { id: 'term-abc-1', title: 'Mobile', agentId: 'claude' } }
    })
    await flush()
    expect(f.registerNode).toHaveBeenCalledWith('p1', { id: 'term-abc-1', title: 'Mobile', agentId: 'claude' })
    expect(f.responses).toEqual([{ id: '1', ok: true, body: { registered: true } }])
  })

  it('forwards the managed account the phone launched under (accountId)', async () => {
    // Without this the off-LAN leg registered every managed-Claude session as the SYSTEM account
    // while the direct-SSH leg got it right — the same session registered as a different identity
    // depending only on whether the phone happened to be on the LAN.
    const f = makeFakes()
    mk(f).onRpc({
      id: '1',
      method: 'projects.registerNode',
      params: {
        projectId: 'p1',
        node: { id: 'term-abc-1', agentId: 'claude', accountId: 'acc-1', note: 'ignored' }
      }
    })
    await flush()
    expect(f.registerNode).toHaveBeenCalledWith('p1', {
      id: 'term-abc-1',
      agentId: 'claude',
      accountId: 'acc-1'
    })
  })

  it('forwards a custom agent base snapshot', async () => {
    const f = makeFakes()
    mk(f).onRpc({
      id: '1',
      method: 'projects.registerNode',
      params: {
        projectId: 'p1',
        node: {
          id: 'term-abc-1',
          agentId: 'custom:proxy',
          agentBaseId: 'claude'
        }
      }
    })
    await flush()
    expect(f.registerNode).toHaveBeenCalledWith('p1', {
      id: 'term-abc-1',
      agentId: 'custom:proxy',
      agentBaseId: 'claude'
    })
  })

  it('drops a non-string accountId instead of passing it on', async () => {
    const f = makeFakes()
    mk(f).onRpc({
      id: '1',
      method: 'projects.registerNode',
      params: { projectId: 'p1', node: { id: 'term-abc-1', accountId: 42 } }
    })
    await flush()
    expect(f.registerNode).toHaveBeenCalledWith('p1', { id: 'term-abc-1' })
  })

  it('a refused registration (bad shape / unknown project) reports registered:false', async () => {
    const f = makeFakes()
    f.registerNode.mockResolvedValueOnce(false as never)
    mk(f).onRpc({ id: '1', method: 'projects.registerNode', params: { projectId: 'p1', node: { id: 'x' } } })
    await flush()
    expect(f.responses).toEqual([{ id: '1', ok: true, body: { registered: false } }])
  })

  it('no registrar injected ⇒ not served', async () => {
    const f = makeFakes()
    mk(f, ['/work'], { git: true, register: false }).onRpc({
      id: '1',
      method: 'projects.registerNode',
      params: { projectId: 'p1', node: { id: 'term-a-1' } }
    })
    await flush()
    expect(f.responses[0].ok).toBe(false)
  })
})

import { describe, expect, it, vi } from 'vitest'
import { resolveIssueFlagFor, resolveIssueFlagForCall } from './issueFlag'

const withBoard = (repository?: string) => ({
  id: 'p1',
  kanban: { github: repository === undefined ? {} : { repository } }
})

describe('resolveIssueFlagFor (open-agent --issue on the desktop)', () => {
  it('is a no-op without the flag', async () => {
    const ask = vi.fn()
    expect(await resolveIssueFlagFor(undefined, 'open-agent', withBoard(), ask)).toEqual({ ok: true })
    expect(ask).not.toHaveBeenCalled()
  })

  it('takes a full owner/repo#N as given, board or no board — and asks nobody', async () => {
    const ask = vi.fn(async () => 'x/y')
    expect(await resolveIssueFlagFor('a/b#3', 'open-agent', undefined, ask)).toEqual({
      ok: true,
      ref: { owner: 'a', repo: 'b', number: 3 }
    })
    expect(await resolveIssueFlagFor('a/b#3', 'open-agent', withBoard(), ask)).toMatchObject({ ok: true })
    // A full reference must not cost a host round trip (git remote, gh auth) before the open.
    expect(ask).not.toHaveBeenCalled()
  })

  it('resolves #N against the repository the board syncs with (the host controller answer)', async () => {
    const ask = vi.fn(async () => 'eneskirca/nodeterm')
    expect(await resolveIssueFlagFor('#9', 'open-agent', withBoard(), ask)).toEqual({
      ok: true,
      ref: { owner: 'eneskirca', repo: 'nodeterm', number: 9 }
    })
    expect(ask).toHaveBeenCalledWith('p1')
  })

  it('falls back to the explicitly configured repository when the controller cannot answer', async () => {
    const ask = vi.fn(async () => {
      throw new Error('E_UNSUPPORTED')
    })
    expect(await resolveIssueFlagFor('#9', 'open-claude', withBoard('o/r'), ask)).toEqual({
      ok: true,
      ref: { owner: 'o', repo: 'r', number: 9 }
    })
  })

  it('treats a controller that throws synchronously (no GitHub api on this session) as unknown', async () => {
    const ask = (): Promise<string | null> => {
      throw new TypeError('githubControl is undefined')
    }
    expect(await resolveIssueFlagFor('#9', 'open-agent', withBoard('o/r'), ask)).toEqual({
      ok: true,
      ref: { owner: 'o', repo: 'r', number: 9 }
    })
  })

  it('refuses #N when the project has no GitHub board at all — without asking anyone', async () => {
    const ask = vi.fn(async () => 'o/r')
    const r = await resolveIssueFlagFor('#9', 'open-agent', { id: 'p1' }, ask)
    expect(r).toEqual({
      ok: false,
      error:
        "open-agent: --issue #9 needs this project's kanban board to be connected to a GitHub repository — pass owner/repo#9 instead"
    })
    expect(ask).not.toHaveBeenCalled()
  })

  it('refuses #N when the board exists but nobody can name its repository', async () => {
    const r = await resolveIssueFlagFor('#9', 'open-agent', withBoard(), async () => null)
    expect(r.ok).toBe(false)
  })

  it.each(['o/r#1; rm -rf ~', 'o/r#`id`', 'o/r#$(id)', 'o/r#1\nx', '#1 && x', '#', 'o/r'])(
    'refuses %j even if a malformed value got past main',
    async (raw) => {
      const r = await resolveIssueFlagFor(raw, 'open-agent', withBoard('o/r'), async () => 'o/r')
      expect(r.ok).toBe(false)
    }
  )

  it('refuses #N against a hostile configured repository instead of splicing it', async () => {
    const r = await resolveIssueFlagFor('#1', 'open-agent', withBoard('o/r;rm -rf ~'), async () => {
      throw new Error('down')
    })
    expect(r.ok).toBe(false)
  })
})

describe('resolveIssueFlagForCall (the gates run before anybody is asked)', () => {
  // Two projects, both with a GitHub board: a lookup against either would run the host controller
  // (`git remote`, `gh auth`) and the answer would tell the caller whether that project has one.
  const board = { github: { repository: 'o/r' } }
  const projects = [
    {
      id: 'mine',
      nodes: [
        { id: 'agent', agentId: 'claude' },
        { id: 'shell' }
      ],
      kanban: board
    },
    { id: 'theirs', nodes: [{ id: 'other', agentId: 'claude' }], kanban: board },
    { id: 'remote', ssh: { host: 'h' }, nodes: [], kanban: board },
    { id: 'parked', closed: true, nodes: [{ id: 'parked-agent', agentId: 'codex' }], kanban: board }
  ]
  const live = (ids: Array<[string, string | undefined]>) =>
    ids.map(([id, agentId]) => ({ id, data: agentId ? { agentId } : {} }))
  const call = (over: Partial<Parameters<typeof resolveIssueFlagForCall>[0]>) => ({
    raw: '#9',
    verb: 'open-agent',
    targetId: undefined,
    sourceNodeId: 'agent',
    liveNodes: live([['agent', 'claude'], ['shell', undefined]]),
    projects,
    activeProjectId: 'mine',
    ...over
  })

  it('resolves against the caller own project, then asks', async () => {
    const ask = vi.fn(async () => 'o/r')
    expect(await resolveIssueFlagForCall(call({}), ask)).toMatchObject({ ok: true, ref: { number: 9 } })
    expect(ask).toHaveBeenCalledWith('mine')
  })

  it('resolves against an authorized --project target', async () => {
    const ask = vi.fn(async () => 'o/r')
    expect(await resolveIssueFlagForCall(call({ targetId: 'theirs' }), ask)).toMatchObject({ ok: true })
    expect(ask).toHaveBeenCalledWith('theirs')
  })

  it('resolves against the stored project owning a source that is not on screen', async () => {
    const ask = vi.fn(async () => 'o/r')
    expect(await resolveIssueFlagForCall(call({ sourceNodeId: 'parked-agent' }), ask)).toMatchObject({ ok: true })
    expect(ask).toHaveBeenCalledWith('parked')
  })

  it.each([
    ['a plain terminal, own project', { sourceNodeId: 'shell' }, 'source node is not a control-capable agent'],
    ['a plain terminal naming another project', { sourceNodeId: 'shell', targetId: 'theirs' },
      'source node is not a control-capable agent'],
    ['an unknown source', { sourceNodeId: 'ghost' }, 'source node is not on an open canvas'],
    ['an unknown source naming a project', { sourceNodeId: 'ghost', targetId: 'theirs' },
      'source node is not in any open project'],
    ['an SSH target', { targetId: 'remote' },
      'project-target-ssh-unsupported: opening sessions into an SSH project is not supported — do not retry'],
    ['a target this renderer does not know', { targetId: 'nowhere' },
      'project-target-refused: the target project is not available here — try again']
  ])('refuses %s with the path refusal and asks nobody', async (_label, over, error) => {
    const ask = vi.fn(async () => 'o/r')
    expect(await resolveIssueFlagForCall(call(over), ask)).toEqual({ ok: false, error })
    expect(ask).not.toHaveBeenCalled()
  })

  it('never refuses a source on the ACTIVE project that is not on the live canvas yet', async () => {
    // The boot load is still in flight: the path waits for the live node, whose agent id the load
    // may still have to MIGRATE (a legacy `tags:['claude']` node has no stored agentId). The gate
    // must not be stricter than that path, so it resolves against the active project and leaves
    // the capability verdict to it.
    const ask = vi.fn(async () => 'o/r')
    const legacy = [{ id: 'mine', nodes: [{ id: 'booting' }], kanban: board }]
    expect(await resolveIssueFlagForCall(call({ sourceNodeId: 'booting', liveNodes: [], projects: legacy }), ask))
      .toMatchObject({ ok: true })
    expect(ask).toHaveBeenCalledWith('mine')
  })

  it('leaves an open without --issue to the paths (no gate, nobody asked)', async () => {
    const ask = vi.fn(async () => 'o/r')
    expect(await resolveIssueFlagForCall(call({ raw: undefined, sourceNodeId: 'ghost' }), ask)).toEqual({ ok: true })
    expect(ask).not.toHaveBeenCalled()
  })

})

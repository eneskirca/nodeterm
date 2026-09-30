import { describe, it, expect } from 'vitest'
import {
  containsDir,
  groupRecentByFolder,
  worktreeGroups,
  heldSessions,
  localCodexAccountIds,
  planResume,
  RESUME_REFUSALS,
  resumeActionLabel,
  type ResumeContext
} from './recentConversations'
import type { RecentConversation } from '@shared/recent-conversations'

const SID = '5f0c2a9e-3b7d-4e61-9a24-7c1d8e0f4b32'
const conv = (over: Partial<RecentConversation> = {}): RecentConversation => ({
  agentId: 'claude',
  sessionId: SID,
  cwd: '/srv/demo',
  lastActiveAt: 1,
  title: 't',
  titleSource: 'prompt',
  ...over
})
const ctx = (over: Partial<ResumeContext> = {}): ResumeContext => ({
  projects: [],
  activeProjectId: '',
  held: [],
  claudeAccounts: [],
  codexAccounts: [],
  ...over
})

describe('planResume', () => {
  it('focuses the node that already holds the session instead of resuming it twice', () => {
    const plan = planResume(
      conv(),
      ctx({
        projects: [{ id: 'p1', cwd: '/srv/demo' }] as never,
        held: [{ nodeId: 'n7', projectId: 'p2', sessionId: SID }]
      })
    )
    expect(plan).toEqual({ kind: 'focus', nodeId: 'n7', projectId: 'p2' })
  })

  it('the live hook id counts as holding too', () => {
    const plan = planResume(conv(), ctx({ held: [{ nodeId: 'n1', projectId: 'p', sessionId: SID }] }))
    expect(plan.kind).toBe('focus')
  })

  it('resumes in the LOCAL project whose cwd is the conversation’s; prefers active, then open', () => {
    const projects = [
      { id: 'closed', cwd: '/srv/demo', closed: true },
      { id: 'ssh', cwd: '/srv/demo', ssh: { server: {}, remoteCwd: '/srv/demo' } },
      { id: 'relay', cwd: '/srv/demo', remote: true },
      { id: 'gone', cwd: '/srv/demo', unavailable: true },
      { id: 'open', cwd: '/srv/demo/' }
    ] as never
    expect(planResume(conv(), ctx({ projects }))).toEqual({ kind: 'resume', projectId: 'open', reopen: false })
    expect(planResume(conv(), ctx({ projects, activeProjectId: 'closed' }))).toEqual({
      kind: 'resume',
      projectId: 'closed',
      reopen: true
    })
  })

  it('reopens a closed project when it is the only match', () => {
    const plan = planResume(conv(), ctx({ projects: [{ id: 'c', cwd: '/srv/demo', closed: true }] as never }))
    expect(plan).toEqual({ kind: 'resume', projectId: 'c', reopen: true })
  })

  it('never resumes into an SSH project or a relay tab — those cwds are on another machine', () => {
    const projects = [
      { id: 'ssh', cwd: '/srv/demo', ssh: { server: {}, remoteCwd: '/srv/demo' } },
      { id: 'relay', cwd: '/srv/demo', remote: true }
    ] as never
    expect(planResume(conv(), ctx({ projects }))).toEqual({ kind: 'open-folder', folder: '/srv/demo' })
  })

  it('offers to open the folder when no project owns it', () => {
    expect(planResume(conv(), ctx())).toEqual({ kind: 'open-folder', folder: '/srv/demo' })
  })

  it('refuses an unsafe session id before planning anything', () => {
    for (const bad of ['-rf', 'a;b', '$(id)']) {
      expect(planResume(conv({ sessionId: bad }), ctx())).toEqual({ kind: 'refuse', reason: RESUME_REFUSALS.unsafeId })
    }
  })

  it('refuses when the history names no folder', () => {
    expect(planResume(conv({ cwd: null }), ctx())).toEqual({ kind: 'refuse', reason: RESUME_REFUSALS.noCwd })
  })

  it('refuses a conversation whose account is gone, pending or host-pinned — never the system login', () => {
    const c = conv({ accountId: 'work' })
    expect(planResume(c, ctx()).kind).toBe('refuse')
    expect(planResume(c, ctx({ claudeAccounts: [{ id: 'work', pending: true }] as never })).kind).toBe('refuse')
    expect(planResume(c, ctx({ claudeAccounts: [{ id: 'work', host: 'me@box' }] as never })).kind).toBe('refuse')
    expect(planResume(c, ctx({ claudeAccounts: [{ id: 'work' }] as never })).kind).toBe('open-folder')
    const x = conv({ agentId: 'codex', accountId: 'cw' })
    expect(planResume(x, ctx({ claudeAccounts: [{ id: 'cw' }] as never })).kind).toBe('refuse')
    expect(planResume(x, ctx({ codexAccounts: [{ id: 'cw' }] as never })).kind).toBe('open-folder')
    // An agent with no managed accounts that claims one is not trusted.
    expect(planResume(conv({ agentId: 'gemini', accountId: 'work' }), ctx({ claudeAccounts: [{ id: 'work' }] as never })).kind).toBe('refuse')
  })
})

describe('planResume — folder ownership (review #1062)', () => {
  it('refuses a folder that no longer exists — never recreates it', () => {
    expect(planResume(conv({ cwdState: 'absent' }), ctx())).toEqual({ kind: 'refuse', reason: RESUME_REFUSALS.folderGone })
    // Even when a project owns an ancestor: the CLI keys the conversation by its folder.
    expect(planResume(conv({ cwdState: 'absent' }), ctx({ projects: [{ id: 'p', cwd: '/srv' }] as never })).kind).toBe('refuse')
  })

  it('an unknown folder state is not absence', () => {
    expect(planResume(conv({ cwdState: 'unknown' }), ctx()).kind).toBe('open-folder')
  })

  it('a conversation in a subfolder resumes in the ancestor project (the longest prefix wins)', () => {
    const projects = [
      { id: 'root', cwd: '/srv' },
      { id: 'repo', cwd: '/srv/demo' },
      { id: 'lookalike', cwd: '/srv/dem' }
    ] as never
    expect(planResume(conv({ cwd: '/srv/demo/packages/app' }), ctx({ projects }))).toEqual({
      kind: 'resume',
      projectId: 'repo',
      reopen: false
    })
    expect(planResume(conv({ cwd: '/srv/demolition' }), ctx({ projects }))).toMatchObject({ projectId: 'root' })
  })

  it('a conversation in a bound worktree resumes inside that worktree’s group', () => {
    const projects = [{ id: 'repo', cwd: '/srv/demo' }] as never
    const groups = [{ projectId: 'repo', groupId: 'g1', path: '/srv/demo.worktrees/fix-x' }]
    expect(
      planResume(conv({ cwd: '/srv/demo.worktrees/fix-x' }), ctx({ projects, worktreeGroups: groups }))
    ).toEqual({ kind: 'resume', projectId: 'repo', reopen: false, groupId: 'g1' })
  })

  it('a worktree group in a relay tab or SSH project is not a local owner', () => {
    const projects = [{ id: 'relay', cwd: '/elsewhere', remote: true }] as never
    const groups = [{ projectId: 'relay', groupId: 'g1', path: '/srv/demo' }]
    expect(planResume(conv(), ctx({ projects, worktreeGroups: groups })).kind).toBe('open-folder')
  })

  it('containsDir is segment-wise and tolerates trailing separators', () => {
    expect(containsDir('/srv/demo/', '/srv/demo')).toBe('/srv/demo'.length)
    expect(containsDir('/srv/demo', '/srv/demo/a')).toBe('/srv/demo'.length)
    expect(containsDir('/srv/demo', '/srv/demolition')).toBe(-1)
    expect(containsDir('C:\\work', 'C:\\work\\app')).toBe('C:\\work'.length)
    expect(containsDir('/', '/srv')).toBe(1)
    expect(containsDir(undefined, '/srv')).toBe(-1)
  })

  it('collects worktree groups from the live canvas and the stored projects', () => {
    const projects = [
      { id: 'a', nodes: [{ id: 'old', kind: 'group', worktree: { path: '/stale' } }] },
      { id: 'b', nodes: [{ id: 'g2', kind: 'group', worktree: { path: '/wt/b' } }, { id: 't', kind: 'terminal' }] }
    ] as never
    const live = [{ id: 'g1', type: 'group', data: { worktree: { path: '/wt/a' } } }, { id: 'x', type: 'terminal', data: {} }]
    expect(worktreeGroups(projects, 'a', live)).toEqual([
      { projectId: 'a', groupId: 'g1', path: '/wt/a' },
      { projectId: 'b', groupId: 'g2', path: '/wt/b' }
    ])
  })
})

describe('heldSessions', () => {
  it('reads the live canvas for the active project and the store for the rest', () => {
    const projects = [
      { id: 'a', nodes: [{ id: 'stale', agentSessionId: 'old' }] },
      { id: 'b', nodes: [{ id: 'n2', agentSessionId: 'x2' }] }
    ] as never
    const held = heldSessions(projects, 'a', [{ id: 'n1', data: { agentSessionId: 'x1' } }], (id) => (id === 'n2' ? 'live2' : undefined))
    expect(held).toEqual([
      { nodeId: 'n1', projectId: 'a', sessionId: 'x1' },
      { nodeId: 'n2', projectId: 'b', sessionId: 'live2' }
    ])
  })

  it('a node that moved to a new session (/clear) no longer holds its launch-minted one', () => {
    // Minted A at launch, live id now B: A must be resumable from the list, B must focus the node.
    const held = heldSessions([], 'p', [{ id: 'n1', data: { agentSessionId: 'A' } }], () => 'B')
    const planA = planResume(conv({ sessionId: 'A' }), ctx({ held }))
    expect(planA.kind).toBe('open-folder')
    expect(planResume(conv({ sessionId: 'B' }), ctx({ held }))).toMatchObject({ kind: 'focus', nodeId: 'n1' })
  })
})

describe('presentation', () => {
  it('groups by folder, groups ordered by their newest row', () => {
    const g = groupRecentByFolder([
      conv({ sessionId: 'a', cwd: '/x', lastActiveAt: 1 }),
      conv({ sessionId: 'b', cwd: '/y', lastActiveAt: 5 }),
      conv({ sessionId: 'c', cwd: '/x', lastActiveAt: 3 }),
      conv({ sessionId: 'd', cwd: null, lastActiveAt: 2 })
    ])
    expect(g.map((x) => [x.cwd, x.items.map((i) => i.sessionId)])).toEqual([
      ['/y', ['b']],
      ['/x', ['c', 'a']],
      [null, ['d']]
    ])
  })

  it('labels each plan', () => {
    const name = (): string => 'Web'
    expect(resumeActionLabel({ kind: 'focus', nodeId: 'n', projectId: 'p' }, name)).toBe('Go to node')
    expect(resumeActionLabel({ kind: 'resume', projectId: 'p', reopen: false }, name)).toBe('Resume in Web')
    expect(resumeActionLabel({ kind: 'open-folder', folder: '/x' }, name)).toBe('Open folder & resume')
  })

  it('sends core only local, settled codex account ids', () => {
    expect(localCodexAccountIds([{ id: 'a' }, { id: 'b', host: 'h' }, { id: 'c', pending: true }] as never)).toEqual(['a'])
  })
})

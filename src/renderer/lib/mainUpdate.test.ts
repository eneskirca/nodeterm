import { describe, expect, it } from 'vitest'
import { agentsIn, busyAgentIn, mainDriftText, mainUpdatedNote } from './mainUpdate'

const status = (byId: Record<string, string | undefined>) => (id: string) =>
  byId[id] === undefined ? undefined : { state: byId[id] as 'working' }

describe('busyAgentIn', () => {
  const nodes = [
    { id: 'a', title: 'Claude', agentId: 'claude', cwd: '/repo/wt' },
    { id: 'b', title: 'Codex', agentId: 'codex', cwd: '/repo/wt/sub' },
    { id: 'c', title: 'shell', cwd: '/repo/wt' },
    { id: 'd', title: 'Other', agentId: 'claude', cwd: '/repo/wt-two' }
  ]

  it('names an agent working, blocked or waiting in the checkout or below it', () => {
    expect(busyAgentIn('/repo/wt', nodes, status({ a: 'working' }))).toBe('Claude')
    expect(busyAgentIn('/repo/wt/', nodes, status({ b: 'blocked' }))).toBe('Codex')
    expect(busyAgentIn('/repo/wt', nodes, status({ a: 'waiting' }))).toBe('Claude')
  })

  it('matches a Windows path whatever its drive case or separators', () => {
    const win = [{ id: 'w', title: 'Win', agentId: 'claude', cwd: 'c:/Repo/wt\\sub' }]
    expect(busyAgentIn('C:\\Repo\\wt', win, status({ w: 'working' }))).toBe('Win')
  })

  it('ignores idle agents, plain terminals and a sibling folder that only shares a prefix', () => {
    expect(busyAgentIn('/repo/wt', nodes, status({ a: 'done', c: 'working', d: 'working' }))).toBeNull()
    expect(busyAgentIn('/repo/wt', nodes, status({}))).toBeNull()
  })
})

describe('mainDriftText', () => {
  it('says how far the default branch moved', () => {
    expect(mainDriftText({ base: 'origin/main', behind: 1 })).toBe('main moved 1 commit')
    expect(mainDriftText({ base: 'origin/master', behind: 4 })).toBe('master moved 4 commits')
  })
})

describe('agentsIn', () => {
  it('lists the agent nodes in the checkout or below it, never a plain terminal or a sibling folder', () => {
    const nodes = [
      { id: 'a', agentId: 'claude', cwd: '/repo/wt' },
      { id: 'b', agentId: 'codex', cwd: '/repo/wt/sub' },
      { id: 'c', cwd: '/repo/wt' },
      { id: 'd', agentId: 'claude', cwd: '/repo/wt-two' }
    ]
    expect(agentsIn('/repo/wt/', nodes).map((n) => n.id)).toEqual(['a', 'b'])
  })
})

describe('mainUpdatedNote', () => {
  it('tells the agent what changed under it and to read files again before editing', () => {
    const merge = mainUpdatedNote({ mode: 'merge', base: 'origin/main', branch: 'feat', behind: 2, cwd: '/repo/wt' })
    expect(merge).toBe('nodeterm: the user merged main into feat in /repo/wt (2 new commits from main). ' +
      'Files here may have changed since you last read them: read a file again before you edit it. ' +
      'Reply in one line and do not start other work.')
    const rebase = mainUpdatedNote({ mode: 'rebase', base: 'origin/main', branch: 'feat', behind: 1, cwd: '/repo/wt' })
    expect(rebase).toMatch(/^nodeterm: the user rebased feat onto main in \/repo\/wt \(1 new commit from main\)\. The branch history was rewritten\. Files here/)
  })
})

import { describe, expect, it } from 'vitest'
import { busyAgentIn, mainDriftText, rememberedUpdateMode } from './mainUpdate'

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

describe('rememberedUpdateMode', () => {
  it('reads merge or rebase from the local overlay, anything else as unset', () => {
    expect(rememberedUpdateMode({ worktree: { updateMode: 'rebase' } })).toBe('rebase')
    expect(rememberedUpdateMode({ worktree: { updateMode: 'merge' } })).toBe('merge')
    expect(rememberedUpdateMode({ worktree: { updateMode: 'reset' } })).toBeUndefined()
    expect(rememberedUpdateMode(undefined)).toBeUndefined()
  })
})

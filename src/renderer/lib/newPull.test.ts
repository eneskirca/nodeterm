import { describe, expect, it } from 'vitest'
import type { GitHistoryItem } from '@shared/git-history'
import { pullDraftFromCommits } from './newPull'

const commit = (id: string, message: string, refs: string[] = []): GitHistoryItem => ({
  id, parentIds: [], subject: message.split('\n')[0], message,
  references: refs.map((r) => ({ id: r, name: r.replace(/^refs\/(heads|remotes)\//, '') }))
})

describe('pullDraftFromCommits', () => {
  it('one commit since the base: its subject is the title and the rest of its message the body', () => {
    const items = [commit('b', 'Add x\n\nBecause y.'), commit('a', 'Base', ['refs/remotes/origin/main'])]
    expect(pullDraftFromCommits(items, 'main', 'feat/x')).toEqual({ title: 'Add x', body: 'Because y.' })
  })

  it('several commits: the branch name is the title and their subjects the body, oldest first', () => {
    const items = [commit('c', 'Second'), commit('b', 'First'), commit('a', 'Base', ['refs/heads/main'])]
    expect(pullDraftFromCommits(items, 'main', 'feat/add-x')).toEqual({ title: 'feat/add-x', body: '- First\n- Second' })
  })

  it('a base the walk never meets (it moved on): only the head commit', () => {
    const items = [commit('c', 'Second\n\nMore.'), commit('b', 'First'), commit('a', 'Old main')]
    expect(pullDraftFromCommits(items, 'main', 'feat/x')).toEqual({ title: 'Second', body: 'More.' })
  })

  it('no commits at all: the branch name and an empty body', () => {
    expect(pullDraftFromCommits([], 'main', 'feat/x')).toEqual({ title: 'feat/x', body: '' })
  })
})

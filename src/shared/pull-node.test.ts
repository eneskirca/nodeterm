import { describe, it, expect } from 'vitest'
import { normalizePullRef, pullPickerChoices } from './pull-node'
import { EMPTY_PULL_BOARD, type GitHubPullStatus } from './github-pull-status'

const pull = (number: number, lifecycle: GitHubPullStatus['lifecycle'], headRefName = `b${number}`): GitHubPullStatus =>
  ({ number, lifecycle, headRefName, closes: [] })

describe('pullPickerChoices', () => {
  it('lists the open and draft PRs the board holds, newest number first; closed and merged are typed', () => {
    const board = { ...EMPTY_PULL_BOARD, pulls: [pull(3, 'open', 'fix-a'), pull(9, 'draft', 'wip'), pull(5, 'merged'), pull(7, 'closed')] }
    expect(pullPickerChoices(board)).toEqual([
      { label: '#9 wip (draft)', value: '9' },
      { label: '#3 fix-a', value: '3' }
    ])
  })
  it('names the author and puts the PRs waiting for my review first', () => {
    const board = {
      ...EMPTY_PULL_BOARD,
      pulls: [
        { ...pull(8, 'open', 'mine'), author: 'me' },
        { ...pull(4, 'open', 'bot-pr'), author: 'github-actions', reviewRequested: true as const },
        { ...pull(6, 'open', 'ok'), author: 'ana', review: 'approved' as const }
      ]
    }
    expect(pullPickerChoices(board)).toEqual([
      { label: '#4 bot-pr · github-actions · Review requested', value: '4' },
      { label: '#8 mine · me', value: '8' },
      { label: '#6 ok · ana · Approved', value: '6' }
    ])
  })
  it('is empty without a board', () => {
    expect(pullPickerChoices(undefined)).toEqual([])
  })
})

describe('normalizePullRef tab', () => {
  it('opens a project saved with the old tab names on the matching new tab', () => {
    const ref = (tab: unknown) => normalizePullRef({ repository: 'o/r', pullNumber: 7, tab })?.tab
    expect(ref('overview')).toBe('conversation')
    expect(ref('conversation')).toBe('conversation')
    expect(ref('files')).toBe('files')
    expect(ref('secrets')).toBeUndefined()
  })
})

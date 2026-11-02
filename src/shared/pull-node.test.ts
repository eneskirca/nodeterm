import { describe, it, expect } from 'vitest'
import { pullPickerChoices } from './pull-node'
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
  it('is empty without a board', () => {
    expect(pullPickerChoices(undefined)).toEqual([])
  })
})

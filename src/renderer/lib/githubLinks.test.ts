import { describe, expect, it } from 'vitest'
import type { GitHubIssueCardView, GitHubLink } from '@shared/github-issues'
import type { GitHubBranchPull } from '@shared/github-issues'
import {
  addLink,
  hasLink,
  linkChipLabel,
  linkKey,
  linkState,
  linkToBoardTitle,
  linkTooltip,
  parseLinkInput,
  removeLink,
  suggestionFor
} from './githubLinks'

const card = (over: Partial<GitHubIssueCardView> = {}): GitHubIssueCardView => ({
  id: 1,
  number: 12,
  title: 'Board',
  body: '',
  state: 'open',
  stateReason: null,
  htmlUrl: 'https://github.com/o/r/issues/12',
  apiUrl: 'https://api.github.com/repos/o/r/issues/12',
  labels: [],
  assignees: [],
  createdAt: '2026-08-01T10:00:00Z',
  updatedAt: '2026-08-09T10:00:00Z',
  locked: false,
  columnId: null,
  conflict: null,
  ...over
})

describe('add / remove', () => {
  const issue: GitHubLink = { kind: 'issue', number: 12 }

  it('keeps issue #7 and pull #7 apart', () => {
    expect(linkKey({ kind: 'issue', number: 7 })).not.toBe(linkKey({ kind: 'pull', number: 7 }))
    const links = addLink([{ kind: 'issue', number: 7 }], { kind: 'pull', number: 7 })
    expect(links).toHaveLength(2)
  })

  it('returns the same array for a duplicate, so the caller can skip the write', () => {
    const links = [issue]
    expect(addLink(links, { ...issue, title: 'again' })).toBe(links)
    expect(hasLink(links, issue)).toBe(true)
  })

  it('refuses to grow past the per-node cap', () => {
    const full = Array.from({ length: 20 }, (_, index): GitHubLink => ({ kind: 'issue', number: index + 1 }))
    expect(addLink(full, { kind: 'issue', number: 99 })).toBe(full)
  })

  it('removes to undefined rather than an empty array', () => {
    expect(removeLink([issue], issue)).toBeUndefined()
    expect(removeLink([issue, { kind: 'pull', number: 3 }], issue)).toEqual([{ kind: 'pull', number: 3 }])
    expect(removeLink(undefined, issue)).toBeUndefined()
  })
})

describe('labels', () => {
  it('shows the first link and how many more', () => {
    expect(linkChipLabel([])).toBe('')
    expect(linkChipLabel([{ kind: 'issue', number: 12 }])).toBe('#12')
    expect(linkChipLabel([
      { kind: 'issue', number: 12 }, { kind: 'pull', number: 3 }, { kind: 'pull', number: 4 }
    ])).toBe('#12 +2')
  })

  it('prefers the live card title over the snapshot, and survives having neither', () => {
    expect(linkToBoardTitle({ kind: 'issue', number: 12, title: 'stale' }, card({ title: 'live' })))
      .toBe('#12 live')
    expect(linkToBoardTitle({ kind: 'issue', number: 12, title: 'stale' })).toBe('#12 stale')
    expect(linkToBoardTitle({ kind: 'issue', number: 12 })).toBe('#12')
  })

  it('tooltips one line per link', () => {
    expect(linkTooltip(
      [{ kind: 'issue', number: 12 }, { kind: 'pull', number: 3, title: 'Ship' }],
      { 'issue#12': card({ title: 'live' }) }
    )).toBe('#12 live\n#3 Ship')
  })
})

describe('linkState', () => {
  it('is unknown until a card is resolved', () => {
    expect(linkState({ kind: 'issue', number: 12 })).toBe('unknown')
  })

  it('reads an issue from its state and a pull request through the pull rules', () => {
    expect(linkState({ kind: 'issue', number: 12 }, card())).toBe('open')
    expect(linkState({ kind: 'issue', number: 12 }, card({ state: 'closed' }))).toBe('closed')
    const pull = { kind: 'pull', number: 12 } as const
    expect(linkState(pull, card({ pull: { draft: true, mergedAt: null } }))).toBe('draft')
    expect(linkState(pull, card({ state: 'closed', pull: { draft: false, mergedAt: '2026-08-09T00:00:00Z' } })))
      .toBe('merged')
    expect(linkState(pull, card({ state: 'closed', pull: { draft: false, mergedAt: null } }))).toBe('closed')
  })
})

describe('parseLinkInput', () => {
  it('reads a bare number and a hashed one, without claiming a kind', () => {
    expect(parseLinkInput('123', 'o/r')).toEqual({ number: 123 })
    expect(parseLinkInput(' #123 ', 'o/r')).toEqual({ number: 123 })
  })

  it('reads a github.com URL for THIS repository, with its kind', () => {
    expect(parseLinkInput('https://github.com/o/r/issues/12', 'o/r')).toEqual({ number: 12, kind: 'issue' })
    expect(parseLinkInput('https://github.com/O/R/pull/12#issuecomment-1', 'o/r'))
      .toEqual({ number: 12, kind: 'pull' })
  })

  it('refuses another repository, a non-link, and #0', () => {
    expect(parseLinkInput('https://github.com/other/repo/issues/12', 'o/r')).toBeNull()
    expect(parseLinkInput('https://github.com/o/r/issues/12', undefined)).toBeNull()
    expect(parseLinkInput('#0', 'o/r')).toBeNull()
    expect(parseLinkInput('fix the board', 'o/r')).toBeNull()
    expect(parseLinkInput('', 'o/r')).toBeNull()
  })
})

describe('suggestionFor', () => {
  const pull = (number: number, updatedAt: string): GitHubBranchPull => ({
    number,
    title: `PR ${number}`,
    draft: false,
    head: 'feat',
    updatedAt,
    htmlUrl: `https://github.com/o/r/pull/${number}`,
    state: 'open'
  })

  it('offers the open pull requests newest first', () => {
    expect(suggestionFor(undefined, [
      pull(7, '2026-08-01T00:00:00Z'),
      pull(8, '2026-08-09T00:00:00Z')
    ], new Set()).map((p) => p.number)).toEqual([8, 7])
  })

  it('drops one that is already linked, and one that was dismissed', () => {
    const pulls = [pull(7, '2026-08-09T00:00:00Z'), pull(8, '2026-08-08T00:00:00Z')]
    expect(suggestionFor([{ kind: 'pull', number: 7 }], pulls, new Set()).map((p) => p.number))
      .toEqual([8])
    expect(suggestionFor(undefined, pulls, new Set([8])).map((p) => p.number)).toEqual([7])
  })

  it('does not treat an ISSUE link as covering the pull request of the same number', () => {
    expect(suggestionFor([{ kind: 'issue', number: 7 }], [pull(7, '2026-08-09T00:00:00Z')], new Set()))
      .toHaveLength(1)
  })
})

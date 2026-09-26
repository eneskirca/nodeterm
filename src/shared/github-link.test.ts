import { describe, expect, it } from 'vitest'
import type { CanvasNodeState } from './types'
import {
  githubLinkUrl,
  sanitizeGitHubLinks,
  sanitizeNodeGitHubLinks
} from './github-link'

const node = (github: unknown): CanvasNodeState => ({
  id: 'n1',
  kind: 'terminal',
  position: { x: 0, y: 0 },
  size: { width: 10, height: 10 },
  title: 't',
  color: '#fff',
  group: null,
  github: github as CanvasNodeState['github']
})

describe('sanitizeGitHubLinks', () => {
  it('keeps well-formed entries and rebuilds them with only the three known keys', () => {
    expect(sanitizeGitHubLinks([
      { kind: 'issue', number: 12, title: 'Fix it', extra: 'smuggled' },
      { kind: 'pull', number: 3 }
    ])).toEqual([
      { kind: 'issue', number: 12, title: 'Fix it' },
      { kind: 'pull', number: 3 }
    ])
  })

  it('drops a non-array, and an array with nothing valid in it', () => {
    expect(sanitizeGitHubLinks(undefined)).toBeUndefined()
    expect(sanitizeGitHubLinks({ kind: 'issue', number: 1 })).toBeUndefined()
    expect(sanitizeGitHubLinks([])).toBeUndefined()
    expect(sanitizeGitHubLinks([{ kind: 'commit', number: 1 }])).toBeUndefined()
  })

  it('drops entries with an unknown kind or an unusable number', () => {
    expect(sanitizeGitHubLinks([
      { kind: 'commit', number: 1 },
      { kind: 'issue', number: -1 },
      { kind: 'issue', number: 0 },
      { kind: 'issue', number: 1.5 },
      { kind: 'issue', number: '2' },
      null,
      ['issue', 3],
      { kind: 'issue', number: 4 }
    ])).toEqual([{ kind: 'issue', number: 4 }])
  })

  it('drops only the title when it is unusable, never the link', () => {
    const long = 'x'.repeat(201)
    expect(sanitizeGitHubLinks([
      { kind: 'issue', number: 1, title: 7 },
      { kind: 'issue', number: 2, title: '   ' },
      { kind: 'issue', number: 3, title: long },
      { kind: 'issue', number: 4, title: '  padded  ' }
    ])).toEqual([
      { kind: 'issue', number: 1 },
      { kind: 'issue', number: 2 },
      { kind: 'issue', number: 3 },
      { kind: 'issue', number: 4, title: 'padded' }
    ])
  })

  it('dedupes by kind and number, first wins, and keeps issue #7 apart from pull #7', () => {
    expect(sanitizeGitHubLinks([
      { kind: 'issue', number: 7, title: 'first' },
      { kind: 'issue', number: 7, title: 'second' },
      { kind: 'pull', number: 7 }
    ])).toEqual([
      { kind: 'issue', number: 7, title: 'first' },
      { kind: 'pull', number: 7 }
    ])
  })

  it('caps at 20 entries', () => {
    const many = Array.from({ length: 50 }, (_, index) => ({ kind: 'issue', number: index + 1 }))
    expect(sanitizeGitHubLinks(many)).toHaveLength(20)
    expect(sanitizeGitHubLinks(many)?.at(-1)).toEqual({ kind: 'issue', number: 20 })
  })
})

describe('sanitizeNodeGitHubLinks', () => {
  it('leaves a node without links untouched by identity', () => {
    const clean: CanvasNodeState = { ...node(undefined) }
    delete clean.github
    expect(sanitizeNodeGitHubLinks([clean])[0]).toBe(clean)
  })

  it('removes the key entirely when nothing survives', () => {
    const [out] = sanitizeNodeGitHubLinks([node([{ kind: 'commit', number: 1 }])])
    expect('github' in out).toBe(false)
  })

  it('normalizes links on a group frame too — there is no kind gate', () => {
    const frame = { ...node([{ kind: 'pull', number: 9, title: 'Ship' }]), kind: 'group' as const }
    expect(sanitizeNodeGitHubLinks([frame])[0].github).toEqual([
      { kind: 'pull', number: 9, title: 'Ship' }
    ])
  })
})

describe('githubLinkUrl', () => {
  it('routes issues and pull requests to their own path segment', () => {
    expect(githubLinkUrl('o/r', { kind: 'issue', number: 12 }))
      .toBe('https://github.com/o/r/issues/12')
    expect(githubLinkUrl('o/r', { kind: 'pull', number: 12 }))
      .toBe('https://github.com/o/r/pull/12')
  })

  it('is empty without a repository', () => {
    expect(githubLinkUrl(undefined, { kind: 'issue', number: 1 })).toBe('')
    expect(githubLinkUrl('', { kind: 'issue', number: 1 })).toBe('')
  })
})

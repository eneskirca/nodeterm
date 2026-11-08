import { describe, expect, it } from 'vitest'
import { issueWorkPrompt, normalizeIssuesRef } from './issues-node'

const ref = { owner: 'o', repo: 'r', number: 12 }

describe('normalizeIssuesRef', () => {
  it('keeps the repository and a selected issue, and nothing else', () => {
    expect(normalizeIssuesRef({ repository: 'o/r', issueNumber: 3, title: 'secret' })).toEqual({ repository: 'o/r', issueNumber: 3 })
    expect(normalizeIssuesRef({ repository: 'o/r', issueNumber: 0 })).toEqual({ repository: 'o/r' })
    expect(normalizeIssuesRef({ repository: 'o/r/x' })).toBeUndefined()
    expect(normalizeIssuesRef(null)).toBeUndefined()
  })
})

describe('issueWorkPrompt', () => {
  it('carries the reference and the gh read, never the issue text', () => {
    const prompt = issueWorkPrompt(ref)!
    expect(prompt).toContain('GitHub issue o/r#12')
    expect(prompt).toContain('https://github.com/o/r/issues/12')
    expect(prompt).toContain('gh issue view 12 --repo o/r --comments')
    expect(prompt).toContain('untrusted')
    expect(prompt).not.toMatch(/Title:|Body:|ISSUE TEXT/)
  })

  it('refuses a malformed reference', () => {
    expect(issueWorkPrompt({ owner: '-x', repo: 'r', number: 1 })).toBeUndefined()
  })
})

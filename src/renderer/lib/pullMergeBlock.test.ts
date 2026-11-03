import { describe, expect, it } from 'vitest'
import type { GitHubPullDetail } from '@shared/github-pull-detail'
import type { GitHubPullChecksResult } from '@shared/github-pull-status'
import { mergeBlock } from './pullMergeBlock'

const head = 'a'.repeat(40)
const pull = (over: Partial<GitHubPullDetail> = {}): GitHubPullDetail => ({
  number: 7, title: 't', body: '', lifecycle: 'open', author: null,
  base: { ref: 'main', sha: 'b'.repeat(40) }, head: { ref: 'feat/x', sha: head },
  merge: 'ready', additions: 0, deletions: 0, changedFiles: 0, url: 'https://github.com/o/r/pull/7', ...over
})
const checks = (states: Array<'passed' | 'failed' | 'pending'>, review?: 'required' | 'changes-requested'): GitHubPullChecksResult => ({
  status: 'ok', headRefOid: head, truncated: false,
  checks: states.map((state, i) => ({ name: `c${i}`, state })), ...(review ? { review } : {})
})

describe('mergeBlock', () => {
  it.each<[string, Partial<GitHubPullDetail>, GitHubPullChecksResult | undefined, string | null, string | null]>([
    ['ready', {}, undefined, null, null],
    ['undecided: GitHub answers the merge itself', { merge: 'undecided' }, undefined, null, null],
    ['unstable: a non-required check failed, merge still allowed', { merge: 'unstable' }, checks(['failed']), null, null],
    ['draft', { lifecycle: 'draft', merge: 'blocked' }, undefined, 'draft',
      'A draft pull request cannot be merged. Mark it ready for review on GitHub first.'],
    ['closed', { lifecycle: 'closed', merge: undefined }, undefined, 'closed', 'This pull request is closed.'],
    ['merged', { lifecycle: 'merged', merge: undefined }, undefined, 'merged', 'This pull request is already merged.'],
    ['conflict', { merge: 'conflict' }, undefined, 'conflict',
      'This pull request has conflicts with main. Resolve them on its branch before it can merge.'],
    ['behind with strict protection', { merge: 'behind' }, undefined, 'behind',
      'This branch is behind main, and branch protection needs it up to date. Update the branch first.'],
    ['blocked: review required', { merge: 'blocked' }, { status: 'no-checks', review: 'required' }, 'blocked',
      'Branch protection needs an approving review.'],
    ['blocked: changes requested', { merge: 'blocked' }, checks(['passed'], 'changes-requested'), 'blocked',
      'A reviewer requested changes. Their approval is needed first.'],
    ['blocked: checks failing', { merge: 'blocked' }, checks(['pending', 'failed']), 'blocked',
      'Checks are failing.'],
    ['blocked: checks pending', { merge: 'blocked' }, checks(['passed', 'pending']), 'blocked',
      'Checks are still running.'],
    ['blocked: review and checks', { merge: 'blocked' }, checks(['failed'], 'required'), 'blocked',
      'Branch protection needs an approving review. Checks are failing.'],
    ['blocked: reason unknown', { merge: 'blocked' }, undefined, 'blocked',
      'Branch protection blocked this merge. Get the required reviews and checks first.'],
    ['blocked: checks of another commit say nothing', { merge: 'blocked' }, { status: 'ok', headRefOid: 'c'.repeat(40), truncated: false, checks: [{ name: 'c0', state: 'failed' }] }, 'blocked',
      'Branch protection blocked this merge. Get the required reviews and checks first.']
  ])('%s', (_name, over, read, kind, text) => {
    const block = mergeBlock(pull(over), read)
    expect(block?.kind ?? null).toBe(kind)
    expect(block?.text ?? null).toBe(text)
  })
})

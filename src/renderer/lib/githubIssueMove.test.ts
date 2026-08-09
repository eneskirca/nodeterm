import { describe, expect, it } from 'vitest'
import { githubMoveIntent, githubMoveConfirmation } from './githubIssueMove'

const open = { number: 7, title: 'Fix the thing', state: 'open' as const, columnId: 'doing' }
const closed = { number: 9, title: 'Old wontfix', state: 'closed' as const, columnId: 'done' }

describe('githubMoveIntent', () => {
  it('is a no-op when the card lands where it already is', () => {
    expect(githubMoveIntent(closed, 'done', 'done').kind).toBe('noop')
  })

  it('closes when an open issue reaches the completion column', () => {
    expect(githubMoveIntent(open, 'done', 'done').kind).toBe('close')
  })

  it('reopens when a closed issue leaves the completion column', () => {
    expect(githubMoveIntent(closed, 'todo', 'done').kind).toBe('reopen')
  })

  it('reopens when a closed issue is dropped on Ungrouped', () => {
    // The Ungrouped column sits at the far left of the board and is the easiest thing to hit by
    // accident. Dropping there is a reopen on GitHub, so it must not be treated as a quiet relabel.
    expect(githubMoveIntent(closed, null, 'done').kind).toBe('reopen')
  })

  it('is labels-only when neither end is the completion column', () => {
    expect(githubMoveIntent(open, 'todo', 'done').kind).toBe('labels-only')
  })

  it('is labels-only when the board has no completion column', () => {
    expect(githubMoveIntent(open, 'todo', undefined).kind).toBe('labels-only')
  })
})

describe('githubMoveConfirmation', () => {
  it('asks before a close, naming the issue', () => {
    const confirmation = githubMoveConfirmation(open, 'done', 'done')
    expect(confirmation?.confirmLabel).toBe('Close issue')
    expect(confirmation?.message).toContain('#7')
    expect(confirmation?.message).toContain('Fix the thing')
  })

  it('asks before a reopen', () => {
    const confirmation = githubMoveConfirmation(closed, null, 'done')
    expect(confirmation?.confirmLabel).toBe('Reopen issue')
    expect(confirmation?.message).toContain('#9')
  })

  it('does not ask for a move that only rewrites labels', () => {
    expect(githubMoveConfirmation(open, 'todo', 'done')).toBeNull()
  })

  it('does not ask for a no-op', () => {
    expect(githubMoveConfirmation(closed, 'done', 'done')).toBeNull()
  })
})

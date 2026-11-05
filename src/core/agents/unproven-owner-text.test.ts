import { describe, expect, it } from 'vitest'

import { renderMessageOutcome } from './agent-messaging'
import { RETRYABLE } from './agent-message-decide'
import { shouldRecordOwnership } from './pane-ownership'

/**
 * The `unproven-target-owner` refusal told its caller to do something that does not work, and
 * nothing in a 11k-test suite noticed — because no test read the sentence.
 *
 * It said: "Re-open the target node so its owner is recorded, then try again." Ownership is
 * recorded ONLY on a genuine fresh spawn (`shouldRecordOwnership`, `fresh === true`), and after an
 * app restart the tmux server has survived, so re-opening ATTACHES to the running session and
 * records nothing. A caller that obeyed got the identical refusal, forever.
 *
 * These assertions pin the sentence against the MECHANISM rather than against itself: the prose
 * claims attaching cannot prove ownership, and the test asks `shouldRecordOwnership` whether that
 * is true. That is the shape that would have caught the original — see the repo's rule about
 * claims written ahead of the mechanism.
 */
const refusal = (): string => {
  const r = renderMessageOutcome({
    kind: 'notPermitted',
    reason: 'unproven-target-owner'
  } as Parameters<typeof renderMessageOutcome>[0])
  return r.error ?? ''
}

describe('the unproven-target-owner refusal describes a remedy that exists', () => {
  it('does not tell the caller to re-open the node', () => {
    // The false remedy, in the two spellings it could come back as.
    expect(refusal().toLowerCase()).not.toContain('re-open')
    expect(refusal().toLowerCase()).not.toContain('reopen')
  })

  it("says attaching cannot prove ownership — and the mechanism agrees", () => {
    expect(refusal().toLowerCase()).toContain('attaching')
    // The claim, measured. An attach is `fresh === false`, and the gate refuses to record it; a
    // genuine fresh spawn is what records. If this ever flips, the sentence becomes a lie again
    // and this test is what says so.
    expect(shouldRecordOwnership(false, 'nt-x', 'proj-1')).toBe(false)
    expect(shouldRecordOwnership(true, 'nt-x', 'proj-1')).toBe(true)
  })

  it('names the remedy that does work, and whose job it is', () => {
    const text = refusal().toLowerCase()
    // Supported local sessions now have a separately verified human-adoption path.
    expect(text).toContain('on a supported local desktop')
    expect(text).toContain('authorize this running session')
    expect(text).toContain('keep the existing session and its work running')
    expect(text).not.toMatch(/end that session and start it again/)
    expect(text).toContain('user')
  })

  it('is honest that an app restart is what put the pane in this state', () => {
    // The commonest way to arrive here, and the one the old text implicitly denied by offering a
    // re-open as the cure.
    expect(refusal().toLowerCase()).toContain('app restart')
  })

  it('spells out no retry advice of its own — that comes from RETRYABLE', () => {
    // `renderMessageOutcome` appends "Do not retry." / "Retryable — …" from the table. A sentence
    // carrying its own "then try again" both duplicated it and contradicted it.
    expect(RETRYABLE.notPermitted).toBe(false)
    expect(refusal()).toContain('Do not retry.')
    // The refusal's OWN half (before the appended advice) must not invite a retry.
    const own = refusal().split('Do not retry.')[0]
    expect(own.toLowerCase()).not.toContain('try again')
    expect(own.toLowerCase()).not.toContain('retry')
  })
})

// The decision table, exhaustively. `controlPolicy` is pure on purpose: the routes it governs are
// the two an agent drives with a shell command, and a rule that can only be exercised through a
// socket is a rule nobody can read off a test.
import { describe, it, expect } from 'vitest'
import {
  controlPolicy,
  CONTEXT_LINK_POLICY_VERB,
  IDENTITY_REFUSED_NOTE,
  IDENTITY_RESTART_NOTE,
  isStrictInstant,
  NODE_IDENTITY_CLOCK_HORIZON_MS,
  NODE_IDENTITY_STRICT_AFTER,
  TOLERANT_CONTROL_VERBS
} from './node-identity-policy'
import { NODE_IDENTITY_STRICT_DATE } from '@shared/node-identity'

const BEFORE = new Date('2026-09-01T00:00:00Z')
const AFTER = new Date('2026-11-01T00:00:00Z')
const TOLERANT = 'list'
const MUTATION = 'open-terminal'

describe('the cutoff is a dated commitment, not a "later"', () => {
  it('is 2026-10-13, in the source', () => {
    expect(NODE_IDENTITY_STRICT_AFTER.toISOString()).toBe('2026-10-13T00:00:00.000Z')
  })

  it('puts that date in the sentence the user reads', () => {
    expect(IDENTITY_RESTART_NOTE).toContain('2026-10-13')
  })

  it('is built from the ONE date string the Settings row also prints', () => {
    // The renderer cannot import this module, so the date lives in @shared and both sides derive
    // from it. A Settings page promising a different cutoff than the server enforces would be the
    // worst possible version of this feature.
    expect(NODE_IDENTITY_STRICT_DATE).toBe('2026-10-13')
    expect(NODE_IDENTITY_STRICT_AFTER.toISOString().slice(0, 10)).toBe(NODE_IDENTITY_STRICT_DATE)
  })

  it('names the action in both sentences, so the user is told what to do', () => {
    for (const note of [IDENTITY_RESTART_NOTE, IDENTITY_REFUSED_NOTE]) {
      expect(note).toContain('Restart agent')
      // One line: both are PREFIXED onto a reply, and a multi-line prefix buries the reply.
      expect(note).not.toContain('\n')
    }
  })

  it('says, in the refusal, that the command did not run', () => {
    expect(IDENTITY_REFUSED_NOTE).toContain('did not run')
  })
})

describe('the tolerant bucket', () => {
  it('holds `list` and nothing that changes the canvas', () => {
    expect([...TOLERANT_CONTROL_VERBS]).toEqual(['list'])
    // The token is never a substitute for the human's answer, so the confirm-gated verbs are not
    // in here — they must reach the handler (and its dialog), not be waved through by tolerance.
    expect(TOLERANT_CONTROL_VERBS.has('write')).toBe(false)
    expect(TOLERANT_CONTROL_VERBS.has('close')).toBe(false)
  })

  it('is what /context-link/* presents, because every context-link verb is a read', () => {
    expect(TOLERANT_CONTROL_VERBS.has(CONTEXT_LINK_POLICY_VERB)).toBe(true)
  })
})

describe('controlPolicy', () => {
  it('refuses a forged token in every combination — it is the one unambiguous attack signal', () => {
    for (const proven of [false, true]) {
      for (const verb of [TOLERANT, MUTATION]) {
        for (const now of [BEFORE, AFTER]) {
          for (const override of [undefined, true, false]) {
            expect(
              controlPolicy({ verdict: 'forged', proven, verb, now, override }),
              `${proven}/${verb}/${now.toISOString()}/${override}`
            ).toBe('refuse')
          }
        }
      }
    }
  })

  it('allows a verified token in every combination, and never warns it', () => {
    for (const proven of [false, true]) {
      for (const verb of [TOLERANT, MUTATION]) {
        for (const now of [BEFORE, AFTER]) {
          for (const override of [undefined, true, false]) {
            expect(
              controlPolicy({ verdict: 'verified', proven, verb, now, override }),
              `${proven}/${verb}/${now.toISOString()}/${override}`
            ).toBe('allow')
          }
        }
      }
    }
  })

  describe('legacy, before the node has ever proven itself', () => {
    it('takes the legacy path for a tolerant verb, on both sides of the cutoff', () => {
      for (const now of [BEFORE, AFTER]) {
        expect(controlPolicy({ verdict: 'legacy', proven: false, verb: TOLERANT, now })).toBe('allow')
      }
    })

    it('runs a mutation with a warning during the window', () => {
      expect(controlPolicy({ verdict: 'legacy', proven: false, verb: MUTATION, now: BEFORE })).toBe(
        'allow-with-warning'
      )
    })

    it('refuses a mutation after the cutoff', () => {
      expect(controlPolicy({ verdict: 'legacy', proven: false, verb: MUTATION, now: AFTER })).toBe(
        'refuse'
      )
    })

    it('treats the cutoff instant itself as strict', () => {
      expect(
        controlPolicy({
          verdict: 'legacy',
          proven: false,
          verb: MUTATION,
          now: new Date(NODE_IDENTITY_STRICT_AFTER.getTime())
        })
      ).toBe('refuse')
      expect(
        controlPolicy({
          verdict: 'legacy',
          proven: false,
          verb: MUTATION,
          now: new Date(NODE_IDENTITY_STRICT_AFTER.getTime() - 1)
        })
      ).toBe('allow-with-warning')
    })
  })

  describe('legacy, after the node HAS proven itself — the latch', () => {
    it('refuses, for every verb and on both sides of the cutoff', () => {
      // A session that demonstrably CAN authenticate and suddenly does not is either a different
      // process wearing its node id or a forgery this instance cannot name. Even `list` leaks the
      // canvas shape, so the latch does not exempt it.
      for (const verb of [TOLERANT, MUTATION]) {
        for (const now of [BEFORE, AFTER]) {
          expect(controlPolicy({ verdict: 'legacy', proven: true, verb, now })).toBe('refuse')
        }
      }
    })
  })

  describe('a machine clock that is not to be believed', () => {
    // A VM restored from a snapshot, a board whose RTC came up wrong, a clock somebody set forward:
    // the cutoff is read against `Date.now()`, so any of them puts an ordinary install into strict
    // mode on day one, with no warning window at all and a refusal naming a date "already past".
    // Nothing distinguishes that from an install genuinely still running years later — so the tie
    // goes to the fail-open direction the rest of this file takes.
    const cutoff = NODE_IDENTITY_STRICT_AFTER.getTime()
    const wayAhead = new Date(cutoff + NODE_IDENTITY_CLOCK_HORIZON_MS + 1)

    it('enforces normally right up to the horizon', () => {
      expect(isStrictInstant(new Date(cutoff))).toBe(true)
      expect(isStrictInstant(new Date(cutoff + NODE_IDENTITY_CLOCK_HORIZON_MS - 1))).toBe(true)
    })

    it('stops believing the clock past the horizon and keeps the window open', () => {
      expect(isStrictInstant(wayAhead)).toBe(false)
      expect(isStrictInstant(new Date('2038-01-01T00:00:00Z'))).toBe(false)
      expect(
        controlPolicy({ verdict: 'legacy', proven: false, verb: MUTATION, now: wayAhead })
      ).toBe('allow-with-warning')
    })

    it('relaxes only the DATE — the latch and `forged` are untouched by it', () => {
      // The clamp only ever relaxes the DATE. A node that has proven itself is still refused when
      // an unverified caller turns up for it — that is what makes the clamp cheap.
      //
      // NOT because the latch is a security boundary: it is not, and this suite must not be read
      // as saying so. The latch catches a MISTAKE (a session that stopped presenting its token);
      // an attacker invents a `kid`, which is FOREIGN, which is `legacy`, which never latches by
      // invariant 3. See `hook-identity-enforcement.test.ts` → "an invented kid is admitted".
      expect(controlPolicy({ verdict: 'legacy', proven: true, verb: MUTATION, now: wayAhead })).toBe(
        'refuse'
      )
      expect(controlPolicy({ verdict: 'forged', proven: false, verb: TOLERANT, now: wayAhead })).toBe(
        'refuse'
      )
    })

    it('still lets an explicit `true` enforce, wherever the clock thinks it is', () => {
      // The clamp disbelieves the CLOCK, not the user. Someone who asked for strict gets strict.
      expect(
        controlPolicy({ verdict: 'legacy', proven: false, verb: MUTATION, now: wayAhead, override: true })
      ).toBe('refuse')
    })

    it('treats an invalid Date as not-strict rather than throwing', () => {
      expect(isStrictInstant(new Date('nonsense'))).toBe(false)
    })
  })

  describe('the hookIdentityStrict escape hatch', () => {
    it('undefined follows the constant', () => {
      expect(
        controlPolicy({ verdict: 'legacy', proven: false, verb: MUTATION, now: AFTER, override: undefined })
      ).toBe('refuse')
      expect(
        controlPolicy({ verdict: 'legacy', proven: false, verb: MUTATION, now: BEFORE, override: undefined })
      ).toBe('allow-with-warning')
    })

    it('true is strict before the cutoff (opt in early)', () => {
      expect(
        controlPolicy({ verdict: 'legacy', proven: false, verb: MUTATION, now: BEFORE, override: true })
      ).toBe('refuse')
    })

    it('false keeps the warning window open past the cutoff, latch included', () => {
      // This is the whole point of the hatch: a user whose upgrade goes wrong gets their canvas
      // back without downgrading the app. It must therefore also release the latch — the latch is
      // the likelier thing to have stranded them.
      expect(
        controlPolicy({ verdict: 'legacy', proven: false, verb: MUTATION, now: AFTER, override: false })
      ).toBe('allow-with-warning')
      expect(
        controlPolicy({ verdict: 'legacy', proven: true, verb: MUTATION, now: AFTER, override: false })
      ).toBe('allow-with-warning')
      expect(
        controlPolicy({ verdict: 'legacy', proven: true, verb: TOLERANT, now: AFTER, override: false })
      ).toBe('allow')
    })

    it('never lets a forged token through, whatever it is set to', () => {
      expect(
        controlPolicy({ verdict: 'forged', proven: false, verb: TOLERANT, now: BEFORE, override: false })
      ).toBe('refuse')
    })
  })
})

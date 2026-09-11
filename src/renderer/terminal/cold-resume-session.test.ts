import { describe, expect, it } from 'vitest'
import { coldResumeDecision, shouldProbeTranscript } from './cold-resume-session'

const ID = '46b36ce2-dd77-4f5e-a89e-4a0e831e83df'

describe('coldResumeDecision — only a positive `absent` drops the resume', () => {
  it('drops the id and raises the notice when the transcript is gone', () => {
    expect(coldResumeDecision(ID, 'absent')).toEqual({ sessionId: undefined, lostSession: true })
  })

  it('resumes when the transcript is there', () => {
    expect(coldResumeDecision(ID, 'present')).toEqual({ sessionId: ID, lostSession: false })
  })

  it('resumes on `unknown` — a probe that could not look is not evidence of deletion', () => {
    // The asymmetry this encodes: wrongly resuming a dead id costs one error line and a bare
    // shell; wrongly dropping a LIVE id silently opens a blank conversation over work the user
    // believes is continuing. `unknown` must therefore behave exactly as it did before the probe.
    expect(coldResumeDecision(ID, 'unknown')).toEqual({ sessionId: ID, lostSession: false })
  })

  it('raises no notice when there was no id to lose', () => {
    // A first open has nothing persisted. `absent` is meaningless there, and a banner saying a
    // conversation could not be found would be an invented failure.
    for (const p of ['absent', 'present', 'unknown'] as const) {
      expect(coldResumeDecision(undefined, p)).toEqual({ sessionId: undefined, lostSession: false })
    }
  })

  it('normalises an empty id to undefined rather than resuming with ""', () => {
    expect(coldResumeDecision('', 'unknown')).toEqual({ sessionId: undefined, lostSession: false })
  })
})

describe('shouldProbeTranscript — who may be asked', () => {
  it('asks for claude, whose transcripts this probe actually resolves', () => {
    expect(shouldProbeTranscript(ID, 'claude')).toBe(true)
  })

  it('never asks for an agent whose id this resolver cannot find', () => {
    // codex/gemini/grok ids miss claude's resolver by construction — EVERY time — so a probe
    // would answer `absent` for a perfectly good session and drop its resume. These agents keep
    // today's behaviour until the probe learns their layouts.
    for (const a of ['codex', 'gemini', 'grok', 'copilot', 'opencode'] as const) {
      expect(shouldProbeTranscript(ID, a)).toBe(false)
    }
  })

  it('never asks without an id, and never asks for a plain terminal', () => {
    expect(shouldProbeTranscript(undefined, 'claude')).toBe(false)
    expect(shouldProbeTranscript('', 'claude')).toBe(false)
    expect(shouldProbeTranscript(ID, undefined)).toBe(false)
  })
})

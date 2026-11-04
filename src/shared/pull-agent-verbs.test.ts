import { describe, expect, it } from 'vitest'
import { parsePrPropose, parsePrShow, pullAgentArgsRefusal } from './pull-agent-verbs'

describe('parsePrShow', () => {
  it('reads a tab, or a file with a line range (which means the Files tab)', () => {
    expect(parsePrShow({ node: 'pull-1', tab: 'conversation' }))
      .toEqual({ ok: true, node: 'pull-1', show: { tab: 'conversation' } })
    expect(parsePrShow({ node: 'pull-1', tab: 'overview' }))
      .toEqual({ ok: true, node: 'pull-1', show: { tab: 'conversation' } })
    expect(parsePrShow({ node: 'pull-1', file: 'src/a.ts', lines: '12-30' }))
      .toEqual({ ok: true, node: 'pull-1', show: { tab: 'files', file: 'src/a.ts', lines: { start: 12, end: 30 } } })
    expect(parsePrShow({ node: 'pull-1', file: 'src/a.ts', lines: '7' }))
      .toEqual({ ok: true, node: 'pull-1', show: { tab: 'files', file: 'src/a.ts', lines: { start: 7, end: 7 } } })
  })

  it('refuses a missing node, an unknown flag, a bad tab, lines without a file and a reversed range', () => {
    expect(parsePrShow({ tab: 'files' })).toMatchObject({ ok: false })
    expect(parsePrShow({ node: 'pull-1', merge: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('--merge') })
    expect(parsePrShow({ node: 'pull-1', tab: 'checks' })).toMatchObject({ ok: false })
    expect(parsePrShow({ node: 'pull-1', lines: '3-4' })).toMatchObject({ ok: false })
    expect(parsePrShow({ node: 'pull-1', file: 'a.ts', lines: '9-3' })).toMatchObject({ ok: false })
    expect(parsePrShow({ node: 'pull-1', file: 'a\nb' })).toMatchObject({ ok: false })
    expect(parsePrShow({ node: 'pull-1', file: 'a.ts', tab: 'overview' })).toMatchObject({ ok: false })
    expect(parsePrShow({ node: 'pull-1' })).toMatchObject({ ok: false })
  })
})

describe('parsePrPropose', () => {
  it('reads approve (message optional), request-changes and comment (message required), merge (method optional)', () => {
    expect(parsePrPropose({ node: 'p', action: 'approve' }))
      .toEqual({ ok: true, node: 'p', proposal: { action: 'approve', message: '' } })
    expect(parsePrPropose({ node: 'p', action: 'request-changes', message: 'Fix the test' }))
      .toEqual({ ok: true, node: 'p', proposal: { action: 'request-changes', message: 'Fix the test' } })
    expect(parsePrPropose({ node: 'p', action: 'comment', message: 'Nice' }))
      .toEqual({ ok: true, node: 'p', proposal: { action: 'comment', message: 'Nice' } })
    expect(parsePrPropose({ node: 'p', action: 'merge', method: 'squash' }))
      .toEqual({ ok: true, node: 'p', proposal: { action: 'merge', method: 'squash' } })
    expect(parsePrPropose({ node: 'p', action: 'merge' }))
      .toEqual({ ok: true, node: 'p', proposal: { action: 'merge' } })
  })

  it('refuses an unknown action or method, a missing message, a message on merge, and an unknown flag', () => {
    expect(parsePrPropose({ node: 'p', action: 'close' })).toMatchObject({ ok: false })
    expect(parsePrPropose({ node: 'p', action: 'merge', method: 'octopus' })).toMatchObject({ ok: false })
    expect(parsePrPropose({ node: 'p', action: 'comment', message: '  ' })).toMatchObject({ ok: false })
    expect(parsePrPropose({ node: 'p', action: 'merge', message: 'x' })).toMatchObject({ ok: false })
    expect(parsePrPropose({ node: 'p', action: 'approve', repository: 'evil/x' })).toMatchObject({ ok: false })
    expect(parsePrPropose({ action: 'approve' })).toMatchObject({ ok: false })
  })
})

describe('pullAgentArgsRefusal', () => {
  it('answers only for the two verbs', () => {
    expect(pullAgentArgsRefusal('pr-show', { node: 'p', tab: 'files' })).toBeNull()
    expect(pullAgentArgsRefusal('pr-propose', { node: 'p' })).toEqual(expect.any(String))
    expect(pullAgentArgsRefusal('list', { anything: 'x' })).toBeNull()
  })
})

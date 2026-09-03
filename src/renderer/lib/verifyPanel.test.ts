import { describe, it, expect } from 'vitest'
import {
  DEFAULT_LENSES,
  MAX_LENSES,
  parseLenses,
  verifyAgentBlockReason,
  verifyLensPrompt,
  verifySynthesisPrompt
} from './verifyPanel'

describe('verifyAgentBlockReason', () => {
  it('requires both readable context and completion hooks', () => {
    expect(verifyAgentBlockReason('claude')).toBeNull()
    expect(verifyAgentBlockReason('agy')).toBe('cannot-report-done')
    expect(verifyAgentBlockReason('pi')).toBe('cannot-report-done')
    expect(verifyAgentBlockReason('goose')).toBe('cannot-report-done')
    expect(verifyAgentBlockReason('custom:unknown')).toBe('cannot-read')
  })
})

describe('parseLenses', () => {
  it('falls back to the default panel when nothing is given', () => {
    expect(parseLenses(undefined)).toEqual(DEFAULT_LENSES)
    expect(parseLenses('')).toEqual(DEFAULT_LENSES)
    expect(parseLenses('  ,  ,')).toEqual(DEFAULT_LENSES)
  })

  it('normalizes case and whitespace, and drops duplicates', () => {
    expect(parseLenses(' Security , security ,TESTS ')).toEqual(['security', 'tests'])
  })

  it('keeps lens words it does not know — an unanticipated angle is still a valid review', () => {
    expect(parseLenses('accessibility,i18n')).toEqual(['accessibility', 'i18n'])
  })

  it('caps the panel size', () => {
    const many = parseLenses('a,b,c,d,e,f,g,h')
    expect(many).toHaveLength(MAX_LENSES)
  })
})

describe('verifyLensPrompt', () => {
  const base = { targetTitle: 'Migration', targetId: 'term-7', shimPath: '/x/nodeterm.sh' }

  it('names the lens, the target, and a known lens brief', () => {
    const p = verifyLensPrompt({ ...base, lens: 'security', agentId: 'claude' })
    expect(p).toContain('single lens: security')
    expect(p).toContain('"Migration" (term-7)')
    expect(p).toContain('injection')
  })

  it('points claude at the skill and other agents at the CLI shim', () => {
    expect(verifyLensPrompt({ ...base, lens: 'tests', agentId: 'claude' })).toContain(
      'get-linked-context skill'
    )
    const codex = verifyLensPrompt({ ...base, lens: 'tests', agentId: 'codex' })
    expect(codex).toContain('/x/nodeterm.sh')
    expect(codex).not.toContain('get-linked-context skill')
  })

  it('gives an unknown lens a generic brief instead of dropping it', () => {
    expect(verifyLensPrompt({ ...base, lens: 'accessibility' })).toContain(
      'problems of this kind: accessibility'
    )
  })

  it('always forbids editing — a panel shares one checkout', () => {
    for (const lens of ['correctness', 'security', 'whatever']) {
      expect(verifyLensPrompt({ ...base, lens })).toMatch(/Do NOT change any files/)
    }
  })

  it('always licenses an empty finding, so reviewers do not invent one', () => {
    expect(verifyLensPrompt({ ...base, lens: 'correctness' })).toContain('nothing found')
  })

  it('folds in --focus when given, and omits the clause when not', () => {
    expect(verifyLensPrompt({ ...base, lens: 'tests', focus: 'the SSH retry path' })).toContain(
      'specifically about: the SSH retry path'
    )
    expect(verifyLensPrompt({ ...base, lens: 'tests' })).not.toContain('specifically about')
    expect(verifyLensPrompt({ ...base, lens: 'tests', focus: '   ' })).not.toContain(
      'specifically about'
    )
  })
})

describe('verifySynthesisPrompt', () => {
  const base = { targetTitle: 'Migration', shimPath: '/x/nodeterm.sh' }

  it('names every lens on the panel and the count', () => {
    const p = verifySynthesisPrompt({ ...base, lenses: ['correctness', 'security'] })
    expect(p).toContain('2 reviewers')
    expect(p).toContain('correctness, security')
  })

  it('makes an empty verdict an acceptable outcome', () => {
    expect(verifySynthesisPrompt({ ...base, lenses: ['correctness'] })).toContain(
      'an empty verdict is a real result'
    )
  })
})

import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  mesaHarnessContract,
  mesaPromptFileError,
  mesaTypedLineError,
  MESA_PROMPT_MAX_BYTES,
  MESA_TYPED_LINE_MAX_CHARS
} from './harness'

describe('mesaHarnessContract', () => {
  it('maps grok/claude to file-argv, opencode to file-flag, gemini to stdin-after-start', () => {
    expect(mesaHarnessContract('grok')).toMatchObject({
      promptTransport: 'file-argv',
      permissionPolicy: 'workspace-scoped',
      expectedProcess: 'grok'
    })
    expect(mesaHarnessContract('claude')).toMatchObject({
      promptTransport: 'file-argv',
      expectedProcess: 'claude'
    })
    expect(mesaHarnessContract('opencode')).toMatchObject({
      promptTransport: 'file-flag',
      expectedProcess: 'opencode'
    })
    expect(mesaHarnessContract('gemini')).toMatchObject({
      promptTransport: 'stdin-after-start',
      expectedProcess: 'gemini'
    })
  })

  it('does not invent a --yolo permission policy', () => {
    const grok = mesaHarnessContract('grok')
    expect('error' in grok ? grok : grok.permissionPolicy).toBe('workspace-scoped')
  })

  it('refuses a harness with no launch command', () => {
    expect(
      mesaHarnessContract('   ', { id: 'custom:empty', label: 'Empty', launchCmd: '' })
    ).toEqual({ error: 'unsupported-harness' })
  })
})

describe('mesa prompt / line limits', () => {
  it('refuses an oversized prompt file', () => {
    const prompt = path.resolve('mesa-prompt.md')
    expect(mesaPromptFileError(prompt, MESA_PROMPT_MAX_BYTES + 1)).toBe('prompt-too-large')
    expect(mesaPromptFileError(prompt, MESA_PROMPT_MAX_BYTES)).toBeNull()
  })

  it('refuses a typed launch line over the shell cap', () => {
    expect(mesaTypedLineError('x'.repeat(MESA_TYPED_LINE_MAX_CHARS + 1))).toBe('launch-line-too-long')
    expect(mesaTypedLineError('grok --help')).toBeNull()
  })
})

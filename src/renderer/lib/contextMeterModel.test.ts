import { describe, expect, it } from 'vitest'
import { contextMeterModel, contextMeterUsage } from './contextMeterModel'

describe('contextMeterModel', () => {
  it('prefers the launch record when present', () => {
    // Trailing a switch: the transcript replays pre-switch rows, so its label can name a model
    // the session no longer runs. The record is what the user clicked.
    expect(contextMeterModel('vllm/GLM-5.2-NVFP4-MTP', 'vllm/GLM-5.3-Flash-NVFP4')).toBe(
      'vllm/GLM-5.3-Flash-NVFP4'
    )
  })

  it('falls back to the transcript when there is no record (hand-launched claude)', () => {
    expect(contextMeterModel('claude-opus-5', undefined)).toBe('claude-opus-5')
    expect(contextMeterModel('claude-opus-5', '')).toBe('claude-opus-5')
  })

  it('falls back when the record is WHITESPACE (an empty record asserts nothing)', () => {
    expect(contextMeterModel('claude-opus-5', '   ')).toBe('claude-opus-5')
  })

  it('passes the record through verbatim (no [1m] normalization at DISPLAY time)', () => {
    // The supervisor already normalizes [1m] where a comparison needs it; the display shows what
    // the CLI was launched with.
    expect(contextMeterModel(null, 'vllm/GLM-5.3-Flash-NVFP4[1m]')).toBe('vllm/GLM-5.3-Flash-NVFP4[1m]')
  })

  it('returns null when neither source has a model', () => {
    expect(contextMeterModel(null, undefined)).toBe(null)
    expect(contextMeterModel(null, '   ')).toBe(null)
  })
})

describe('contextMeterUsage', () => {
  it('uses the launch window immediately while the transcript still names the old window', () => {
    expect(contextMeterUsage(100_000, 1_000_000, 400_000)).toEqual({
      windowTokens: 400_000,
      usedPercent: 25
    })
  })

  it('falls back to the transcript window for agents Nodeterm did not launch', () => {
    expect(contextMeterUsage(100_000, 1_000_000)).toEqual({
      windowTokens: 1_000_000,
      usedPercent: 10
    })
    expect(contextMeterUsage(100_000, 1_000_000, Number.NaN)).toEqual({
      windowTokens: 1_000_000,
      usedPercent: 10
    })
    expect(contextMeterUsage(100_000, 1_000_000, 0)).toEqual({
      windowTokens: 1_000_000,
      usedPercent: 10
    })
  })

  it('clamps fill when the recorded usage exceeds the new model window', () => {
    expect(contextMeterUsage(450_000, 1_000_000, 400_000)).toEqual({
      windowTokens: 400_000,
      usedPercent: 100
    })
  })
})

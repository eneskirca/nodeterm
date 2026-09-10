import { describe, expect, it } from 'vitest'
import { formatTalkPayload } from './talkMessage'

describe('formatTalkPayload', () => {
  it('names the sender by callsign for an agent, as a prompt', () => {
    const text = formatTalkPayload({
      fromCallsign: 'A',
      fromTitle: 'UI',
      body: 'please review this',
      forAgent: true
    })
    expect(text).toContain('terminal A · UI')
    expect(text).toContain('please review this')
    expect(text.startsWith('[Mesa · mensaje manual del usuario]')).toBe(true)
  })

  it('names both ends so a human message cannot impersonate the orchestrator', () => {
    const text = formatTalkPayload({
      fromCallsign: 'A',
      fromTitle: 'UI',
      toCallsign: 'B',
      toTitle: 'API',
      body: 'please review this',
      forAgent: true
    })
    expect(text).toContain('terminal A · UI → terminal B · API')
  })

  it('is a shell comment for a plain terminal, so it does not run', () => {
    const text = formatTalkPayload({
      fromCallsign: 'B',
      fromTitle: 'logs',
      body: 'rm -rf /\necho hi',
      forAgent: false
    })
    expect(text.startsWith('# [B · logs]')).toBe(true)
    expect(text).not.toContain('\n')
  })
})

import { describe, expect, it } from 'vitest'
import { parseRemoteControl, remoteControlHandler } from './remote-control-scan'

const on = JSON.stringify({
  type: 'system',
  subtype: 'bridge_status',
  content: '/remote-control is active · Continue here, on your phone, or at https://claude.ai/code/session_x',
  url: 'https://claude.ai/code/session_x'
})
const off = JSON.stringify({
  type: 'system',
  subtype: 'local_command',
  content: '<local-command-stdout>Remote Control disconnected.</local-command-stdout>',
  commandRun: { command: 'remote-control', args: '' }
})
// MEASURED on 2.1.325: what `/remote-control` writes when its dialog is dismissed.
const dismissed = JSON.stringify({
  type: 'system',
  subtype: 'local_command',
  content: '<local-command-stdout></local-command-stdout>',
  commandRun: { command: 'remote-control', args: '' }
})

describe('parseRemoteControl', () => {
  it('reads a connect as on and a disconnect as off', () => {
    expect(parseRemoteControl([on])).toBe(true)
    expect(parseRemoteControl([off])).toBe(false)
  })

  it('lets the latest record win', () => {
    expect(parseRemoteControl([on, off])).toBe(false)
    expect(parseRemoteControl([off, on])).toBe(true)
    expect(parseRemoteControl([on, off, on].join('\n'))).toBe(true)
  })

  it('says nothing when no record matches', () => {
    expect(parseRemoteControl([])).toBeNull()
    expect(parseRemoteControl([dismissed])).toBeNull()
    expect(parseRemoteControl(['{"type":"user","message":{"content":"hi"}}'])).toBeNull()
  })

  it('never reads the words out of conversation text', () => {
    // A user or assistant message that merely MENTIONS either marker is not a state change.
    const chatter = [
      JSON.stringify({ type: 'user', message: { content: 'what does bridge_status mean?' } }),
      JSON.stringify({ type: 'assistant', message: { content: 'Remote Control disconnected.' } }),
      JSON.stringify({ type: 'system', subtype: 'informational', content: 'Remote Control disconnected.' })
    ]
    expect(parseRemoteControl(chatter)).toBeNull()
    expect(parseRemoteControl([on, ...chatter])).toBe(true)
  })

  it('skips torn and malformed lines', () => {
    expect(parseRemoteControl([on.slice(0, 40), '', 'not json bridge_status'])).toBeNull()
    expect(parseRemoteControl([on, off.slice(0, 50)])).toBe(true)
  })
})

describe('remoteControlHandler', () => {
  it('maps the session back to its node', () => {
    const seen: unknown[] = []
    const handler = remoteControlHandler(new Map([['n1', 's1'], ['n2', 's2']]), (u) => seen.push(u))
    handler('s2', true)
    handler('unknown', true)
    expect(seen).toEqual([{ nodeId: 'n2', sessionId: 's2', on: true }])
  })
})

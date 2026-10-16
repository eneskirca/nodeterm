// Source pins for the relay-only-host parity wiring in the desktop shell: each seam is unit-tested
// where it lives (core / host-service / host-chat), and these pin that main actually connects them —
// a dependency left unwired answers "not served" forever and every unit test stays green.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const read = (rel: string): string => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n')

describe('relay-only-host parity is wired in the desktop shell', () => {
  const src = read('main/index.ts')
  it('the mirror tells the phone which platform it is talking to', () => {
    expect(src).toMatch(/hostPlatform: process\.platform\n/)
  })
  it('core gets the host-authoritative launch context', () => {
    expect(src).toMatch(/ptyManager\.setRelayLaunchContext\(\(\) => \{/)
  })
  it('agent.key is guarded on the mirror and typed through PtyManager', () => {
    expect(src).toMatch(/agentState: nodeState,\n\s*openAsk: openAskFor,\n\s*sendKeys: \(nodeId, keys\) => ptyManager\.sendKeys\(nodeId, keys\),/)
  })
  it('inbox.ack runs the ack sweeper’s own handler pair', () => {
    expect(src).toMatch(/inboxAck: \(nodeId: string\) => applyPhoneReadAck\(nodeId, phoneReadAckHandlers\)/)
    expect(src).toMatch(/createAckSweeper\(\{ handlers: phoneReadAckHandlers \}\)/)
  })
  it('both phone hosts forward the extras into their sessions', () => {
    expect(read('main/remote/host-service.ts')).toMatch(/relayExtras: bridge\.relayExtras,/)
    expect(read('main/remote/standing-host.ts')).toMatch(/relayExtras: bridge\.relayExtras,/)
  })
})

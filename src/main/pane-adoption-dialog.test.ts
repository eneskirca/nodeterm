import { describe, expect, it } from 'vitest'
import { paneAdoptionDialogOptions } from './pane-adoption-dialog'
import type { LocalPaneIdentity } from '../shared/agents/pane-adoption'
describe('native human confirmation options', () => {
  it('defaults to cancel, identifies exactly one snapshot and never waives the native decision', () => {
    const identity: LocalPaneIdentity = { backend: 'local-session-host-linux', nodeId: 'n1', projectId: 'private-p1', projectCwd: '/synthetic/project',
      bootId: '11111111-1111-4111-8111-111111111111', host: { pid: 10, birth: '100' }, pane: { pid: 20, birth: '200' }, foreground: [{ pid: 30, birth: '300' }], generation: 'generation-a', agentId: 'codex', providerSessionId: 'session-a' }
    const options = paneAdoptionDialogOptions(identity)
    expect(options.buttons).toEqual(['Cancel', 'Authorize this session'])
    expect(options.defaultId).toBe(0); expect(options.cancelId).toBe(0); expect(options.noLink).toBe(true)
    for (const value of ['n1', 'private-p1', '/synthetic/project', 'session-a', '10 / 100', '20 / 200', '30 / 300', 'generation-a']) expect(options.detail).toContain(value)
    expect(options.detail).toContain('does not start work')
    expect(options.detail).toContain('historical held mail')
    const unusual = paneAdoptionDialogOptions({ ...identity, projectCwd: '/synthetic/\u202eproject', providerSessionId: 'session\u2028injected' })
    expect(unusual.detail).toContain('\\u202e')
    expect(unusual.detail).toContain('\\u2028')
    expect(unusual.detail).not.toContain('\u202e')
  })
})

import { describe, expect, it } from 'vitest'
import { checkMasterArgs, childArgs, masterArgs, sshDestination } from './control-master'

/**
 * SECURITY: the `user@host` destination is one argv element, and ssh parses an element starting
 * with `-` as an OPTION — `-oProxyCommand=<cmd>@host` runs `<cmd>` on THIS machine. The endpoint
 * can come from a hand-edited project file or another machine, so the leaf refuses it.
 */
describe('sshDestination', () => {
  it('builds user@host for an ordinary endpoint', () => {
    expect(sshDestination({ user: 'corvin', host: 'devbox.example' })).toBe('corvin@devbox.example')
    expect(sshDestination({ user: 'deploy', host: '10.0.0.7' })).toBe('deploy@10.0.0.7')
  })

  it('refuses a user or host that ssh would read as an option', () => {
    expect(() => sshDestination({ user: '-oProxyCommand=touch /tmp/x', host: 'h' })).toThrow(/refusing ssh user/)
    expect(() => sshDestination({ user: 'u', host: '-oProxyCommand=x' })).toThrow(/refusing ssh host/)
  })

  it('refuses whitespace and control characters', () => {
    expect(() => sshDestination({ user: 'a b', host: 'h' })).toThrow()
    expect(() => sshDestination({ user: 'u', host: 'h\nx' })).toThrow()
    expect(() => sshDestination({ user: 'u', host: 'h\u0000' })).toThrow()
    expect(() => sshDestination({ user: 'u', host: '' })).toThrow()
  })

  it('every argv builder goes through it', () => {
    const bad = { user: '-oProxyCommand=x', host: 'h' }
    expect(() => masterArgs(bad, '/cp')).toThrow(/refusing/)
    expect(() => childArgs(bad, '/cp', 'true')).toThrow(/refusing/)
    expect(() => checkMasterArgs(bad, '/cp')).toThrow(/refusing/)
  })
})

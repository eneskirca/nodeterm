import { describe, it, expect } from 'vitest'
import {
  WINDOWS_OPENSSH_AGENT_PIPE,
  findPageantPipe,
  pickWindowsAgent,
  resolveWindowsIdentityAgent
} from './windows-agent-discovery'

const PAGEANT = 'pageant.Dev.3f9a1c0b2e'

describe('pickWindowsAgent', () => {
  it('prefers the OpenSSH agent service', () => {
    expect(pickWindowsAgent({ pipes: [PAGEANT, 'openssh-ssh-agent'], user: 'dev' })).toBe(WINDOWS_OPENSSH_AGENT_PIPE)
  })
  it('falls back to the user\'s Pageant pipe (user matched case-insensitively)', () => {
    expect(pickWindowsAgent({ pipes: ['pageant.other.aa', PAGEANT], user: 'dev' })).toBe(`\\\\.\\pipe\\${PAGEANT}`)
  })
  it('another user\'s Pageant is not ours; no agent pipe at all is undefined', () => {
    expect(pickWindowsAgent({ pipes: ['pageant.other.aa'], user: 'dev' })).toBeUndefined()
    expect(pickWindowsAgent({ pipes: ['some-other-pipe'], user: 'dev' })).toBeUndefined()
    expect(pickWindowsAgent({ pipes: [] })).toBeUndefined()
  })
  it('a user name with dots still matches', () => {
    expect(findPageantPipe(['pageant.first.last.abc123'], 'First.Last')).toBe('\\\\.\\pipe\\pageant.first.last.abc123')
  })
})

describe('resolveWindowsIdentityAgent', () => {
  it('maps `IdentityAgent pageant` (any case) to the discovered pipe', () => {
    expect(resolveWindowsIdentityAgent('pageant', [PAGEANT], 'dev')).toEqual({ agent: `\\\\.\\pipe\\${PAGEANT}` })
    expect(resolveWindowsIdentityAgent('PAGEANT', [PAGEANT], 'dev')).toEqual({ agent: `\\\\.\\pipe\\${PAGEANT}` })
  })
  it('never hands back the bare string when there is no pipe (ssh2 would spawn pagent.exe)', () => {
    expect(resolveWindowsIdentityAgent('pageant', ['openssh-ssh-agent'], 'dev')).toEqual({ agent: undefined, missing: true })
  })
  it('passes every other value through', () => {
    expect(resolveWindowsIdentityAgent('none', [PAGEANT], 'dev')).toEqual({ agent: 'none' })
    expect(resolveWindowsIdentityAgent(undefined, [PAGEANT], 'dev')).toEqual({ agent: undefined })
    expect(resolveWindowsIdentityAgent('\\\\.\\pipe\\x', [], 'dev')).toEqual({ agent: '\\\\.\\pipe\\x' })
  })
})

import { describe, expect, it } from 'vitest'
import { cmdShimPathFor, shimCommand, shimDialectFor, shimFence, windowsShimNoteLines } from './shim-invocation'
import { setCustomAgentBaseResolver } from './config'

describe('shimDialectFor', () => {
  it('only a win32 host changes anything', () => {
    for (const host of ['darwin', 'linux', undefined, null, 'freebsd']) {
      for (const agent of ['claude', 'codex', 'gemini', 'grok', 'copilot', 'opencode', undefined]) {
        expect(shimDialectFor(agent, host), `${agent}@${host}`).toBe('posix')
      }
    }
  })

  it('win32: claude stays POSIX (Git Bash), every other agent runs the .cmd launcher', () => {
    expect(shimDialectFor('claude', 'win32')).toBe('posix')
    for (const agent of ['codex', 'gemini', 'grok', 'copilot', 'opencode', 'my-custom', undefined]) {
      expect(shimDialectFor(agent, 'win32'), String(agent)).toBe('windows-cmd')
    }
  })

  it('a custom agent inherits its base harness\'s tool shell', () => {
    setCustomAgentBaseResolver((id) => (id === 'my-claude' ? 'claude' : undefined))
    try {
      expect(shimDialectFor('my-claude', 'win32')).toBe('posix')
    } finally {
      setCustomAgentBaseResolver(null)
    }
  })
})

describe('shim invocation strings', () => {
  it('posix is the historical `sh "<path>"`', () => {
    expect(shimCommand('/u/nodeterm.sh')).toBe('sh "/u/nodeterm.sh"')
    expect(shimCommand('/u/nodeterm.sh', 'posix')).toBe('sh "/u/nodeterm.sh"')
    expect(shimFence()).toBe('sh')
    expect(windowsShimNoteLines('/u/nodeterm.sh', 'posix')).toEqual([])
  })

  it('windows-cmd calls the .cmd beside the shim with PowerShell\'s call operator', () => {
    expect(cmdShimPathFor('C:\\d\\nodeterm.sh')).toBe('C:\\d\\nodeterm.cmd')
    expect(cmdShimPathFor('context.sh')).toBe('context.cmd')
    expect(shimCommand('C:\\d\\context.sh', 'windows-cmd')).toBe('& "C:\\d\\context.cmd"')
    expect(shimFence('windows-cmd')).toBe('powershell')
    expect(windowsShimNoteLines('C:\\d\\context.sh', 'windows-cmd').join(' ')).toContain('Git for Windows')
  })
})

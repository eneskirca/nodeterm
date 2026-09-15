import { describe, expect, it } from 'vitest'
import { opencodeExportCommand } from './opencode-export'

describe('OpenCode export launcher', () => {
  it('uses the executable directly on POSIX and a Windows shell for npm shims', () => {
    expect(opencodeExportCommand('ses_abc123', 'linux')).toEqual({ file: 'opencode', args: ['export', 'ses_abc123'] })
    const call = opencodeExportCommand('ses_abc123', 'win32')!
    expect(call.file).toMatch(/(?:pwsh(?:\.exe)?|powershell\.exe)$/i)
    expect(call.args).toContain('-NoProfile')
    expect(call.args.at(-1)).toContain("& opencode export 'ses_abc123'")
  })
  it.each(["x'; evil", '-x', '', 'x\ncmd', 'x\0cmd'])('refuses unsafe session identifiers: %j', (id) => {
    // Leading dashes are not session IDs and must never become CLI options.
    expect(opencodeExportCommand(id, 'win32')).toBeNull()
  })
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const manager = readFileSync(join(__dirname, 'pty-manager.ts'), 'utf8')

describe('Windows persistent-session integration', () => {
  it('always routes Windows sessions to the packaged session host', () => {
    expect(manager).toMatch(
      /if \(os\.platform\(\) === 'win32'\) \{[\s\S]{0,500}?return null\s*\}/
    )
    expect(manager).toContain("sessionHostSupported() ? 'session-host' : null")
  })

  it('prepends the Codex launcher onto the PATH key the environment already uses', () => {
    expect(manager).toContain('const pathKey = envPathKey(env)')
    expect(manager).not.toContain("env.PATH ?? env.Path")
  })
})

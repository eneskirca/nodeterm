// Guard for the run-wide HOME sandbox (src/core/test-home.ts): a hook installer run anywhere in the
// suite must land in the sandbox, never in the developer's real home.
//
// The real home is read from the account database (`os.userInfo().homedir` — getpwuid on POSIX,
// the user profile on Windows), which ignores HOME/USERPROFILE. That is the directory a broken
// sandbox would let `installCodexHooks()` write into, and it is what this test watches.
import { execFileSync } from 'child_process'
import fs from 'fs'
import os, { homedir } from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { HOME_SANDBOX_ENV } from './test-home'
import { installCodexHooks } from './agents/hooks/codex'

const sandbox = process.env[HOME_SANDBOX_ENV] as string

function stamp(file: string): string {
  try {
    const st = fs.statSync(file)
    return `${st.size}:${st.mtimeMs}`
  } catch {
    return 'absent'
  }
}

describe('HOME sandbox', () => {
  it('os.homedir() resolves inside the sandbox — through the namespace AND a named import', () => {
    expect(sandbox).toBeTruthy()
    expect(os.homedir()).toBe(sandbox)
    // codex.ts and friends use the named import; a `vi.spyOn(os, 'homedir')` never reached it.
    expect(homedir()).toBe(sandbox)
    expect(path.resolve(os.userInfo().homedir)).not.toBe(path.resolve(sandbox))
  })

  it('a child process inherits it', () => {
    const out = execFileSync(process.execPath, ['-e', "process.stdout.write(require('os').homedir())"], {
      encoding: 'utf8'
    })
    expect(out).toBe(sandbox)
  })

  it('the real codex installer writes the sandbox and leaves the real ~/.codex untouched', () => {
    const realCodex = path.join(os.userInfo().homedir, '.codex')
    const before = ['config.toml', 'hooks.json'].map((f) => stamp(path.join(realCodex, f)))
    installCodexHooks()
    expect(fs.existsSync(path.join(sandbox, '.codex', 'hooks.json'))).toBe(true)
    expect(fs.readFileSync(path.join(sandbox, '.codex', 'config.toml'), 'utf8')).toContain(
      'trusted_hash'
    )
    const after = ['config.toml', 'hooks.json'].map((f) => stamp(path.join(realCodex, f)))
    expect(after).toEqual(before)
  })
})

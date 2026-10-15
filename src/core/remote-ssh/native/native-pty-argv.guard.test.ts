// Source-level pin: the argv a NATIVE ssh pty channel executes on the host comes only from the
// remote-tmux builders. pty-manager's `args` is shared by every spawn branch (the local tmux `-e
// PATH=…` list, the zellij client's shell, the session-host's), so handing that shared variable to
// NativeSshPty let local, environment-derived argv flow — on paper — into the REMOTE command a
// channel runs (CodeQL js/indirect-command-line-injection). A dedicated variable, written by the two
// remote-ssh branches alone, is what states the real invariant; this keeps a refactor from folding
// it back into `args`. Same discipline as hook-verified-parity.test.ts.
import { readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

const src = readFileSync(path.join(__dirname, '..', '..', 'pty-manager.ts'), 'utf8')

describe('pty-manager: the native ssh pty argv', () => {
  it('constructs NativeSshPty only from nativeSshArgv', () => {
    const ctors = [...src.matchAll(/new NativeSshPty\(([^,]+),\s*([^,]+),/g)]
    expect(ctors.length).toBeGreaterThan(0)
    for (const m of ctors) expect(m[2].trim()).toBe('nativeSshArgv')
  })

  it('assigns nativeSshArgv only from the remote-tmux builders', () => {
    const writes = [...src.matchAll(/\bnativeSshArgv\s*=(?!=)\s*([A-Za-z_][\w]*)/g)].map((m) => m[1])
    expect(writes.length).toBeGreaterThan(0)
    for (const w of writes) expect(['null', 'remoteTmuxWatcherArgs', 'remoteTmuxPtyArgs']).toContain(w)
  })
})

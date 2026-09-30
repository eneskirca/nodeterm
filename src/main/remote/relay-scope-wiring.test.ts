// The desktop shell must hand the relay host its scoped-guest policy deps. Without them a
// project-scoped invite throws at connect (fail closed) — correct, but it would mean Team Access
// sharing one project stopped working. Pinned at source level because index.ts is not importable.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

describe('initRelayHost wiring', () => {
  it('passes the scope deps from this core\'s own records', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../index.ts'), 'utf8').replace(/\r\n/g, '\n')
    const at = src.indexOf('initRelayHost(win, corePlatform, {')
    expect(at).toBeGreaterThan(0)
    const call = src.slice(at, src.indexOf('\n  })', at))
    for (const needle of ['scope:', 'workspaceStore.projectIdsForNode', 'ptyManager.nodeOfSession', 'workspaceStore.localCwdForProject', "app.getPath('userData')"]) {
      expect(call, needle).toContain(needle)
    }
  })
})

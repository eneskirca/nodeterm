// Every Codex line TerminalNode builds (cold restore, its fresh fallback, restart, wake) must AWAIT
// the bounded caps and say when it is a relay tab. A synchronous read races the probe exactly when
// every node cold-restores at once after a reboot — the first node then launches without
// `--no-daemon` and starts Codex's shared daemon with its own env — and a relay tab would type the
// GUEST's answer into the HOST's pane. Both compile fine, hence a source-level pin.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const src = fs.readFileSync(path.join(__dirname, 'TerminalNode.tsx'), 'utf8').replace(/\r\n/g, '\n')

describe('TerminalNode codex launch caps', () => {
  it('never reads the caps synchronously', () => {
    expect(src).not.toMatch(/codexApprovalCaps\(/)
  })

  it('awaits the bounded caps at every launch site, relay flag included', () => {
    const sites = src.match(/await ensureCodexLaunchCaps\(\s*capabilityAgentId\(\w+\),\s*data\.ssh \|\| data\.sshRemoteTmux \|\| session\.source === 'relay'\s*\)/g) ?? []
    expect(sites.length).toBe(4)
  })
})

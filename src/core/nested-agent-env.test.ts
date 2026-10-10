import { describe, expect, it } from 'vitest'
import { NESTED_AGENT_ENV_STRIP } from './nested-agent-env'
import { ACCOUNT_SCOPE_UPDATE_ENV } from './pty-manager'

describe('NESTED_AGENT_ENV_STRIP', () => {
  it('carries the marker that actually turned transcript saving off', () => {
    // The measured culprit (see the module docblock). Losing this entry restores the bug in full.
    expect(NESTED_AGENT_ENV_STRIP).toContain('CLAUDE_CODE_CHILD_SESSION')
  })

  it('never strips a variable this app SETS to bind an account', () => {
    // The whole reason this is an explicit list and not a `CLAUDE*` / `CODEX*` prefix sweep: these
    // are how a managed-account node selects its config dir. Sweeping them would silently run every
    // managed-account session as the system account — a much worse bug than the one being fixed.
    for (const kept of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'NODETERM_CODEX_ACCOUNT_ID']) {
      expect(NESTED_AGENT_ENV_STRIP).not.toContain(kept)
    }
  })

  it('is also listed for tmux update-environment, or a seeded server re-adds them', () => {
    // The #419 rule: a shared tmux server inherits the env of the client that starts it, so a
    // per-client delete alone does not reach sessions created later through that server.
    for (const name of NESTED_AGENT_ENV_STRIP) {
      expect(ACCOUNT_SCOPE_UPDATE_ENV).toContain(name)
    }
  })
})

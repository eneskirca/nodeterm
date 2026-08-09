import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DEFAULT_SETTINGS, UNKNOWN_CLAUDE_CLI_CAPS, type ClaudeCliCaps } from '@shared/types'
import type { SshConnection } from '@shared/ssh'
import { useProjects } from './projects'
import { useSettings } from './settings'
import { useSshConn } from './sshConn'
import {
  activePermissionMode,
  ensureActivePermissionMode,
  ensureClaudeCliCaps,
  resetClaudeCliCapsForTests,
  sshAutoModeHint,
  SSH_AUTO_PROBE_WAIT_MS
} from './permissionMode'

/** Stand in for the preload/bridge `claude.cliCaps()` probe. */
function mockCliCaps(caps: ClaudeCliCaps | Error): ReturnType<typeof vi.fn> {
  const fn = vi.fn(() => (caps instanceof Error ? Promise.reject(caps) : Promise.resolve(caps)))
  ;(globalThis as { window?: unknown }).window = { nodeTerminal: { claude: { cliCaps: fn } } }
  return fn
}

const MODERN: ClaudeCliCaps = { version: '2.1.207 (Claude Code)', autoPermissionMode: true, fullscreenTui: true }
const OLD: ClaudeCliCaps = { version: '2.1.50 (Claude Code)', autoPermissionMode: false, fullscreenTui: false }

const SSH_SERVER = { id: 's1', label: 'box', host: 'box', user: 'me' } as unknown as SshConnection

beforeEach(() => {
  useProjects.getState().hydrate({ version: 2, activeProjectId: '', projects: [] })
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS }, hydrated: false })
  useSshConn.setState({ byProject: {}, autoPermByProject: {}, remoteClaudeVersionByProject: {} })
  resetClaudeCliCapsForTests()
  mockCliCaps(MODERN)
})

/** Adds a project and makes it active. */
function activeProject(name = 'p', ssh?: { server: SshConnection; remoteCwd: string }) {
  const p = useProjects.getState().addProject(name, '/tmp/p')
  if (ssh) useProjects.getState().replaceProject({ ...p, ssh })
  useProjects.getState().setActive(p.id)
  return p
}

describe('activePermissionMode', () => {
  it('returns the global setting when the active project has no override', async () => {
    useSettings.setState((s) => ({ settings: { ...s.settings, claudePermissionMode: 'plan' } }))
    activeProject()
    await ensureClaudeCliCaps()

    expect(activePermissionMode()).toBe('plan')
  })

  it("returns the active project's override, not another project's", async () => {
    useSettings.setState((s) => ({ settings: { ...s.settings, claudePermissionMode: 'auto' } }))
    const other = useProjects.getState().addProject('other', '/tmp/other')
    useProjects.getState().setProjectDefaultPermissionMode(other.id, 'bypassPermissions')
    const active = useProjects.getState().addProject('active', '/tmp/active')
    useProjects.getState().setProjectDefaultPermissionMode(active.id, 'acceptEdits')
    useProjects.getState().setActive(active.id)
    await ensureClaudeCliCaps()

    // The bug this test exists to catch: a stray project.find()-style lookup could pick up
    // the wrong project's override (e.g. the first one in the array) instead of the active one.
    expect(activePermissionMode()).toBe('acceptEdits')
    expect(activePermissionMode()).not.toBe('bypassPermissions')
  })

  it('falls back to the global setting when there is no active project', async () => {
    useSettings.setState((s) => ({ settings: { ...s.settings, claudePermissionMode: 'manual' } }))
    useProjects.getState().addProject('solo', '/tmp/solo')
    useProjects.getState().setActive('nonexistent-id')
    await ensureClaudeCliCaps()

    expect(activePermissionMode()).toBe('manual')
  })
})

// The whole point of the version gate: `auto` is our DEFAULT, and a Claude CLI < 2.1.71 exits 1
// on `--permission-mode auto`. Degrading to `manual` (= no flag) keeps every launch working.
describe('activePermissionMode — the `auto` version gate', () => {
  it('keeps auto when the local CLI is new enough', async () => {
    mockCliCaps(MODERN)
    activeProject()
    await ensureClaudeCliCaps()

    expect(activePermissionMode()).toBe('auto')
  })

  it('degrades auto to manual (bare command) when the local CLI is too old', async () => {
    mockCliCaps(OLD)
    activeProject()
    await ensureClaudeCliCaps()

    expect(activePermissionMode()).toBe('manual')
  })

  it('degrades auto to manual before the probe has answered (conservative)', () => {
    mockCliCaps(MODERN)
    activeProject()
    // Deliberately NOT awaiting ensureClaudeCliCaps: an unknown version means no flag.
    expect(activePermissionMode()).toBe('manual')
  })

  it('degrades auto to manual when the probe rejects', async () => {
    mockCliCaps(new Error('spawn ENOENT'))
    activeProject()
    await ensureClaudeCliCaps()

    expect(activePermissionMode()).toBe('manual')
  })

  it('never touches the other four modes, even with an old CLI', async () => {
    mockCliCaps(OLD)
    const p = activeProject()
    await ensureClaudeCliCaps()

    for (const mode of ['manual', 'acceptEdits', 'plan', 'bypassPermissions'] as const) {
      useProjects.getState().setProjectDefaultPermissionMode(p.id, mode)
      expect(activePermissionMode()).toBe(mode)
    }
  })

  it('probes once and caches (the CLI version does not change under a running app)', async () => {
    const fn = mockCliCaps(MODERN)
    activeProject()
    await Promise.all([ensureClaudeCliCaps(), ensureClaudeCliCaps()])
    await ensureClaudeCliCaps()

    expect(fn).toHaveBeenCalledTimes(1)
  })
})

// The gate exists because Claude Code < 2.1.71 EXITS 1 on `--permission-mode auto`, and it is fed
// by a `claude --version` probe. grok has accepted `auto` since 1.0.0, its first release, so gating
// it on a claude probe would launch grok sessions in `default` (ask each time) on any machine whose
// claude is old — or absent — silently, and for a reason that has nothing to do with grok.
describe("activePermissionMode — the auto gate is CLAUDE's, not every agent's", () => {
  it('keeps `auto` for grok even when the local claude CLI is old or missing', () => {
    useSettings.setState((s) => ({ settings: { ...s.settings, claudePermissionMode: 'auto' } }))
    activeProject()
    resetClaudeCliCapsForTests(UNKNOWN_CLAUDE_CLI_CAPS) // no claude on this machine

    expect(activePermissionMode('grok')).toBe('auto')
    expect(activePermissionMode('claude')).toBe('manual')
    expect(activePermissionMode()).toBe('manual') // default argument = claude = unchanged behavior
  })

  it('still honors the project override and the global setting for grok', () => {
    useSettings.setState((s) => ({ settings: { ...s.settings, claudePermissionMode: 'auto' } }))
    const p = activeProject()
    useProjects.getState().setProjectDefaultPermissionMode(p.id, 'plan')

    expect(activePermissionMode('grok')).toBe('plan')
  })

  it('ensureActivePermissionMode does not wait on EITHER probe for a non-claude agent', async () => {
    vi.useFakeTimers()
    try {
      // BOTH halves of "does not wait" have to be enforced, and each needs its own trap:
      //  - the LOCAL probe: pointed at the never-resolving stub, so awaiting `ensureClaudeCliCaps()`
      //    can only be escaped by its 3s timeout — which the assertion below does not allow. A
      //    resolving mock would let a wrongly-placed await pass, because it settles in microtasks
      //    that `advanceTimersByTimeAsync(0)` flushes. In the Server Edition this await is a real
      //    WS-RPC round trip on every launch, so "it resolves eventually" is not good enough.
      //  - the REMOTE probe: an SSH project whose answer never arrives, so awaiting it costs
      //    SSH_AUTO_PROBE_WAIT_MS.
      // Neither timer may be needed: `advanceTimersByTimeAsync(0)` runs no timer at all.
      ;(globalThis as { window?: unknown }).window = {
        nodeTerminal: { claude: { cliCaps: () => new Promise<never>(() => {}) } }
      }
      resetClaudeCliCapsForTests()
      useSettings.setState((s) => ({ settings: { ...s.settings, claudePermissionMode: 'auto' } }))
      activeProject('remote', { server: SSH_SERVER, remoteCwd: '/srv/app' })

      const pending = ensureActivePermissionMode('grok')
      await vi.advanceTimersByTimeAsync(0)

      await expect(pending).resolves.toBe('auto')
    } finally {
      vi.useRealTimers()
    }
  })
})

// An SSH project's terminals run on the REMOTE host, whose claude CLI can be older than the local
// one. The local probe's answer must never be applied to a remote launch.
describe('activePermissionMode — SSH projects', () => {
  it('ignores the local CLI and uses the remote probe', async () => {
    mockCliCaps(MODERN) // local supports auto…
    const p = activeProject('remote', { server: SSH_SERVER, remoteCwd: '/srv/app' })
    await ensureClaudeCliCaps()
    // …but the remote does not.
    useSshConn.getState().setConn(p.id, { controlPath: '/tmp/cm', claudeAutoPermissionMode: false })

    expect(activePermissionMode()).toBe('manual')
  })

  it('keeps auto when the REMOTE host is known to support it', async () => {
    mockCliCaps(OLD) // local is old — irrelevant for a remote launch
    const p = activeProject('remote', { server: SSH_SERVER, remoteCwd: '/srv/app' })
    await ensureClaudeCliCaps()
    useSshConn.getState().setConn(p.id, { controlPath: '/tmp/cm', claudeAutoPermissionMode: true })

    expect(activePermissionMode()).toBe('auto')
  })

  it('omits auto while the project is not connected / not yet probed', async () => {
    mockCliCaps(MODERN)
    activeProject('remote', { server: SSH_SERVER, remoteCwd: '/srv/app' })
    await ensureClaudeCliCaps()
    // No sshConn entry at all: unknown remote version ⇒ bare command.
    expect(activePermissionMode()).toBe('manual')
  })

  it('still honors an explicitly chosen non-auto mode on an unprobed remote', async () => {
    mockCliCaps(MODERN)
    const p = activeProject('remote', { server: SSH_SERVER, remoteCwd: '/srv/app' })
    useProjects.getState().setProjectDefaultPermissionMode(p.id, 'plan')
    await ensureClaudeCliCaps()

    expect(activePermissionMode()).toBe('plan')
  })
})

describe('ensureActivePermissionMode', () => {
  it('awaits the probe, so a launch right after boot still gets auto', async () => {
    mockCliCaps(MODERN)
    activeProject()

    // Without the await this would be 'manual' (see the conservative case above).
    await expect(ensureActivePermissionMode()).resolves.toBe('auto')
  })

  it('resolves to the fail-open mode when the probe is unavailable', async () => {
    ;(globalThis as { window?: unknown }).window = {}
    resetClaudeCliCapsForTests()
    activeProject()

    await expect(ensureActivePermissionMode()).resolves.toBe('manual')
    expect(await ensureClaudeCliCaps()).toEqual(UNKNOWN_CLAUDE_CLI_CAPS)
  })

  it('never hangs on a probe that never answers (Server Edition: WS-RPC has no timeout)', async () => {
    // A dropped socket between send and response leaves the RPC promise unsettled forever. The
    // relaunch awaits this, so it must time out into the fail-open bare command instead.
    vi.useFakeTimers()
    try {
      ;(globalThis as { window?: unknown }).window = {
        nodeTerminal: { claude: { cliCaps: () => new Promise<never>(() => {}) } }
      }
      resetClaudeCliCapsForTests()
      activeProject()

      const pending = ensureActivePermissionMode()
      await vi.advanceTimersByTimeAsync(3000)
      await expect(pending).resolves.toBe('manual')
    } finally {
      vi.useRealTimers()
    }
  })
})

// A cold-restore relaunch on an SSH project fires on mount, seconds before the REMOTE probe's
// login shell answers. Without a bounded wait, every relaunch after a server reboot silently
// dropped `auto` — the exact "the setting does nothing on SSH" report this exists to fix.
describe('ensureActivePermissionMode — SSH projects wait for the remote probe', () => {
  it('waits for the remote answer, so a relaunch racing the probe still gets auto', async () => {
    mockCliCaps(OLD) // the LOCAL CLI is irrelevant for a remote launch
    const p = activeProject('remote', { server: SSH_SERVER, remoteCwd: '/srv/app' })

    const pending = ensureActivePermissionMode()
    // The probe answer lands ASYNCHRONOUSLY, after the relaunch already started waiting — the
    // exact cold-restore race (mount beats the remote login-shell probe by seconds).
    setTimeout(
      () => useSshConn.getState().setClaudeAutoPermissionMode(p.id, true, '2.1.90 (Claude Code)'),
      25
    )

    await expect(pending).resolves.toBe('auto')
  })

  it('resolves without waiting when the probe already answered', async () => {
    vi.useFakeTimers()
    try {
      mockCliCaps(MODERN)
      const p = activeProject('remote', { server: SSH_SERVER, remoteCwd: '/srv/app' })
      useSshConn.getState().setClaudeAutoPermissionMode(p.id, false, null)

      const pending = ensureActivePermissionMode()
      await vi.advanceTimersByTimeAsync(0) // no timer must be needed

      await expect(pending).resolves.toBe('manual') // probed 'no' ⇒ bare command
    } finally {
      vi.useRealTimers()
    }
  })

  it('times out into the bare command when no probe answer ever arrives', async () => {
    vi.useFakeTimers()
    try {
      mockCliCaps(MODERN)
      activeProject('remote', { server: SSH_SERVER, remoteCwd: '/srv/app' })

      const pending = ensureActivePermissionMode()
      await vi.advanceTimersByTimeAsync(SSH_AUTO_PROBE_WAIT_MS)

      await expect(pending).resolves.toBe('manual')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not wait at all when the resolved mode is not auto', async () => {
    vi.useFakeTimers()
    try {
      mockCliCaps(MODERN)
      const p = activeProject('remote', { server: SSH_SERVER, remoteCwd: '/srv/app' })
      useProjects.getState().setProjectDefaultPermissionMode(p.id, 'plan')

      const pending = ensureActivePermissionMode()
      await vi.advanceTimersByTimeAsync(0)

      await expect(pending).resolves.toBe('plan')
    } finally {
      vi.useRealTimers()
    }
  })
})

// The tab menu's Auto rows surface WHY Auto may not apply on an SSH project — the silent
// degradation was indistinguishable from "the dropdown is broken".
describe('sshAutoModeHint', () => {
  it('no hint once the remote CLI is confirmed to support auto', () => {
    expect(sshAutoModeHint('yes', '2.1.90 (Claude Code)')).toBeNull()
  })

  it('names the too-old remote version and the required minimum', () => {
    const hint = sshAutoModeHint('no', '2.0.30 (Claude Code)')
    expect(hint).toContain('2.0.30')
    expect(hint).toContain('2.1.71')
  })

  it('says claude was not found when the probe failed', () => {
    expect(sshAutoModeHint('no', null)).toMatch(/not found/i)
  })

  it('reads as unverified while the probe has not answered', () => {
    expect(sshAutoModeHint('unknown', undefined)).toMatch(/not verified/i)
  })
})

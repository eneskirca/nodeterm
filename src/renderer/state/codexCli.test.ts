import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  codexApprovalCaps,
  ensureCodexLaunchCaps,
  registerCodexRelayProjectCheck,
  resetCodexCliCapsForTests
} from './codexCli'
import { useSshConn } from './sshConn'

const server = { host: 'box.example', user: 'dev', port: 22 }
const KEY = 'dev@box.example:22'

beforeEach(() => {
  resetCodexCliCapsForTests()
  useSshConn.setState({ codexNoDaemonByHost: {} })
  registerCodexRelayProjectCheck(null)
})
afterEach(() => vi.useRealTimers())

describe('codexApprovalCaps — --no-daemon', () => {
  it("a LOCAL session uses this machine's probe", () => {
    resetCodexCliCapsForTests({ approvalValues: null, noDaemon: true })
    expect(codexApprovalCaps().codexNoDaemon).toBe(true)
    resetCodexCliCapsForTests({ approvalValues: null, noDaemon: false })
    expect(codexApprovalCaps().codexNoDaemon).toBe(false)
  })

  it('a REMOTE session never borrows the local answer', () => {
    resetCodexCliCapsForTests({ approvalValues: null, noDaemon: true })
    expect(codexApprovalCaps(server).codexNoDaemon).toBeNull()
    expect(codexApprovalCaps(true).codexNoDaemon).toBeNull()
  })

  it("a RELAY tab never gets the guest's answer — its pane runs the HOST's codex", () => {
    resetCodexCliCapsForTests({ approvalValues: ['untrusted', 'on-request', 'never'], noDaemon: true })
    registerCodexRelayProjectCheck((id) => id === 'relay-tab')
    const byProject = codexApprovalCaps(undefined, 'relay-tab')
    expect(byProject).toEqual({ codexApprovalValues: null, codexNoDaemon: null })
    // …and a node that says so itself (`session.source === 'relay'`).
    expect(codexApprovalCaps(true).codexNoDaemon).toBeNull()
    // A local project is untouched.
    expect(codexApprovalCaps(undefined, 'local').codexNoDaemon).toBe(true)
  })

  it("a REMOTE session uses ITS host's probe, from a node connection or a project binding", () => {
    useSshConn.getState().setRemoteCodexNoDaemon({ hostKey: KEY, supported: true })
    expect(codexApprovalCaps(server).codexNoDaemon).toBe(true)
    expect(codexApprovalCaps({ server, remoteCwd: '~' }).codexNoDaemon).toBe(true)
    // Another user on the same host is another answer.
    expect(codexApprovalCaps({ ...server, user: 'ops' }).codexNoDaemon).toBeNull()
  })

  it('the PORT is part of the host: two containers on one machine are two binaries', () => {
    useSshConn.getState().setRemoteCodexNoDaemon({ hostKey: 'root@localhost:2222', supported: true })
    useSshConn.getState().setRemoteCodexNoDaemon({ hostKey: 'root@localhost:2223', supported: false })
    expect(codexApprovalCaps({ host: 'localhost', user: 'root', port: 2222 }).codexNoDaemon).toBe(true)
    expect(codexApprovalCaps({ host: 'localhost', user: 'root', port: 2223 }).codexNoDaemon).toBeNull()
    // No port = ssh's default, 22 — never "any port".
    expect(codexApprovalCaps({ host: 'localhost', user: 'root' }).codexNoDaemon).toBeNull()
  })

  it('a host that answered no stays flagless', () => {
    useSshConn.getState().setRemoteCodexNoDaemon({ hostKey: KEY, supported: false })
    expect(codexApprovalCaps(server).codexNoDaemon).toBeNull()
  })

  it('a reused connection carries the answer in its connect result', () => {
    useSshConn.getState().setConn('p1', {
      controlPath: '/tmp/cm',
      remoteCodexNoDaemon: { hostKey: KEY, supported: true }
    })
    expect(codexApprovalCaps(server).codexNoDaemon).toBe(true)
  })
})

// The cold-restore race: every Codex node relaunches in the same tick after a reboot, and the one
// that builds its line before the probe lands starts the shared daemon with its own env.
describe('ensureCodexLaunchCaps — waits (bounded) for the answer before a codex line is built', () => {
  it('an SSH codex launch waits for its host\'s probe and then carries the flag', async () => {
    const pending = ensureCodexLaunchCaps('codex', server, undefined, 5000)
    let settled = false
    void pending.then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    useSshConn.getState().setRemoteCodexNoDaemon({ hostKey: KEY, supported: true })
    expect((await pending).codexNoDaemon).toBe(true)
  })

  it('a host that never answers releases the launch at the bound, flagless (fail open)', async () => {
    vi.useFakeTimers()
    const pending = ensureCodexLaunchCaps('codex', server, undefined, 3000)
    await vi.advanceTimersByTimeAsync(3000)
    expect((await pending).codexNoDaemon).toBeNull()
  })

  it('never waits for a non-codex agent, nor for a relay tab', async () => {
    registerCodexRelayProjectCheck((id) => id === 'relay-tab')
    vi.useFakeTimers()
    let done = 0
    void ensureCodexLaunchCaps('claude', server).then(() => done++)
    void ensureCodexLaunchCaps('codex', undefined, 'relay-tab').then(() => done++)
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(2)
  })

  it('a local codex launch reads the landed local probe', async () => {
    resetCodexCliCapsForTests({ approvalValues: null, noDaemon: true })
    expect((await ensureCodexLaunchCaps('codex')).codexNoDaemon).toBe(true)
  })
})

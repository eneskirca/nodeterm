import { describe, it, expect, beforeEach } from 'vitest'
import { useSshConn } from './sshConn'

beforeEach(() => {
  useSshConn.setState({
    byProject: {},
    attachments: {},
    autoPermByProject: {},
    remoteClaudeVersionByProject: {}
  })
})

// If a project's SSH server gets repointed to a DIFFERENT host whose claude CLI is older, the
// previous host's cached `true` must not survive the disconnect — otherwise a Claude node created
// before the new probe lands launches `--permission-mode auto` against a CLI that exits 1 on it
// (dead node). A `disconnected` / `reconnecting` status must drop the cached answer so the window
// degrades to "unknown ⇒ bare command" (fail-open), not stale `true`.
describe('useSshConn — auto-permission-mode cache invalidation on disconnect', () => {
  it('stops reporting auto-supported once invalidated after a disconnected status', () => {
    const s = useSshConn.getState()
    s.setConn('p1', { controlPath: '/tmp/cm', claudeAutoPermissionMode: true })
    expect(s.supportsAutoPermissionMode('p1')).toBe(true)

    s.invalidateAutoPermissionMode('p1')

    expect(useSshConn.getState().supportsAutoPermissionMode('p1')).toBe(false)
  })

  it('stops reporting auto-supported once invalidated after a reconnecting status', () => {
    const s = useSshConn.getState()
    s.setConn('p1', { controlPath: '/tmp/cm', claudeAutoPermissionMode: true })
    expect(s.supportsAutoPermissionMode('p1')).toBe(true)

    // Same invalidation path is used for 'reconnecting' as for 'disconnected' — a repointed host
    // may still be mid-reconnect when a launch happens, and the stale answer must already be gone.
    s.invalidateAutoPermissionMode('p1')

    expect(useSshConn.getState().supportsAutoPermissionMode('p1')).toBe(false)
  })

  it('does not disturb other projects’ cached answers', () => {
    const s = useSshConn.getState()
    s.setConn('p1', { controlPath: '/tmp/cm1', claudeAutoPermissionMode: true })
    s.setConn('p2', { controlPath: '/tmp/cm2', claudeAutoPermissionMode: true })

    s.invalidateAutoPermissionMode('p1')

    expect(useSshConn.getState().supportsAutoPermissionMode('p1')).toBe(false)
    expect(useSshConn.getState().supportsAutoPermissionMode('p2')).toBe(true)
  })

  it('keeps the connection coordinates (controlPath etc.) — only the auto-perm answer is dropped', () => {
    const s = useSshConn.getState()
    s.setConn('p1', { controlPath: '/tmp/cm', claudeAutoPermissionMode: true })

    s.invalidateAutoPermissionMode('p1')

    // Unlike clear() (used on project delete), invalidation must not wipe the live conn info —
    // a reconnect on the same project still needs it until setConn() overwrites it.
    expect(useSshConn.getState().getControlPath('p1')).toBe('/tmp/cm')
  })
})

// The tab menu's Auto hint needs THREE states, not the boolean gate: 'unknown' (not probed yet /
// disconnected) reads differently from 'no' (probed: old CLI or claude missing). The launch gate
// (`supportsAutoPermissionMode`) stays boolean and conservative.
describe('useSshConn — tri-state probe answer + remote version (tab-menu hint)', () => {
  it('answers unknown before any probe, no/yes after, unknown again after invalidation', () => {
    const s = useSshConn.getState()
    expect(s.autoPermAnswer('p1')).toBe('unknown')

    s.setClaudeAutoPermissionMode('p1', false, '2.0.30 (Claude Code)')
    expect(useSshConn.getState().autoPermAnswer('p1')).toBe('no')

    s.setClaudeAutoPermissionMode('p1', true, '2.1.90 (Claude Code)')
    expect(useSshConn.getState().autoPermAnswer('p1')).toBe('yes')

    s.invalidateAutoPermissionMode('p1')
    expect(useSshConn.getState().autoPermAnswer('p1')).toBe('unknown')
  })

  it('records the probed version, including null for "claude not found"', () => {
    const s = useSshConn.getState()
    expect(s.getRemoteClaudeVersion('p1')).toBeUndefined()

    s.setClaudeAutoPermissionMode('p1', false, null)
    expect(useSshConn.getState().getRemoteClaudeVersion('p1')).toBeNull()

    s.setClaudeAutoPermissionMode('p1', true, '2.1.90 (Claude Code)')
    expect(useSshConn.getState().getRemoteClaudeVersion('p1')).toBe('2.1.90 (Claude Code)')
  })

  it('invalidation drops the cached version along with the answer (repointed host)', () => {
    const s = useSshConn.getState()
    s.setClaudeAutoPermissionMode('p1', false, '2.0.30 (Claude Code)')

    s.invalidateAutoPermissionMode('p1')

    expect(useSshConn.getState().getRemoteClaudeVersion('p1')).toBeUndefined()
  })

  it('setConn carries a reused connection’s probe answer + version', () => {
    const s = useSshConn.getState()
    s.setConn('p1', {
      controlPath: '/tmp/cm',
      claudeAutoPermissionMode: true,
      remoteClaudeVersion: '2.1.90 (Claude Code)'
    })

    expect(useSshConn.getState().autoPermAnswer('p1')).toBe('yes')
    expect(useSshConn.getState().getRemoteClaudeVersion('p1')).toBe('2.1.90 (Claude Code)')
  })
})

// A HOST ATTACHMENT — a remote node inside a canvas that is not that endpoint's SSH project — has
// no project row anywhere. The record here is the ONLY way back to the machine, and it is kept in
// its own map (not on the connection) precisely so it survives a connect that never succeeded.
describe('useSshConn — host attachments', () => {
  const ATTACHMENT = {
    conn: { host: 'devbox', user: 'corvin', port: 2222 },
    hostKey: 'corvin@devbox',
    remoteCwd: '/srv/app',
    ownerProjectId: 'local-1'
  }

  it('answers the owning canvas for an attachment scope, and itself for an SSH project', () => {
    const s = useSshConn.getState()
    s.registerAttachment('attached-local-1-deadbeef', ATTACHMENT)
    s.setConn('ssh-project-1', { controlPath: '/tmp/b' })

    expect(useSshConn.getState().ownerProjectId('attached-local-1-deadbeef')).toBe('local-1')
    expect(useSshConn.getState().ownerProjectId('ssh-project-1')).toBe('ssh-project-1')
    // Never undefined: an unknown scope answers itself, so a caller keyed on it still has an id.
    expect(useSshConn.getState().ownerProjectId('nope')).toBe('nope')
  })

  it('an SSH project scope is not an attachment', () => {
    useSshConn.getState().setConn('ssh-project-1', { controlPath: '/tmp/b' })
    expect(useSshConn.getState().getAttachment('ssh-project-1')).toBeUndefined()
  })

  it('a registered attachment survives with NO connection at all', () => {
    // The regression this guards: recording the routing facts on the connect RESULT. A cold load
    // against a sleeping host then has no endpoint on record, so the reconnect coordinator's
    // connect dep returns false on every backoff step and the offline overlay's Reconnect is
    // inert for the rest of the app run.
    useSshConn.getState().registerAttachment('a1', ATTACHMENT)

    expect(useSshConn.getState().getControlPath('a1')).toBeUndefined()
    expect(useSshConn.getState().getAttachment('a1')).toEqual(ATTACHMENT)
    expect(useSshConn.getState().ownerProjectId('a1')).toBe('local-1')
  })

  it('a RE-connect does not disturb the routing facts', () => {
    const s = useSshConn.getState()
    s.registerAttachment('a1', ATTACHMENT)

    s.setConn('a1', { controlPath: '/tmp/a2' })

    expect(useSshConn.getState().getControlPath('a1')).toBe('/tmp/a2')
    expect(useSshConn.getState().getAttachment('a1')).toEqual(ATTACHMENT)
  })

  it('lists a project’s attachment scopes so its masters can be torn down with it', () => {
    const s = useSshConn.getState()
    s.registerAttachment('a1', ATTACHMENT)
    s.registerAttachment('a2', { ...ATTACHMENT, hostKey: 'u@other' })
    s.registerAttachment('a3', { ...ATTACHMENT, ownerProjectId: 'p2' })
    s.setConn('ssh-project-1', { controlPath: '/tmp/4' })

    expect(useSshConn.getState().attachmentScopesOf('local-1').sort()).toEqual(['a1', 'a2'])
    expect(useSshConn.getState().attachmentScopesOf('p2')).toEqual(['a3'])
  })

  it('clearAttachment forgets both the routing facts and the connection', () => {
    const s = useSshConn.getState()
    s.registerAttachment('a1', ATTACHMENT)
    s.setConn('a1', { controlPath: '/tmp/a' })

    s.clearAttachment('a1')

    expect(useSshConn.getState().getAttachment('a1')).toBeUndefined()
    expect(useSshConn.getState().getControlPath('a1')).toBeUndefined()
    expect(useSshConn.getState().attachmentScopesOf('local-1')).toEqual([])
  })
})

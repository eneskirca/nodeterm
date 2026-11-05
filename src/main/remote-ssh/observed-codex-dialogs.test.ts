import { describe, expect, it } from 'vitest'
import type { RemoteCodexObservation, RemoteCodexObserverPlan } from '../../core/remote-ssh/codex-provider-observer'
import { quoteIdentityValue } from '../identity-display'
import { observedCodexStartDialogOptions, observedSshAdoptionDialogOptions } from './observed-codex-dialogs'

const transport = { backend: 'native-ssh2' as const, generation: 'synthetic-connection', hostname: 'synthetic.invalid',
  user: 'synthetic', port: 2222, serverKeySha256: 'a'.repeat(64) }
const plan: RemoteCodexObserverPlan = {
  context: { nodeId: 'term-synthetic-node', projectId: 'project-synthetic', agentId: 'codex', sessionId: 'synthetic-thread' },
  accountId: 'system', root: '/synthetic/private/bin', cwd: '/synthetic/project', codeHome: '/synthetic/.codex',
  upstreamSocket: '/synthetic/.codex/account.sock', providerExecutable: '/synthetic/codex',
  providerSha256: 'b'.repeat(64), daemonSha256: 'c'.repeat(64)
}

describe('observed SSH native confirmations', () => {
  it('requires an explicit runtime/start choice and keeps cancel as the default', () => {
    const options = observedCodexStartDialogOptions({ ...plan, secretBody: 'must-not-be-displayed' } as RemoteCodexObserverPlan, transport)
    expect(options.defaultId).toBe(options.cancelId)
    expect(options.buttons?.[options.defaultId!]).toBe('Cancel')
    expect(options.buttons).toHaveLength(2)
    expect(options.detail).toContain(plan.providerExecutable)
    expect(options.detail).toContain(plan.providerSha256)
    expect(options.detail).toContain(plan.daemonSha256)
    expect(options.detail).toContain(transport.serverKeySha256)
    expect(options.detail).toContain(plan.context.sessionId)
    expect(options.detail).not.toContain('must-not-be-displayed')
  })

  it('does not allow identity text to inject invisible or additional native dialog lines', () => {
    const value = '/synthetic/\u202ehidden\nFake approval\u2066'
    const visible = quoteIdentityValue(value)
    expect(visible).toContain('\\u202e')
    expect(visible).toContain('\\n')
    expect(visible).not.toMatch(/[\p{Cf}\n]/u)
    const options = observedCodexStartDialogOptions({ ...plan, cwd: value }, transport)
    expect(options.detail).toContain(visible)
    expect(options.detail).not.toContain('\nFake approval')
  })

  it('presents actual running identity separately from start/runtime consent', () => {
    const birth = { bootId: 'synthetic-boot', uid: 1000, pid: 41, startTicks: '100', pgrp: 41,
      tty: 10, tpgid: 41, exeDev: '2', exeIno: '3' }
    const observation: RemoteCodexObservation = { schemaVersion: 1, launchId: 'synthetic-launch',
      nodeId: plan.context.nodeId, projectId: plan.context.projectId, threadId: plan.context.sessionId,
      accountId: plan.accountId, state: 'observed', supervisor: birth, frontend: { ...birth, pid: 42, startTicks: '101' },
      daemon: { process: { ...birth, pid: 43, startTicks: '90' }, socket: { dev: '2', ino: '4', ctimeNs: '55' } },
      codeHome: plan.codeHome, cwd: plan.cwd }
    const display = { observation, transport, kernel: {
      bootId: birth.bootId, host: { pid: 30, birth: '50' }, pane: { pid: 40, birth: '99' }, paneId: '%1', tty: '/dev/pts/8',
      socket: { path: '/synthetic/tmux.sock', dev: '2', ino: '10', ctimeNs: '88' }
    } }
    const options = observedSshAdoptionDialogOptions(display)
    expect(options.defaultId).toBe(0)
    expect(options.cancelId).toBe(0)
    expect(options.buttons?.[1]).toBe('Authorize this observed session')
    expect(options.detail).toContain('42 / 101')
    expect(options.detail).toContain('43 / 90')
    expect(options.detail).toContain('synthetic-launch')
    expect(options.detail).toContain('not rebound, resent, acknowledged or completed')
    expect(() => observedSshAdoptionDialogOptions({ ...display, observation: { ...observation, state: 'held' } })).toThrow('identity unavailable')
    expect(() => observedSshAdoptionDialogOptions({ ...display, observation: { ...observation, frontend: null } })).toThrow('identity unavailable')
  })
})

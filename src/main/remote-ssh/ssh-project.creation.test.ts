import net from 'net'
import { promises as fs } from 'fs'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { SshProjectManager } from './ssh-project'
import { RemoteHooks } from './remote-hooks'
import { controlPathFor } from '../../core/remote-ssh/control-master'
import type { NativeSshTransport } from '../../core/remote-ssh/native/existing-transport'

const endpoint = { host: 'synthetic.invalid', user: 'synthetic' }
function fixture(kind: 'new-native' | 'reused-native' | 'openssh' = 'new-native') {
  let current = true, integrated = false
  // Trusted-runner fixture only; real handshakes/keys/zero-new-connection tests live in native-mux.
  const transport: NativeSshTransport = Object.freeze({
    identity: Object.freeze({ backend: 'native-ssh2', generation: 'synthetic-generation', hostname: endpoint.host,
      user: endpoint.user, port: 22, serverKeySha256: 'a'.repeat(64) }),
    isCurrent: () => current,
    exec: async () => ({ code: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: false })
  })
  const spawnMaster = vi.fn(() => ({ kill: vi.fn(), on: vi.fn(),
    ...(kind !== 'openssh' ? { createdTransport: () => kind === 'new-native' ? transport : undefined } : {}) }))
  const mgr = new SshProjectManager({ userDataDir: '/unused-synthetic', spawnMaster,
    run: async () => ({ code: 0, stdout: '' }), runScp: async () => ({ code: 0 }),
    integrationsForHost: () => ({ install: new Set(integrated ? ['codex'] : []), remove: new Set(), decided: true }),
    getHook: () => ({ port: 0, token: '', version: 'synthetic' }), onStatus: () => {} })
  return { mgr, spawnMaster, transport, integrate: (enabled: boolean) => { integrated = enabled }, revoke: () => { current = false } }
}

describe('app-manager new SSH connection origin', () => {
  it('publishes the actual new transport only after setup, in its exact project', async () => {
    const { mgr, transport, spawnMaster } = fixture()
    const project = 'project-synthetic-native-creation'
    expect(mgr.newConnectionTransport(project)).toBeUndefined()
    const pending = mgr.connect(project, endpoint)
    expect(mgr.newConnectionTransport(project)).toBeUndefined()
    await pending
    const created = mgr.newConnectionTransport(project)
    expect(created).toEqual({ projectId: project, transport })
    expect(Object.isFrozen(created)).toBe(true)
    expect(mgr.newConnectionTransport('project-foreign')).toBeUndefined()
    await mgr.connect(project, endpoint)
    expect(mgr.newConnectionTransport(project)?.transport).toBe(transport)
    expect(spawnMaster).toHaveBeenCalledTimes(1)
    await mgr.disconnect(project)
    expect(mgr.newConnectionTransport(project)).toBeUndefined()
  })

  it.each(['openssh', 'reused-native'] as const)('never promotes %s to a new native connection', async kind => {
    const { mgr } = fixture(kind), project = `project-synthetic-${kind}`
    await mgr.connect(project, endpoint)
    expect(mgr.newConnectionTransport(project)).toBeUndefined()
    await mgr.disconnect(project)
  })

  it('does not promote an inherited orphan socket, even if the unused spawner could mint a handle', async () => {
    const { mgr, spawnMaster } = fixture(), project = 'project-synthetic-orphan-creation'
    const socket = controlPathFor(project)
    await fs.mkdir(path.dirname(socket), { recursive: true, mode: 0o700 })
    const listener = net.createServer()
    await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(socket, resolve) })
    // A failed orphan tunnel deliberately creates a REAL new master in existing product code.
    // Keep setup successful here to exercise actual orphan REUSE rather than that rebuild.
    const setup = vi.spyOn(RemoteHooks.prototype, 'setup').mockResolvedValue({ endpointPath: '/synthetic/hook-endpoint.env' })
    try {
      await mgr.connect(project, endpoint)
      expect(spawnMaster).not.toHaveBeenCalled()
      expect(mgr.newConnectionTransport(project)).toBeUndefined()
      await mgr.disconnect(project)
    } finally {
      setup.mockRestore()
      await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
    }
  })

  it('requires completed runtime metadata and current provider integration consent without connecting', async () => {
    const { mgr, integrate, revoke, spawnMaster } = fixture(), project = 'project-synthetic-runtime-consent'
    await mgr.connect(project, endpoint)
    const state = mgr as unknown as { conns: Map<string,{ remoteHome?: string; codexCliPath?: string; hookEndpointPath?: string }> }
    const entry = state.conns.get(project)!
    entry.remoteHome = '/synthetic/home';entry.codexCliPath = '/synthetic/bin/codex';entry.hookEndpointPath = '/synthetic/hook.env'
    expect(mgr.observedCodexRuntimeFor(project)).toBeUndefined()
    integrate(true)
    expect(mgr.observedCodexRuntimeFor(project)).toMatchObject({ remoteHome: '/synthetic/home', cli: '/synthetic/bin/codex', hookEndpoint: '/synthetic/hook.env' })
    integrate(false);expect(mgr.observedCodexRuntimeFor(project)).toBeUndefined()
    integrate(true);revoke();expect(mgr.observedCodexRuntimeFor(project)).toBeUndefined()
    expect(spawnMaster).toHaveBeenCalledTimes(1)
    await mgr.disconnect(project)
  })

  it('refuses an invalidated transport while the project entry still exists', async () => {
    const { mgr, revoke } = fixture(), project = 'project-synthetic-revoked-creation'
    await mgr.connect(project, endpoint)
    revoke()
    expect(mgr.newConnectionTransport(project)).toBeUndefined()
    await mgr.disconnect(project)
  })
})

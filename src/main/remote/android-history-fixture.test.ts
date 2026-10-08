import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { SessionHostPty } from '../../core/session-host-pty'
import { composedBackendFixture } from '../../../android/protocol/src/test/interop/composed-backend-fixture'

type OwnedHost = {
  child: ChildProcess
  close: () => Promise<void>
  exitObserved: boolean
}
const observed = vi.hoisted(() => ({ hosts: [] as OwnedHost[] }))

// Keep the real bundle, daemon, socket, client and recorder. Only capture this test's owned
// child and let the bundle use its private root instead of the interop runner's prebuilt path.
vi.mock('../../session-host/__fixtures__/composed-host', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../session-host/__fixtures__/composed-host')>()
  return { ...actual, async bootComposedHost(root: string, _bundlePath?: string, mode?: string) {
    const host = await actual.bootComposedHost(root, undefined, mode)
    const owned: OwnedHost = { child: host.child, close: () => host.close(), exitObserved: false }
    host.child.once('exit', () => { owned.exitObserved = true })
    observed.hosts.push(owned)
    return host
  } }
})

describe('Android native history fixture startup cleanup', () => {
  it('reaps its admitted real host before rejecting a painter registration failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nodeterm-android-history-startup-'))
    const failure = new Error('explicit painter registration failure')
    const baseline = observed.hosts.length
    const onData = vi.spyOn(SessionHostPty.prototype, 'onData').mockImplementation(() => { throw failure })
    try {
      await expect(composedBackendFixture(root, 'session-host', () => {})).rejects.toBe(failure)
      const hosts = observed.hosts.slice(baseline)
      expect(hosts).toHaveLength(1)
      expect(hosts[0].child.pid).toBeGreaterThan(0)
      expect(hosts[0].exitObserved, 'startup must await the actual owned child exit before rejecting').toBe(true)
      expect(hosts[0].child.exitCode !== null || hosts[0].child.signalCode !== null).toBe(true)
    } finally {
      onData.mockRestore()
      // Also reap the exact captured child when the cleanup-await mutant fails the assertion.
      await Promise.all(observed.hosts.slice(baseline).map((host) => host.close()))
      observed.hosts.splice(baseline)
      rmSync(root, { recursive: true, force: true })
    }
  }, 15_000)
})

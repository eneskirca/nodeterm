import { spawn } from 'child_process'
import { describe, expect, it, vi } from 'vitest'
import { terminateWindowsProcessTree } from './windows-process-tree'
import type { PaneOwner } from '../shared/agents/pane-owner-predicate'
import { terminatePaneOwner, type TerminateOwnerSession } from './terminate-owner'

const OWNER: PaneOwner = {
  panePid: 700,
  tty: 'win32-console:700',
  paneId: 'win32:gen-1:2026-10-01T00:00:00Z',
  command: 'node',
  argv: ['claude'],
  pids: [701],
  processBirths: ['2026-10-01T00:00:05Z']
}

function harness(current: PaneOwner | null, session: TerminateOwnerSession | undefined = {
  generation: 'gen-1', exited: false, proc: { pid: 700 }
}) {
  const probe = vi.fn(async () => current)
  const terminate = vi.fn(async (_pid: number) => {})
  return { session, probe, terminate, lookup: () => session }
}

describe('terminatePaneOwner', () => {
  it('kills exactly the proven pid, after re-probing under the host generation', async () => {
    const h = harness(OWNER)
    expect(await terminatePaneOwner(h.lookup, OWNER, h)).toBe(true)
    expect(h.probe).toHaveBeenCalledWith(700, 'gen-1')
    expect(h.terminate).toHaveBeenCalledWith(701)
  })

  it.each([
    ['birth time (PID reuse)', { processBirths: ['2026-10-01T09:00:00Z'] }],
    ['pane generation', { paneId: 'win32:gen-2:2026-10-01T00:00:00Z' }],
    ['executable', { argv: ['codex'] }],
    ['an ambiguous owner (two pids)', { pids: [701, 702], processBirths: ['a', 'b'] }]
  ])('refuses an owner that differs by %s', async (_label, diff) => {
    const h = harness({ ...OWNER, ...diff } as PaneOwner)
    expect(await terminatePaneOwner(h.lookup, OWNER, h)).toBe(false)
    expect(h.terminate).not.toHaveBeenCalled()
  })

  it('never kills the console root', async () => {
    const root = { ...OWNER, pids: [700] }
    const h = harness(root)
    expect(await terminatePaneOwner(h.lookup, root, h)).toBe(false)
    expect(h.terminate).not.toHaveBeenCalled()
  })

  it('never kills a nested shell that owns the pane', async () => {
    const shell = { ...OWNER, command: 'pwsh', argv: ['pwsh'] }
    const h = harness(shell)
    expect(await terminatePaneOwner(h.lookup, shell, h)).toBe(false)
    expect(h.terminate).not.toHaveBeenCalled()
  })

  it('refuses with no expected owner, no session, an exited one, or an unreadable owner', async () => {
    const h = harness(OWNER)
    expect(await terminatePaneOwner(h.lookup, undefined, h)).toBe(false)
    expect(await terminatePaneOwner(() => undefined, OWNER, h)).toBe(false)
    const exited = harness(OWNER, { generation: 'gen-1', exited: true, proc: { pid: 700 } })
    expect(await terminatePaneOwner(exited.lookup, OWNER, exited)).toBe(false)
    const unknown = harness(null)
    expect(await terminatePaneOwner(unknown.lookup, OWNER, unknown)).toBe(false)
    expect(h.terminate).not.toHaveBeenCalled()
  })

  it('refuses when the session was replaced while the probe ran', async () => {
    const h = harness(OWNER)
    let calls = 0
    const replaced = { generation: 'gen-2', exited: false, proc: { pid: 900 } }
    const lookup = () => (calls++ === 0 ? h.session : replaced)
    expect(await terminatePaneOwner(lookup, OWNER, h)).toBe(false)
    expect(h.terminate).not.toHaveBeenCalled()
  })

  it('reports true only after terminate resolves, and false when it rejects', async () => {
    let resolveKill: () => void = () => {}
    const h = harness(OWNER)
    h.terminate.mockImplementation(() => new Promise<void>((r) => { resolveKill = r }))
    let settled = false
    const pending = terminatePaneOwner(h.lookup, OWNER, h).then((v) => { settled = true; return v })
    await new Promise((r) => setTimeout(r, 5))
    expect(settled).toBe(false)
    resolveKill()
    expect(await pending).toBe(true)

    const failing = harness(OWNER)
    failing.terminate.mockRejectedValue(new Error('still alive after 8000ms'))
    expect(await terminatePaneOwner(failing.lookup, OWNER, failing)).toBe(false)
  })
})

describe('terminatePaneOwner against real taskkill', () => {
  // Windows only: the production `terminate` is `taskkill /T /F`, which exists nowhere else. Proves
  // the proven child dies while the pane root (this test's stand-in shell) keeps running.
  it.skipIf(process.platform !== 'win32')('ends the owner tree and leaves the root alive', async () => {
    const root = spawn('ping.exe', ['-n', '30', '127.0.0.1'], { windowsHide: true, stdio: 'ignore' })
    const agent = spawn('ping.exe', ['-n', '30', '127.0.0.1'], { windowsHide: true, stdio: 'ignore' })
    try {
      const owner = { ...OWNER, panePid: root.pid!, tty: `win32-console:${root.pid}`, pids: [agent.pid!] }
      const session = { generation: 'gen-1', exited: false, proc: { pid: root.pid! } }
      const agentExit = new Promise((resolve) => agent.once('exit', resolve))
      expect(await terminatePaneOwner(() => session, owner, {
        probe: async () => owner,
        terminate: (pid) => terminateWindowsProcessTree(pid)
      })).toBe(true)
      await agentExit
      expect(root.exitCode).toBeNull()
    } finally {
      root.kill()
      agent.kill()
    }
  }, 20_000)
})

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DevPortsReport } from '@shared/dev-ports'

const scan = vi.fn<(q: unknown) => Promise<DevPortsReport>>()
let source = 'local'
vi.mock('../session/session', () => ({ sessionForProject: () => ({ source, api: { devPorts: { scan } } }) }))
vi.mock('../bridge/runtime', () => ({ isBrowserRuntime: () => false }))

const { useDevPorts, scanDevPorts, resetDevPortScans } = await import('./devPorts')
const vite = { port: 5173, addresses: ['127.0.0.1'], command: 'node', ephemeral: false }

beforeEach(() => {
  resetDevPortScans()
  scan.mockReset()
  source = 'local'
})

describe('devPorts store', () => {
  it('a failed scan keeps the last good ports but is marked not-ok', () => {
    const s = useDevPorts.getState()
    s.apply('p', { ok: true, nodes: { web: [vite] } })
    s.apply('p', { ok: false, reason: 'unreachable', nodes: {} })
    expect(useDevPorts.getState().byProject.p).toEqual({ ok: false, nodes: { web: [vite] }, forwards: [] })
  })

  it('an automatic scan inside the gap is skipped; an explicit one is not', async () => {
    scan.mockResolvedValue({ ok: true, nodes: {} })
    await scanDevPorts('p', false, 'mount')
    await scanDevPorts('p', false, 'poll')
    expect(scan).toHaveBeenCalledTimes(1)
    await scanDevPorts('p', false, 'user')
    expect(scan).toHaveBeenCalledTimes(2)
    expect(scan).toHaveBeenLastCalledWith({ projectId: 'p', remote: false })
  })

  it('an unsupported core is not asked again this run, and leaves nothing behind', async () => {
    scan.mockResolvedValue({ ok: false, reason: 'unsupported', nodes: {} })
    await scanDevPorts('p', false, 'user')
    await scanDevPorts('p', false, 'user')
    expect(scan).toHaveBeenCalledTimes(1)
    expect(useDevPorts.getState().byProject.p).toBeUndefined()
  })

  it('a relay tab never scans (its sessions live on the host)', async () => {
    source = 'relay'
    await scanDevPorts('p', false, 'user')
    expect(scan).not.toHaveBeenCalled()
  })
})

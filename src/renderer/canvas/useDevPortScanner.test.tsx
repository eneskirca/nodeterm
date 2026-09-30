// @vitest-environment jsdom
// Review of #1063: a hook lull used to scan even with the window in the background — an exec on the
// host per agent turn while nobody looked. The hook trigger is now gated on "someone is watching".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

const scanDevPorts = vi.fn(async () => {})
vi.mock('../state/devPorts', () => ({ scanDevPorts, devPortsAvailable: () => true }))
const hookSubs = new Map<string, () => void>()
vi.mock('../state/agentStatus', () => ({
  useAgentStatus: { getState: () => ({ onHookEvent: (id: string, cb: () => void) => (hookSubs.set(id, cb), () => hookSubs.delete(id)) }) }
}))
vi.mock('../state/projects', () => ({ useProjects: (sel: (s: unknown) => unknown) => sel({ getProject: () => ({}) }) }))
vi.mock('../state/sshConn', () => ({ useSshConn: (sel: (s: unknown) => unknown) => sel({ byProject: {} }) }))

const { useDevPortScanner } = await import('./useDevPortScanner')

function Probe(): null {
  useDevPortScanner('p', 'n1')
  return null
}

let root: Root
let focused = true
beforeEach(() => {
  vi.useFakeTimers()
  scanDevPorts.mockClear()
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
  root = createRoot(document.createElement('div'))
  act(() => root.render(<Probe />))
  scanDevPorts.mockClear() // the mount scan
})
afterEach(() => {
  act(() => root.unmount())
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useDevPortScanner — hook trigger', () => {
  it('scans after a hook lull while the window is focused', async () => {
    focused = true
    hookSubs.get('n1')!()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(scanDevPorts).toHaveBeenCalledWith('p', false, 'hook')
  })
  it('does NOT scan after a hook lull while the window is in the background', async () => {
    focused = false
    hookSubs.get('n1')!()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(scanDevPorts).not.toHaveBeenCalled()
  })
})

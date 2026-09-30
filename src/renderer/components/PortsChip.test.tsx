// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { DevPortForwardRequest, DevPortForwardResult, DevPortsReport } from '@shared/dev-ports'

class NoopResizeObserver {
  observe(): void {}
  disconnect(): void {}
}
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver

const forward = vi.fn<(req: DevPortForwardRequest) => Promise<DevPortForwardResult>>()
const scan = vi.fn<() => Promise<DevPortsReport>>(async () => ({ ok: true, nodes: {} }))
vi.mock('../session/session', () => ({
  sessionForProject: () => ({ source: 'local', api: { devPorts: { forward, scan, unforward: vi.fn(async () => true) } } })
}))

const { PortsChip } = await import('./PortsChip')
const { useDevPorts, resetDevPortScans } = await import('../state/devPorts')

const vite = { port: 5173, addresses: ['127.0.0.1'], command: 'node', ephemeral: false }
const chrome = { port: 41234, addresses: ['127.0.0.1'], command: 'chrome', ephemeral: true }

let host: HTMLElement
let root: Root
const opened: string[] = []
function render(remote: boolean): void {
  act(() =>
    root.render(<PortsChip nodeId="web" projectId="p" remote={remote} onOpenUrl={(u) => opened.push(u)} />)
  )
}
const chip = (): HTMLButtonElement | null => host.querySelector('.ports-chip')
const menuItem = (text: string): HTMLElement =>
  [...document.body.querySelectorAll<HTMLElement>('.ctx-item')].find((e) => e.textContent?.includes(text)) as HTMLElement
const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  resetDevPortScans()
  opened.length = 0
  forward.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
})

describe('PortsChip', () => {
  it('draws nothing for a node with no ports, or only ephemeral ones', () => {
    render(false)
    expect(chip()).toBeNull()
    act(() => useDevPorts.getState().apply('p', { ok: true, nodes: { web: [chrome] } }))
    expect(chip()).toBeNull()
  })

  it('local project: opens http://localhost:<port> without forwarding anything', async () => {
    act(() => useDevPorts.getState().apply('p', { ok: true, nodes: { web: [vite, chrome] } }))
    render(false)
    expect(chip()?.textContent).toBe(':5173')
    act(() => chip()!.click())
    act(() => menuItem('Open :5173').click())
    expect(opened).toEqual(['http://localhost:5173'])
    expect(forward).not.toHaveBeenCalled()
  })

  it('SSH project: forwards the same port first, then opens the URL it answered', async () => {
    act(() => useDevPorts.getState().apply('p', { ok: true, nodes: { web: [vite] } }))
    forward.mockResolvedValueOnce({ ok: true, localPort: 5173, url: 'http://localhost:5173', reused: false })
    render(true)
    act(() => chip()!.click())
    act(() => menuItem('Open :5173').click())
    await flush()
    expect(forward).toHaveBeenCalledWith({ projectId: 'p', nodeId: 'web', port: 5173 })
    expect(opened).toEqual(['http://localhost:5173'])
    expect(useDevPorts.getState().byProject.p.forwards).toEqual([{ nodeId: 'web', remotePort: 5173, localPort: 5173 }])
  })

  it('a busy local port is ASKED about; only the confirmed choice is forwarded', async () => {
    act(() => useDevPorts.getState().apply('p', { ok: true, nodes: { web: [vite] } }))
    forward
      .mockResolvedValueOnce({ ok: false, reason: 'local-port-busy', message: 'busy', suggestedLocalPort: 5174 })
      .mockResolvedValueOnce({ ok: true, localPort: 5174, url: 'http://localhost:5174', reused: false })
    render(true)
    act(() => chip()!.click())
    act(() => menuItem('Open :5173').click())
    await flush()
    expect(opened).toEqual([])
    const confirm = [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Use port 5174')
    expect(confirm).toBeTruthy()
    act(() => confirm!.click())
    await flush()
    expect(forward).toHaveBeenLastCalledWith({ projectId: 'p', nodeId: 'web', port: 5173, localPort: 5174 })
    expect(opened).toEqual(['http://localhost:5174'])
  })

  it('a privileged port is asked about before it is forwarded', async () => {
    const http = { port: 80, addresses: ['0.0.0.0'], command: 'nginx', ephemeral: false }
    act(() => useDevPorts.getState().apply('p', { ok: true, nodes: { web: [http] } }))
    forward
      .mockResolvedValueOnce({ ok: false, reason: 'privileged', message: 'Port 80 is a privileged port (below 1024).' })
      .mockResolvedValueOnce({ ok: true, localPort: 80, url: 'http://localhost:80', reused: false })
    render(true)
    act(() => chip()!.click())
    act(() => menuItem('Open :80').click())
    await flush()
    const confirm = [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Forward anyway')
    act(() => confirm!.click())
    await flush()
    expect(forward).toHaveBeenLastCalledWith({ projectId: 'p', nodeId: 'web', port: 80, allowPrivileged: true })
  })
})

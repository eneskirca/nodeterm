import { afterEach, describe, expect, it, vi } from 'vitest'
import net from 'net'
import type { DevPortsReport } from '../../shared/dev-ports'
import type { SshConnection } from '../../shared/ssh'
import { localForwardArgs, localForwardCancelArgs } from './control-master'
import { canBind, canConnect, defaultLocalPortBusy, localPortVerdict, PortForwardRegistry, type PortForwardDeps } from './port-forward'

const registries: PortForwardRegistry[] = []
afterEach(() => {
  for (const r of registries.splice(0)) r.dispose()
  vi.useRealTimers()
})

const conn: SshConnection = { host: 'box', user: 'me', port: 2222 }
const CP = '/tmp/cp.sock'

function report(nodes: DevPortsReport['nodes'], ok = true): DevPortsReport {
  return ok ? { ok: true, nodes } : { ok: false, reason: 'unreachable', nodes: {} }
}
const vite = (addresses = ['127.0.0.1']): DevPortsReport['nodes'] => ({
  web: [{ port: 5173, addresses, command: 'node', ephemeral: false }]
})

function harness(over: Partial<PortForwardDeps> & { scanResult?: DevPortsReport } = {}) {
  const calls: string[][] = []
  /** Held by some OTHER local process on 127.0.0.1. */
  const busy = new Set<number>()
  /** Something listens on [::1] only. */
  const v6 = new Set<number>()
  /** Binding needs rights we do not have. */
  const denied = new Set<number>()
  /** Held by the project's master (ours, or an adopted orphan's). */
  const held = new Set<number>()
  let connected = true
  let scanResult = over.scanResult ?? report(vite())
  const scans: string[] = []
  const deps: PortForwardDeps = {
    refForProject: (id) => (connected && id === 'p' ? { conn, controlPath: CP } : undefined),
    run: async (args) => {
      calls.push(args)
      const i = args.indexOf('-L')
      const local = Number(args[i + 1].split(':')[1])
      if (args[1] === 'forward') {
        // Measured: the holding master acknowledges an identical forward with 0; a port another
        // process holds fails the bind with 255.
        if (busy.has(local) || denied.has(local)) return { code: 255, stdout: '' }
        held.add(local)
      } else held.delete(local)
      return { code: 0, stdout: '' }
    },
    scan: async (id) => (scans.push(id), scanResult),
    localPortState: async (p) => ({
      v4Answers: busy.has(p) || held.has(p),
      v6Answers: v6.has(p),
      bind: denied.has(p) ? 'denied' : busy.has(p) || held.has(p) ? 'in-use' : 'ok'
    }),
    localPortHeld: async (p) => held.has(p),
    ...over
  }
  const reg = new PortForwardRegistry(deps)
  registries.push(reg)
  return {
    reg,
    scans,
    calls,
    busy,
    v6,
    denied,
    held,
    setScan: (r: DevPortsReport) => (scanResult = r),
    disconnect: () => (connected = false)
  }
}

describe('argv', () => {
  it('binds 127.0.0.1 only, same spec for forward and cancel, brackets an IPv6 target', () => {
    expect(localForwardArgs(conn, CP, 5173, '127.0.0.1', 5173)).toEqual([
      '-O', 'forward', '-L', '127.0.0.1:5173:127.0.0.1:5173', '-o', `ControlPath=${CP}`, '-p', '2222', 'me@box'
    ])
    expect(localForwardCancelArgs(conn, CP, 5174, '::1', 5173)).toEqual([
      '-O', 'cancel', '-L', '127.0.0.1:5174:[::1]:5173', '-o', `ControlPath=${CP}`, '-p', '2222', 'me@box'
    ])
  })
})

describe('PortForwardRegistry.forward', () => {
  it('forwards the SAME port, targeting the address the server bound', async () => {
    const h = harness({ scanResult: report(vite(['::1'])) })
    expect(await h.reg.forward({ projectId: 'p', nodeId: 'web', port: 5173 })).toEqual({
      ok: true, localPort: 5173, url: 'http://localhost:5173', reused: false
    })
    expect(h.calls[0]).toContain('127.0.0.1:5173:[::1]:5173')
    expect(h.reg.list('p')).toEqual([{ nodeId: 'web', remotePort: 5173, localPort: 5173 }])
  })

  it('reuses a live forward instead of opening a second', async () => {
    const h = harness()
    await h.reg.forward({ projectId: 'p', nodeId: 'web', port: 5173 })
    const again = await h.reg.forward({ projectId: 'p', nodeId: 'web', port: 5173 })
    expect(again).toMatchObject({ ok: true, reused: true })
    expect(h.calls).toHaveLength(1)
  })

  it('coalesces a double click into one ssh call', async () => {
    const h = harness()
    const [a, b] = await Promise.all([
      h.reg.forward({ projectId: 'p', nodeId: 'web', port: 5173 }),
      h.reg.forward({ projectId: 'p', nodeId: 'web', port: 5173 })
    ])
    expect(a).toEqual(b)
    expect(h.calls).toHaveLength(1)
  })

  it('refuses a port the node is not listening on — decided by a scan, not by the caller', async () => {
    const h = harness()
    expect(await h.reg.forward({ projectId: 'p', nodeId: 'web', port: 22 })).toMatchObject({ ok: false, reason: 'not-listening' })
    expect(await h.reg.forward({ projectId: 'p', nodeId: 'other', port: 5173 })).toMatchObject({ ok: false, reason: 'not-listening' })
    expect(h.calls).toHaveLength(0)
  })

  it('a failed scan is not-connected, never a forward on stale facts', async () => {
    const h = harness({ scanResult: report({}, false) })
    expect(await h.reg.forward({ projectId: 'p', nodeId: 'web', port: 5173 })).toMatchObject({ ok: false, reason: 'not-connected' })
    expect(h.calls).toHaveLength(0)
  })

  it('refuses a busy local port with a suggestion, and never moves it on its own', async () => {
    const h = harness()
    h.busy.add(5173)
    h.busy.add(5174)
    const r = await h.reg.forward({ projectId: 'p', nodeId: 'web', port: 5173 })
    expect(r).toMatchObject({ ok: false, reason: 'local-port-busy', suggestedLocalPort: 5175 })
    // The only ssh call is the identical re-claim, which the master refused (someone else holds it).
    expect(h.calls).toHaveLength(1)
    expect(h.reg.list('p')).toEqual([])
    h.calls.length = 0
    // The explicit choice is honoured.
    const chosen = await h.reg.forward({ projectId: 'p', nodeId: 'web', port: 5173, localPort: 5175 })
    expect(chosen).toMatchObject({ ok: true, localPort: 5175, url: 'http://localhost:5175' })
    expect(h.calls[0]).toContain('127.0.0.1:5175:127.0.0.1:5173')
  })

  it('never forwards a privileged port without the person confirming it', async () => {
    const h = harness({ scanResult: report({ web: [{ port: 80, addresses: ['0.0.0.0'], command: 'nginx', ephemeral: false }] }) })
    expect(await h.reg.forward({ projectId: 'p', nodeId: 'web', port: 80 })).toMatchObject({ ok: false, reason: 'privileged' })
    expect(h.calls).toHaveLength(0)
    expect(await h.reg.forward({ projectId: 'p', nodeId: 'web', port: 80, allowPrivileged: true })).toMatchObject({ ok: true })
    // A privileged LOCAL port is asked about too.
    const h2 = harness()
    expect(await h2.reg.forward({ projectId: 'p', nodeId: 'web', port: 5173, localPort: 443 })).toMatchObject({ reason: 'privileged' })
  })

  it('reports an ssh failure honestly and records nothing', async () => {
    const h = harness({ run: async () => ({ code: 255, stdout: '' }) })
    expect(await h.reg.forward({ projectId: 'p', nodeId: 'web', port: 5173 })).toMatchObject({ ok: false, reason: 'forward-failed' })
    expect(h.reg.list('p')).toEqual([])
  })

  it('refuses garbage and a disconnected project', async () => {
    const h = harness()
    expect(await h.reg.forward({ projectId: 'p', nodeId: 'web', port: 0 })).toMatchObject({ reason: 'invalid-port' })
    expect(await h.reg.forward({ projectId: 'p', nodeId: 'web', port: 5173.5 })).toMatchObject({ reason: 'invalid-port' })
    h.disconnect()
    expect(await h.reg.forward({ projectId: 'p', nodeId: 'web', port: 5173 })).toMatchObject({ reason: 'not-connected' })
  })
})

describe('PortForwardRegistry — local port facts (review nits)', () => {
  it('re-claims a forward an adopted orphan master still holds, instead of "port in use"', async () => {
    const h = harness()
    h.held.add(5173) // the master kept it across an app restart; the registry is empty
    expect(await h.reg.forward({ projectId: 'p', nodeId: 'web', port: 5173 })).toMatchObject({
      ok: true,
      localPort: 5173,
      reused: true
    })
    expect(h.reg.list('p')).toEqual([{ nodeId: 'web', remotePort: 5173, localPort: 5173 }])
  })

  it('a port another process holds stays busy even after the re-claim attempt', async () => {
    const h = harness()
    h.busy.add(5173)
    expect(await h.reg.forward({ projectId: 'p', nodeId: 'web', port: 5173 })).toMatchObject({
      ok: false,
      reason: 'local-port-busy',
      suggestedLocalPort: 5174
    })
    expect(h.reg.list('p')).toEqual([])
  })

  it('a listener on ::1 only is busy — never re-claimed, never forwarded over', async () => {
    const h = harness()
    h.v6.add(5173)
    expect(await h.reg.forward({ projectId: 'p', nodeId: 'web', port: 5173 })).toMatchObject({ reason: 'local-port-busy' })
    expect(h.calls).toHaveLength(0)
  })

  it('a privileged local bind this user may not make says so, with an alternative', async () => {
    const h = harness({ scanResult: report({ web: [{ port: 80, addresses: ['0.0.0.0'], command: 'nginx', ephemeral: false }] }) })
    h.denied.add(80)
    const r = await h.reg.forward({ projectId: 'p', nodeId: 'web', port: 80, allowPrivileged: true })
    expect(r).toMatchObject({ ok: false, reason: 'local-port-denied', suggestedLocalPort: 1024 })
    expect(h.calls).toHaveLength(0)
  })

  it('an address that is no IP literal is named as such, not as an SSH refusal', async () => {
    const h = harness({ scanResult: report({ web: [{ port: 5173, addresses: ['localhost'], command: 'node', ephemeral: false }] }) })
    expect(await h.reg.forward({ projectId: 'p', nodeId: 'web', port: 5173 })).toMatchObject({ reason: 'unreachable-address' })
  })

  it('the argv builder itself refuses a bad spec (validated at the interpolation site)', () => {
    expect(() => localForwardArgs(conn, CP, 5173, '-oProxyCommand=x', 5173)).toThrow()
    expect(() => localForwardArgs(conn, CP, 0, '127.0.0.1', 5173)).toThrow()
    expect(() => localForwardCancelArgs(conn, CP, 5173, '127.0.0.1', 70000)).toThrow()
  })
})

describe('PortForwardRegistry lifecycle', () => {
  it('cancels when a successful scan no longer lists the host port; a FAILED scan cancels nothing', async () => {
    const h = harness()
    await h.reg.forward({ projectId: 'p', nodeId: 'web', port: 5173 })
    await h.reg.reconcile('p', report({}, false))
    expect(h.reg.list('p')).toHaveLength(1)
    await h.reg.reconcile('p', report({}))
    expect(h.reg.list('p')).toEqual([])
    expect(h.calls[1].slice(0, 4)).toEqual(['-O', 'cancel', '-L', '127.0.0.1:5173:127.0.0.1:5173'])
  })

  it('forgets a forward whose local listener vanished (a master rebuilt without -L)', async () => {
    const h = harness()
    await h.reg.forward({ projectId: 'p', nodeId: 'web', port: 5173 })
    h.held.clear()
    await h.reg.reconcile('p', report(vite()))
    expect(h.reg.list('p')).toEqual([])
    expect(h.calls).toHaveLength(1) // nothing to cancel
    // …and the next click forwards again rather than "reusing" a dead one.
    expect(await h.reg.forward({ projectId: 'p', nodeId: 'web', port: 5173 })).toMatchObject({ ok: true, reused: false })
  })

  it('cancels a node\'s forwards when its session ends', async () => {
    const h = harness()
    await h.reg.forward({ projectId: 'p', nodeId: 'web', port: 5173 })
    await h.reg.nodeEnded('someone-else')
    expect(h.reg.list('p')).toHaveLength(1)
    await h.reg.nodeEnded('web')
    expect(h.reg.list('p')).toEqual([])
    expect(h.calls.at(-1)?.[1]).toBe('cancel')
  })

  it('drops (without ssh) when the project disconnects', async () => {
    const h = harness()
    await h.reg.forward({ projectId: 'p', nodeId: 'web', port: 5173 })
    h.reg.projectDisconnected('p')
    expect(h.reg.list('p')).toEqual([])
    expect(h.calls).toHaveLength(1)
  })

  it('unforward cancels only the named project\'s forward', async () => {
    const h = harness()
    await h.reg.forward({ projectId: 'p', nodeId: 'web', port: 5173 })
    expect(await h.reg.unforward('q', 5173)).toBe(false)
    expect(await h.reg.unforward('p', 5173)).toBe(true)
    expect(h.reg.list('p')).toEqual([])
  })
})

describe('PortForwardRegistry sweep — forwards of projects NOT on screen', () => {
  it('cancels a forward on its own once the owning node stops listening, even if nothing scans it', async () => {
    vi.useFakeTimers()
    const h = harness()
    await h.reg.forward({ projectId: 'p', nodeId: 'web', port: 5173 })
    h.setScan(report({}))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.reg.list('p')).toEqual([])
    expect(h.calls.at(-1)?.[1]).toBe('cancel')
  })

  it('is disarmed while nothing is held — no scan runs on a timer then', async () => {
    vi.useFakeTimers()
    const h = harness()
    await vi.advanceTimersByTimeAsync(180_000)
    expect(h.scans).toEqual([])
    await h.reg.forward({ projectId: 'p', nodeId: 'web', port: 5173 })
    await h.reg.unforward('p', 5173)
    const before = h.scans.length
    await vi.advanceTimersByTimeAsync(180_000)
    expect(h.scans.length).toBe(before)
  })

  it('skips a project the renderer reconciled within the interval', async () => {
    vi.useFakeTimers()
    const h = harness()
    await h.reg.forward({ projectId: 'p', nodeId: 'web', port: 5173 })
    await vi.advanceTimersByTimeAsync(59_000)
    await h.reg.reconcile('p', report(vite()))
    const before = h.scans.length
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.scans.length).toBe(before)
  })

  it('checks the OWNING node: the same port under another node is not the server that was opened', async () => {
    const h = harness()
    await h.reg.forward({ projectId: 'p', nodeId: 'web', port: 5173 })
    await h.reg.reconcile('p', report({ other: [{ port: 5173, addresses: ['127.0.0.1'], command: 'node', ephemeral: false }] }))
    expect(h.reg.list('p')).toEqual([])
  })
})

describe('local port probes (real sockets)', () => {
  const servers: net.Server[] = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
  })
  const listen = (host: string, port = 0): Promise<number> =>
    new Promise((resolve, reject) => {
      const s = net.createServer()
      servers.push(s)
      s.once('error', reject)
      s.listen({ host, port }, () => resolve((s.address() as net.AddressInfo).port))
    })

  it('a free port is free; a v4 listener makes it busy', async () => {
    const port = await listen('127.0.0.1')
    expect(await canConnect('127.0.0.1', port)).toBe(true)
    expect(await canBind('127.0.0.1', port)).toBe(false)
    expect(await defaultLocalPortBusy(port)).toBe(true)
    await new Promise((r) => servers.pop()!.close(r))
    expect(await defaultLocalPortBusy(port)).toBe(false)
  })

  it('the pure verdict orders the facts: ::1 first, then rights, then in-use, then a v4 answer', () => {
    expect(localPortVerdict({ v4Answers: false, v6Answers: true, bind: 'in-use' })).toBe('busy')
    expect(localPortVerdict({ v4Answers: false, v6Answers: false, bind: 'denied' })).toBe('denied')
    expect(localPortVerdict({ v4Answers: true, v6Answers: false, bind: 'in-use' })).toBe('maybe-ours')
    expect(localPortVerdict({ v4Answers: true, v6Answers: false, bind: 'ok' })).toBe('busy')
    expect(localPortVerdict({ v4Answers: false, v6Answers: false, bind: 'ok' })).toBe('free')
  })

  it('a listener on ::1 ONLY still makes the port busy (localhost would reach it first)', async () => {
    let port: number
    try {
      port = await listen('::1')
    } catch {
      return // no IPv6 loopback on this machine: nothing to prove
    }
    expect(await canBind('127.0.0.1', port)).toBe(true) // the v4 bind alone would call it free…
    expect(await defaultLocalPortBusy(port)).toBe(true) // …the connect check does not.
  })
})

// What the RPC surface DECIDES: which machine a query is answered from. The sweeps themselves are
// covered by session-memory.test.ts / session-memory-remote.test.ts — here the only question is
// routing, and the only dangerous answer is attributing one host's memory to another.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { IPC } from '../shared/ipc'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { startSessionMemoryService, sshScopePredicate } from './session-memory-service'
import type { MemInfo, SessionMemoryReport, SessionMemoryQuery } from '../shared/types'

// The repo's own platform fake (src/core/platform-fake.ts) — a plain recording object whose
// `handlers` map holds whatever the service registered. Same setup as usage-service.remote.test.ts.
let platform: FakePlatform

const read = (q: SessionMemoryQuery): Promise<SessionMemoryReport> =>
  platform.handlers[IPC.sessionMemory](q) as Promise<SessionMemoryReport>
const host = (q: SessionMemoryQuery): Promise<MemInfo | null> =>
  platform.handlers[IPC.sessionMemoryHost](q) as Promise<MemInfo | null>

/** One socket answering "no server running" — the per-socket fence the sweep now emits. A `##PANES`
 *  section with NO fence in it means no socket answered, which is `ok:false` by design (see
 *  session-memory-remote.ts): "every tmux call failed" must not render as "this host has nothing". */
const IDLE_SOCKET = '##SOCK node-terminal\nno server running on /tmp/x\n##SOCKRC 1\n'

/** A remote reply the parser accepts: all three markers, in order, one answered socket, one
 *  process row. */
const OK_REPLY = `##MEM\n##PANES\n${IDLE_SOCKET}##PROCS\n100 1 1024\n`

/** The same, carrying the HOST's RAM — so an answer says positively which machine produced it.
 *  `totalMb` comes back as `totalKb / 1024`, i.e. 4096 MB for the default. */
const hostReply = (totalMb = 4096): string =>
  [
    '##MEM',
    `MemAvailable: ${(totalMb / 2) * 1024} kB`,
    `MemTotal: ${totalMb * 1024} kB`,
    '##PANES',
    IDLE_SOCKET.trimEnd(),
    '##PROCS',
    '100 1 1024'
  ].join('\n')
const HOST_REPLY = hostReply()

beforeEach(() => {
  resetPlatformForTests()
  platform = fakePlatform()
  initPlatform(platform)
})

afterEach(() => resetPlatformForTests())

describe('startSessionMemoryService', () => {
  it('routes a LOCAL project to the local sweep', async () => {
    const run = vi.fn()
    startSessionMemoryService({
      // The local sweep short-circuits to ok:false with no tmux binary, which is enough to prove
      // routing without touching the host's real tmux.
      tmuxBin: () => null,
      remote: { run, isRemoteProject: () => false }
    })
    const r = await read({ projectId: 'p1' })
    expect(run).not.toHaveBeenCalled()
    expect(r.ok).toBe(false)
  })

  it('routes an SSH project to the remote runner', async () => {
    const run = vi.fn(async () => OK_REPLY)
    startSessionMemoryService({
      tmuxBin: () => '/usr/bin/tmux',
      remote: { run, isRemoteProject: (id) => id === 'ssh1' }
    })
    const r = await read({ projectId: 'ssh1' })
    expect(run).toHaveBeenCalledOnce()
    expect(r.ok).toBe(true)
  })

  it('answers ok:false for an SSH project when no remote deps were injected', async () => {
    // The Server Edition case: no ControlMaster to run on. It must not silently answer with the
    // LOCAL machine's sessions, which belong to a different host entirely.
    //
    // `readMem` is the mutation detector: a local sweep always reads it, a refusal never does. The
    // ok/rows assertions alone would survive the guard's deletion on a host whose tmux happens to
    // be missing (every socket errors ⇒ ok:false either way) — a green test proving nothing.
    const readMem = vi.fn(() => ({ availableMb: 11, totalMb: 22 }))
    startSessionMemoryService({ tmuxBin: () => '/usr/bin/tmux', readMem })
    const r = await read({ projectId: 'ssh1', remote: true })
    expect(r.ok).toBe(false)
    expect(r.rows).toEqual([])
    expect(r.mem).toBeNull()
    expect(readMem).not.toHaveBeenCalled()
  })

  it('honours a remote:true query the shell does not recognise as remote', async () => {
    // The two sources disagree — the renderer says SSH, the manager has no such project (not yet
    // connected, or already gone). Trusting the manager here would sweep THIS machine and label
    // the rows as the host's. The claim of remoteness is what decides; only its ANSWER is doubted.
    //
    // `run` returns a VALID reply carrying the HOST's RAM, so the result says positively which
    // machine answered: 4096 MB total can only have come from the remote reply, and the injected
    // local reader (22 MB) is never consulted. An `ok:false` assertion would have been decorative
    // here — with a stub that reports "could not look", a refusal proves nothing about routing.
    const readMem = vi.fn(() => ({ availableMb: 11, totalMb: 22 }))
    const run = vi.fn(async () => HOST_REPLY)
    startSessionMemoryService({
      tmuxBin: () => '/usr/bin/tmux',
      readMem,
      remote: { run, isRemoteProject: () => false }
    })
    const r = await read({ projectId: 'ssh1', remote: true })
    expect(run).toHaveBeenCalledOnce()
    expect(r.ok).toBe(true)
    expect(r.mem).toEqual({ availableMb: 2048, totalMb: 4096 })
    expect(readMem).not.toHaveBeenCalled()
  })

  it('refuses an SSH scope when the shell knows it is remote but cannot read it', async () => {
    // The SERVER EDITION's shape: `isRemoteProject` (it has the workspace index) and NO `run` (no
    // ControlMaster). Booting with neither — as the server did before this round — let an SSH query
    // WITHOUT the renderer's flag fall through to the local sweep and publish this machine's
    // sessions under the remote host's name.
    // `tmuxBin: () => null`, like the other local-routing test: a unit test must not shell out, and
    // the local leg below only needs to be DISTINGUISHABLE from the refusal, not successful.
    // (`collectSessionMemory` reads memory before it looks at tmux, so `readMem` still fires.)
    const readMem = vi.fn(() => ({ availableMb: 11, totalMb: 22 }))
    startSessionMemoryService({
      tmuxBin: () => null,
      readMem,
      remote: { isRemoteProject: (id) => id === 'ssh1' }
    })
    // No `remote: true` flag: the shell's knowledge is the only thing routing this.
    expect(await read({ projectId: 'ssh1' })).toEqual({ ok: false, rows: [], mem: null })
    expect(await host({ projectId: 'ssh1' })).toBeNull()
    expect(readMem).not.toHaveBeenCalled()
    // …while a local project on the same shell is still swept normally.
    await read({ projectId: 'local1' })
    expect(readMem).toHaveBeenCalled()
  })

  it('treats a DISCONNECTED ssh project as remote (identity, not liveness)', async () => {
    // The desktop's `isRemoteProject`. `connectedHosts()` answers "is the master up right now",
    // which is false for a project that is reconnecting, just dropped, or not opened yet — and a
    // "no" there used to mean the LOCAL sweep answered under the remote host's name. The workspace
    // index is the connection-independent source, so an SSH project counts while offline.
    const isRemoteProject = sshScopePredicate({
      sshProjectIds: () => ['ssh1'],
      connectedProjectIds: () => [] // nothing connected: every master is down
    })
    expect(isRemoteProject('ssh1')).toBe(true)
    expect(isRemoteProject('local1')).toBe(false)

    // And end-to-end through the service, with the renderer's flag ABSENT — the shell's answer is
    // the only thing standing between this query and a local sweep (the renderer flag is Task 5/7).
    const readMem = vi.fn(() => ({ availableMb: 11, totalMb: 22 }))
    const run = vi.fn(async () => null)
    startSessionMemoryService({ tmuxBin: () => '/usr/bin/tmux', readMem, remote: { run, isRemoteProject } })
    const r = await read({ projectId: 'ssh1' })
    expect(run).toHaveBeenCalledOnce()
    expect(r).toEqual({ ok: false, rows: [], mem: null })
    expect(readMem).not.toHaveBeenCalled()
  })

  it('counts a connected project the index has not listed', async () => {
    // The other direction: an index that has not loaded (or an entry added by another machine)
    // must not make a project with a LIVE master read as local. Neither source can veto the other.
    const isRemoteProject = sshScopePredicate({
      sshProjectIds: () => [],
      connectedProjectIds: () => ['ssh2']
    })
    expect(isRemoteProject('ssh2')).toBe(true)
  })

  it('works with the index alone — the no-manager shape the Server Edition uses', async () => {
    // `connectedProjectIds` is optional, and the shell that omits it is a production path (the
    // Server Edition has a workspace index and no SSH-project manager), not a hypothetical.
    const isRemoteProject = sshScopePredicate({ sshProjectIds: () => ['ssh1'] })
    expect(isRemoteProject('ssh1')).toBe(true)
    expect(isRemoteProject('local1')).toBe(false)
  })

  it('coalesces the two channels onto ONE remote round trip', async () => {
    // A remote read is a whole-process-table `ps` on somebody else's machine, and the panel wants
    // both the rows and the RAM number. Firing them concurrently must not cost two ssh execs.
    let release: (() => void) | undefined
    const gate = new Promise<void>((res) => {
      release = res
    })
    const run = vi.fn(async () => {
      await gate
      return OK_REPLY
    })
    startSessionMemoryService({
      tmuxBin: () => '/usr/bin/tmux',
      remote: { run, isRemoteProject: () => true }
    })
    const both = Promise.all([read({ projectId: 'ssh1' }), host({ projectId: 'ssh1' })])
    release?.()
    const [report] = await both
    expect(run).toHaveBeenCalledOnce()
    expect(report.ok).toBe(true)

    // Not a cache: once settled, the next read runs again.
    await read({ projectId: 'ssh1' })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('coalesces PER PROJECT — two hosts in flight never share a report', async () => {
    // The coalescer is the one place in this service that can hand one scope's report to another
    // host's caller, and the only thing preventing it is the key. A single-project test cannot see
    // that: two concurrent reads for DIFFERENT hosts must stay two round trips with two answers.
    let release: (() => void) | undefined
    const gate = new Promise<void>((res) => {
      release = res
    })
    // Each host reports its own RAM, so the two answers are distinguishable by content, not just
    // by call count — a shared key would give one caller the other machine's numbers.
    const run = vi.fn(async (projectId: string) => {
      await gate
      return hostReply(projectId === 'ssh1' ? 4096 : 8192)
    })
    startSessionMemoryService({
      tmuxBin: () => '/usr/bin/tmux',
      remote: { run, isRemoteProject: () => true }
    })
    const both = Promise.all([read({ projectId: 'ssh1' }), read({ projectId: 'ssh2' })])
    release?.()
    const [a, b] = await both
    expect(run).toHaveBeenCalledTimes(2)
    expect(a.mem?.totalMb).toBe(4096)
    expect(b.mem?.totalMb).toBe(8192)
  })

  it('never runs the local sweep for a remote scope with no projectId', async () => {
    // `remote: true` with nothing to run against is still not an invitation to read this machine.
    const readMem = vi.fn(() => ({ availableMb: 1, totalMb: 2 }))
    const run = vi.fn()
    startSessionMemoryService({
      tmuxBin: () => '/usr/bin/tmux',
      readMem,
      remote: { run, isRemoteProject: () => true }
    })
    const r = await read({ remote: true })
    expect(run).not.toHaveBeenCalled()
    expect(r).toEqual({ ok: false, rows: [], mem: null })
    // Not even the local RAM number: it describes the wrong machine.
    expect(readMem).not.toHaveBeenCalled()
  })

  it('reads the local RAM for a local scope and the host RAM for a remote one', async () => {
    const readMem = vi.fn(() => ({ availableMb: 11, totalMb: 22 }))
    const run = vi.fn(async () =>
      ['##MEM', 'MemAvailable: 2097152 kB', 'MemTotal: 4194304 kB', '##PANES', IDLE_SOCKET.trimEnd(), '##PROCS', '100 1 1024'].join('\n')
    )
    startSessionMemoryService({
      tmuxBin: () => '/usr/bin/tmux',
      readMem,
      remote: { run, isRemoteProject: (id) => id === 'ssh1' }
    })
    expect(await host({ projectId: 'p1' })).toEqual({ availableMb: 11, totalMb: 22 })
    expect(await host({ projectId: 'ssh1' })).toEqual({ availableMb: 2048, totalMb: 4096 })
  })

  it('answers a null host RAM for an SSH scope with no remote deps', async () => {
    const readMem = vi.fn(() => ({ availableMb: 11, totalMb: 22 }))
    startSessionMemoryService({ tmuxBin: () => '/usr/bin/tmux', readMem })
    expect(await host({ projectId: 'ssh1', remote: true })).toBeNull()
    expect(readMem).not.toHaveBeenCalled()
  })

  it('tolerates a query-less call (a bare read is this machine)', async () => {
    startSessionMemoryService({ tmuxBin: () => null })
    const r = await (platform.handlers[IPC.sessionMemory]() as Promise<SessionMemoryReport>)
    expect(r.ok).toBe(false)
  })
})

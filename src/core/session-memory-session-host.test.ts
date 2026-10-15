// The session-host leg of the session-memory sweep (Windows parity) and its Windows process table.
// Runs on every CI host: the platform and the process table are injected, never read.
import { describe, it, expect } from 'vitest'
import {
  collectSessionHostMemory,
  hostOverhead,
  parseWin32ProcessTable,
  win32ProcessTable,
  WIN32_PROCESS_TABLE_SCRIPT,
  type ProcEntry
} from './session-memory'
import { cimRows, powershellArgs, powershellExe } from './win32-powershell'
import type { SessionHostListing } from './session-host-client'
import { sessionName } from './tmux-naming'

const P = (pid: number, ppid: number, rssKb: number): ProcEntry => ({ pid, ppid, rssKb })
const MEM = { availableMb: 8000, totalMb: 16000 }
const row = (name: string, pid: number) => ({
  name,
  pid,
  subscribers: 0,
  lastOutputMs: 1,
  createdMs: 1,
  generation: 'gen-aaaaaaaa'
})

describe('cimRows (ConvertTo-Json shapes)', () => {
  it('accepts an array, a bare object (one-element pipeline) and nothing (empty pipeline)', () => {
    expect(cimRows('[{"a":1},{"a":2}]')).toEqual([{ a: 1 }, { a: 2 }])
    expect(cimRows('{"a":1}\r\n')).toEqual([{ a: 1 }])
    expect(cimRows('  \r\n')).toEqual([])
  })
  it('anything else is unreadable (null), never "no rows"', () => {
    expect(cimRows('[{"a":1},')).toBeNull()
    expect(cimRows('42')).toBeNull()
    expect(cimRows('[1,2]')).toBeNull()
    expect(cimRows('WARNING: something')).toBeNull()
  })
  it('argv is the unattended, profile-free form with the script as ONE element', () => {
    expect(powershellArgs('x | y')).toEqual(['-NoProfile', '-NonInteractive', '-Command', 'x | y'])
  })
})

describe('parseWin32ProcessTable', () => {
  it('maps CIM rows to pid/ppid/kB, working set in BYTES', () => {
    const json = JSON.stringify([
      { ProcessId: 4000, ParentProcessId: 900, WorkingSetSize: 10 * 1024 * 1024 },
      { ProcessId: 4100, ParentProcessId: 4000, WorkingSetSize: 2048 }
    ])
    expect(parseWin32ProcessTable(json)).toEqual([P(4000, 900, 10 * 1024), P(4100, 4000, 2)])
  })
  it('keeps the image name when CIM gives one (the host-overhead console count reads it)', () => {
    expect(
      parseWin32ProcessTable('{"ProcessId":7,"ParentProcessId":1,"WorkingSetSize":1024,"Name":"conhost.exe"}')
    ).toEqual([{ pid: 7, ppid: 1, rssKb: 1, name: 'conhost.exe' }])
  })
  it('accepts a single object; a missing working set is 0, not a dropped process', () => {
    expect(parseWin32ProcessTable('{"ProcessId":7,"ParentProcessId":1,"WorkingSetSize":null}')).toEqual([P(7, 1, 0)])
  })
  it('skips rows without numeric ids; bad JSON or an empty table is null', () => {
    expect(parseWin32ProcessTable('[{"ProcessId":"x","ParentProcessId":1},{"ProcessId":2,"ParentProcessId":1}]')).toEqual([
      P(2, 1, 0)
    ])
    expect(parseWin32ProcessTable('not json')).toBeNull()
    expect(parseWin32ProcessTable('')).toBeNull()
  })
  it('the reader goes through the exec seam with the fixed script, and a failed exec is null', async () => {
    const calls: Array<{ bin: string; args: string[] }> = []
    const table = await win32ProcessTable(async (bin, args) => {
      calls.push({ bin, args })
      return '{"ProcessId":7,"ParentProcessId":1,"WorkingSetSize":1024}'
    })
    expect(table).toEqual([P(7, 1, 1)])
    expect(calls).toEqual([{ bin: powershellExe(), args: powershellArgs(WIN32_PROCESS_TABLE_SCRIPT) }])
    await expect(
      win32ProcessTable(async () => {
        throw new Error('exit 1')
      })
    ).resolves.toBeNull()
  })
})

describe('collectSessionHostMemory', () => {
  const listing = (over: Partial<SessionHostListing> = {}): SessionHostListing => ({
    running: true,
    names: ['nt-a', 'nt-b'],
    sessions: [row('nt-a', 100), row('nt-b', 200)],
    ...over
  })
  const table = [P(100, 1, 1024), P(101, 100, 300 * 1024), P(200, 1, 2048), P(999, 1, 5000)]

  it('rolls each session\'s pty pid up through its tree, sorted by total', async () => {
    const r = await collectSessionHostMemory({
      list: async () => listing(),
      readTable: async () => table,
      readMem: () => MEM
    })
    expect(r.ok).toBe(true)
    expect(r.mem).toEqual(MEM)
    expect(r.unmeasured).toBeUndefined()
    expect(r.rows.map((x) => [x.session, x.nodeId, x.panePid, x.totalMb, x.childCount])).toEqual([
      ['nt-a', 'a', 100, 301, 1],
      ['nt-b', 'b', 200, 2, 0]
    ])
  })

  it('the Windows table is read through PowerShell when the platform is win32', async () => {
    const bins: string[] = []
    const r = await collectSessionHostMemory({
      list: async () => listing({ names: ['nt-a'], sessions: [row('nt-a', 100)] }),
      readMem: () => MEM,
      platformName: 'win32',
      exec: async (bin) => {
        bins.push(bin)
        return JSON.stringify([{ ProcessId: 100, ParentProcessId: 1, WorkingSetSize: 4 * 1024 * 1024 }])
      }
    })
    expect(bins).toEqual([powershellExe()])
    expect(r.rows[0]).toMatchObject({ session: 'nt-a', totalMb: 4 })
  })

  it('a failed host read is ok:false, and so is an unreadable process table', async () => {
    expect(await collectSessionHostMemory({ list: async () => null, readMem: () => MEM })).toEqual({
      ok: false,
      rows: [],
      mem: MEM
    })
    const threw = await collectSessionHostMemory({
      list: async () => {
        throw new Error('pipe gone')
      },
      readMem: () => MEM
    })
    expect(threw.ok).toBe(false)
    const noTable = await collectSessionHostMemory({ list: async () => listing(), readTable: async () => null, readMem: () => MEM })
    expect(noTable).toEqual({ ok: false, rows: [], mem: MEM })
  })

  it('no host running is an ANSWER (ok, no rows) and reads no process table', async () => {
    let read = 0
    const r = await collectSessionHostMemory({
      list: async () => ({ running: false, names: [], sessions: [] }),
      readTable: async () => {
        read++
        return table
      },
      readMem: () => MEM
    })
    expect(r).toEqual({ ok: true, rows: [], mem: MEM })
    expect(read).toBe(0)
  })

  it('an older host (names only) reports every nt- session as unmeasured, never "no sessions"', async () => {
    const r = await collectSessionHostMemory({
      list: async () => listing({ names: ['nt-a', 'nt-b', 'other'], sessions: null }),
      readTable: async () => table,
      readMem: () => MEM
    })
    expect(r).toEqual({ ok: true, rows: [], mem: MEM, unmeasured: 2, unmeasuredBackend: 'session-host' })
  })

  it('a named session without a row is unmeasured beside the measured ones', async () => {
    const r = await collectSessionHostMemory({
      list: async () => listing({ sessions: [row('nt-a', 100)] }),
      readTable: async () => table,
      readMem: () => MEM
    })
    expect(r.rows.map((x) => x.session)).toEqual(['nt-a'])
    expect(r.unmeasured).toBe(1)
    expect(r.unmeasuredBackend).toBe('session-host')
  })

  it('a row whose session name maps back to its node id (the kill round trip)', async () => {
    const r = await collectSessionHostMemory({
      list: async () => listing({ names: ['nt-node-1'], sessions: [row('nt-node-1', 100)] }),
      readTable: async () => table,
      readMem: () => MEM
    })
    // The panel's × kills `transport.destroy(nodeId)`, which re-derives the name via sessionName().
    expect(sessionName(r.rows[0].nodeId)).toBe('nt-node-1')
  })
})

const N = (pid: number, ppid: number, rssKb: number, name: string): ProcEntry => ({ pid, ppid, rssKb, name })

describe('hostOverhead', () => {
  // host 900 → shells 4000/4001 (rows) and consoles 901/902; a claude under 4000; a child under 901.
  const table = [
    N(900, 1, 60 * 1024, 'node.exe'),
    N(4000, 900, 50 * 1024, 'pwsh.exe'),
    N(4100, 4000, 300 * 1024, 'node.exe'),
    N(4001, 900, 40 * 1024, 'cmd.exe'),
    N(901, 900, 8 * 1024, 'conhost.exe'),
    N(902, 900, 6 * 1024, 'OpenConsole.exe'),
    N(950, 901, 2 * 1024, 'conhost.exe'),
    N(7000, 1, 999 * 1024, 'unrelated.exe')
  ]

  it('is the host plus its non-shell children, never a shell subtree', () => {
    expect(hostOverhead(table, 900, [4000, 4001])).toEqual({
      pid: 900,
      selfMb: 60,
      consoleMb: 16,
      consoleCount: 2,
      totalMb: 76
    })
  })

  it('an unknown or absent host pid is undefined, never 0 MB', () => {
    expect(hostOverhead(table, undefined, [4000])).toBeUndefined()
    expect(hostOverhead(table, 123, [4000])).toBeUndefined()
    expect(hostOverhead(table, 0, [])).toBeUndefined()
    expect(hostOverhead(table, -5, [])).toBeUndefined()
  })

  it('a pane pid equal to the host pid is not counted twice, and a ppid cycle cannot hang the walk', () => {
    expect(hostOverhead([N(900, 1, 1024, 'node.exe')], 900, [900])).toMatchObject({ selfMb: 1, consoleMb: 0 })
    const cyclic = [N(900, 901, 1024, 'node.exe'), N(901, 900, 1024, 'conhost.exe')]
    expect(hostOverhead(cyclic, 900, [])).toMatchObject({ selfMb: 1, consoleMb: 1, consoleCount: 1 })
  })

  it('without image names the memory is still counted, the console count is 0', () => {
    expect(hostOverhead([P(900, 1, 1024), P(901, 900, 2048)], 900, [])).toEqual({
      pid: 900,
      selfMb: 1,
      consoleMb: 2,
      consoleCount: 0,
      totalMb: 3
    })
  })
})

describe('collectSessionHostMemory: the host\'s own cost', () => {
  const table = [
    N(900, 1, 60 * 1024, 'node.exe'),
    N(100, 900, 1024, 'pwsh.exe'),
    N(101, 100, 300 * 1024, 'node.exe'),
    N(901, 900, 8 * 1024, 'conhost.exe')
  ]
  const listing = (over: Partial<SessionHostListing> = {}): SessionHostListing => ({
    running: true,
    names: ['nt-a'],
    sessions: [row('nt-a', 100)],
    hostPid: 900,
    ...over
  })

  it('rows are unchanged and the host is reported beside them', async () => {
    const r = await collectSessionHostMemory({ list: async () => listing(), readTable: async () => table, readMem: () => MEM })
    expect(r.rows.map((x) => [x.session, x.totalMb])).toEqual([['nt-a', 301]])
    expect(r.host).toEqual({ pid: 900, selfMb: 60, consoleMb: 8, consoleCount: 1, totalMb: 68 })
  })

  it('an idle host (no sessions) is still measured', async () => {
    const r = await collectSessionHostMemory({
      list: async () => listing({ names: [], sessions: [] }),
      readTable: async () => table.filter((e) => e.pid === 900 || e.pid === 901),
      readMem: () => MEM
    })
    expect(r).toEqual({ ok: true, rows: [], mem: MEM, host: { pid: 900, selfMb: 60, consoleMb: 8, consoleCount: 1, totalMb: 68 } })
  })

  it('with no session to describe, an unreadable table is still the "no sessions" answer', async () => {
    const r = await collectSessionHostMemory({
      list: async () => listing({ names: [], sessions: [] }),
      readTable: async () => null,
      readMem: () => MEM
    })
    expect(r).toEqual({ ok: true, rows: [], mem: MEM })
  })

  it('a host pid missing from the table leaves host undefined and the rows ok', async () => {
    const r = await collectSessionHostMemory({
      list: async () => listing({ hostPid: 4242 }),
      readTable: async () => table,
      readMem: () => MEM
    })
    expect(r.ok).toBe(true)
    expect(r.rows).toHaveLength(1)
    expect(r.host).toBeUndefined()
  })

  it('an undescribed session would be booked as overhead, so the host is not reported', async () => {
    const r = await collectSessionHostMemory({
      list: async () => listing({ names: ['nt-a', 'nt-b'] }),
      readTable: async () => table,
      readMem: () => MEM
    })
    expect(r.unmeasured).toBe(1)
    expect(r.host).toBeUndefined()
  })

  it('a described session outside nt- is not a row, and its shell is not booked as host overhead', async () => {
    const extra = [...table, N(200, 900, 1024, 'cmd.exe'), N(201, 200, 500 * 1024, 'node.exe')]
    const r = await collectSessionHostMemory({
      list: async () => listing({ names: ['nt-a', 'other'], sessions: [row('nt-a', 100), row('other', 200)] }),
      readTable: async () => extra,
      readMem: () => MEM
    })
    expect(r.rows.map((x) => x.session)).toEqual(['nt-a'])
    expect(r.host).toEqual({ pid: 900, selfMb: 60, consoleMb: 8, consoleCount: 1, totalMb: 68 })
  })

  it('an UNDESCRIBED session outside nt- withholds the host line (its shell could not be excluded)', async () => {
    const extra = [...table, N(200, 900, 500 * 1024, 'cmd.exe')]
    const r = await collectSessionHostMemory({
      list: async () => listing({ names: ['nt-a', 'other'] }),
      readTable: async () => extra,
      readMem: () => MEM
    })
    expect(r.unmeasured).toBeUndefined()
    expect(r.rows).toHaveLength(1)
    expect(r.host).toBeUndefined()
  })

  it('ok:false carries no host', async () => {
    const r = await collectSessionHostMemory({ list: async () => listing(), readTable: async () => null, readMem: () => MEM })
    expect(r).toEqual({ ok: false, rows: [], mem: MEM })
  })
})

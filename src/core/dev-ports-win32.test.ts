// The Windows leg of dev-server port discovery: the session host's panes + one PowerShell call,
// joined by the same `assembleDevPorts`. Runs on every CI host — the platform, the host listing and
// the PowerShell output are all injected.
import { describe, it, expect, vi } from 'vitest'
import {
  collectLocalDevPorts,
  collectWin32DevPorts,
  parseNetstatListeners,
  parseWin32DevPortsProbe,
  parseWin32ProcRows,
  parseWinNetTcpListeners,
  WIN32_DEV_PORTS_SCRIPT
} from './dev-ports'
import { powershellArgs, powershellExe } from './win32-powershell'
import type { SessionHostListing } from './session-host-client'

const PROCS_JSON = JSON.stringify([
  { ProcessId: 4000, ParentProcessId: 900, Name: 'pwsh.exe' },
  { ProcessId: 4100, ParentProcessId: 4000, Name: 'node.exe' },
  { ProcessId: 4200, ParentProcessId: 4100, Name: 'esbuild.exe' },
  { ProcessId: 7000, ParentProcessId: 1, Name: 'svchost.exe' }
])

const NETTCP_JSON = JSON.stringify([
  { LocalAddress: '127.0.0.1', LocalPort: 5173, OwningProcess: 4200 },
  { LocalAddress: '::1', LocalPort: 5173, OwningProcess: 4200 },
  { LocalAddress: '0.0.0.0', LocalPort: 135, OwningProcess: 7000 },
  { LocalAddress: '::', LocalPort: 50123, OwningProcess: 4100 }
])

const NETSTAT = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       7000',
  '  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       4200',
  '  TCP    127.0.0.1:5173         127.0.0.1:61000        ESTABLISHED     4200',
  '  TCP    [::]:3000              [::]:0                 ABHÖREN         4100',
  '  TCP    [::1]:5173             [::]:0                 LISTENING       4200',
  '  UDP    0.0.0.0:5353           *:*                                    1234'
].join('\r\n')

const probe = (via: 'nettcp' | 'netstat', body: string): string =>
  ['##PROCS', PROCS_JSON, '##LISTEN', `##VIA ${via}`, body, '##END', ''].join('\r\n')

const listing = (over: Partial<SessionHostListing> = {}): SessionHostListing => ({
  running: true,
  names: ['nt-web'],
  sessions: [{ name: 'nt-web', pid: 4000, subscribers: 1, lastOutputMs: 1, createdMs: 1, generation: 'gen-aaaaaaaa' }],
  ...over
})
const PANES = [{ session: 'nt-web', panePid: 4000, command: '' }]

describe('Windows parsers', () => {
  it('Win32_Process rows: basename without .exe; a single object is one row; bad JSON is null', () => {
    expect(parseWin32ProcRows(PROCS_JSON)?.map((p) => p.command)).toEqual(['pwsh', 'node', 'esbuild', 'svchost'])
    expect(parseWin32ProcRows('{"ProcessId":1,"ParentProcessId":0,"Name":"System"}')).toEqual([
      { pid: 1, ppid: 0, command: 'System' }
    ])
    expect(parseWin32ProcRows('nope')).toBeNull()
  })

  it('Get-NetTCPConnection: owner is the kernel pid field; IPv6 wildcard normalized', () => {
    expect(parseWinNetTcpListeners(NETTCP_JSON)).toEqual([
      { owners: [{ pid: 4200, command: '' }], address: '127.0.0.1', port: 5173 },
      { owners: [{ pid: 4200, command: '' }], address: '::1', port: 5173 },
      { owners: [{ pid: 7000, command: '' }], address: '0.0.0.0', port: 135 },
      { owners: [{ pid: 4100, command: '' }], address: '::', port: 50123 }
    ])
    expect(parseWinNetTcpListeners('{"LocalAddress":"::ffff:127.0.0.1","LocalPort":8080,"OwningProcess":5}')).toEqual([
      { owners: [{ pid: 5, command: '' }], address: '127.0.0.1', port: 8080 }
    ])
    expect(parseWinNetTcpListeners('')).toEqual([])
    expect(parseWinNetTcpListeners('{oops')).toBeNull()
  })

  it('netstat -ano: listeners by foreign port 0, whatever language the state column is in', () => {
    expect(parseNetstatListeners(NETSTAT)).toEqual([
      { owners: [{ pid: 7000, command: '' }], address: '0.0.0.0', port: 135 },
      { owners: [{ pid: 4200, command: '' }], address: '127.0.0.1', port: 5173 },
      { owners: [{ pid: 4100, command: '' }], address: '::', port: 3000 },
      { owners: [{ pid: 4200, command: '' }], address: '::1', port: 5173 }
    ])
  })
})

describe('parseWin32DevPortsProbe', () => {
  it('attributes a listener two processes below the pane, and nobody else\'s', () => {
    const r = parseWin32DevPortsProbe(probe('nettcp', NETTCP_JSON), PANES)
    expect(r.ok).toBe(true)
    expect(Object.keys(r.nodes)).toEqual(['web'])
    expect(r.nodes.web).toEqual([
      { port: 5173, addresses: ['127.0.0.1', '::1'], command: 'esbuild', ephemeral: false },
      { port: 50123, addresses: ['::'], command: 'node', ephemeral: true }
    ])
  })

  it('the netstat fallback feeds the same join', () => {
    const r = parseWin32DevPortsProbe(probe('netstat', NETSTAT), PANES)
    expect(r.nodes.web?.map((p) => p.port)).toEqual([3000, 5173])
  })

  it('every malformed stream is unreachable, never "no ports"', () => {
    const unreachable = { ok: false, reason: 'unreachable', nodes: {} }
    expect(parseWin32DevPortsProbe('', PANES)).toEqual(unreachable)
    expect(parseWin32DevPortsProbe(probe('nettcp', NETTCP_JSON).replace('##END', ''), PANES)).toEqual(unreachable)
    expect(parseWin32DevPortsProbe(probe('nettcp', '{bad'), PANES)).toEqual(unreachable)
    expect(parseWin32DevPortsProbe(probe('nettcp', NETTCP_JSON).replace(PROCS_JSON, ''), PANES)).toEqual(unreachable)
    expect(parseWin32DevPortsProbe(probe('nettcp', NETTCP_JSON).replace('##VIA nettcp', '##VIA what'), PANES)).toEqual(
      unreachable
    )
  })

  it('the script is fenced with the same markers and carries no double quote (one argv element)', () => {
    for (const marker of ["'##PROCS'", "'##LISTEN'", "'##VIA nettcp'", "'##VIA netstat'", "'##END'"]) {
      expect(WIN32_DEV_PORTS_SCRIPT).toContain(marker)
    }
    expect(WIN32_DEV_PORTS_SCRIPT).not.toContain('"')
    expect(WIN32_DEV_PORTS_SCRIPT).toContain('exit 1')
  })
})

describe('collectWin32DevPorts / collectLocalDevPorts(win32)', () => {
  it('runs ONE PowerShell call through the seam and joins the host pane', async () => {
    const calls: Array<{ bin: string; args: string[] }> = []
    const r = await collectLocalDevPorts({
      tmuxBin: () => null,
      platformName: 'win32',
      sessionHost: async () => listing(),
      execWin: async (bin, args) => {
        calls.push({ bin, args })
        return probe('nettcp', NETTCP_JSON)
      }
    })
    expect(calls).toEqual([{ bin: powershellExe(), args: powershellArgs(WIN32_DEV_PORTS_SCRIPT) }])
    expect(r.ok).toBe(true)
    expect(r.nodes.web?.[0].port).toBe(5173)
  })

  it('no session host as the backend is unsupported, and runs nothing', async () => {
    const execWin = vi.fn(async () => '')
    const r = await collectLocalDevPorts({ tmuxBin: () => null, platformName: 'win32', sessionHost: () => undefined, execWin })
    expect(r).toEqual({ ok: false, reason: 'unsupported', nodes: {} })
    expect(execWin).not.toHaveBeenCalled()
  })

  it('a failed host read, or an older host without pids, is unreachable — never unsupported', async () => {
    const execWin = vi.fn(async () => probe('nettcp', NETTCP_JSON))
    expect((await collectWin32DevPorts(Promise.resolve(null), execWin)).reason).toBe('unreachable')
    expect((await collectWin32DevPorts(Promise.reject(new Error('pipe')), execWin)).reason).toBe('unreachable')
    expect((await collectWin32DevPorts(Promise.resolve(listing({ sessions: null })), execWin)).reason).toBe('unreachable')
    expect(execWin).not.toHaveBeenCalled()
  })

  it('a non-zero PowerShell exit (the exec rejects) is unreachable', async () => {
    const r = await collectWin32DevPorts(Promise.resolve(listing()), async () => {
      throw new Error('Command failed: exit 1')
    })
    expect(r).toEqual({ ok: false, reason: 'unreachable', nodes: {} })
  })

  it('no host running, or no nt- session, is an empty answer that spawns no PowerShell', async () => {
    const execWin = vi.fn(async () => '')
    expect(await collectWin32DevPorts(Promise.resolve({ running: false, names: [], sessions: [] }), execWin)).toEqual({
      ok: true,
      nodes: {}
    })
    expect(await collectWin32DevPorts(Promise.resolve(listing({ names: [], sessions: [] })), execWin)).toEqual({
      ok: true,
      nodes: {}
    })
    expect(execWin).not.toHaveBeenCalled()
  })

  it('a POSIX platform never takes the Windows leg', async () => {
    const sessionHost = vi.fn(async () => listing())
    const exec = vi.fn(async () => '')
    await collectLocalDevPorts({ tmuxBin: () => '/usr/bin/tmux', platformName: 'linux', sessionHost, exec })
    expect(sessionHost).not.toHaveBeenCalled()
    expect(exec).toHaveBeenCalledTimes(1)
  })
})

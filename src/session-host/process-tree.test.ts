import { describe, expect, it } from 'vitest'
import {
  createProcessTableReader,
  paneCommandFromRows,
  readWin32,
  readWin32OneShot,
  WIN32_PANE_TABLE_SCRIPT,
  type ProcRow
} from './process-tree'
import { powershellArgs } from '../core/win32-powershell'

const row = (pid: number, ppid: number, name: string): ProcRow => ({ pid, ppid, name })

describe('paneCommandFromRows', () => {
  it('answers the idle shell when it has no children', () => {
    expect(paneCommandFromRows([row(10, 1, 'pwsh.exe')], 10)).toBe('pwsh.exe')
  })

  it('answers null when the root is gone', () => {
    expect(paneCommandFromRows([row(11, 1, 'pwsh.exe')], 10)).toBeNull()
  })

  it('answers a nested shell the user typed into (pwsh -> cmd)', () => {
    expect(paneCommandFromRows([row(10, 1, 'pwsh.exe'), row(20, 10, 'cmd.exe')], 10)).toBe('cmd.exe')
  })

  it('answers the agent, not the shell its tool spawned as a leaf (pwsh -> node -> bash.exe)', () => {
    const rows = [row(10, 1, 'pwsh.exe'), row(20, 10, 'node.exe'), row(30, 20, 'bash.exe')]
    expect(paneCommandFromRows(rows, 10)).toBe('node.exe')
  })

  it('answers a non-shell for an MCP server launched via cmd /c (node -> cmd -> node)', () => {
    const rows = [
      row(10, 1, 'pwsh.exe'),
      row(20, 10, 'cmd.exe'),
      row(30, 20, 'node.exe'),
      row(40, 30, 'cmd.exe'),
      row(50, 30, 'powershell.exe')
    ]
    expect(paneCommandFromRows(rows, 10)).toBe('node.exe')
  })

  it('still answers the deepest non-shell process otherwise', () => {
    const rows = [row(10, 1, 'pwsh.exe'), row(20, 10, 'node.exe'), row(30, 20, 'codex.exe')]
    expect(paneCommandFromRows(rows, 10)).toBe('codex.exe')
  })

  it('answers a non-shell root (a session spawned straight into a program)', () => {
    expect(paneCommandFromRows([row(10, 1, 'node.exe'), row(20, 10, 'cmd.exe')], 10)).toBe('node.exe')
  })
})

describe('createProcessTableReader', () => {
  it('ten concurrent reads share ONE table read', async () => {
    let reads = 0
    let release: (rows: ProcRow[]) => void = () => {}
    const reader = createProcessTableReader(() => {
      reads++
      return new Promise<ProcRow[]>((r) => (release = r))
    })
    const all = Array.from({ length: 10 }, () => reader())
    release([row(10, 1, 'pwsh.exe')])
    const results = await Promise.all(all)
    expect(reads).toBe(1)
    expect(results.every((r) => r.length === 1)).toBe(true)
  })

  it('a settled read is never reused: the next call reads again (the exit poll needs two observations)', async () => {
    let reads = 0
    const reader = createProcessTableReader(async () => {
      reads++
      return [row(10, 1, 'pwsh.exe')]
    })
    await reader()
    await reader()
    expect(reads).toBe(2)
  })

  it('a failed or throwing read is [] and is not shared with later callers', async () => {
    let reads = 0
    const reader = createProcessTableReader(async () => {
      reads++
      if (reads === 1) throw new Error('boom')
      return []
    })
    await expect(reader()).resolves.toEqual([])
    await expect(reader()).resolves.toEqual([])
    expect(reads).toBe(2)
  })
})

describe('readWin32', () => {
  const table = [{ ProcessId: 10, ParentProcessId: 1, Name: 'pwsh.exe' }]

  it('answers from the probe worker without a one-shot PowerShell', async () => {
    let oneShots = 0
    const rows = await readWin32(
      { request: async () => ({ kind: 'ok', result: table }) },
      async () => {
        oneShots++
        return []
      }
    )
    expect(rows).toEqual([row(10, 1, 'pwsh.exe')])
    expect(oneShots).toBe(0)
  })

  it('a worker that cannot answer falls back to the one-shot read; a failed probe is a failed read', async () => {
    const fallback = async (): Promise<ProcRow[]> => [row(1, 0, 'System')]
    await expect(readWin32({ request: async () => ({ kind: 'unavailable' }) }, fallback)).resolves.toEqual([
      row(1, 0, 'System')
    ])
    await expect(readWin32(null, fallback)).resolves.toEqual([row(1, 0, 'System')])
    await expect(readWin32({ request: async () => ({ kind: 'failed' }) }, fallback)).resolves.toEqual([])
  })

  it('the one-shot read runs the ABSOLUTE System32 PowerShell, once', async () => {
    const calls: Array<{ file: string; args: string[] }> = []
    const rows = await readWin32OneShot(
      (file, args, _opts, cb) => {
        calls.push({ file, args })
        cb(null, JSON.stringify(table[0]))
      },
      { SystemRoot: 'D:\\Windows' }
    )
    expect(calls).toEqual([{ file: 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: powershellArgs(WIN32_PANE_TABLE_SCRIPT) }])
    expect(rows).toEqual([row(10, 1, 'pwsh.exe')])
  })

  it('an unreadable one-shot reply is a failed read ([])', async () => {
    await expect(readWin32OneShot((_f, _a, _o, cb) => cb(null, 'not json'), {})).resolves.toEqual([])
    await expect(readWin32OneShot((_f, _a, _o, cb) => cb(new Error('timeout'), ''), {})).resolves.toEqual([])
  })
})

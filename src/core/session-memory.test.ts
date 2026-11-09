import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import {
  indexProcesses,
  rollupTree,
  parseProcessTable,
  parsePaneList,
  buildReport,
  collectSessionHostMemory,
  collectSessionMemory,
  defaultProcessTableReader,
  isNoServerError,
  processLabel,
  type ProcEntry,
  type SessionMemoryReport
} from './session-memory'
import type { SessionHostListing } from './session-host-client'

const P = (pid: number, ppid: number, rssKb: number): ProcEntry => ({ pid, ppid, rssKb })

describe('indexProcesses + rollupTree', () => {
  it('sums a pane pid and every descendant, splitting self from children', () => {
    // pane(100) -> claude(200) -> mcp(300), and claude also has mcp2(301)
    const { table, kids } = indexProcesses([
      P(100, 1, 1024),
      P(200, 100, 350 * 1024),
      P(300, 200, 30 * 1024),
      P(301, 200, 20 * 1024)
    ])
    const r = rollupTree(table, kids, 100)
    expect(r.selfMb).toBe(1)
    expect(r.childrenMb).toBe(400)
    expect(r.childCount).toBe(3)
    expect(r.totalMb).toBe(401)
  })

  it('returns zeros for a pid that is not in the table', () => {
    const { table, kids } = indexProcesses([P(100, 1, 1024)])
    expect(rollupTree(table, kids, 999)).toEqual({
      selfMb: 0,
      childrenMb: 0,
      childCount: 0,
      totalMb: 0,
      largestMb: 0
    })
  })

  it('names the largest process wherever it sits in the tree, without taking it out of the total', () => {
    // The row's number is the whole tree, and the shell at its root is a few MB. What a reader
    // needs next is which process holds it: here a grandchild, not the pane's direct child.
    const { table, kids } = indexProcesses([
      { ...P(100, 1, 4 * 1024), name: '-zsh' },
      { ...P(200, 100, 500 * 1024), name: 'claude' },
      { ...P(300, 200, 900 * 1024), name: 'dart' }
    ])
    const r = rollupTree(table, kids, 100)
    expect(r.largestName).toBe('dart')
    expect(r.largestMb).toBe(900)
    expect(r.totalMb).toBe(1404)
  })

  it('can name the pane root itself: a pane started directly on the agent has no bigger child', () => {
    const { table, kids } = indexProcesses([
      { ...P(100, 1, 300 * 1024), name: 'claude' },
      { ...P(200, 100, 20 * 1024), name: 'node' }
    ])
    expect(rollupTree(table, kids, 100)).toMatchObject({ largestName: 'claude', largestMb: 300 })
  })

  it('reports the largest size with no name when the reader has none', () => {
    const { table, kids } = indexProcesses([P(100, 1, 1024), P(200, 100, 2048)])
    const r = rollupTree(table, kids, 100)
    expect(r.largestMb).toBe(2)
    expect(r.largestName).toBeUndefined()
  })

  it('does not loop forever on a cyclic ppid chain', () => {
    // A pid whose parent chain points back at it must not hang the sweep.
    const { table, kids } = indexProcesses([P(100, 200, 1024), P(200, 100, 1024)])
    const r = rollupTree(table, kids, 100)
    expect(r.totalMb).toBe(2)
    expect(r.childCount).toBe(1)
  })
})

describe('processLabel', () => {
  it('reads an absolute path by its file name, spaces included', () => {
    expect(processLabel('/bin/zsh')).toBe('zsh')
    expect(processLabel('/Applications/Wow Keywords.app/Contents/MacOS/Wow Keywords')).toBe('Wow Keywords')
  })

  it('leaves a process title alone even when it holds a slash', () => {
    // macOS `ps` prints a retitled process verbatim. A basename here would print `mcp@latest`.
    expect(processLabel('npm exec @playwright/mcp@latest')).toBe('npm exec @playwright/mcp@latest')
  })

  it('drops the leading dash of a login shell', () => {
    expect(processLabel('-zsh')).toBe('zsh')
  })

  it('strips control and format characters: a process title is whatever the process set', () => {
    expect(processLabel('cla\u0007ude\u202e')).toBe('claude')
  })

  it('caps a long title', () => {
    const label = processLabel('x'.repeat(200)) as string
    expect(Array.from(label)).toHaveLength(40)
    expect(label.endsWith('…')).toBe(true)
  })

  it('answers nothing when there is nothing left to show', () => {
    expect(processLabel(undefined)).toBeUndefined()
    expect(processLabel('')).toBeUndefined()
    expect(processLabel('\u0007')).toBeUndefined()
  })
})

describe('parseProcessTable', () => {
  it('keeps the name column, spaces included', () => {
    const out = parseProcessTable(
      '  PID  PPID    RSS COMM\n  100     1   1024 /Applications/Wow Keywords.app/Contents/MacOS/Wow Keywords\n  200   100   2048 claude\n'
    )
    expect(out.map((e) => e.name)).toEqual([
      '/Applications/Wow Keywords.app/Contents/MacOS/Wow Keywords',
      'claude'
    ])
  })

  it('still reads a three-column table, with no name', () => {
    expect(parseProcessTable('100 1 1024\n')[0].name).toBeUndefined()
  })

  it('parses ps output and skips the header and malformed lines', () => {
    const out = parseProcessTable(
      '  PID  PPID    RSS COMMAND\n' +
        '  100     1   1024 tmux\n' +
        'garbage line\n' +
        '  200   100 358400 claude\n'
    )
    expect(out).toEqual([
      { pid: 100, ppid: 1, rssKb: 1024, name: 'tmux' },
      { pid: 200, ppid: 100, rssKb: 358400, name: 'claude' }
    ])
  })

  it('returns an empty array for empty input rather than throwing', () => {
    expect(parseProcessTable('')).toEqual([])
  })
})

describe('parsePaneList', () => {
  it('parses the pipe-delimited pane list and skips malformed lines', () => {
    // `nt-zero||sh` is the phantom case: an empty pid field parses as 0, which IS finite, so a
    // finite-only guard would emit a 0 MB row for a pid that cannot exist.
    expect(
      parsePaneList('nt-term-a|100|claude\nbroken\nnt-term-b|200|zsh\n|300|x\nnt-zero||sh\n')
    ).toEqual([
      { session: 'nt-term-a', panePid: 100, command: 'claude' },
      { session: 'nt-term-b', panePid: 200, command: 'zsh' }
    ])
  })
})

describe('buildReport', () => {
  it('rolls up each nt- session and sorts by total descending', () => {
    const r = buildReport(
      [
        { session: 'nt-small', panePid: 100, command: 'zsh' },
        { session: 'nt-big', panePid: 200, command: 'claude' }
      ],
      [
        P(100, 1, 40 * 1024),
        P(200, 1, 350 * 1024),
        P(201, 200, 50 * 1024)
      ],
      { availableMb: 1000, totalMb: 64000 }
    )
    expect(r.ok).toBe(true)
    expect(r.rows.map((x) => x.session)).toEqual(['nt-big', 'nt-small'])
    expect(r.rows[0]).toMatchObject({
      nodeId: 'big',
      totalMb: 400,
      selfMb: 350,
      childrenMb: 50,
      childCount: 1,
      command: 'claude'
    })
  })

  it('ignores sessions that are not nt- prefixed', () => {
    const r = buildReport(
      [{ session: 'my-own-tmux', panePid: 100, command: 'zsh' }],
      [P(100, 1, 40 * 1024)],
      null
    )
    expect(r.rows).toEqual([])
  })
})

describe('collectSessionMemory', () => {
  const table = [P(100, 1, 40 * 1024), P(200, 1, 350 * 1024)]

  it('reports ok:false with no rows when the process table cannot be read', async () => {
    const r = await collectSessionMemory({
      tmuxBin: () => '/usr/bin/tmux',
      sockets: ['s1'],
      exec: async () => 'nt-a|100|claude\n',
      readTable: () => null,
      readMem: () => ({ availableMb: 1, totalMb: 2 })
    })
    // "could not look" must never render as "uses nothing".
    expect(r.ok).toBe(false)
    expect(r.rows).toEqual([])
    // The host total is still a real reading — the failure path must not throw it away.
    expect(r.mem).toEqual({ availableMb: 1, totalMb: 2 })
  })

  it('reports ok:true with no rows when tmux has no server (a real answer)', async () => {
    const r = await collectSessionMemory({
      tmuxBin: () => '/usr/bin/tmux',
      sockets: ['s1'],
      exec: async () => {
        throw new Error('no server running')
      },
      readTable: () => table,
      readMem: () => null
    })
    expect(r.ok).toBe(true)
    expect(r.rows).toEqual([])
  })

  it('reports ok:false when tmux is unavailable entirely', async () => {
    const r = await collectSessionMemory({ tmuxBin: () => null, readTable: () => table })
    expect(r.ok).toBe(false)
    expect(r.rows).toEqual([])
  })

  it('counts "no server" as an answer but a permission failure as a failure', () => {
    expect(isNoServerError('no server running on /tmp/tmux-0/node-terminal')).toBe(true)
    expect(isNoServerError('error connecting to /tmp/x (No such file or directory)')).toBe(true)
    // A socket dir we may not read says nothing about whether sessions exist there.
    expect(isNoServerError('error connecting to /tmp/x (Permission denied)')).toBe(false)
    expect(isNoServerError('killed: timeout')).toBe(false)
    // The regression the anchor exists for: stderr that merely CONTAINS the errno phrase. A tmux
    // client that cannot load a library fails this way on EVERY socket — same binary — so counting
    // it as an answer would print "no sessions" while the already-running server holds live ones.
    expect(
      isNoServerError(
        'Command failed: tmux -L node-terminal list-panes\ntmux: error while loading shared ' +
          'libraries: libtinfo.so.6: cannot open shared object file: No such file or directory'
      )
    ).toBe(false)
    // Same shape one layer out: a dead ssh ControlMaster, which this sweep may later run over.
    expect(isNoServerError('Control socket connect(/tmp/cm.sock): No such file or directory')).toBe(
      false
    )
  })

  it('reports ok:false when NO socket answered', async () => {
    // One socket erroring is normal (nobody used it). Every socket erroring means we never looked,
    // and "we never looked" must not render as "there are no sessions".
    const r = await collectSessionMemory({
      tmuxBin: () => '/usr/bin/tmux',
      sockets: ['s1', 's2'],
      exec: async () => {
        throw new Error('connect failed')
      },
      readTable: () => table,
      readMem: () => null
    })
    expect(r.ok).toBe(false)
    expect(r.rows).toEqual([])
  })

  it('merges panes from every socket and the first socket wins a duplicate session', async () => {
    const r = await collectSessionMemory({
      tmuxBin: () => '/usr/bin/tmux',
      sockets: ['s1', 's2'],
      exec: async (_bin, args) =>
        args[1] === 's1' ? 'nt-a|100|zsh\n' : 'nt-b|200|claude\nnt-a|999|claude\n',
      readTable: () => table,
      readMem: () => null
    })
    expect(r.rows.map((x) => x.session).sort()).toEqual(['nt-a', 'nt-b'])
    // s2 also reported nt-a, with a different pid and command: s1's entry must be the one kept.
    expect(r.rows.find((x) => x.session === 'nt-a')).toMatchObject({
      panePid: 100,
      command: 'zsh'
    })
  })

  it('routes the ps fallback through the injected exec seam', async () => {
    // With no readTable injected the default /proc reader runs first; make it fail so the `ps`
    // fallback is reached on every platform, including the Linux box this suite runs on.
    const spy = vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw new Error('/proc unreadable')
    })
    try {
      const calls: string[] = []
      const r = await collectSessionMemory({
        tmuxBin: () => '/usr/bin/tmux',
        sockets: ['s1'],
        exec: async (bin) => {
          calls.push(bin)
          if (bin === 'ps') return '  PID  PPID    RSS\n  100     1   1024\n'
          return 'nt-a|100|zsh\n'
        },
        readMem: () => null
      })
      // The `ps` call must come THROUGH the seam, not around it — otherwise this path can never
      // be driven by a test and the file's "every exec is injectable" promise is false.
      expect(calls).toContain('ps')
      expect(r.ok).toBe(true)
      expect(r.rows[0]).toMatchObject({ session: 'nt-a', selfMb: 1 })
    } finally {
      spy.mockRestore()
    }
  })
})

import { parseVmStat, darwinMemInfo, parseTopFootprint } from './session-memory'

/** Shaped from Apple's documented `vm_stat` format, at a 16 KiB page (Apple Silicon). COMPOSED, not
 *  captured — nobody in this loop has a Mac. Numbers chosen so the arithmetic is checkable by hand:
 *  anonymous 800k - purgeable 50k + wired 150k + compressor 100k = 1,000,000 pages.
 *  1,000,000 x 16384 B = 15625 MiB used of a 24576 MiB machine, i.e. 8951 MiB available. */
const VM_STAT = [
  'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
  'Pages free:                                50000.',
  'Pages active:                             600000.',
  'Pages inactive:                           400000.',
  'Pages speculative:                         30000.',
  'Pages throttled:                               0.',
  'Pages wired down:                         150000.',
  'Pages purgeable:                           50000.',
  '"Translation faults":                  987654321.',
  'Pages occupied by compressor:             100000.',
  'File-backed pages:                        700000.',
  'Anonymous pages:                          800000.'
].join('\n')

const TOTAL_BYTES = 24576 * 1048576

describe('parseVmStat', () => {
  it('reports app+wired+compressed as used, not the near-zero free page count', () => {
    // The bug this exists for: `Pages free` is 50000 (≈781 MiB) on a machine with 8.4 GiB genuinely
    // available, because macOS holds the rest as reclaimable cache.
    expect(parseVmStat(VM_STAT, TOTAL_BYTES)).toEqual({ availableMb: 8951, totalMb: 24576 })
  })

  it('reads the page size from the header rather than assuming 4096', () => {
    // Same class as the Linux statm bug: a hard-coded 4096 would report a QUARTER of the real usage
    // on Apple Silicon, i.e. an alarmingly empty machine.
    const fourK = parseVmStat(VM_STAT.replace('16384 bytes', '4096 bytes'), TOTAL_BYTES)
    // 1,000,000 x 4096 B = 3906 MiB, so the machine would read 5044 MiB emptier than it is.
    expect(fourK).toEqual({ availableMb: 20670, totalMb: 24576 })
  })

  it('subtracts purgeable pages from anonymous — they are droppable cache, not app memory', () => {
    const noPurge = parseVmStat(VM_STAT.replace(/Pages purgeable:.*\n/, ''), TOTAL_BYTES)
    // Without the subtraction the machine reads 50000 pages (781 MiB) fuller than it is.
    expect(noPurge?.availableMb).toBe(8951 - 781)
  })

  it('returns null when a field it needs is missing, rather than a partial number', () => {
    expect(parseVmStat(VM_STAT.replace(/Pages wired down:.*\n/, ''), TOTAL_BYTES)).toBeNull()
    expect(parseVmStat('not vm_stat output', TOTAL_BYTES)).toBeNull()
    expect(parseVmStat(VM_STAT, 0)).toBeNull()
  })

  it('never reports negative availability on a heavily compressed machine', () => {
    const tiny = parseVmStat(VM_STAT, 1024 * 1048576)
    expect(tiny?.availableMb).toBe(0)
  })
})

describe('darwinMemInfo', () => {
  it('reports null when vm_stat cannot run — never the os.freemem() value', () => {
    // The whole point. Falling back to os.freemem() here would restore the bug: on macOS it reads
    // near zero, the reaper's 10%-of-RAM watermark reads as permanent pressure, and idle detached
    // sessions get reaped every sweep. A confirmed field symptom ("my sessions keep disappearing").
    // planReap treats null as NO pressure, so no signal is the safe answer.
    expect(
      darwinMemInfo(() => {
        throw new Error('spawn vm_stat ENOENT')
      }, TOTAL_BYTES)
    ).toBeNull()
  })

  it('reports null on output it cannot parse', () => {
    expect(darwinMemInfo(() => 'garbage', TOTAL_BYTES)).toBeNull()
  })

  it('passes a good reading through', () => {
    expect(darwinMemInfo(() => VM_STAT, TOTAL_BYTES)).toEqual({ availableMb: 8951, totalMb: 24576 })
  })
})

/** CAPTURED from a real Mac (2026-08-12), not composed: the exact header block, the blank line, the
 *  `PID    MEM` header and real rows. The bracketed spacing quirks the capture surfaced are kept —
 *  the MEM column is LEFT-aligned in five chars, so short values carry trailing spaces. */
const TOP_REAL = [
  'Processes: 973 total, 5 running, 968 sleeping, 5566 threads',
  '2026/08/12 04:40:17',
  'Load Avg: 4.13, 4.82, 6.19',
  'CPU usage: 22.1% user, 19.11% sys, 58.86% idle',
  'SharedLibs: 501M resident, 114M data, 85M linkedit.',
  'MemRegions: 887125 total, 6692M resident, 248M private, 2163M shared.',
  'PhysMem: 23G used (2941M wired, 8908M compressor), 83M unused.',
  'VM: 460T vsize, 6144M framework vsize, 210882(0) swapins, 517764(0) swapouts.',
  'Networks: packets: 754492311/1003G in, 62312609/20G out.',
  'Disks: 43587984/769G read, 23106973/357G written.',
  '',
  'PID    MEM  ',
  '99554  3696K',
  '99132  6288K',
  '98779  12M  ',
  '97530  8433K',
  '97519  29M  ',
  '70698  1314M',
  '0      36M  '
].join('\n')

describe('parseTopFootprint', () => {
  it('parses the real capture, including the left-aligned trailing spaces', () => {
    const m = parseTopFootprint(TOP_REAL)
    expect(m.get(99554)).toBe(3696)
    expect(m.get(8433)).toBeUndefined()
    expect(m.get(97530)).toBe(8433)
    // `12M  ` carries two trailing spaces — the quirk that makes a /M$/ regex miss two thirds of
    // the column on a real host.
    expect(m.get(98779)).toBe(12 * 1024)
    expect(m.get(70698)).toBe(1314 * 1024)
  })

  it('reads pid 0 (kernel_task), which is present and accessible', () => {
    expect(parseTopFootprint(TOP_REAL).get(0)).toBe(36 * 1024)
  })

  it('ignores the header block — those lines contain digits and units too', () => {
    // `PhysMem: 23G used (2941M wired, ...)` would be a tempting false match.
    const m = parseTopFootprint(TOP_REAL)
    expect(m.size).toBe(7)
  })

  it('accepts G even though it was never observed on the capture host', () => {
    // A 1314M process stayed in M, so the G threshold is unknown — but top's own header prints
    // `PhysMem: 23G`, so the unit exists and the parser must not choke on it.
    expect(parseTopFootprint('PID    MEM\n42     3G   ').get(42)).toBe(3 * 1024 * 1024)
  })

  it('SKIPS a row whose unit it does not recognise rather than guessing a scale', () => {
    // `B` and any restricted-process rendering were not observed on the capture host and are
    // deliberately not invented. A wrong scale is a wrong number presented as a fact.
    const m = parseTopFootprint('PID    MEM\n42     500Q \n43     7K')
    expect(m.has(42)).toBe(false)
    expect(m.get(43)).toBe(7)
  })

  it('returns an empty map when there is no PID/MEM header at all', () => {
    expect(parseTopFootprint('not top output').size).toBe(0)
  })
})

describe('collectSessionMemory on darwin', () => {
  const asDarwin = (fn: () => Promise<void>) => async (): Promise<void> => {
    const real = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    try {
      await fn()
    } finally {
      Object.defineProperty(process, 'platform', real)
    }
  }

  const run = async (): Promise<{ calls: string[]; rows: unknown }> => {
    const calls: string[] = []
    const r = await collectSessionMemory({
      tmuxBin: () => '/usr/bin/tmux',
      sockets: ['s1'],
      exec: async (bin, args) => {
        calls.push(bin)
        if (bin.includes('tmux')) return 'nt-a|4242|claude\n'
        if (bin === 'ps') return 'PID PPID RSS\n4242 1 100000\n'
        // 4242's footprint is DOUBLE its rss — the measured idle-process shape.
        return 'PID    MEM  \n4242   200000K'
      },
      readTable: undefined,
      readMem: () => null
    })
    return { calls, rows: r.rows }
  }

  it(
    'prefers phys_footprint over rss — the idle-session number rss halves',
    asDarwin(async () => {
      const { calls, rows } = await run()
      expect(calls).toContain('top')
      // 200000 kB, not the 100000 kB `ps` reported.
      expect((rows as { selfMb: number }[])[0].selfMb).toBe(Math.round(200000 / 1024))
    })
  )

  it(
    'asks ps for the process name, and says the rows are physical footprint',
    asDarwin(async () => {
      let psArgs: string[] = []
      const r = await collectSessionMemory({
        tmuxBin: () => '/usr/bin/tmux',
        sockets: ['s1'],
        exec: async (bin, args) => {
          if (bin.includes('tmux')) return 'nt-a|4242|claude\n'
          if (bin === 'ps') {
            psArgs = args
            return 'PID PPID RSS COMM\n4242 1 100000 -zsh\n'
          }
          return 'PID    MEM  \n4242   200000K'
        },
        readTable: undefined,
        readMem: () => null
      })
      expect(psArgs).toEqual(['-eo', 'pid,ppid,rss,comm'])
      expect(r.metric).toBe('footprint')
      expect(r.rows[0].largestName).toBe('zsh')
    })
  )

  it(
    'the "nodeterm itself" group reuses that SAME top read — footprint for a covered pid, nothing for a missed one',
    asDarwin(async () => {
      const calls: string[] = []
      const r = await collectSessionMemory({
        tmuxBin: () => '/usr/bin/tmux',
        sockets: ['s1'],
        exec: async (bin) => {
          calls.push(bin)
          if (bin.includes('tmux')) return 'nt-a|4242|claude\n'
          // 900 = the GPU helper: rss 120 MB. 901 = a renderer top did not list.
          if (bin === 'ps') return 'PID PPID RSS\n4242 1 100000\n900 1 122880\n901 1 307200\n'
          return 'PID    MEM  \n4242   200000K\n900    1600M\n'
        },
        readTable: undefined,
        readMem: () => null,
        appProcesses: () => [
          { pid: 900, type: 'GPU' },
          { pid: 901, type: 'Tab' }
        ]
      })
      // ONE top for the whole panel, sessions and app together (~0.5 s each, measured).
      expect(calls.filter((c) => c === 'top')).toHaveLength(1)
      expect(r.app?.groups).toEqual([
        { kind: 'gpu', count: 1, mb: 1600 },
        { kind: 'renderer', count: 1 }
      ])
    })
  )
})

import { parseMemInfoText, parsePsiMemory, readMemInfo } from './session-memory'

/** A verbatim excerpt of the production host's /proc/meminfo, 2026-08-15 (62.7 GB, swap 74% spent). */
const MEMINFO = `MemTotal:       65697400 kB
MemFree:         4154020 kB
MemAvailable:   13804628 kB
Buffers:          412300 kB
Cached:          9216440 kB
SwapCached:       501232 kB
SwapTotal:       8388604 kB
SwapFree:        2192260 kB
Dirty:               736 kB
`

const PSI = `some avg10=0.00 avg60=1.25 avg300=0.18 total=29288181130
full avg10=0.00 avg60=0.75 avg300=0.15 total=25621111809
`

describe('parseMemInfoText', () => {
  it('reads the required pair and the optional swap pair from ONE snapshot', () => {
    expect(parseMemInfoText(MEMINFO)).toEqual({
      availableMb: 13481,
      totalMb: 64158,
      swapTotalMb: 8192,
      swapFreeMb: 2141,
      // The pill's copy of the same instant, in the display-only object the reaper never reads.
      display: { swapUsedMb: 8192 - 2141, swapTotalMb: 8192 }
    })
  })

  it('MemAvailable/MemTotal are required — a /proc we do not understand yields NO reading', () => {
    // Not a partial object: a reading missing its primary field would be a number the watermark
    // could still compare against, which is the "wrong number presented as a fact" failure.
    expect(parseMemInfoText(MEMINFO.replace(/MemAvailable:.*\n/, ''))).toBeNull()
    expect(parseMemInfoText(MEMINFO.replace(/MemTotal:.*\n/, ''))).toBeNull()
    expect(parseMemInfoText('garbage')).toBeNull()
  })

  it('swap is OMITTED, not zeroed, when the kernel does not report it', () => {
    // The distinction the swap term depends on: `undefined` means "did not measure" and disables
    // the term, whereas `0` would read as "swap totally exhausted" and could only ever reap MORE.
    const noSwap = parseMemInfoText(MEMINFO.replace(/SwapTotal:.*\n/, '').replace(/SwapFree:.*\n/, ''))
    expect(noSwap).toEqual({ availableMb: 13481, totalMb: 64158 })
    expect(noSwap).not.toHaveProperty('swapTotalMb')
    expect(noSwap).not.toHaveProperty('swapFreeMb')
  })

  it('half a swap reading is no swap reading (a free without a total cannot be a ratio)', () => {
    const half = parseMemInfoText(MEMINFO.replace(/SwapTotal:.*\n/, ''))
    expect(half).not.toHaveProperty('swapFreeMb')
  })

  it('a swapless host reports a real zero TOTAL, which every consumer guard turns off', () => {
    const off = parseMemInfoText(MEMINFO.replace(/SwapTotal:.*/, 'SwapTotal:             0 kB').replace(/SwapFree:.*/, 'SwapFree:              0 kB'))
    expect(off).toMatchObject({ swapTotalMb: 0, swapFreeMb: 0 })
  })
})

describe('parsePsiMemory', () => {
  it('reads avg60 from both lines', () => {
    expect(parsePsiMemory(PSI)).toEqual({ psiSomeAvg60: 1.25, psiFullAvg60: 0.75 })
  })

  it('takes avg60 specifically — not avg10 and not avg300', () => {
    // The cadence argument: the reaper sweeps every 10 minutes, so avg10 is noise and avg300 stays
    // elevated through a recovery. Distinct values in every column make a mix-up visible.
    const distinct = 'some avg10=11.00 avg60=22.00 avg300=33.00 total=1\nfull avg10=44.00 avg60=55.00 avg300=66.00 total=2\n'
    expect(parsePsiMemory(distinct)).toEqual({ psiSomeAvg60: 22, psiFullAvg60: 55 })
  })

  it('does not confuse the some line for the full line', () => {
    expect(parsePsiMemory('some avg10=0.00 avg60=9.00 avg300=0.00 total=1\n')).toEqual({ psiSomeAvg60: 9 })
  })

  it('an unreadable or absent PSI file yields NO figures, never zeros', () => {
    expect(parsePsiMemory('')).toEqual({})
    expect(parsePsiMemory('garbage')).toEqual({})
    expect(parsePsiMemory('some avg10=0.00 avg300=0.18 total=1\n')).toEqual({})
  })
})

describe('readMemInfo on this Linux host (integration)', () => {
  const onLinux = it.skipIf(process.platform !== 'linux')

  onLinux('carries swap alongside the available/total pair', () => {
    const m = readMemInfo()
    expect(m).not.toBeNull()
    expect(m!.totalMb).toBeGreaterThan(0)
    // Swap is not guaranteed configured, but if the kernel reports a total it must report a free.
    if (m!.swapTotalMb !== undefined) {
      expect(m!.swapFreeMb).toBeDefined()
      expect(m!.swapFreeMb!).toBeLessThanOrEqual(m!.swapTotalMb!)
    }
  })

  onLinux('PSI is optional and never breaks the reading', () => {
    const m = readMemInfo()
    expect(m).not.toBeNull()
    if (m!.psiFullAvg60 !== undefined) expect(m!.psiFullAvg60).toBeGreaterThanOrEqual(0)
  })
})

import {
  appProcessKind,
  appSelfMemory,
  parsePressureLevel,
  parseSwapUsage,
  type AppProcessSample
} from './session-memory'

/** Captured live on a Mac, 2026-10-19 (`sysctl vm.swapusage`). */
const SWAPUSAGE = 'vm.swapusage: total = 9216.00M  used = 7853.62M  free = 1362.38M  (encrypted)\n'

describe('parseSwapUsage (darwin)', () => {
  it('reads used and total from the live string, prefixed or not', () => {
    expect(parseSwapUsage(SWAPUSAGE)).toEqual({ swapUsedMb: 7854, swapTotalMb: 9216 })
    expect(parseSwapUsage(SWAPUSAGE.replace('vm.swapusage: ', ''))).toEqual({ swapUsedMb: 7854, swapTotalMb: 9216 })
  })

  it('accepts K and G, and passes a real zero through', () => {
    expect(parseSwapUsage('total = 2.00G  used = 512.00K  free = 1.99G')).toEqual({ swapUsedMb: 1, swapTotalMb: 2048 })
    expect(parseSwapUsage('total = 0.00M  used = 0.00M  free = 0.00M')).toEqual({ swapUsedMb: 0, swapTotalMb: 0 })
  })

  it('an unknown unit or a missing half yields NOTHING, never a guessed scale or a zero', () => {
    expect(parseSwapUsage('total = 9216.00T  used = 1.00M  free = 1.00M')).toEqual({})
    expect(parseSwapUsage('total = 9216.00M  free = 1.00M')).toEqual({})
    expect(parseSwapUsage('')).toEqual({})
  })
})

describe('parsePressureLevel (darwin)', () => {
  it('maps xnu levels 1/2/4 and nothing else', () => {
    expect(parsePressureLevel('1')).toBe('normal')
    expect(parsePressureLevel('kern.memorystatus_vm_pressure_level: 2\n')).toBe('warn')
    expect(parsePressureLevel('4')).toBe('critical')
    for (const junk of ['0', '3', '12', '', 'unknown oid', 'kern.memorystatus_vm_pressure_level: 21'])
      expect(parsePressureLevel(junk)).toBeUndefined()
  })
})

describe('darwinMemInfo display extras', () => {
  /** One `sysctl <names…>` run: the known oids print their `name: value` lines, in order; an
   *  unknown one makes the run exit non-zero, which the caller hands over as the partial stdout
   *  (`readMemInfo`'s runner) — so here a run with no known oid at all throws. */
  const sysctl = (answers: Record<string, string>) => (names: string[]): string => {
    const lines = names.filter((n) => answers[n] !== undefined).map((n) => answers[n])
    if (lines.length === 0) throw new Error(`unknown oid ${names.join(' ')}`)
    return lines.join('\n') + '\n'
  }

  it('reads swap and pressure in ONE sysctl run, never one per field', () => {
    const runs: string[][] = []
    const both = sysctl({
      'vm.swapusage': SWAPUSAGE.trimEnd(),
      'kern.memorystatus_vm_pressure_level': 'kern.memorystatus_vm_pressure_level: 4'
    })
    const m = darwinMemInfo(() => VM_STAT, TOTAL_BYTES, (names) => {
      runs.push(names)
      return both(names)
    })
    expect(runs).toEqual([['vm.swapusage', 'kern.memorystatus_vm_pressure_level']])
    expect(m?.display).toEqual({ swapUsedMb: 7854, swapTotalMb: 9216, pressureLevel: 'critical' })
  })

  it('the one run answers each field from its own line, in either order', () => {
    const reversed = (): string =>
      'kern.memorystatus_vm_pressure_level: 1\n' + SWAPUSAGE
    expect(darwinMemInfo(() => VM_STAT, TOTAL_BYTES, reversed)?.display).toEqual({
      swapUsedMb: 7854,
      swapTotalMb: 9216,
      pressureLevel: 'normal'
    })
  })

  it('adds swap and pressure under `display` and NEVER fills the reaper pair', () => {
    const m = darwinMemInfo(() => VM_STAT, TOTAL_BYTES, sysctl({
      'vm.swapusage': SWAPUSAGE.trimEnd(),
      'kern.memorystatus_vm_pressure_level': 'kern.memorystatus_vm_pressure_level: 2'
    }))
    expect(m).toEqual({
      availableMb: 8951,
      totalMb: 24576,
      display: { swapUsedMb: 7854, swapTotalMb: 9216, pressureLevel: 'warn' }
    })
    // The reaper's Linux swap term reads these; on this Mac (16% free) it would fire all day.
    expect(m).not.toHaveProperty('swapTotalMb')
    expect(m).not.toHaveProperty('swapFreeMb')
  })

  it('a failed sysctl omits only its own field; both failing leaves the vm_stat reading untouched', () => {
    const swapOnly = darwinMemInfo(() => VM_STAT, TOTAL_BYTES, sysctl({ 'vm.swapusage': SWAPUSAGE.trimEnd() }))
    expect(swapOnly?.display).toEqual({ swapUsedMb: 7854, swapTotalMb: 9216 })
    const none = darwinMemInfo(() => VM_STAT, TOTAL_BYTES, sysctl({}))
    expect(none).toEqual({ availableMb: 8951, totalMb: 24576 })
    // vm_stat failing still wins: no reading at all, never a display-only one.
    expect(darwinMemInfo(() => { throw new Error('no vm_stat') }, TOTAL_BYTES, sysctl({ 'vm.swapusage': SWAPUSAGE.trimEnd() }))).toBeNull()
  })

  it.skipIf(process.platform !== 'darwin')('reads this Mac\'s real swap and pressure (darwin-only: sysctl oids)', () => {
    const m = readMemInfo()
    expect(m).not.toBeNull()
    expect(m).not.toHaveProperty('swapTotalMb')
    expect(typeof m?.display?.swapTotalMb).toBe('number')
    expect(['normal', 'warn', 'critical']).toContain(m?.display?.pressureLevel)
  })
})

describe('appSelfMemory — "nodeterm itself"', () => {
  const S = (pid: number, type: string, cpuSeconds?: number): AppProcessSample => ({
    pid,
    type,
    ...(cpuSeconds !== undefined ? { cpuSeconds } : {})
  })
  // The live shape: GPU footprint 1.6 GB while its rss was ~120 MB; two renderers (canvas + HUD).
  const SAMPLES = [S(10, 'Browser', 60), S(11, 'GPU', 3600), S(12, 'Tab', 900), S(13, 'Tab', 5), S(14, 'Utility', 2)]
  const FP = (pid: number, kb: number) => ({ pid, ppid: 1, rssKb: kb, footprint: true as const })
  const TABLE = [FP(10, 180 * 1024), FP(11, 1600 * 1024), FP(12, 300 * 1024), FP(13, 40 * 1024), FP(14, 20 * 1024)]

  it('folds Electron types into gpu / renderer / main / helper, GPU first', () => {
    expect(['Browser', 'Tab', 'GPU', 'Utility', 'Zygote'].map(appProcessKind)).toEqual(['main', 'renderer', 'gpu', 'helper', 'helper'])
    const r = appSelfMemory(SAMPLES, TABLE, 'darwin')
    expect(r).toEqual({
      ok: true,
      groups: [
        { kind: 'gpu', count: 1, mb: 1600, cpuSeconds: 3600 },
        { kind: 'renderer', count: 2, mb: 340, cpuSeconds: 905 },
        { kind: 'main', count: 1, mb: 180, cpuSeconds: 60 },
        { kind: 'helper', count: 1, mb: 20, cpuSeconds: 2 }
      ],
      totalMb: 2140
    })
  })

  it('darwin: a pid top did not cover keeps NO figure — its rss is the blind number this replaces', () => {
    const table = TABLE.map((e) => (e.pid === 11 ? { pid: 11, ppid: 1, rssKb: 120 * 1024 } : e))
    const r = appSelfMemory(SAMPLES, table, 'darwin')
    expect(r.ok).toBe(true)
    expect(r.groups.find((g) => g.kind === 'gpu')).toEqual({ kind: 'gpu', count: 1, cpuSeconds: 3600 })
    // No total over a missing GPU: it would understate by the very 1.5 GB at issue.
    expect(r).not.toHaveProperty('totalMb')
    // Linux / Windows read the table's own accounting (VmRSS / working set) — same as the rows.
    expect(appSelfMemory(SAMPLES, table, 'linux').groups[0]).toMatchObject({ kind: 'gpu', mb: 120 })
  })

  it('a group with one missing pid has no partial sum', () => {
    const r = appSelfMemory(SAMPLES, TABLE.filter((e) => e.pid !== 13), 'darwin')
    expect(r.groups.find((g) => g.kind === 'renderer')).toEqual({ kind: 'renderer', count: 2, cpuSeconds: 905 })
  })

  it('CPU time is omitted, not zeroed, when Electron did not report it', () => {
    const r = appSelfMemory([S(10, 'Browser'), S(11, 'GPU', 7)], TABLE, 'darwin')
    expect(r.groups).toEqual([
      { kind: 'gpu', count: 1, mb: 1600, cpuSeconds: 7 },
      { kind: 'main', count: 1, mb: 180 }
    ])
  })

  it('ok:false — never an empty ok group — when nothing could be measured', () => {
    expect(appSelfMemory(null, TABLE, 'darwin')).toEqual({ ok: false, groups: [] })
    expect(appSelfMemory([], TABLE, 'darwin')).toEqual({ ok: false, groups: [] })
    expect(appSelfMemory(SAMPLES, null, 'darwin')).toEqual({ ok: false, groups: [] })
    expect(appSelfMemory(SAMPLES, [], 'linux')).toEqual({ ok: false, groups: [] })
  })

  it('rides on the tmux sweep\'s own table, and a throwing reader is not-measured', async () => {
    const base = {
      tmuxBin: () => '/usr/bin/tmux',
      sockets: ['s1'],
      exec: async () => 'nt-a|100|claude\n',
      readTable: () => [P(100, 1, 40 * 1024), { pid: 7, ppid: 1, rssKb: 512 * 1024, footprint: true as const }],
      readMem: () => null
    }
    const ok = await collectSessionMemory({ ...base, appProcesses: () => [S(7, 'GPU')] })
    expect(ok.app).toEqual({ ok: true, groups: [{ kind: 'gpu', count: 1, mb: 512 }], totalMb: 512 })
    // The session rows are untouched by it.
    expect(ok.rows.map((r) => r.nodeId)).toEqual(['a'])
    const threw = await collectSessionMemory({ ...base, appProcesses: () => { throw new Error('gone') } })
    expect(threw.app).toEqual({ ok: false, groups: [] })
    // No reader injected (Server Edition) → no field at all: "not available", not "could not measure".
    expect(await collectSessionMemory(base)).not.toHaveProperty('app')
  })
})

describe('which memory measure the rows are in', () => {
  const report = (table: ProcEntry[]): Promise<SessionMemoryReport> =>
    collectSessionMemory({
      tmuxBin: () => '/usr/bin/tmux',
      sockets: ['s1'],
      exec: async () => 'nt-a|100|claude\n',
      readTable: () => table,
      readMem: () => null
    })

  it('says rss (working set on Windows) when the table carries no footprint', async () => {
    expect((await report([P(100, 1, 1024)])).metric).toBe(
      process.platform === 'win32' ? 'working-set' : 'rss'
    )
  })

  it('says footprint when it does', async () => {
    expect((await report([{ ...P(100, 1, 1024), footprint: true }])).metric).toBe('footprint')
  })

  it('says working set for a Windows session host', async () => {
    const r = await collectSessionHostMemory({
      platformName: 'win32',
      list: async () => ({ running: true, names: ['nt-a'], sessions: [{ name: 'nt-a', pid: 100 }] }) as SessionHostListing,
      readTable: async () => [{ ...P(100, 1, 1024), name: 'pwsh.exe' }],
      readMem: () => null
    })
    expect(r.metric).toBe('working-set')
    expect(r.rows[0].largestName).toBe('pwsh.exe')
  })
})

describe.skipIf(process.platform !== 'linux')('the Linux /proc reader', () => {
  it('carries each process name', () => {
    const me = defaultProcessTableReader()?.find((e) => e.pid === process.pid)
    expect(me?.name).toBeTruthy()
  })
})

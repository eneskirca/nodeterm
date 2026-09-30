import { describe, expect, it, vi } from 'vitest'
import {
  assembleDevPorts,
  collectLocalDevPorts,
  decodeProcAddress,
  devPortsProbeCommand,
  fetchRemoteDevPorts,
  forwardTarget,
  parseDevPortsProbe,
  parseLsofListeners,
  parseProcFdSockets,
  parseProcNetTcp,
  parseProcRows,
  parseSsListeners,
  splitHostPort
} from './dev-ports'

// Captured from a real Ubuntu 24.04 host (iproute2 6.1) — note the glued `PortProcess` header.
const SS_REAL = `State  Recv-Q Send-Q Local Address:Port  Peer Address:PortProcess
LISTEN 0      511        127.0.0.1:5173      0.0.0.0:*    users:(("node",pid=210,fd=26))
LISTEN 0      511            [::1]:5173         [::]:*    users:(("node",pid=210,fd=27))
LISTEN 0      4096         0.0.0.0:6543      0.0.0.0:*    users:(("docker-proxy",pid=7799,fd=8))
LISTEN 0      128                *:3000            *:*    users:(("ruby",pid=300,fd=9),("ruby",pid=301,fd=9))
LISTEN 0      128             [::]:8080         [::]:*
LISTEN 0      128    127.0.0.53%lo:53        0.0.0.0:*`

describe('splitHostPort', () => {
  it('reads every spelling ss and lsof print', () => {
    expect(splitHostPort('127.0.0.1:5173')).toEqual({ address: '127.0.0.1', port: 5173 })
    expect(splitHostPort('[::1]:5173')).toEqual({ address: '::1', port: 5173 })
    expect(splitHostPort('[::]:80')).toEqual({ address: '::', port: 80 })
    expect(splitHostPort(':::8080')).toEqual({ address: '::', port: 8080 })
    expect(splitHostPort('*:3000')).toEqual({ address: '*', port: 3000 })
    expect(splitHostPort('127.0.0.53%lo:53')).toEqual({ address: '127.0.0.53', port: 53 })
    // An IPv4-mapped bind is its IPv4 address (it used to make forwardTarget answer null).
    expect(splitHostPort('[::ffff:127.0.0.1]:5173')).toEqual({ address: '127.0.0.1', port: 5173 })
  })
  it('refuses a peer column and out-of-range ports', () => {
    expect(splitHostPort('0.0.0.0:*')).toBeNull()
    expect(splitHostPort('1.2.3.4:0')).toBeNull()
    expect(splitHostPort('1.2.3.4:70000')).toBeNull()
    expect(splitHostPort('LISTEN')).toBeNull()
  })
})

describe('parseSsListeners', () => {
  it('takes the local address, every owning pid and the command', () => {
    const l = parseSsListeners(SS_REAL)
    expect(l[0]).toEqual({ owners: [{ pid: 210, command: 'node' }], address: '127.0.0.1', port: 5173 })
    expect(l[1]).toEqual({ owners: [{ pid: 210, command: 'node' }], address: '::1', port: 5173 })
    expect(l[3]).toEqual({ owners: [{ pid: 300, command: 'ruby' }, { pid: 301, command: 'ruby' }], address: '*', port: 3000 })
    // Another user's socket carries no process column: listed, but owned by nobody we know.
    expect(l[4]).toEqual({ owners: [], address: '::', port: 8080 })
    expect(l).toHaveLength(6)
  })
})

describe('parseSsListeners — the owner column is attacker-influenced', () => {
  // Reproduced (review of #1063): a process owned by `nobody` renamed itself `vite",pid=12345` and
  // ss printed its name raw. Collecting every `pid=` on the line handed the port to pid 12345.
  const forged = 'LISTEN 0 5 0.0.0.0:8000 0.0.0.0:* users:(("vite",pid=12345",pid=219072,fd=3))'
  it('takes only the LAST pid of a group, and keeps the forged text as the name', () => {
    expect(parseSsListeners(forged)[0].owners).toEqual([{ pid: 219072, command: 'vite",pid=12345' }])
  })
  it('never attributes the forged port to the node whose tree holds the named pid', () => {
    const out = assembleDevPorts(
      [{ session: 'nt-a', panePid: 12345, command: 'zsh' }],
      [
        { pid: 12345, ppid: 1, command: 'zsh' },
        { pid: 219072, ppid: 1, command: 'vite",pid=12345' }
      ],
      parseSsListeners(forged)
    )
    expect(out).toEqual({})
  })
  it('a pid whose ps name disagrees with the tool\'s name is not trusted', () => {
    const out = assembleDevPorts(
      [{ session: 'nt-a', panePid: 100, command: 'zsh' }],
      [
        { pid: 100, ppid: 1, command: 'zsh' },
        { pid: 101, ppid: 100, command: 'node' }
      ],
      [{ owners: [{ pid: 101, command: 'postgres' }], address: '127.0.0.1', port: 5432 }]
    )
    expect(out).toEqual({})
  })
  it('truncated names still agree (lsof prints 9 chars, macOS ps the full basename)', () => {
    const out = assembleDevPorts(
      [{ session: 'nt-a', panePid: 100, command: 'zsh' }],
      [
        { pid: 100, ppid: 1, command: 'zsh' },
        { pid: 101, ppid: 100, command: 'com.docker.backend' }
      ],
      [{ owners: [{ pid: 101, command: 'com.docke' }], address: '127.0.0.1', port: 3000 }]
    )
    expect(out.a.map((p) => p.port)).toEqual([3000])
  })
})

describe('parseLsofListeners', () => {
  it('groups n-fields under the preceding p/c', () => {
    const out = parseLsofListeners('p210\ncnode\nf26\nn127.0.0.1:5173\nf27\nn[::1]:5173\np300\ncruby\nn*:3000\n')
    expect(out).toEqual([
      { owners: [{ pid: 210, command: 'node' }], address: '127.0.0.1', port: 5173 },
      { owners: [{ pid: 210, command: 'node' }], address: '::1', port: 5173 },
      { owners: [{ pid: 300, command: 'ruby' }], address: '*', port: 3000 }
    ])
  })
})

describe('/proc parsing', () => {
  it('decodes little-endian IPv4 and IPv6 words', () => {
    expect(decodeProcAddress('0100007F')).toBe('127.0.0.1')
    expect(decodeProcAddress('00000000')).toBe('0.0.0.0')
    expect(decodeProcAddress('00000000000000000000000001000000')).toBe('::1')
    expect(decodeProcAddress('00000000000000000000000000000000')).toBe('::')
    expect(decodeProcAddress('0000000000000000FFFF00000100007F')).toBe('127.0.0.1')
    expect(decodeProcAddress('zz')).toBeNull()
  })
  it('keeps only LISTEN rows, keyed by inode', () => {
    const tcp = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1
   1: 0100007F:1435 0100007F:C001 01 00000000:00000000 00:00000000 00000000  1000        0 9999 1
   0: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A 0 0 0 1000 0 777 1`
    const m = parseProcNetTcp(tcp)
    expect([...m.entries()]).toEqual([
      ['4242', { address: '127.0.0.1', port: 5173 }],
      ['777', { address: '::1', port: 8080 }]
    ])
  })
  it('maps socket inodes to pids from ls -l over several fd dirs', () => {
    const ls = `/proc/210/fd:
total 0
lrwx------ 1 u u 64 Sep 30 12:00 0 -> /dev/pts/1
lrwx------ 1 u u 64 Sep 30 12:00 26 -> socket:[4242]

/proc/211/fd:
lrwx------ 1 u u 64 Sep 30 12:00 3 -> socket:[4242]
lrwx------ 1 u u 64 Sep 30 12:00 4 -> socket:[777]`
    const m = parseProcFdSockets(ls)
    expect(m.get('4242')).toEqual([210, 211])
    expect(m.get('777')).toEqual([211])
  })
  it('parses ps rows and keeps the command basename', () => {
    expect(parseProcRows('  1     0 /sbin/launchd\n 42     1 node\n x\n')).toEqual([
      { pid: 1, ppid: 0, command: 'launchd' },
      { pid: 42, ppid: 1, command: 'node' }
    ])
  })
})

describe('assembleDevPorts — ownership by process tree', () => {
  const panes = [
    { session: 'nt-a', panePid: 100, command: 'zsh' },
    { session: 'nt-b', panePid: 200, command: 'zsh' },
    { session: 'someone-else', panePid: 900, command: 'bash' }
  ]
  const procs = [
    { pid: 1, ppid: 0, command: 'init' },
    { pid: 100, ppid: 1, command: 'zsh' },
    { pid: 101, ppid: 100, command: 'npm' },
    { pid: 102, ppid: 101, command: 'node' }, // vite, two levels below the pane
    { pid: 200, ppid: 1, command: 'zsh' },
    { pid: 900, ppid: 1, command: 'bash' },
    { pid: 901, ppid: 900, command: 'python3' },
    { pid: 500, ppid: 1, command: 'postgres' }
  ]
  it('attributes a descendant listener to its node, merges families, sorts', () => {
    const out = assembleDevPorts(panes, procs, [
      { owners: [{ pid: 102, command: '' }], address: '::1', port: 5173 },
      { owners: [{ pid: 102, command: 'node' }], address: '127.0.0.1', port: 5173 },
      { owners: [{ pid: 102, command: 'node' }], address: '127.0.0.1', port: 4000 },
      { owners: [{ pid: 102, command: 'node' }], address: '127.0.0.1', port: 40001 }
    ])
    expect(out).toEqual({
      a: [
        { port: 4000, addresses: ['127.0.0.1'], command: 'node', ephemeral: false },
        { port: 5173, addresses: ['::1', '127.0.0.1'], command: 'node', ephemeral: false },
        { port: 40001, addresses: ['127.0.0.1'], command: 'node', ephemeral: true }
      ]
    })
  })
  it('never reports a port owned outside every nt- pane tree', () => {
    const out = assembleDevPorts(panes, procs, [
      { owners: [{ pid: 500, command: 'postgres' }], address: '0.0.0.0', port: 5432 },
      { owners: [{ pid: 901, command: 'python3' }], address: '0.0.0.0', port: 8000 },
      { owners: [], address: '::', port: 8080 }
    ])
    expect(out).toEqual({})
  })
  it('takes the command from ps when the listener tool did not name it', () => {
    const out = assembleDevPorts(panes, procs, [{ owners: [{ pid: 102, command: '' }], address: '127.0.0.1', port: 3000 }])
    expect(out.a[0].command).toBe('node')
  })
  it('survives a cyclic ppid chain', () => {
    const cyclic = [
      { pid: 100, ppid: 101, command: 'zsh' },
      { pid: 101, ppid: 100, command: 'node' }
    ]
    const out = assembleDevPorts([{ session: 'nt-a', panePid: 100, command: 'zsh' }], cyclic, [
      { owners: [{ pid: 101, command: 'node' }], address: '127.0.0.1', port: 3000 }
    ])
    expect(out.a.map((p) => p.port)).toEqual([3000])
  })
})

const probeOut = (listen: string, panes = "##SOCK node-terminal\nnt-a|100|zsh\n##SOCKRC 0\n##SOCK nodeterm-rmt\nno server running on /tmp/x\n##SOCKRC 1"): string =>
  ['##PANES', panes, '##PROCS', '  100 1 zsh', '  102 100 node', '##LISTEN', listen, '##END', ''].join('\n')

describe('parseDevPortsProbe', () => {
  it('reads an ss answer', () => {
    const r = parseDevPortsProbe(probeOut('##VIA ss\n' + SS_REAL.replace(/pid=210/g, 'pid=102') + '\n##LISTENRC 0'))
    expect(r.ok).toBe(true)
    expect(r.nodes.a.map((p) => p.port)).toEqual([5173])
  })
  it('reads an lsof answer, and lsof exit 1 with no output is "no listeners"', () => {
    expect(parseDevPortsProbe(probeOut('##VIA lsof\np102\ncnode\nn*:3000\n##LISTENRC 0')).nodes.a[0].port).toBe(3000)
    expect(parseDevPortsProbe(probeOut('##VIA lsof\n##LISTENRC 1'))).toEqual({ ok: true, nodes: {} })
  })
  it('reads the /proc answer', () => {
    const r = parseDevPortsProbe(
      probeOut(
        '##VIA proc\n   0: 0100007F:1435 00000000:0000 0A 0 0 0 1000 0 4242 1\n##FD\n/proc/102/fd:\nl 1 -> socket:[4242]\n/proc/1/fd:\n##LISTENRC 0'
      )
    )
    expect(r).toEqual({ ok: true, nodes: { a: [{ port: 5173, addresses: ['127.0.0.1'], command: 'node', ephemeral: false }] } })
  })
  it('never turns a failure into "no ports"', () => {
    expect(parseDevPortsProbe('').ok).toBe(false)
    // cut short: no ##END
    expect(parseDevPortsProbe(probeOut('##VIA ss\n##LISTENRC 0').replace('##END', '')).reason).toBe('unreachable')
    // no socket answered (broken tmux client on both)
    const broken = '##SOCK node-terminal\ntmux: error while loading shared libraries\n##SOCKRC 127\n##SOCK nodeterm-rmt\ntmux: error\n##SOCKRC 127'
    expect(parseDevPortsProbe(probeOut('##VIA ss\n##LISTENRC 0', broken)).reason).toBe('unreachable')
    // ss failed
    expect(parseDevPortsProbe(probeOut('##VIA ss\n##LISTENRC 1')).reason).toBe('unreachable')
    // lsof failed WITH output
    expect(parseDevPortsProbe(probeOut('##VIA lsof\nlsof: WARNING\n##LISTENRC 1')).reason).toBe('unreachable')
    // no tool
    expect(parseDevPortsProbe(probeOut('##VIA none'))).toEqual({ ok: false, reason: 'no-listener-tool', nodes: {} })
    // an rc file echoing a marker ahead of ours
    expect(parseDevPortsProbe('##END\n' + probeOut('##VIA ss\n##LISTENRC 0').replace(/##END\n$/, '')).ok).toBe(false)
  })
})

describe('forwardTarget', () => {
  it('follows the bind', () => {
    expect(forwardTarget(['::1', '127.0.0.1'])).toBe('127.0.0.1')
    expect(forwardTarget(['*'])).toBe('127.0.0.1')
    expect(forwardTarget(['0.0.0.0'])).toBe('127.0.0.1')
    expect(forwardTarget(['::1'])).toBe('::1')
    expect(forwardTarget(['::'])).toBe('::1')
    expect(forwardTarget(['10.0.0.5'])).toBe('10.0.0.5')
    expect(forwardTarget(['fe80::1'])).toBe('fe80::1')
  })
  it('refuses anything that is not an IP literal', () => {
    expect(forwardTarget(['localhost'])).toBeNull()
    expect(forwardTarget(['-oProxyCommand=x'])).toBeNull()
    expect(forwardTarget([])).toBeNull()
  })
})

describe('runners', () => {
  it('local: Windows is unsupported, a throwing exec is unreachable', async () => {
    const tmuxBin = (): string => '/usr/bin/tmux'
    expect(await collectLocalDevPorts({ tmuxBin, exec: async () => '', platformName: 'win32' })).toEqual({
      ok: false,
      reason: 'unsupported',
      nodes: {}
    })
    const exec = async (): Promise<string> => {
      throw new Error('x')
    }
    expect((await collectLocalDevPorts({ tmuxBin, exec, platformName: 'linux' })).reason).toBe('unreachable')
  })

  it("local: asks the APP's tmux by absolute path, quoted — never whatever `tmux` is on PATH", async () => {
    // A Mac whose only tmux is the bundled one has none on PATH; a bare `tmux` answered 127 twice.
    let seen = ''
    await collectLocalDevPorts({
      tmuxBin: () => "/Applications/node term.app/Contents/Resources/tmux/bin/tm'ux",
      exec: async (cmd) => ((seen = cmd), ''),
      platformName: 'darwin'
    })
    expect(seen).toContain(`'/Applications/node term.app/Contents/Resources/tmux/bin/tm'\\''ux' -L node-terminal list-panes`)
    expect(seen).not.toMatch(/^tmux -L/m)
  })

  it('local: no tmux at all is unsupported (plain shells own no pane tree)', async () => {
    const exec = vi.fn(async () => '')
    expect((await collectLocalDevPorts({ tmuxBin: () => null, exec, platformName: 'linux' })).reason).toBe('unsupported')
    expect(exec).not.toHaveBeenCalled()
  })
  it('remote: a null (dead master) is unreachable, never empty', async () => {
    expect(await fetchRemoteDevPorts('p', async () => null)).toEqual({ ok: false, reason: 'unreachable', nodes: {} })
    let seen = ''
    await fetchRemoteDevPorts('p', async (_id, cmd) => ((seen = cmd), null))
    expect(seen).toBe(devPortsProbeCommand())
  })
})

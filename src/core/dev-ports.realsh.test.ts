// The dev-ports probe is generated shell no compiler checks, so it is executed here for real:
//  1. under /bin/sh against a FAKE host tree (stub tmux / ps / ss / lsof and a fake /proc), one
//     case per listener-tool branch — the branch a real host takes depends on what it has installed;
//  2. end to end on this machine: a real tmux session (in the suite's private TMUX_TMPDIR, on a
//     socket name nothing else uses) running a real TCP listener two processes below its pane,
//     read back through real `ps` and real `ss`/`lsof`.
import { afterAll, describe, expect, it } from 'vitest'
import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import { devPortsProbeCommand, parseDevPortsProbe } from './dev-ports'
import { testTmpDir } from './test-tmp'

const run = promisify(execFile)
const SOCKS = ['node-terminal', 'nodeterm-rmt']

function fakeHost(bins: Record<string, string>): string {
  const dir = testTmpDir('devports-bin-')
  for (const [name, body] of Object.entries(bins)) {
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  }
  return dir
}
const TMUX = `case "$2" in
  node-terminal) printf 'nt-web|100|zsh\\nnt-idle|300|zsh\\n'; exit 0;;
  *) echo "no server running on /tmp/tmux-1000/$2" >&2; exit 1;;
esac`
const PS = `printf '  1     0 init\\n  100   1 zsh\\n  101 100 npm\\n  102 101 node\\n  300   1 zsh\\n  500   1 postgres\\n'`

async function probe(binDir: string, procRoot = '/nonexistent-proc'): Promise<string> {
  // PATH is ONLY the fake dir: the script appends its own dirs, none of which hold ss/lsof here.
  const { stdout } = await run('/bin/sh', ['-c', devPortsProbeCommand({ sockets: SOCKS, procRoot })], {
    env: { PATH: binDir, HOME: '/nonexistent' }
  })
  return stdout
}

const realSsOnAppendedPath = ['/usr/sbin/ss', '/sbin/ss', '/usr/local/bin/ss', '/opt/homebrew/bin/ss'].some((p) =>
  fs.existsSync(p)
)
const realLsofOnAppendedPath = ['/usr/sbin/lsof', '/sbin/lsof', '/usr/local/bin/lsof', '/opt/homebrew/bin/lsof'].some(
  (p) => fs.existsSync(p)
)

describe('dev-ports probe under a real /bin/sh, fake host', () => {
  it('ss branch: the vite two levels below the pane is the node\'s; postgres is nobody\'s', async () => {
    const bin = fakeHost({
      tmux: TMUX,
      ps: PS,
      ss: `cat <<'EOF'
State  Recv-Q Send-Q Local Address:Port  Peer Address:PortProcess
LISTEN 0      511        127.0.0.1:5173      0.0.0.0:*    users:(("node",pid=102,fd=26))
LISTEN 0      511            [::1]:5173         [::]:*    users:(("node",pid=102,fd=27))
LISTEN 0      244          0.0.0.0:5432      0.0.0.0:*    users:(("postgres",pid=500,fd=7))
EOF`,
      cat: 'exec /bin/cat "$@"'
    })
    const r = parseDevPortsProbe(await probe(bin), SOCKS)
    expect(r).toEqual({
      ok: true,
      nodes: { web: [{ port: 5173, addresses: ['127.0.0.1', '::1'], command: 'node', ephemeral: false }] }
    })
  })

  it.skipIf(realSsOnAppendedPath)('lsof branch (macOS, or Linux without ss); lsof exit 1 = nothing listening', async () => {
    const bin = fakeHost({ tmux: TMUX, ps: PS, lsof: `printf 'p102\\ncnode\\nf21\\nn*:3000\\n'` })
    const r = parseDevPortsProbe(await probe(bin), SOCKS)
    expect(r.nodes).toEqual({ web: [{ port: 3000, addresses: ['*'], command: 'node', ephemeral: false }] })
    const none = fakeHost({ tmux: TMUX, ps: PS, lsof: 'exit 1' })
    expect(parseDevPortsProbe(await probe(none), SOCKS)).toEqual({ ok: true, nodes: {} })
  })

  it.skipIf(realSsOnAppendedPath || realLsofOnAppendedPath)('/proc branch joins the socket inode to the pid', async () => {
    const proc = testTmpDir('devports-proc-')
    fs.mkdirSync(path.join(proc, 'net'))
    fs.writeFileSync(
      path.join(proc, 'net/tcp'),
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n' +
        '   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1\n'
    )
    for (const pid of ['102', '500']) fs.mkdirSync(path.join(proc, pid, 'fd'), { recursive: true })
    fs.symlinkSync('socket:[4242]', path.join(proc, '102/fd/26'))
    fs.symlinkSync('/dev/null', path.join(proc, '500/fd/0'))
    const bin = fakeHost({ tmux: TMUX, ps: PS, cat: 'exec /bin/cat "$@"', ls: 'exec /bin/ls "$@"' })
    const r = parseDevPortsProbe(await probe(bin, proc), SOCKS)
    expect(r).toEqual({ ok: true, nodes: { web: [{ port: 8080, addresses: ['127.0.0.1'], command: 'node', ephemeral: false }] } })
  })

  it('ss branch: a process NAMED like a group cannot claim a node\'s pid', async () => {
    // 100 is the web pane's shell; 700 is a stranger's server that renamed itself.
    const bin = fakeHost({
      tmux: TMUX,
      ps: `printf '  1 0 init\\n  100 1 zsh\\n  700 1 %s\\n' 'x",pid=100'`,
      ss: `printf '%s\\n' 'LISTEN 0 5 0.0.0.0:8000 0.0.0.0:* users:(("x",pid=100",pid=700,fd=3))'`
    })
    expect(parseDevPortsProbe(await probe(bin), SOCKS)).toEqual({ ok: true, nodes: {} })
  })

  it.skipIf(realSsOnAppendedPath || realLsofOnAppendedPath)(
    '/proc branch: a newline in an fd target cannot forge a pid header',
    async () => {
      const proc = testTmpDir('devports-procq-')
      fs.mkdirSync(path.join(proc, 'net'))
      fs.writeFileSync(
        path.join(proc, 'net/tcp'),
        '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n' +
          '   0: 00000000:1F40 00000000:0000 0A 00000000:00000000 00:00000000 00000000  65534        0 999 1\n'
      )
      // 700 is a stranger (not under any pane); its fd target smuggles a header naming pid 100,
      // the web pane's shell, followed by a line claiming socket 999.
      fs.mkdirSync(path.join(proc, '700', 'fd'), { recursive: true })
      fs.symlinkSync(`a\n${proc}/100/fd:\nl -> socket:[999]`, path.join(proc, '700/fd/4'))
      fs.symlinkSync('socket:[999]', path.join(proc, '700/fd/3'))
      const bin = fakeHost({
        tmux: TMUX,
        ps: `printf '  1 0 init\\n  100 1 zsh\\n  700 1 evil\\n'`,
        cat: 'exec /bin/cat "$@"',
        ls: 'exec /bin/ls "$@"'
      })
      expect(parseDevPortsProbe(await probe(bin, proc), SOCKS)).toEqual({ ok: true, nodes: {} })
    }
  )

  it.skipIf(realSsOnAppendedPath || realLsofOnAppendedPath)('no tool at all says so — never "no ports"', async () => {
    const bin = fakeHost({ tmux: TMUX, ps: PS })
    expect(parseDevPortsProbe(await probe(bin), SOCKS)).toEqual({ ok: false, reason: 'no-listener-tool', nodes: {} })
  })

  it('a broken tmux on every socket is unreachable, not empty', async () => {
    const bin = fakeHost({ tmux: 'echo "tmux: cannot open shared object file" >&2; exit 127', ps: PS, ss: 'exit 0' })
    expect(parseDevPortsProbe(await probe(bin), SOCKS).reason).toBe('unreachable')
  })
})

// ---- real end to end -------------------------------------------------------------------------

const hasTool = (t: string): boolean => {
  try {
    execFileSync('/bin/sh', ['-c', `command -v ${t}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const canRunReal = process.platform !== 'win32' && hasTool('tmux') && (hasTool('ss') || hasTool('lsof'))
const SOCKET = `ntports-${process.pid}-${Math.random().toString(36).slice(2, 8)}`

describe.skipIf(!canRunReal)('dev-ports probe end to end (real tmux, real listener)', () => {
  afterAll(() => {
    // Our own socket only — never a kill-server on a shared name.
    try {
      execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' })
    } catch {
      /* already gone */
    }
  })

  it('finds a listener two processes below the pane and attributes it to the node', async () => {
    const dir = testTmpDir('devports-real-')
    const portFile = path.join(dir, 'port')
    const server = path.join(dir, 'server.js')
    fs.writeFileSync(
      server,
      `const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>require('fs').writeFileSync(${JSON.stringify(portFile)},String(s.address().port)))`
    )
    // sh → sh → node: the listener is a grandchild of the pane's process.
    execFileSync('tmux', [
      '-L', SOCKET, '-f', '/dev/null', 'new-session', '-d', '-s', 'nt-realnode',
      `sh -c 'sh -c "exec ${process.execPath} ${server}"; sleep 60'`
    ])
    let port = ''
    for (let i = 0; i < 100 && !port; i++) {
      await new Promise((r) => setTimeout(r, 50))
      port = fs.existsSync(portFile) ? fs.readFileSync(portFile, 'utf8') : ''
    }
    expect(port).not.toBe('')
    const { stdout } = await run('/bin/sh', ['-c', devPortsProbeCommand({ sockets: [SOCKET] })])
    const r = parseDevPortsProbe(stdout, [SOCKET])
    expect(r.ok).toBe(true)
    expect(r.nodes.realnode?.map((p) => p.port)).toEqual([Number(port)])
    expect(r.nodes.realnode?.[0].addresses).toEqual(['127.0.0.1'])
  }, 20_000)

  it.skipIf(!hasTool('ss') || !hasTool('python3'))(
    'a REAL process outside the tree, renamed to name the pane\'s pid, is not attributed (real ss)',
    async () => {
      const dir = testTmpDir('devports-forge-')
      const portFile = path.join(dir, 'port')
      execFileSync('tmux', ['-L', SOCKET, '-f', '/dev/null', 'new-session', '-d', '-s', 'nt-victim', 'sleep 60'])
      const panePid = execFileSync('tmux', ['-L', SOCKET, 'list-panes', '-t', '=nt-victim', '-F', '#{pane_pid}'], {
        encoding: 'utf8'
      }).trim()
      const name = `x",pid=${panePid}`.slice(0, 15)
      // A child of the TEST RUNNER — never under the pane — that renames itself and listens.
      const py = [
        'import ctypes,socket,sys,time',
        `ctypes.CDLL(None).prctl(15, ctypes.c_char_p(${JSON.stringify(name)}.encode()), 0, 0, 0)`,
        "s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen()",
        `open(${JSON.stringify(portFile)},'w').write(str(s.getsockname()[1]))`,
        'time.sleep(30)'
      ].join('\n')
      const child = execFile('python3', ['-c', py])
      try {
        let port = ''
        for (let i = 0; i < 100 && !port; i++) {
          await new Promise((r) => setTimeout(r, 50))
          port = fs.existsSync(portFile) ? fs.readFileSync(portFile, 'utf8') : ''
        }
        expect(port).not.toBe('')
        const { stdout } = await run('/bin/sh', ['-c', devPortsProbeCommand({ sockets: [SOCKET] })])
        // Only meaningful if ss really printed the forged name — assert the precondition.
        expect(stdout).toContain(`"${name}"`)
        const r = parseDevPortsProbe(stdout, [SOCKET])
        expect(r.ok).toBe(true)
        expect(r.nodes.victim).toBeUndefined()
      } finally {
        child.kill()
      }
    },
    20_000
  )
})

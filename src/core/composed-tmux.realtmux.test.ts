import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { captureComposedViewer, composedSubmissionPlan, submitComposedTmux, type ComposedViewerReceipt } from './composed-tmux'
import { makeTmuxTmpdir } from './tmux-test-socket'

const tmux = ['/usr/bin/tmux', '/usr/local/bin/tmux', '/opt/homebrew/bin/tmux', '/bin/tmux'].find((p) => fs.existsSync(p))
const socket = `nt-composed-${process.pid}`
const supported = process.platform === 'linux' || process.platform === 'darwin'
let work: string, session: string, bytes: string, siblingBytes: string
let viewer: ChildProcessWithoutNullStreams | undefined
let receipt: ComposedViewerReceipt
let count = 0
let alive = true
function env(): NodeJS.ProcessEnv { return { ...process.env, HOME: path.join(work, 'home'), TMUX_TMPDIR: work, TMUX: '', TMUX_PANE: '', LC_ALL: 'C', TERM: 'xterm-256color' } }
function run(args: string[], input?: string): string {
  return execFileSync(tmux!, args, { env: env(), input, encoding: 'utf8', timeout: 3000, maxBuffer: 256 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })
}
function command(args: string[]): string { return run(['-L', socket, ...args]) }
async function waitFor(test: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (!test() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  expect(test()).toBe(true)
}
const boundary = () => ({ current: () => alive, run: async (args: string[], input?: string) => run(args, input) })
function contents(file: string): string { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '' }

describe.skipIf(!tmux || !supported)('composed Send against its own real tmux viewer and panes', () => {
  beforeAll(() => {
    work = makeTmuxTmpdir('ntcs-', socket)
    fs.mkdirSync(path.join(work, 'home'))
    // Judge input at the application's raw tty. A composer that coalesces Enter within 100ms of
    // paste-end records it as paste content instead of a submit. Bytes alone cannot prove this.
    fs.writeFileSync(path.join(work, 'record'), `#!${process.execPath}
const fs = require('node:fs');
const out = process.argv[2];
process.stdin.setRawMode(true);
process.stdout.write('\\x1b[?2004h');
fs.writeFileSync(out + '.ready', 'ready');
let raw = Buffer.alloc(0), endAt = null;
process.stdin.on('data', chunk => {
  const now = process.hrtime.bigint();
  fs.appendFileSync(out, chunk);
  for (const byte of chunk) {
    raw = Buffer.concat([raw, Buffer.from([byte])]);
    fs.appendFileSync(out + '.times', JSON.stringify({ byte, ns: now.toString() }) + '\\n');
    const tail = raw.subarray(-6).toString('binary');
    if (tail === '\\x1b[200~') endAt = null;
    if (tail === '\\x1b[201~') endAt = now;
    if (byte === 13 && endAt !== null) {
      const milliseconds = Number(now - endAt) / 1e6;
      fs.appendFileSync(out + '.submits', JSON.stringify({ status: milliseconds >= 100 ? 'submitted' : 'coalesced', milliseconds }) + '\\n');
    }
  }
});
`, { mode: 0o755 })
  })
  beforeEach(async () => {
    alive = true
    session = `nt-composed-${process.pid}-${++count}`
    bytes = path.join(work, `${count}.bytes`)
    siblingBytes = path.join(work, `${count}.sibling`)
    command(['-f', '/dev/null', 'new-session', '-d', '-s', session, '-x', '80', '-y', '24', `${path.join(work, 'record')} ${bytes}`])
    command(['new-window', '-d', '-t', `=${session}`, `${path.join(work, 'record')} ${siblingBytes}`])
    await waitFor(() => fs.existsSync(bytes + '.ready') && fs.existsSync(siblingBytes + '.ready'))
    // A real tmux control-mode viewer needs no native node-pty binding. Its actual client process
    // is attested by production code; ordinary local relay node-pty viewers use the same receipt.
    viewer = spawn(tmux!, ['-L', socket, '-C', 'attach-session', '-t', `=${session}`], { env: env() })
    viewer.stdout.resume(); viewer.stderr.resume()
    const captured = await captureComposedViewer(socket, session, viewer.pid!, boundary())
    expect(captured).not.toBeNull()
    receipt = captured!
  })
  afterEach(async () => {
    alive = false
    try { command(['detach-client', '-t', receipt.viewerName]) } catch { /* already detached */ }
    if (viewer) {
      viewer.stdin.end()
      await waitFor(() => viewer!.exitCode !== null)
      viewer = undefined
    }
    try { command(['kill-session', '-t', `=${session}`]) } catch { /* already ended */ }
  })
  afterAll(() => {
    if (work) {
      try { command(['kill-server']) } catch { /* last session ended */ }
      fs.rmSync(work, { recursive: true, force: true })
    }
  })

  it.each(['emacs', 'vi'])('leaves %s copy mode and sends one bracketed paste followed by a separate Enter', async (mode) => {
    command(['set-option', '-w', '-t', receipt.paneId, 'mode-keys', mode])
    command(['copy-mode', '-t', receipt.paneId])
    expect(command(['display-message', '-p', '-t', receipt.paneId, '#{pane_in_mode}']).trim()).toBe('1')
    const input = { kind: 'paste', text: 'first\r\nΩ 😀\x1b[201~', enter: true } as const
    expect(await submitComposedTmux(receipt, input, boundary())).toEqual({ status: 'delivered' })
    const expected = '\x1b[200~first\rΩ 😀[201~\x1b[201~\r'
    await waitFor(() => contents(bytes) === expected)
    expect(command(['display-message', '-p', '-t', receipt.paneId, '#{pane_in_mode}']).trim()).toBe('0')
    expect(contents(siblingBytes)).toBe('')
  })
  it('preserves explicit Ctrl bytes without adding paste markers or Enter', async () => {
    command(['copy-mode', '-t', receipt.paneId])
    expect(await submitComposedTmux(receipt, { kind: 'control', text: '\x03', enter: false }, boundary())).toEqual({ status: 'delivered' })
    await waitFor(() => contents(bytes) === '\x03')
    expect(contents(siblingBytes)).toBe('')
  })
  it('delays Enter after paste-end so a paste-coalescing consumer submits exactly once', async () => {
    expect(await submitComposedTmux(receipt, { kind: 'paste', text: 'timed marker', enter: true }, boundary())).toEqual({ status: 'delivered' })
    await waitFor(() => fs.existsSync(bytes + '.submits'))
    const submits = contents(bytes + '.submits').trim().split('\n').map((line) => JSON.parse(line))
    expect(submits).toHaveLength(1)
    expect(submits[0].status).toBe('submitted')
    expect(submits[0].milliseconds).toBeGreaterThanOrEqual(100)
    expect(contents(bytes)).toBe('\x1b[200~timed marker\x1b[201~\r')
    expect(contents(siblingBytes)).toBe('')
    console.info(JSON.stringify({ fixture: 'owned real tmux paste-coalescing consumer',
      pasteEndToEnterMs: submits[0].milliseconds, submissions: submits.length }))
  })
  it.each(['detach', 'select'])('withholds Enter if the captured viewer changes during paste settling (%s)', async (change) => {
    const result = await submitComposedTmux(receipt, { kind: 'paste', text: 'pending marker', enter: true }, {
      ...boundary(), wait: async (ms) => {
        if (change === 'detach') command(['detach-client', '-t', receipt.viewerName])
        else command(['select-window', '-t', `=${session}:1`])
        await new Promise((resolve) => setTimeout(resolve, ms))
      }
    })
    expect(result.status).toBe('uncertain')
    await waitFor(() => contents(bytes) === '\x1b[200~pending marker\x1b[201~')
    expect(contents(bytes + '.submits')).toBe('')
    expect(contents(siblingBytes)).toBe('')
  })
  it('rechecks viewer presence inside the Enter queue after a late detach, preserving postpaste uncertainty', async () => {
    const result = await submitComposedTmux(receipt, { kind: 'paste', text: 'late marker', enter: true }, {
      ...boundary(), run: async (args, input) => {
        if (input === '' && !args.includes('delete-buffer')) command(['detach-client', '-t', receipt.viewerName])
        return run(args, input)
      }
    })
    expect(result.status).toBe('uncertain')
    await waitFor(() => contents(bytes) === '\x1b[200~late marker\x1b[201~')
    expect(contents(bytes + '.submits')).toBe('')
    expect(contents(siblingBytes)).toBe('')
  })
  it('refuses changed pane identity and detached viewer inside the final tmux queue', () => {
    for (const changed of [{ ...receipt, panePid: receipt.panePid + 1 },
      { ...receipt, serverPid: receipt.serverPid + 1 }, { ...receipt, sessionCreated: String(Number(receipt.sessionCreated) + 1) }]) {
      const plan = composedSubmissionPlan(changed, { kind: 'paste', text: 'must not arrive', enter: false })
      expect(run(plan.args, plan.body).trim()).toBe('nt-composed-refused')
    }
    command(['detach-client', '-t', receipt.viewerName])
    const plan = composedSubmissionPlan(receipt, { kind: 'paste', text: 'must not arrive', enter: false })
    expect(run(plan.args, plan.body).trim()).toBe('nt-composed-refused')
    expect(contents(bytes)).toBe('')
    expect(contents(siblingBytes)).toBe('')
  })
  it('refuses a pane respawn rather than sending to its replacement', async () => {
    command(['respawn-pane', '-k', '-t', receipt.paneId, `${path.join(work, 'record')} ${bytes}`])
    expect((await submitComposedTmux(receipt, { kind: 'paste', text: 'replacement must stay empty', enter: true }, boundary())).status).toBe('refused')
    expect(contents(bytes)).toBe('')
    expect(contents(siblingBytes)).toBe('')
  })
  it('refuses selected-window changes instead of following the new selected pane', async () => {
    command(['select-window', '-t', `=${session}:1`])
    expect((await submitComposedTmux(receipt, { kind: 'paste', text: 'must not follow', enter: true }, boundary())).status).toBe('refused')
    expect(contents(bytes)).toBe('')
    expect(contents(siblingBytes)).toBe('')
  })
  it('classifies a lost acknowledgment as uncertain without sending its payload again', async () => {
    let deliveries = 0
    const result = await submitComposedTmux(receipt, { kind: 'paste', text: 'once', enter: true }, {
      ...boundary(), run: async (args, input) => {
        const output = run(args, input)
        if (args.includes('load-buffer')) { deliveries++; throw new Error('simulated lost response after actual dispatch') }
        return output
      }
    })
    expect(result.status).toBe('uncertain')
    await waitFor(() => contents(bytes) === '\x1b[200~once\x1b[201~')
    expect(contents(bytes + '.submits')).toBe('')
    expect(deliveries).toBe(1)
    expect(contents(siblingBytes)).toBe('')
  })
})

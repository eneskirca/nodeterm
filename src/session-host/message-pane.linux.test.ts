import { spawn } from 'child_process'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { hostMessagePane } from './message-pane'
import { TerminalEmulator } from './terminal-emulator'
import { isAgentPane } from '../shared/agents/pane-owner-predicate'

describe.skipIf(process.platform !== 'linux')('persistent host messaging on a real Linux PTY', () => {
  it('default probe recognizes the foreground agent and submits only after rendering the paste', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linux-message-'))
    const script = join(dir, 'codex')
    await writeFile(script, `import os, tty
tty.setraw(0)
os.write(1, b'READY\\r\\n\\x1b[?2004h')
os.write(1, '› \\r\\n? for shortcuts'.encode())
data = b''
while True:
    chunk = os.read(0, 4096)
    if chunk == b'\\r':
        os.write(1, b'ACK\\n')
        break
    data += chunk
    if b'\\x1b[201~' in data:
        body = data.split(b'\\x1b[200~', 1)[-1].split(b'\\x1b[201~', 1)[0].decode()
        os.write(1, ('\\x1b[2J\\x1b[H› ' + body.replace('\\n', '\\r\\n') + '\\r\\n? for shortcuts').encode())
`)
    // The supervisor owns the master; pty.fork supplies a real controlling tty and foreground
    // group. No tmux, no native-addon mock, no actual user's terminal or input is touched.
    const child = spawn('python3', ['-u', '-c', `import os, pty, select, sys
pid, master = pty.fork()
if pid == 0:
    os.execv(sys.executable, [sys.executable, sys.argv[1]])
print('PID=' + str(pid), flush=True)
try:
    while True:
        ready, _, _ = select.select([master, 0], [], [])
        if master in ready:
            try: data = os.read(master, 4096)
            except OSError: break
            if not data: break
            os.write(1, data)
        if 0 in ready:
            data = os.read(0, 4096)
            if not data: break
            os.write(master, data)
finally:
    os.close(master)
    os.waitpid(pid, 0)
`, script], { stdio: ['pipe', 'pipe', 'pipe'] })
    let screen = ''
    const emulator = new TerminalEmulator({ cols: 100, rows: 12, scrollback: 20 })
    let outputTail = Promise.resolve()
    child.stdout.on('data', data => {
      const text = data.toString()
      screen += text
      outputTail = outputTail.then(() => emulator.write(text))
    })
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    try {
      await expect.poll(() => screen, { timeout: 3000 }).toContain('READY')
      const pid = Number(/PID=(\d+)/.exec(screen)![1])
      const session = {
        generation: 'real-linux-pty', exited: false,
        proc: { pid, write: (data: string) => { child.stdin.write(data) } },
        messagePasteReady: async () => { await outputTail; return emulator.bracketedPasteRequested() },
        serialize: async () => { await outputTail; return emulator.serialize() },
        messageCapturePlain: async () => { await outputTail; return emulator.capturePlain() }
      }
      const pane = hostMessagePane(() => session)
      const owner = await pane.owner()
      expect(isAgentPane(owner, 'codex')).toBe('agent')
      expect(isAgentPane(owner, 'claude')).toBe('not-agent')
      expect(await pane.send('hello from left\nsecond line', owner!)).toBe(true)
      await expect.poll(() => screen).toContain('ACK')
      await exited
      expect(await pane.owner()).toBeNull()
    } finally {
      child.stdin.end()
      child.kill()
      await exited
      await outputTail
      emulator.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

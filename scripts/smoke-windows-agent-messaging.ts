// Run with Electron's Node ABI after bundling (node-pty is Electron-built):
// esbuild scripts/smoke-windows-agent-messaging.ts --bundle --platform=node --format=cjs
//   --external:node-pty --outfile=out/native-messaging-smoke.cjs
// ELECTRON_RUN_AS_NODE=1 electron out/native-messaging-smoke.cjs
// NODETERM_SMOKE_NODE_EXE must name a real node.exe; no model/API call is made.
import fs from 'fs'
import os from 'os'
import path from 'path'
import assert from 'assert/strict'
import * as pty from 'node-pty'
import { NativeWindowsPane } from '../src/core/native-windows-pane'
import { isAgentPane } from '../src/shared/agents/pane-owner-predicate'

async function main(): Promise<void> {
  assert.equal(process.platform, 'win32', 'this smoke test needs a real Windows console')
  const nodeExe = process.env.NODETERM_SMOKE_NODE_EXE
  assert.ok(nodeExe && fs.existsSync(nodeExe), 'set NODETERM_SMOKE_NODE_EXE to node.exe')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-native-message-'))
  // A native reader named opencode, like the fake CLI used by the real tmux tests. The
  // assertion is actual ConPTY input framing/identity, not a claim of an LLM response.
  const readerExe = path.join(dir, 'opencode.exe')
  fs.copyFileSync(nodeExe, readerExe)
  // The reader echoes the pasted text like a composer does: delivery submits in a second write
  // only once the envelope is visible (core/settled-submit.ts), so a silent reader gets no Enter.
  const reader = "process.stdin.setRawMode(true); process.stdin.resume(); process.stdout.write('\\x1b[?2004hREADY_NATIVE'); let b=''; process.stdin.on('data',d=>{const s=d.toString(); b+=s; process.stdout.write(s.replace(/\\x1b\\[20[01]~/g,'').replace(/\\r/g,'').replace(/\\n/g,'\\r\\n')); if(b.endsWith('\\r')) {process.stdout.write('RECEIVED_NATIVE:'+Buffer.from(b).toString('base64')+';'); b='';}});"
  const quote = (text: string) => "'" + text.replace(/'/g, "''") + "'"
  const proc = pty.spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NoExit', '-Command', `& ${quote(readerExe)} -e ${quote(reader)}`], {
    cwd: dir, env: process.env as Record<string, string>, cols: 120, rows: 30, name: 'xterm-256color'
  })
  const pane = new NativeWindowsPane(proc, { cols: 120, rows: 30, scrollback: 200 })
  const exited = new Promise<void>((resolve) => proc.onExit(() => resolve()))
  let output = ''
  proc.onData((data) => { output += data; pane.recordOutput(data) })
  const waitFor = async (test: () => boolean) => {
    const deadline = Date.now() + 15_000
    while (!test()) {
      if (Date.now() > deadline) throw new Error('native reader timed out')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  try {
    await waitFor(() => output.includes('READY_NATIVE'))
    const owner = await pane.owner()
    assert.equal(isAgentPane(owner, 'opencode'), 'agent')
    assert.equal(await pane.pasteAware(), true)
    const body = 'NT_PING_WINDOWS\nsecond line'
    assert.equal(await pane.sendEnvelope(body, owner!), true)
    await waitFor(() => /RECEIVED_NATIVE:[A-Za-z0-9+/=]+;/.test(output))
    const encoded = output.match(/RECEIVED_NATIVE:([A-Za-z0-9+/=]+);/)![1]
    assert.equal(Buffer.from(encoded, 'base64').toString(), `\x1b[200~${body}\x1b[201~\r`)
    pane.dispose()
    assert.equal(await pane.sendEnvelope('must not be sent', owner!), false)
  } finally {
    pane.dispose()
    // Let node-pty close its own ConPTY while the console still exists. Killing the root
    // first makes node-pty's asynchronous console-list cleanup fail on AttachConsole.
    proc.kill()
    await Promise.race([exited, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('fixture did not exit')), 8000))])
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
  console.log(JSON.stringify({ consoleIdentity: 'passed', multilinePaste: 'passed', disposedRefusal: 'passed', cleanup: 'passed' }))
}

void main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1) })

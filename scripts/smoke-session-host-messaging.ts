// Bundle to out/session-host-message-smoke.cjs, externalizing node-pty, and run with
// ELECTRON_RUN_AS_NODE=1 Electron. NODETERM_SMOKE_NODE_EXE points at node.exe.
// An isolated host + native fake CLI exercise the actual named-pipe protocol. No model call.
import fs from 'fs'
import os from 'os'
import path from 'path'
import assert from 'assert/strict'
import { SessionHostClient } from '../src/core/session-host-client'
import { isAgentPane } from '../src/shared/agents/pane-owner-predicate'

async function main(): Promise<void> {
  assert.equal(process.platform, 'win32')
  const nodeExe = process.env.NODETERM_SMOKE_NODE_EXE
  assert.ok(nodeExe && fs.existsSync(nodeExe))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-host-message-'))
  const exe = path.join(dir, 'opencode.exe')
  fs.copyFileSync(nodeExe, exe)
  const quote = (s: string) => "'" + s.replace(/'/g, "''") + "'"
  // The reader echoes the pasted text like a composer does: delivery submits in a second write
  // only once the envelope is visible (core/settled-submit.ts), so a silent reader gets no Enter.
  const reader = "process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('\\x1b[?2004hREADY_HOST');let b='';process.stdin.on('data',d=>{const s=d.toString();b+=s;process.stdout.write(s.replace(/\\x1b\\[20[01]~/g,'').replace(/\\r/g,'').replace(/\\n/g,'\\r\\n'));if(b.endsWith('\\r')){process.stdout.write('HOST_RECEIVED:'+Buffer.from(b).toString('base64')+';');b='';}})"
  const client = new SessionHostClient({ userDataDir: dir, repoRoot: process.cwd() })
  const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) =>
    v !== undefined && !k.startsWith('NODETERM_') && k !== 'ELECTRON_RUN_AS_NODE')) as Record<string, string>
  let output = ''
  const name = 'nt-isolated-message-smoke'
  const wait = async (predicate: () => boolean, timeout = 15_000) => {
    const until = Date.now() + timeout
    while (!predicate()) {
      if (Date.now() > until) throw new Error('isolated host fixture timed out')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  let probeMs = 0
  try {
    await client.attach(name, {
      shell: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NoExit', '-Command', `& ${quote(exe)} -e ${quote(reader)}`],
      cwd: dir, env, cols: 120, rows: 30
    }, 200, { onData: (data) => { output += data }, onExit: () => {} })
    await wait(() => output.includes('READY_HOST'))
    const start = Date.now()
    const owner = await client.messageOwner(name)
    probeMs = Date.now() - start
    assert.equal(isAgentPane(owner, 'opencode'), 'agent')
    assert.ok(probeMs < 2000, `OS probe exceeds the delivery budget: ${probeMs}ms`)
    assert.equal(await client.messagePasteReady(name), true)
    const envelope = 'HOST_PING\nsecond line'
    assert.equal(await client.messageEnvelope(name, envelope, owner!), true)
    await wait(() => /HOST_RECEIVED:[A-Za-z0-9+/=]+;/.test(output))
    const received = output.match(/HOST_RECEIVED:([A-Za-z0-9+/=]+);/)![1]
    assert.equal(Buffer.from(received, 'base64').toString(), `\x1b[200~${envelope}\x1b[201~\r`)
    assert.equal(await client.messageEnvelope(name, 'must not arrive', { ...owner!, paneId: 'wrong-generation' }), false)
  } finally {
    await client.killSession(name)
    // Only the private fixture is retired. The real user's host is never contacted.
    await wait(() => !fs.existsSync(path.join(dir, 'session-host.json')), 40_000)
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
  console.log(JSON.stringify({ namedPipe: 'passed', consoleIdentity: 'passed', probeMs,
    multilinePaste: 'passed', staleGenerationRefusal: 'passed', cleanup: 'passed' }))
}

// The client intentionally unrefs its transport; Electron normally owns the event loop. Keep
// this standalone runner alive until assertions and the private host's retirement finish.
const keepAlive = setInterval(() => {}, 1000)
void main().then(() => { clearInterval(keepAlive); process.exit(0) }, (error) => {
  clearInterval(keepAlive)
  console.error(error)
  process.exit(1)
})

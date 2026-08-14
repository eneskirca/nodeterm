// The hook prelude, run by the real /bin/sh. It is prepended to every managed hook script, so a
// quoting slip here does not break "codex identity recovery" — it breaks every agent's hooks on
// every machine. It is also the one place where a data file's contents become environment
// variables, which is why the negative cases below matter as much as the positive one.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { codexThreadIdentityResolverSh } from './codex-thread-identity-sh'

const run = promisify(execFile)

let dir = ''
let root = ''
let script = ''

beforeAll(() => {
  // A space in the path on purpose: the real one is macOS's "Application Support".
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm codex prelude '))
  root = path.join(dir, 'codex-thread-nodes')
  fs.mkdirSync(root, { recursive: true })
  script = path.join(dir, 'prelude.sh')
  fs.writeFileSync(
    script,
    `#!/bin/sh\n${codexThreadIdentityResolverSh(root)}\n` +
      `printf '%s|%s|%s\\n' "\${NODETERM_NODE_ID-}" "\${NODETERM_HOOK_ENDPOINT-}" "\${NODETERM_CANVAS_CONTROL-}"\n`,
    { mode: 0o755 }
  )
})

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

function record(threadId: string, body: string): void {
  fs.writeFileSync(path.join(root, threadId), body)
}

async function resolve(env: Record<string, string>): Promise<string> {
  const { stdout } = await run('/bin/sh', [script], {
    env: { PATH: process.env.PATH ?? '', HOME: dir, ...env }
  })
  return stdout.trim()
}

describe('codex thread identity prelude', () => {
  it('is valid POSIX sh', async () => {
    await expect(run('/bin/sh', ['-n', script])).resolves.toBeTruthy()
  })

  it('recovers the node binding a tool shell never inherited', async () => {
    record('thread-1', `nodeId=node-7\nendpoint=${dir}/hook-endpoint.env\nsignature=x\n`)
    expect(await resolve({ CODEX_THREAD_ID: 'thread-1' })).toBe(
      `node-7|${dir}/hook-endpoint.env|1`
    )
  })

  it('changes nothing when the session already knows its node', async () => {
    record('thread-1', `nodeId=node-7\nendpoint=${dir}/hook-endpoint.env\nsignature=x\n`)
    expect(await resolve({ CODEX_THREAD_ID: 'thread-1', NODETERM_NODE_ID: 'node-own' })).toBe(
      'node-own||'
    )
  })

  it('is inert for every other agent (no CODEX_THREAD_ID, no record)', async () => {
    expect(await resolve({})).toBe('||')
    expect(await resolve({ CODEX_THREAD_ID: 'unknown-thread' })).toBe('||')
  })

  it('refuses a thread id that could escape the record directory', async () => {
    expect(await resolve({ CODEX_THREAD_ID: '../../etc/passwd' })).toBe('||')
  })

  it('exports nothing when a record carries a node id or endpoint it should not', async () => {
    record('thread-bad-node', `nodeId=node 7; rm -rf /\nendpoint=${dir}/e\n`)
    expect(await resolve({ CODEX_THREAD_ID: 'thread-bad-node' })).toBe('||')
    record('thread-bad-ep', 'nodeId=node-7\nendpoint=relative/e\n')
    expect(await resolve({ CODEX_THREAD_ID: 'thread-bad-ep' })).toBe('||')
    record('thread-bad-ep2', 'nodeId=node-7\nendpoint=/etc/$(id)\n')
    expect(await resolve({ CODEX_THREAD_ID: 'thread-bad-ep2' })).toBe('||')
  })
})

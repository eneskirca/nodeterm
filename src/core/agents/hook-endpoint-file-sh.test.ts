import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { hookServer } from './hook-server'
import { nodeTokenDir } from './node-token-files'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'
import { testTmpDir } from '../test-tmp'

// Issue #351: on macOS the userDataDir lives under "Application Support" — a directory name WITH A
// SPACE. The managed hook script SOURCES the endpoint file (`. "$file"`) under /bin/sh, so an
// unquoted `NODETERM_NODE_TOKEN_DIR=/Users/x/Library/Application Support/...` made sh try to run
// `Support/...`, exit 127, and the hook fell back to plain mode for EVERY macOS user. This test
// proves the file sources cleanly under a REAL /bin/sh — the current-line-27 structural assertion
// passed while real sh failed, which is exactly the class of bug this repo insists we prove against
// a real reader.
let spaced = ''
beforeAll(async () => {
  const root = testTmpDir('nodeterm-ep-sh-')
  // A subdir with a space in its name — the "Application Support" shape.
  spaced = path.join(root, 'App Support', 'node-terminal')
  fs.mkdirSync(spaced, { recursive: true })
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: spaced }))
  await hookServer.start()
})
afterAll(() => {
  hookServer.stop()
})

describe('endpoint file sources cleanly under real /bin/sh with a spaced path', () => {
  it('preserves the exact NODETERM_NODE_TOKEN_DIR path, space intact', () => {
    const p = hookServer.endpointFilePath()
    // Sanity: the writer really is exercising a spaced path this run.
    expect(nodeTokenDir()).toContain(' ')
    expect(nodeTokenDir().startsWith(spaced)).toBe(true)

    const r = spawnSync(
      '/bin/sh',
      ['-c', `. "$1" && printf %s "$NODETERM_NODE_TOKEN_DIR"`, 'sh', p],
      { encoding: 'utf8' }
    )
    // (1) sh must source the file without error (unquoted → exit 127).
    expect(r.status).toBe(0)
    // (2) and the path must arrive with its space intact, byte for byte.
    expect(r.stdout).toBe(nodeTokenDir())
  })

  it('the shared TS parser reads the REAL writer output identically to sh', async () => {
    const { parseEndpointEnv } = await import('./hook-endpoint-parse')
    const env = parseEndpointEnv(fs.readFileSync(hookServer.endpointFilePath(), 'utf8'))
    expect(env.NODETERM_NODE_TOKEN_DIR).toBe(nodeTokenDir())
    expect(env.NODETERM_HOOK_TOKEN).toBe(hookServer.getToken())
    expect(Number(env.NODETERM_HOOK_PORT)).toBe(hookServer.getPort())
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Guard for a bug that bit a developer for real: `startServer` merges the managed agent hooks
// into the user's REAL agent config dirs (~/.claude/settings.json et al), pointing them at
// `<dataDir>/agent-hooks/<agent>.sh`. A test booting the server with a temp `dataDir` and then
// removing it therefore left a DANGLING hook behind in the developer's own settings.json —
// which Claude Code runs on every tool call, so every later session on that machine died.
// `installHooks: false` is the opt-out; every server test must pass it. This test keeps the
// flag honest (and the default — a real deployment does need the hooks installed).
vi.mock('../../src/core/agents/hooks', () => ({ installManagedAgentHooks: vi.fn() }))

import { startServer } from '../../src/server/index'
import { installManagedAgentHooks } from '../../src/core/agents/hooks'

describe('startServer: managed hook install is opt-out-able', () => {
  let dataDir: string
  let testHome: string
  let close: (() => Promise<void>) | undefined
  const realHome = process.env.HOME

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-e2e-hookguard-'))
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-e2e-hookguard-home-'))
    process.env.HOME = testHome
    vi.mocked(installManagedAgentHooks).mockClear()
  })

  afterEach(async () => {
    await close?.()
    close = undefined
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    fs.rmSync(dataDir, { recursive: true, force: true })
    fs.rmSync(testHome, { recursive: true, force: true })
  })

  const boot = (installHooks?: boolean) =>
    startServer({
      port: 0,
      host: '127.0.0.1',
      dataDir,
      rendererDir: path.join(dataDir, 'no-renderer'),
      insecureHttp: false,
      passwordSeed: 'hookguard-pw',
      ...(installHooks === undefined ? {} : { installHooks })
    })

  it('does NOT touch the real agent config dirs when installHooks is false', async () => {
    const srv = await boot(false)
    close = srv.close
    expect(installManagedAgentHooks).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(testHome, '.claude', 'skills', 'get-linked-context', 'SKILL.md'))).toBe(false)
    expect(fs.existsSync(path.join(testHome, '.codex', 'AGENTS.md'))).toBe(false)
  }, 30_000)

  it('installs the hooks by default (real deployments need them)', async () => {
    const srv = await boot(undefined)
    close = srv.close
    expect(installManagedAgentHooks).toHaveBeenCalledOnce()
    expect(fs.existsSync(path.join(testHome, '.claude', 'skills', 'get-linked-context', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(testHome, '.codex', 'AGENTS.md'))).toBe(true)
  }, 30_000)
})

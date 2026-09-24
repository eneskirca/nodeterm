/**
 * Linking a config dir whose `settings.json` is a SYMLINK must keep it a symlink.
 *
 * This is not a hypothetical shape — it is the layout the feature was built for. A user running
 * two logins keeps `~/.claude-2` with `settings.json`, `hooks/`, `skills/` and `projects/` all
 * symlinked into `~/.claude/`, so the two identities share one configuration and differ only in
 * `.claude.json` + `.credentials.json`. If `link` replaced the link with a regular file, the two
 * profiles would silently fork: every later edit to the real `~/.claude/settings.json` — including
 * this app's own hook upgrades — would stop reaching the second account.
 *
 * Deliberately NO `vi.mock` here (unlike claude-accounts-service.test.ts, which observes the
 * installer): the property under test is what the REAL writer does to a REAL symlink, and a mock
 * of the writer is exactly the fixture that cannot discriminate.
 *
 * MUTATION: publish the staged config to the symlink path instead of its resolved target.
 * The symlink assertion must fail: atomic publication is safe only at the shared target.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import { registerClaudeAccountsIpc } from './claude-accounts-service'
import { resetClaudeAccountsSourceForTests } from './claude-config-dir'

let fake: FakePlatform
let root = ''
let userDataDir = ''
/** The real `$HOME`, put back after each case. */
let realHome: string | undefined

const call = (channel: string, ...args: unknown[]): Promise<any> =>
  Promise.resolve(fake.handlers[channel](...args))

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'nt-link-symlink-'))
  userDataDir = path.join(root, 'userData')
  mkdirSync(userDataDir, { recursive: true })
  // The REAL installer runs here, and its managed script lives per MACHINE at
  // `$HOME/.nodeterm/agent-hooks/<agent>.sh` (install-helper.ts) — not under userData. Without a
  // scratch HOME this test overwrote the developer's live hook script with one that embeds THIS
  // test's temp userData path (measured 2026-09-01: a running nodeterm Server's Codex identity
  // recovery pointed at a deleted tmp dir). `os.homedir()` honours $HOME on POSIX; on Windows it
  // reads USERPROFILE, so both are pointed at the fixture.
  realHome = process.env.HOME
  process.env.HOME = root
  process.env.USERPROFILE = root
  fake = fakePlatform({ userDataDir })
  initPlatform(fake)
  registerClaudeAccountsIpc()
})
afterEach(() => {
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  delete process.env.USERPROFILE
  resetPlatformForTests()
  resetClaudeAccountsSourceForTests()
  rmSync(root, { recursive: true, force: true })
})

describe('link() installs the managed hook THROUGH a symlinked settings.json', () => {
  it('keeps the symlink and writes the hook into its shared target', async () => {
    // The real two-profile layout: `.claude` holds the real settings, `.claude-2` symlinks to it.
    const primary = path.join(root, '.claude')
    const second = path.join(root, '.claude-2')
    mkdirSync(primary, { recursive: true })
    mkdirSync(second, { recursive: true })
    const target = path.join(primary, 'settings.json')
    const link = path.join(second, 'settings.json')
    writeFileSync(target, JSON.stringify({ theme: 'dark', hooks: {} }, null, 2))
    symlinkSync(target, link)

    const res = await call(IPC.claudeAccountsLink, second)
    expect(res.configDir).toBe(second)

    // 1. Still a symlink — the two profiles did not fork.
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    // 2. The SHARED target gained the managed hook (written through the link).
    const written = JSON.parse(readFileSync(target, 'utf8')) as {
      theme?: string
      hooks?: Record<string, unknown[]>
    }
    expect(written.theme).toBe('dark') // the user's own settings survived the merge
    expect(Object.keys(written.hooks ?? {}).length).toBeGreaterThan(0)
    expect(JSON.stringify(written.hooks)).toContain('agent-hooks')
  })

  it('creates settings.json when the linked dir has none (an unconfigured profile)', async () => {
    const second = path.join(root, '.claude-3')
    mkdirSync(second, { recursive: true })
    await call(IPC.claudeAccountsLink, second)
    const written = JSON.parse(readFileSync(path.join(second, 'settings.json'), 'utf8')) as {
      hooks?: Record<string, unknown[]>
    }
    expect(Object.keys(written.hooks ?? {}).length).toBeGreaterThan(0)
  })
})

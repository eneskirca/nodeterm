/**
 * Issue #313 — the managed-Claude-account LIFECYCLE lives in core, so both shells serve it.
 *
 * Every one of these cases drives the shipped registration through the platform seam
 * (`fakePlatform().handlers[...]`), i.e. exactly what `ipcMain.handle` / the server's WS dispatch
 * invoke. Registering with NO deps is the Server Edition's own configuration: no canvas skill
 * (canvas control is not wired there) and no SSH manager, so a ctx carrying a projectId must still
 * take the local path.
 *
 * MUTATION: drop the `installSkill` call, or let `remoteFor` treat a projectId alone as remote →
 * the skill case and the local-fallback case redden.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import { registerClaudeAccountsIpc, installHooksIntoLocalAccounts } from './claude-accounts-service'
import { accountConfigDir } from './claude-accounts-core'
import {
  registerClaudeAccountsSource,
  resetClaudeAccountsSourceForTests
} from './claude-config-dir'
import type { ClaudeAccount } from '../shared/types'

// The hook + TUI writers are exercised by their own suites; here they only have to be OBSERVED,
// and a real write would touch the account dir this file then asserts about.
const installed: string[] = []
const tui: string[] = []
vi.mock('./agents/hooks/claude', () => ({
  installClaudeHooksInto: (dir: string) => {
    installed.push(dir)
  },
  ensureClaudeFullscreenTuiInto: async (dir: string) => {
    tui.push(dir)
  }
}))

// Same reason as the hook writers above, with one addition: the real applier resolves the SYSTEM
// skills dir from `os.homedir()`, so an unmocked sweep in this suite would read the developer's own
// `~/.claude/skills`. Its behaviour is covered against a real filesystem in
// `claude-skill-share.test.ts`; here we only assert the WIRING (issue #643).
const shared: { dir: string; enabled: boolean }[] = []
vi.mock('./claude-skill-share', () => ({
  EMPTY_SKILL_SHARE: { linked: 0, unlinked: 0, shared: 0, occupied: 0, failed: 0 },
  applySkillShare: async (dir: string, enabled: boolean) => {
    shared.push({ dir, enabled })
    return { linked: enabled ? 2 : 0, unlinked: 0, shared: enabled ? 2 : 0, occupied: 0, failed: 0 }
  }
}))

let fake: FakePlatform
let userDataDir: string

const call = (channel: string, ...args: unknown[]): Promise<any> =>
  Promise.resolve(fake.handlers[channel](...args))

beforeEach(() => {
  installed.length = 0
  tui.length = 0
  shared.length = 0
  userDataDir = mkdtempSync(path.join(os.tmpdir(), 'nt-accounts-'))
  fake = fakePlatform({ userDataDir })
  initPlatform(fake)
})
afterEach(() => {
  resetPlatformForTests()
  resetClaudeAccountsSourceForTests()
  rmSync(userDataDir, { recursive: true, force: true })
})

describe('registerClaudeAccountsIpc — the six channels', () => {
  it('registers exactly the six claude-accounts channels', () => {
    registerClaudeAccountsIpc()
    expect(Object.keys(fake.handlers).sort()).toEqual(
      [
        IPC.claudeAccountsAdd,
        IPC.claudeAccountsCancelWait,
        IPC.claudeAccountsLink,
        IPC.claudeAccountsRemove,
        IPC.claudeAccountsSetSkillSharing,
        IPC.claudeAccountsWaitLogin
      ].sort()
    )
  })

  it('add() creates the config dir under userData, installs the hook and returns the id', async () => {
    const skilled: string[] = []
    registerClaudeAccountsIpc({ installSkill: (d) => skilled.push(d) })
    const res = await call(IPC.claudeAccountsAdd)
    expect(res.id).toMatch(/^[A-Za-z0-9-]+$/)
    expect(res.configDir).toBe(accountConfigDir(userDataDir, res.id))
    expect(existsSync(res.configDir)).toBe(true)
    expect(installed).toEqual([res.configDir])
    expect(skilled).toEqual([res.configDir])
    expect(tui).toEqual([res.configDir])
  })

  it('add() without an installSkill dep (the Server Edition) writes no skill', async () => {
    registerClaudeAccountsIpc()
    const res = await call(IPC.claudeAccountsAdd)
    expect(existsSync(res.configDir)).toBe(true)
    expect(installed).toEqual([res.configDir])
  })

  it('waitLogin resolves once .claude.json carries an oauthAccount email', async () => {
    registerClaudeAccountsIpc({ pollMs: 5 })
    const { id, configDir } = await call(IPC.claudeAccountsAdd)
    const pending = call(IPC.claudeAccountsWaitLogin, id)
    setTimeout(() => {
      writeFileSync(
        path.join(configDir, '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: 'a@b.com' } })
      )
    }, 20)
    await expect(pending).resolves.toEqual({ email: 'a@b.com' })
  })

  it('cancelWaitLogin makes an in-flight wait resolve null', async () => {
    registerClaudeAccountsIpc({ pollMs: 5 })
    const { id } = await call(IPC.claudeAccountsAdd)
    const pending = call(IPC.claudeAccountsWaitLogin, id)
    await new Promise((r) => setTimeout(r, 20))
    await call(IPC.claudeAccountsCancelWait, id)
    await expect(pending).resolves.toBeNull()
  })

  it('remove() deletes the account dir', async () => {
    registerClaudeAccountsIpc()
    const { id, configDir } = await call(IPC.claudeAccountsAdd)
    writeFileSync(path.join(configDir, '.credentials.json'), '{}')
    await call(IPC.claudeAccountsRemove, id)
    expect(existsSync(configDir)).toBe(false)
  })

  it('a traversing id is refused, not resolved outside the accounts root', async () => {
    registerClaudeAccountsIpc({ pollMs: 5 })
    await expect(call(IPC.claudeAccountsRemove, '../x')).rejects.toThrow(/invalid account id/)
    await expect(call(IPC.claudeAccountsWaitLogin, '../x')).rejects.toThrow(/invalid account id/)
  })
})

describe('the remote leg is resolved lazily, and its absence falls back to LOCAL', () => {
  it('a ctx with a projectId takes the remote leg when one is wired', async () => {
    const calls: string[] = []
    registerClaudeAccountsIpc({
      pollMs: 5,
      remote: () => ({
        add: async (projectId, id) => {
          calls.push(`add:${projectId}:${id}`)
          return { configDir: `~/.nodeterm/claude-accounts/${id}`, versionSupported: true }
        },
        readLogin: async () => JSON.stringify({ oauthAccount: { email: 'r@h.com' } }),
        remove: async (projectId, id) => {
          calls.push(`rm:${projectId}:${id}`)
        }
      })
    })
    const res = await call(IPC.claudeAccountsAdd, { projectId: 'p1' })
    expect(res.configDir).toBe(`~/.nodeterm/claude-accounts/${res.id}`)
    // Nothing local was created or installed for a remote account.
    expect(existsSync(accountConfigDir(userDataDir, res.id))).toBe(false)
    expect(installed).toEqual([])
    await expect(call(IPC.claudeAccountsWaitLogin, res.id, { projectId: 'p1' })).resolves.toEqual({
      email: 'r@h.com'
    })
    await call(IPC.claudeAccountsRemove, res.id, { projectId: 'p1' })
    expect(calls).toEqual([`add:p1:${res.id}`, `rm:p1:${res.id}`])
  })

  it('a ctx with a projectId but NO wired remote takes the local path (Server Edition)', async () => {
    registerClaudeAccountsIpc({ remote: () => undefined })
    const res = await call(IPC.claudeAccountsAdd, { projectId: 'p1' })
    expect(res.configDir).toBe(accountConfigDir(userDataDir, res.id))
    expect(existsSync(res.configDir)).toBe(true)
  })
})

describe('installHooksIntoLocalAccounts', () => {
  it('installs into every LOCAL account dir and skips host-scoped ones', () => {
    const extra: string[] = []
    installHooksIntoLocalAccounts(
      [{ id: 'aaa' }, { id: 'bbb', host: 'user@example' }, { id: 'ccc' }],
      (d) => extra.push(d)
    )
    const dirs = ['aaa', 'ccc'].map((id) => accountConfigDir(userDataDir, id))
    expect(installed).toEqual(dirs)
    expect(extra).toEqual(dirs)
    expect(tui).toEqual(dirs)
  })

  it('one failing account never stops the rest (boot must not be blocked)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mkdirSync(path.join(userDataDir, 'claude-accounts'), { recursive: true })
    installHooksIntoLocalAccounts([{ id: 'aaa' }, { id: '../evil' }, { id: 'ccc' }])
    expect(installed).toEqual(
      ['aaa', 'ccc'].map((id) => accountConfigDir(userDataDir, id))
    )
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  // Issue #643. The launch sweep re-links (a skill added to ~/.claude/skills since the last run)
  // and NEVER removes: ownership is inferred from a link's shape, so an OFF pass here could delete
  // an identical link the user made by hand in their own linked-account dir. Removal happens only
  // where the user asked for it, in `setSkillSharing`.
  it('re-links shared skills for local accounts that opted in, and touches no other account', () => {
    installHooksIntoLocalAccounts([
      { id: 'aaa', shareSystemSkills: true },
      { id: 'bbb', host: 'user@example', shareSystemSkills: true },
      { id: 'ccc' },
      { id: 'ddd', shareSystemSkills: false }
    ])
    expect(shared).toEqual([{ dir: accountConfigDir(userDataDir, 'aaa'), enabled: true }])
  })
})

describe('claudeAccounts.setSkillSharing', () => {
  it('reconciles the account dir and reports what happened', async () => {
    registerClaudeAccountsIpc()
    const res = await call(IPC.claudeAccountsSetSkillSharing, 'aaa', true)
    expect(shared).toEqual([{ dir: accountConfigDir(userDataDir, 'aaa'), enabled: true }])
    expect(res).toMatchObject({ linked: 2, shared: 2 })
  })

  // A remote account's config dir is on its HOST; reconciling the local one would link this
  // machine's skills into a directory the session never reads. v1 refuses instead of guessing.
  it('refuses a remote (SSH) account and touches no filesystem', async () => {
    registerClaudeAccountsSource(() => [
      { id: 'aaa', label: 'r', host: 'user@example', createdAt: 0 } as ClaudeAccount
    ])
    registerClaudeAccountsIpc()
    const res = await call(IPC.claudeAccountsSetSkillSharing, 'aaa', true)
    expect(res.refused).toBe('remote-account')
    expect(shared).toEqual([])
  })

  it('refuses an id that could traverse out of the accounts root', async () => {
    registerClaudeAccountsIpc()
    await expect(call(IPC.claudeAccountsSetSkillSharing, '../evil', true)).rejects.toThrow()
    expect(shared).toEqual([])
  })
})

// ---- Linked accounts (adopting a config dir the user already drives) -------------------------
//
// A linked account is a config dir the USER already owns (`~/.claude-2` driven by their own
// `CLAUDE_CONFIG_DIR` shell function). Two properties matter more than the rest and are pinned
// against REAL temp directories rather than mocks: the validation actually refuses each bad shape,
// and removing a linked account never deletes anything.
describe('claudeAccounts.link', () => {
  let linkDir = ''
  beforeEach(() => {
    linkDir = mkdtempSync(path.join(os.tmpdir(), 'nt-linked-'))
    registerClaudeAccountsIpc()
  })
  afterEach(() => rmSync(linkDir, { recursive: true, force: true }))

  it('links an existing dir: id + normalized path + email, hook and TUI installed into it', async () => {
    writeFileSync(
      path.join(linkDir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'second@example.com' } })
    )
    const res = await call(IPC.claudeAccountsLink, `${linkDir}/`)
    expect(res.id).toMatch(/^[A-Za-z0-9-]+$/)
    expect(res.configDir).toBe(linkDir) // trailing slash normalized away
    expect(res.email).toBe('second@example.com')
    // The same two writes an ADDED account gets — or the linked identity reports no agent status.
    expect(installed).toEqual([linkDir])
    expect(tui).toEqual([linkDir])
  })

  it('is email: null — not a failure — when the dir is not signed in yet', async () => {
    await expect(call(IPC.claudeAccountsLink, linkDir)).resolves.toMatchObject({ email: null })
    writeFileSync(path.join(linkDir, '.claude.json'), 'not json at all')
    await expect(call(IPC.claudeAccountsLink, linkDir)).resolves.toMatchObject({ email: null })
    writeFileSync(path.join(linkDir, '.claude.json'), JSON.stringify({ oauthAccount: {} }))
    await expect(call(IPC.claudeAccountsLink, linkDir)).resolves.toMatchObject({ email: null })
  })

  it('expands a leading ~ (the value is typed, not shell-expanded by anything else)', async () => {
    // Proved through the REFUSAL rather than by linking something inside the real home: the
    // message names the path we actually resolved, so an unexpanded `~` would read as
    // `No such directory: ~/nodeterm-link-probe` and this assertion would fail.
    await expect(call(IPC.claudeAccountsLink, '~/nodeterm-link-probe-does-not-exist')).rejects.toThrow(
      `No such directory: ${path.join(os.homedir(), 'nodeterm-link-probe-does-not-exist')}`
    )
    // A bare `~` is the home dir itself; `~evil` is NOT a home-relative path and stays literal
    // (so it is refused as relative, never resolved against $HOME).
    await expect(call(IPC.claudeAccountsLink, '~notauser/.claude-2')).rejects.toThrow(
      /Not an absolute path/
    )
  })

  it('refuses a relative path, a `..` path, and a non-string', async () => {
    for (const bad of ['.claude-2', '../.claude-2', 'claude', '', '   ']) {
      await expect(call(IPC.claudeAccountsLink, bad)).rejects.toThrow()
    }
    await expect(call(IPC.claudeAccountsLink, 42 as unknown as string)).rejects.toThrow()
    expect(installed).toEqual([]) // nothing was written for any refusal
  })

  it('refuses the system ~/.claude by name, without stat-ing anything', async () => {
    await expect(call(IPC.claudeAccountsLink, path.join(os.homedir(), '.claude'))).rejects.toThrow(
      /system Claude config dir/
    )
    // Same dir spelled differently must give the same refusal — both sides go through one
    // normalizer (CONTRIBUTING: normalize BOTH sides of a path comparison).
    await expect(
      call(IPC.claudeAccountsLink, path.join(os.homedir(), 'x', '..', '.claude') + '/')
    ).rejects.toThrow(/system Claude config dir/)
  })

  it('refuses a nodeterm-managed account dir (one dir must not have two account ids)', async () => {
    const managed = accountConfigDir(userDataDir, 'abc')
    mkdirSync(managed, { recursive: true })
    await expect(call(IPC.claudeAccountsLink, managed)).rejects.toThrow(/nodeterm-managed/)
    await expect(call(IPC.claudeAccountsLink, path.join(userDataDir, 'claude-accounts'))).rejects.toThrow(
      /nodeterm-managed/
    )
  })

  it('refuses a dir already linked — by NORMALIZED path, not by the string typed', async () => {
    registerClaudeAccountsSource(() => [
      { id: 'existing', label: 'first', configDir: linkDir, createdAt: 0 } as ClaudeAccount
    ])
    await expect(call(IPC.claudeAccountsLink, `${linkDir}/`)).rejects.toThrow(/already linked/)
    await expect(call(IPC.claudeAccountsLink, path.join(linkDir, 'x', '..'))).rejects.toThrow(
      /already linked/
    )
  })

  it('refuses a path that does not exist, and a path that is a FILE', async () => {
    await expect(call(IPC.claudeAccountsLink, path.join(linkDir, 'nope'))).rejects.toThrow(
      /No such directory/
    )
    const file = path.join(linkDir, 'a-file')
    writeFileSync(file, 'x')
    await expect(call(IPC.claudeAccountsLink, file)).rejects.toThrow(/Not a directory/)
    expect(installed).toEqual([])
  })
})

describe('removing a LINKED account never deletes the directory', () => {
  it('forgets the record and leaves a REAL directory (and its contents) on disk', async () => {
    const linkDir = mkdtempSync(path.join(os.tmpdir(), 'nt-linked-rm-'))
    const credentials = path.join(linkDir, '.credentials.json')
    writeFileSync(credentials, '{"token":"the user\'s own login"}')
    try {
      registerClaudeAccountsIpc()
      const res = await call(IPC.claudeAccountsLink, linkDir)
      registerClaudeAccountsSource(() => [
        { id: res.id, label: 'second', configDir: linkDir, createdAt: 0 } as ClaudeAccount
      ])
      await call(IPC.claudeAccountsRemove, res.id)
      // THE assertion of this whole work package: the dir is the user's, and it is still there.
      expect(existsSync(linkDir)).toBe(true)
      expect(existsSync(credentials)).toBe(true)
      // …and no managed dir was invented and deleted in its place either.
      expect(existsSync(accountConfigDir(userDataDir, res.id))).toBe(false)
    } finally {
      rmSync(linkDir, { recursive: true, force: true })
    }
  })

  it('still deletes a MANAGED dir — the rm path is unchanged for the accounts nodeterm created', async () => {
    registerClaudeAccountsIpc()
    const { id, configDir } = await call(IPC.claudeAccountsAdd)
    // A settings list that mentions the id but carries NO configDir must not turn off the delete.
    registerClaudeAccountsSource(() => [{ id, label: 'm', createdAt: 0 } as ClaudeAccount])
    await call(IPC.claudeAccountsRemove, id)
    expect(existsSync(configDir)).toBe(false)
  })
})

describe('installHooksIntoLocalAccounts covers linked accounts', () => {
  it('installs into the linked dir, not into a managed dir that does not exist', () => {
    registerClaudeAccountsSource(() => [
      { id: 'linked', label: 'l', configDir: '/home/u/.claude-2', createdAt: 0 } as ClaudeAccount
    ])
    installHooksIntoLocalAccounts([{ id: 'linked' }, { id: 'managed' }])
    expect(installed).toEqual(['/home/u/.claude-2', accountConfigDir(userDataDir, 'managed')])
  })
})

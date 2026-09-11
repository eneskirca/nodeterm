// Impure lifecycle for managed Claude accounts: config-dir creation/deletion, login capture
// (poll .claude.json), CLI version check, per-account hook install. The account LIST lives in
// settings.json (renderer-owned via useSettings); this module only owns the filesystem.
//
// Lives in core so BOTH shells serve it. Before this the channels were registered only by
// src/main, so the Server Edition's bridge answered E_UNSUPPORTED for every one of them: a
// browser-only deployment could select a managed account (env injection, transcript readers,
// usage and the pickers are all core already) but could never CREATE, log into or remove one
// (issue #313).
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { homedir } from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { IPC } from '../shared/ipc'
import {
  accountConfigDir,
  isSupportedClaudeVersion,
  normalizeLinkedConfigDir,
  parseLoginCapture
} from './claude-accounts-core'
import {
  claudeAccountsSnapshot,
  claudeConfigDirFor,
  linkedClaudeConfigDirFor
} from './claude-config-dir'
import { applySkillShare, EMPTY_SKILL_SHARE } from './claude-skill-share'
import { installClaudeHooksInto, ensureClaudeFullscreenTuiInto } from './agents/hooks/claude'
import { findInLoginPath } from './pty-manager'
import { platform } from './platform'

const execFileP = promisify(execFile)
const LOGIN_POLL_MS = 2000
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Optional per-call SSH context. When `projectId` is present AND that project has a live
 * ControlMaster, the account is a REMOTE one: its config dir + login capture + removal happen on the
 * host over ssh instead of on the local filesystem. The renderer passes it only for accounts scoped
 * to an SSH project (`ClaudeAccount.host`); local accounts omit it entirely (unchanged behavior).
 */
export interface AccountCtx {
  projectId?: string
}

/** The three remote legs, as the shell implements them (desktop: SshProjectManager). */
export interface ClaudeAccountsRemote {
  add(
    projectId: string,
    id: string
  ): Promise<{ configDir: string; versionSupported: boolean } | null>
  readLogin(projectId: string, id: string): Promise<string | null>
  remove(projectId: string, id: string): Promise<void>
}

export interface ClaudeAccountsDeps {
  /**
   * Install the canvas-control skill into a freshly created account dir. Claude Code resolves
   * skills relative to CLAUDE_CONFIG_DIR, so a managed account needs its own copy. DESKTOP ONLY:
   * canvas control is not wired on the Server Edition at all (its hook server answers
   * `control unavailable` by name), so there is nothing for a skill file to reach there.
   */
  installSkill?: (configDir: string) => void
  /**
   * Resolves the live remote legs, or undefined when SSH is not wired / not yet created. A THUNK
   * rather than a plain object because that is the fact the local fallback turns on: desktop
   * creates its SshProjectManager after this registration, and an `AccountCtx` carrying a
   * projectId while no manager exists must degrade to the LOCAL path (pre-existing behavior).
   * The Server Edition passes none, so every call takes that same local path.
   */
  remote?: () => ClaudeAccountsRemote | undefined
  /** Login poll interval. Injectable so tests need not wait out the 2 s production cadence. */
  pollMs?: number
}

const waiters = new Map<string, { cancelled: boolean }>()

async function checkClaudeVersion(): Promise<boolean> {
  // The < 2.1 warning is about the shared macOS Keychain service; on Linux/Windows
  // credentials are files inside each config dir, so no version collides.
  if (process.platform !== 'darwin') return true
  try {
    const claude = await findInLoginPath('claude')
    if (!claude) return false
    const { stdout } = await execFileP(claude, ['--version'], { timeout: 5000 })
    return isSupportedClaudeVersion(stdout.trim())
  } catch {
    return false
  }
}

/** Register the five `claude-accounts:*` channels on the core platform seam. */
export function registerClaudeAccountsIpc(deps: ClaudeAccountsDeps = {}): void {
  const pollMs = deps.pollMs ?? LOGIN_POLL_MS
  // Resolve the live remote legs for a context, or null when the context is local / not connected.
  const remoteFor = (ctx?: AccountCtx): { r: ClaudeAccountsRemote; projectId: string } | null => {
    const projectId = ctx?.projectId
    const r = deps.remote?.()
    return projectId && r ? { r, projectId } : null
  }

  platform().handle(IPC.claudeAccountsAdd, async (ctx?: AccountCtx) => {
    const id = randomUUID()
    const remote = remoteFor(ctx)
    if (remote) {
      // REMOTE account: create the config dir + install the status hook on the host. No local dir
      // and no local hook install — the session runs entirely on the remote host.
      const res = await remote.r.add(remote.projectId, id)
      // Null means the project wasn't connected / mkdir failed: still return the id so the renderer
      // can show the pending row; the login node will surface the connection error itself.
      return { id, configDir: res?.configDir ?? '', versionSupported: res?.versionSupported ?? true }
    }
    const configDir = claudeConfigDirFor(id)
    await fs.mkdir(configDir, { recursive: true })
    // Install the managed hook (+ the canvas skill where the shell has one) up front so the very
    // first session in this account already reports status (badges/notifications/subagent viz)
    // and can control the canvas (Claude resolves both relative to CLAUDE_CONFIG_DIR, not ~/.claude).
    installClaudeHooksInto(configDir)
    deps.installSkill?.(configDir)
    // Ensure fullscreen TUI in the new account dir (write-if-absent, version-gated). Best-effort,
    // off the response path — the memoized probe + write both fail open.
    void ensureClaudeFullscreenTuiInto(configDir)
    const versionSupported = await checkClaudeVersion()
    return { id, configDir, versionSupported }
  })

  platform().handle(IPC.claudeAccountsWaitLogin, async (id: string, ctx?: AccountCtx) => {
    const remote = remoteFor(ctx)
    // Local path: `claudeConfigDirFor` also validates the id shape (rejects traversal).
    const configDir = remote ? null : claudeConfigDirFor(id)
    const w = { cancelled: false }
    waiters.set(id, w)
    const deadline = Date.now() + LOGIN_TIMEOUT_MS
    try {
      while (!w.cancelled && Date.now() < deadline) {
        try {
          const raw = remote
            ? await remote.r.readLogin(remote.projectId, id)
            : await fs.readFile(path.join(configDir as string, '.claude.json'), 'utf-8')
          const captured = raw ? parseLoginCapture(raw) : null
          if (captured) return captured
        } catch {
          // not written yet — keep polling
        }
        await new Promise((r) => setTimeout(r, pollMs))
      }
      return null
    } finally {
      waiters.delete(id)
    }
  })

  platform().handle(IPC.claudeAccountsCancelWait, (id: string) => {
    const w = waiters.get(id)
    if (w) w.cancelled = true
  })

  platform().handle(IPC.claudeAccountsRemove, async (id: string, ctx?: AccountCtx) => {
    const remote = remoteFor(ctx)
    if (remote) {
      // Best-effort remote cleanup; if the project isn't connected the manager no-ops and the
      // renderer still drops the account from its list (the dir is orphaned, harmless).
      await remote.r.remove(remote.projectId, id)
      return
    }
    // LINKED account: the directory is the USER's — `~/.claude-2` with their real
    // login in it — and removing the account only forgets the settings row (the renderer owns the
    // list). Forgetting is the whole operation here; `rm -rf` would delete a second Claude
    // identity the app never created.
    if (linkedClaudeConfigDirFor(id)) return
    // `accountConfigDir`, NOT `claudeConfigDirFor`: the resolver now answers with a LINKED dir for
    // a linked account, and the one call in this file that deletes recursively must be incapable
    // of naming anything but `{userData}/claude-accounts/<id>` — id-validated, as it always was.
    // The early return above is the behaviour; this line is the structural guarantee behind it.
    const configDir = accountConfigDir(platform().userDataDir, id)
    await fs.rm(configDir, { recursive: true, force: true })
  })

  /**
   * Link a PRE-EXISTING Claude config dir as an account. The renderer owns the settings list, so
   * this returns the record and appends nothing itself.
   *
   * Every refusal is a distinct `Error` message because the Settings UI shows it: "that path does
   * not exist" and "that is already linked" need different fixes from the user, and one generic
   * "invalid config dir" would make the second one look like a typo in the first.
   */
  platform().handle(IPC.claudeAccountsLink, async (rawDir: string) => {
    if (typeof rawDir !== 'string' || !rawDir.trim()) {
      throw new Error('Enter the path to a Claude config directory.')
    }
    // `~` expansion is ours to do: the value is typed into a text field, not passed through a
    // shell, so nothing else would ever expand it — and `~/.claude-2` is exactly how the user
    // refers to the dir their own shell function exports.
    const typed = rawDir.trim()
    const expanded =
      typed === '~' || typed.startsWith('~/') ? path.join(homedir(), typed.slice(1)) : typed
    const configDir = normalizeLinkedConfigDir(expanded)
    if (!configDir) {
      throw new Error(`Not an absolute path: ${typed}`)
    }
    // The three STRING refusals run before the fs is touched at all, and that ORDER is
    // deliberate rather than incidental: a path we are going to refuse on its shape alone is a
    // path we should not be stat'ing, and refusing `~/.claude` needs to say so even on a machine
    // where the dir has not been created yet ("no such directory" would be a misleading answer to
    // "why can't I link my system account?").
    if (configDir === normalizeLinkedConfigDir(path.join(homedir(), '.claude'))) {
      throw new Error('That is the system Claude config dir — it is already the default account.')
    }
    const managedRoot = normalizeLinkedConfigDir(
      path.join(platform().userDataDir, 'claude-accounts')
    )
    // Under the managed root ⇒ it is an account nodeterm created. Linking it would give one dir two
    // account ids, and the second one would be removable-without-delete while the first still
    // `rm -rf`s the same directory.
    if (managedRoot && (configDir === managedRoot || configDir.startsWith(managedRoot + path.sep))) {
      throw new Error('That is a nodeterm-managed account directory — add it with Add account.')
    }
    // Duplicate by NORMALIZED path, not by the string typed: `~/.claude-2/` and `/home/u/.claude-2`
    // are the same dir, and two rows for one dir would show two chips for one identity.
    for (const a of claudeAccountsSnapshot()) {
      if (!a.host && normalizeLinkedConfigDir(a.configDir) === configDir) {
        throw new Error(`That config dir is already linked (${a.label || a.email || a.id}).`)
      }
    }
    // EXISTS and IS A DIRECTORY, checked before anything is written into it. `stat`, not `lstat`:
    // a symlinked config dir is a normal way to keep one, and the target is what everything else
    // — the CLI, the jail, the transcript reader — resolves through.
    let isDir = false
    try {
      isDir = (await fs.stat(configDir)).isDirectory()
    } catch {
      throw new Error(`No such directory: ${configDir}`)
    }
    if (!isDir) throw new Error(`Not a directory: ${configDir}`)
    // The ONLY read of the dir's contents, and only after the user asked for this dir by name.
    // Missing / not-logged-in is `email: null`, NOT a failure: linking a dir the user has not
    // signed into yet is legitimate — the CLI writes the email when they do.
    let email: string | null = null
    try {
      const raw = await fs.readFile(path.join(configDir, '.claude.json'), 'utf-8')
      email = parseLoginCapture(raw)?.email ?? null
    } catch {
      email = null
    }
    // Same two writes an ADDED account gets, so a linked account reports agent status from its
    // very next session. `installClaudeHooksInto` MERGES into an existing settings.json and writes
    // it back through `writeFileSync`, which follows a symlink — the two-profile layout where
    // `<dir>/settings.json` is a symlink into `~/.claude/` keeps its symlink and the shared target
    // gains the managed hook (pinned by test).
    installClaudeHooksInto(configDir)
    void ensureClaudeFullscreenTuiInto(configDir)
    return { id: randomUUID(), configDir, email }
  })

  /**
   * Turn `~/.claude/skills` sharing on/off for one LOCAL account and reconcile now (issue #643).
   * The renderer owns the settings flag; this is only the effect.
   *
   * **Local accounts only, by construction.** A REMOTE account's config dir lives on its host, so
   * this would have to link that host's `~/.claude/skills` over the ControlMaster — a generated
   * shell with its own "never delete through the link" proof obligation, and a separate change.
   * Rather than silently reconciling the wrong machine's filesystem, an account with a `host`
   * REFUSES here (the Settings switch is disabled with the reason, so this is the backstop for a
   * hand-edited settings.json, not the message anyone normally sees).
   */
  platform().handle(IPC.claudeAccountsSetSkillSharing, async (id: string, enabled: boolean) => {
    const remoteAccount = claudeAccountsSnapshot().some((a) => a.id === id && a.host)
    if (remoteAccount) return { ...EMPTY_SKILL_SHARE, refused: 'remote-account' as const }
    // `claudeConfigDirFor` validates the id alphabet AND resolves a LINKED account to the user's
    // own dir — which is the right target: a linked account is an identity like any other, and its
    // `skills/` is subject to the same isolation. The plan's realpath refusal is what keeps a
    // hand-edited `configDir` of `~/.claude` from turning this into a self-link.
    return applySkillShare(claudeConfigDirFor(id), enabled)
  })
}

/**
 * Install the managed hook + fullscreen-TUI setting into every LOCAL managed account dir. Managed
 * accounts each carry their own settings.json (Claude Code resolves it relative to
 * CLAUDE_CONFIG_DIR), so an app update's new hook version must reach them too. Best-effort per
 * account: one failing account must never block launch (matches installManagedAgentHooks'
 * fail-open). `extra` is the shell's per-account addition — desktop installs the canvas skill.
 *
 * LINKED accounts (`ClaudeAccount.configDir`) are covered by the same loop and need no branch:
 * they carry no `host`, and `claudeConfigDirFor` answers with the user's own dir — which is the
 * point, because an app update's new hook version has to reach `~/.claude-2` too or that identity
 * silently stops reporting agent status. The shells register the accounts source BEFORE calling
 * this, or the resolver would hand back a managed dir that does not exist for those rows.
 */
export function installHooksIntoLocalAccounts(
  accounts: readonly { id: string; host?: string; shareSystemSkills?: boolean }[],
  extra?: (configDir: string) => void
): void {
  for (const acct of accounts) {
    if (acct.host) continue // remote accounts live on another host; nothing to install locally
    try {
      const configDir = claudeConfigDirFor(acct.id)
      installClaudeHooksInto(configDir)
      extra?.(configDir)
      // Shared-skills reconcile (issue #643) — the ON direction ONLY, and that asymmetry is the
      // safety property. ON has real work to do at every boot: a skill the user added to
      // `~/.claude/skills` since the last run needs a new link, and one they deleted leaves a
      // broken entry Claude Code would still try to read. OFF is a REMOVAL, and a launch sweep is
      // the wrong place to perform one: ownership here is inferred from a link's shape (a link at
      // `<name>` pointing at `<system>/<name>`), which cannot tell OUR link from an identical one
      // the user made by hand — and a LINKED account's dir is the user's own `~/.claude-2`, where
      // exactly that hand-made link is a normal thing to find. So the off-switch removes links
      // only where intent is explicit (`claude-accounts:set-skill-sharing`). The cost is that a
      // settings.json edited to `false` while the app was closed leaves its links until the switch
      // is flipped — links, not data, and visible in the account's own folder.
      // AFTER `extra`, so the canvas skill's own directory exists before anything looks at it.
      if (acct.shareSystemSkills) void applySkillShare(configDir, true)
      // Off the critical path: it awaits the memoized CLI probe, then writes fail-open. (The
      // system ~/.claude is handled by installManagedAgentHooks, which covers both shells.)
      void ensureClaudeFullscreenTuiInto(configDir)
    } catch (e) {
      console.warn(`[agent-hooks] account ${acct.id} hook install failed`, e)
    }
  }
}

import { describe, expect, it } from 'vitest'
import {
  accountConfigDir,
  remoteAccountConfigDir,
  isSafeRemoteTranscriptPath,
  remoteAccountConfigDirAbs,
  claudeKeychainService,
  usageCredsPaths,
  AUTH_ENV_STRIP,
  accountTmuxEnvArgs,
  parseLoginCapture,
  isSupportedClaudeVersion,
  transcriptRootFor,
  isSafeLocalTranscriptPath,
  classifyClaudeConfigDir,
  configDirFromTranscriptPath,
  normalizeLinkedConfigDir,
  expandTildeLinkedDir,
  sameLinkedConfigDir,
  isUnderLinkedConfigDir
} from './claude-accounts-core'
import type { ClaudeAccount } from '../shared/types'

describe('accountConfigDir', () => {
  it('maps an account id under userData/claude-accounts', () => {
    expect(accountConfigDir('/Users/x/Library/Application Support/nodeterm', 'a1')).toBe(
      '/Users/x/Library/Application Support/nodeterm/claude-accounts/a1'
    )
  })
  it('rejects ids that could traverse out of the root', () => {
    expect(() => accountConfigDir('/ud', '../evil')).toThrow()
    expect(() => accountConfigDir('/ud', 'a/b')).toThrow()
    expect(() => accountConfigDir('/ud', '')).toThrow()
  })
})

describe('remoteAccountConfigDir', () => {
  it('is a ~-relative path under .nodeterm/claude-accounts (leading ~ for ssh expansion)', () => {
    expect(remoteAccountConfigDir('a1')).toBe('~/.nodeterm/claude-accounts/a1')
  })
  it('rejects ids that could traverse out of the remote root', () => {
    expect(() => remoteAccountConfigDir('../evil')).toThrow()
    expect(() => remoteAccountConfigDir('a/b')).toThrow()
    expect(() => remoteAccountConfigDir('')).toThrow()
  })
})

describe('remoteAccountConfigDirAbs', () => {
  it('joins the resolved remote $HOME with the account dir (absolute for tmux -e)', () => {
    expect(remoteAccountConfigDirAbs('/home/bob', 'a1')).toBe(
      '/home/bob/.nodeterm/claude-accounts/a1'
    )
  })
  it('tolerates a trailing slash on the remote home', () => {
    expect(remoteAccountConfigDirAbs('/home/bob/', 'a1')).toBe(
      '/home/bob/.nodeterm/claude-accounts/a1'
    )
  })
  it('rejects traversing ids', () => {
    expect(() => remoteAccountConfigDirAbs('/home/bob', '../evil')).toThrow()
  })
})

describe('claudeKeychainService', () => {
  // Claude Code ≥ 2.1 scopes the macOS Keychain service per config dir:
  // 'Claude Code-credentials-' + first 8 hex chars of sha256(configDir).
  it('appends the first 8 hex of sha256(configDir)', () => {
    const svc = claudeKeychainService('/ud/claude-accounts/a1')
    expect(svc).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/)
  })
  it('is deterministic per dir and differs across dirs', () => {
    expect(claudeKeychainService('/a')).toBe(claudeKeychainService('/a'))
    expect(claudeKeychainService('/a')).not.toBe(claudeKeychainService('/b'))
  })
})

describe('usageCredsPaths', () => {
  it('without a config dir uses the legacy unscoped services + ~/.claude paths', () => {
    expect(usageCredsPaths('/Users/x')).toEqual({
      services: ['Claude Code-credentials', 'claudeAiOauth'],
      credsFile: '/Users/x/.claude/.credentials.json',
      identityFile: '/Users/x/.claude.json'
    })
  })
  it('with a config dir puts the scoped service first + reads that dir', () => {
    const configDir = '/ud/claude-accounts/a1'
    const p = usageCredsPaths('/Users/x', configDir)
    expect(p.services).toEqual([
      claudeKeychainService(configDir),
      'Claude Code-credentials',
      'claudeAiOauth'
    ])
    expect(p.credsFile).toBe('/ud/claude-accounts/a1/.credentials.json')
    expect(p.identityFile).toBe('/ud/claude-accounts/a1/.claude.json')
  })
})

describe('AUTH_ENV_STRIP', () => {
  it('covers the env vars that would shadow the account OAuth login', () => {
    expect(AUTH_ENV_STRIP).toEqual(
      expect.arrayContaining(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'])
    )
  })
})

describe('accountTmuxEnvArgs', () => {
  it('emits one -e pair for CLAUDE_CONFIG_DIR', () => {
    expect(accountTmuxEnvArgs('/ud/claude-accounts/a1')).toEqual([
      '-e',
      'CLAUDE_CONFIG_DIR=/ud/claude-accounts/a1'
    ])
  })
})

describe('parseLoginCapture', () => {
  it('extracts the email from oauthAccount', () => {
    const raw = JSON.stringify({ oauthAccount: { emailAddress: 'work@example.com' } })
    expect(parseLoginCapture(raw)).toEqual({ email: 'work@example.com' })
  })
  it('accepts the alternate `email` key', () => {
    const raw = JSON.stringify({ oauthAccount: { email: 'e@x.com' } })
    expect(parseLoginCapture(raw)).toEqual({ email: 'e@x.com' })
  })
  it('returns null while login has not completed', () => {
    expect(parseLoginCapture('{}')).toBeNull()
    expect(parseLoginCapture('not json')).toBeNull()
    expect(parseLoginCapture(JSON.stringify({ oauthAccount: {} }))).toBeNull()
  })
})

describe('transcriptRootFor', () => {
  it('defaults to the system ~/.claude/projects when no account', () => {
    expect(transcriptRootFor('/Users/x', null)).toBe('/Users/x/.claude/projects')
    expect(transcriptRootFor('/Users/x', '/ud', undefined)).toBe('/Users/x/.claude/projects')
  })
  it('uses the account config dir + projects when an account id is given', () => {
    expect(transcriptRootFor('/Users/x', '/ud', 'a1')).toBe('/ud/claude-accounts/a1/projects')
  })
  it('rejects account ids that could traverse out of the root', () => {
    expect(() => transcriptRootFor('/Users/x', '/ud', '../evil')).toThrow()
  })
})

describe('isSupportedClaudeVersion', () => {
  it('accepts 2.1+ and rejects older', () => {
    expect(isSupportedClaudeVersion('2.1.0 (Claude Code)')).toBe(true)
    expect(isSupportedClaudeVersion('2.10.3 (Claude Code)')).toBe(true)
    expect(isSupportedClaudeVersion('3.0.0')).toBe(true)
    expect(isSupportedClaudeVersion('2.0.14 (Claude Code)')).toBe(false)
    expect(isSupportedClaudeVersion('1.0.44')).toBe(false)
    expect(isSupportedClaudeVersion('garbage')).toBe(false) // unparseable → unsupported (warn)
  })
})

describe('isSafeLocalTranscriptPath', () => {
  const home = '/Users/x'
  const ud = '/Users/x/Library/Application Support/nodeterm'
  const legacy = '/Users/x/.claude/projects'
  const acctRoot = `${ud}/claude-accounts`

  it('accepts the legacy system root and paths under it', () => {
    expect(isSafeLocalTranscriptPath(legacy, home, ud)).toBe(true)
    expect(isSafeLocalTranscriptPath(`${legacy}/-repo/abc.jsonl`, home, ud)).toBe(true)
  })
  it('accepts a valid account transcript root and paths under it', () => {
    expect(isSafeLocalTranscriptPath(`${acctRoot}/a1/projects`, home, ud)).toBe(true)
    expect(isSafeLocalTranscriptPath(`${acctRoot}/a1/projects/-repo/s.jsonl`, home, ud)).toBe(true)
    expect(isSafeLocalTranscriptPath(`${acctRoot}/A1_b-2/projects/x.jsonl`, home, ud)).toBe(true)
  })
  it("accepts gemini's chats root and paths under it", () => {
    expect(isSafeLocalTranscriptPath(`${home}/.gemini/tmp`, home, ud)).toBe(true)
    expect(
      isSafeLocalTranscriptPath(`${home}/.gemini/tmp/nodeterm/chats/session-2026-08-09T10-48-fd01438b.jsonl`, home, ud)
    ).toBe(true)
  })
  it("accepts codex's sessions root and paths under it", () => {
    expect(isSafeLocalTranscriptPath(`${home}/.codex/sessions`, home, ud)).toBe(true)
    expect(
      isSafeLocalTranscriptPath(`${home}/.codex/sessions/2026/07/26/rollout-2026-07-26T00-48-38-019f9b40.jsonl`, home, ud)
    ).toBe(true)
  })
  it("honors a relocated codex home ($CODEX_HOME), and only that one", () => {
    // The shells pass `codexHome()` (core/usage/codex-usage.ts), which honors $CODEX_HOME. Without
    // this the jail fails CLOSED on a relocated codex — its meter would silently never fill, which
    // is the quiet failure mode, not a leak.
    const moved = '/opt/codex-home'
    expect(isSafeLocalTranscriptPath(`${moved}/sessions/2026/07/26/rollout-x.jsonl`, home, ud, moved)).toBe(true)
    expect(isSafeLocalTranscriptPath(`${moved}/sessions`, home, ud, moved)).toBe(true)
    // The relocated home REPLACES the default; it does not add to it.
    expect(isSafeLocalTranscriptPath(`${home}/.codex/sessions/x.jsonl`, home, ud, moved)).toBe(false)
    // …and the rest of the relocated home is still out of reach.
    expect(isSafeLocalTranscriptPath(`${moved}/auth.json`, home, ud, moved)).toBe(false)
    // Omitted / empty ⇒ the `<home>/.codex` default, exactly as before this parameter existed.
    expect(isSafeLocalTranscriptPath(`${home}/.codex/sessions/x.jsonl`, home, ud)).toBe(true)
    expect(isSafeLocalTranscriptPath(`${home}/.codex/sessions/x.jsonl`, home, ud, '')).toBe(true)
  })
  it('still refuses the rest of those agents\' config trees, and everything outside all roots', () => {
    // The widening is per-ROOT, not per-agent-home: the credential and settings files that sit
    // beside the transcripts stay out of reach.
    expect(isSafeLocalTranscriptPath(`${home}/.gemini/settings.json`, home, ud)).toBe(false)
    expect(isSafeLocalTranscriptPath(`${home}/.gemini`, home, ud)).toBe(false)
    expect(isSafeLocalTranscriptPath(`${home}/.codex/auth.json`, home, ud)).toBe(false)
    expect(isSafeLocalTranscriptPath(`${home}/.codex`, home, ud)).toBe(false)
    // …and $HOME itself was never opened up.
    expect(isSafeLocalTranscriptPath(home, home, ud)).toBe(false)
    expect(isSafeLocalTranscriptPath(`${home}/.ssh/id_rsa`, home, ud)).toBe(false)
    expect(isSafeLocalTranscriptPath('/etc/passwd', home, ud)).toBe(false)
  })
  it('rejects a `..` escape out of the accounts root', () => {
    // Callers pass an already-resolved path; a resolved traversal lands elsewhere entirely.
    expect(isSafeLocalTranscriptPath('/Users/x/.ssh/id_rsa', home, ud)).toBe(false)
    expect(isSafeLocalTranscriptPath(`${ud}/hook-endpoint.env`, home, ud)).toBe(false)
  })
  it('rejects an invalid account-id segment', () => {
    expect(isSafeLocalTranscriptPath(`${acctRoot}/../evil/projects/x`, home, ud)).toBe(false)
    expect(isSafeLocalTranscriptPath(`${acctRoot}/a.b/projects/x`, home, ud)).toBe(false)
  })
  it('rejects a non-projects subpath under a valid account', () => {
    expect(isSafeLocalTranscriptPath(`${acctRoot}/a1/.credentials.json`, home, ud)).toBe(false)
    expect(isSafeLocalTranscriptPath(`${acctRoot}/a1`, home, ud)).toBe(false)
    expect(isSafeLocalTranscriptPath(acctRoot, home, ud)).toBe(false)
  })
  it('rejects a sibling-prefix root (…/projects-evil)', () => {
    expect(isSafeLocalTranscriptPath(`${legacy}-evil/x.jsonl`, home, ud)).toBe(false)
    expect(isSafeLocalTranscriptPath(`${acctRoot}/a1/projects-evil/x`, home, ud)).toBe(false)
  })
})

// The remote analogue of isSafeLocalTranscriptPath. A remote node's managed account writes its
// transcripts under `~/.nodeterm/claude-accounts/<id>/projects` (remoteAccountConfigDir), NOT
// under `~/.claude/projects` — jailing to the latter alone silently dropped every hook payload
// for a remote account, which killed the session-name sync, the context meter and subagent cards.
describe('isSafeRemoteTranscriptPath', () => {
  const home = '/home/enes'
  const ok = (p: string) => isSafeRemoteTranscriptPath(p, home)

  it('accepts the system-default remote root', () => {
    expect(ok('/home/enes/.claude/projects/-srv-proj/abc.jsonl')).toBe(true)
  })

  it('accepts a managed REMOTE account root', () => {
    expect(ok('/home/enes/.nodeterm/claude-accounts/a1/projects/-srv-proj/abc.jsonl')).toBe(true)
  })

  it('rejects an arbitrary remote file (forged POST over the reverse tunnel)', () => {
    expect(ok('/home/enes/.ssh/id_rsa')).toBe(false)
    expect(ok('/etc/passwd')).toBe(false)
  })

  it('rejects a sibling-prefix root', () => {
    expect(ok('/home/enes/.claude/projects-evil/x.jsonl')).toBe(false)
  })

  it('rejects a non-projects dir inside the accounts root, and a traversing account id', () => {
    expect(ok('/home/enes/.nodeterm/claude-accounts/a1/.ssh/id_rsa')).toBe(false)
    expect(ok('/home/enes/.nodeterm/claude-accounts/../../.ssh/id_rsa')).toBe(false)
  })

  it('is false when the remote home is unknown', () => {
    expect(isSafeRemoteTranscriptPath('/home/enes/.claude/projects/x.jsonl', undefined)).toBe(false)
  })
})

// ---- Observed accounts (deriving a session's account from its transcript path) ----------------
//
// The whole feature turns on these three pure functions, so each is driven with BOTH path
// dialects: the desktop that classifies an SSH node's POSIX `transcript_path` may itself be
// running on Windows, and the config dir a Windows user posts is `C:\Users\x\.claude`.

describe('configDirFromTranscriptPath', () => {
  it('walks up to the projects root and names its parent (POSIX)', () => {
    expect(
      configDirFromTranscriptPath('/home/u/.claude/projects/-home-u-repo/abc-123.jsonl')
    ).toBe('/home/u/.claude')
    expect(
      configDirFromTranscriptPath('/home/u/.claude-2/projects/-home-u-repo/abc-123.jsonl')
    ).toBe('/home/u/.claude-2')
  })

  it('handles a Windows-shaped path', () => {
    expect(
      configDirFromTranscriptPath('C:\\Users\\x\\.claude\\projects\\slug\\id.jsonl')
    ).toBe('C:\\Users\\x\\.claude')
    // Forward slashes are separators on Windows too, and a drive letter is what says so.
    expect(configDirFromTranscriptPath('C:/Users/x/.claude-2/projects/slug/id.jsonl')).toBe(
      'C:\\Users\\x\\.claude-2'
    )
    expect(
      configDirFromTranscriptPath('\\\\srv\\share\\.claude\\projects\\slug\\id.jsonl')
    ).toBe('\\\\srv\\share\\.claude')
  })

  it('resolves a SUBAGENT transcript nested deeper under the same projects root', () => {
    expect(
      configDirFromTranscriptPath('/home/u/.claude-2/projects/-repo/parent/sub/agent.jsonl')
    ).toBe('/home/u/.claude-2')
  })

  it('takes the NEAREST projects walking up, not the first one in the path', () => {
    // Someone who keeps their checkouts in ~/projects: taking the FIRST match would answer
    // `/home/u` — i.e. hand the jail a $HOME-wide root.
    expect(
      configDirFromTranscriptPath('/home/u/projects/.claude/projects/-repo/s.jsonl')
    ).toBe('/home/u/projects/.claude')
  })

  it('normalizes the answer (redundant separators, `.`, a resolved `..`)', () => {
    expect(configDirFromTranscriptPath('/home/u//.claude/./projects/slug/s.jsonl')).toBe(
      '/home/u/.claude'
    )
    expect(configDirFromTranscriptPath('/home/u/x/../.claude/projects/slug/s.jsonl')).toBe(
      '/home/u/.claude'
    )
  })

  it('is null when there is no projects segment to walk up to', () => {
    expect(configDirFromTranscriptPath('/home/u/.claude/settings.json')).toBeNull()
    expect(configDirFromTranscriptPath('/home/u/projects')).toBeNull() // no parent-of-projects file
    expect(configDirFromTranscriptPath('')).toBeNull()
    expect(configDirFromTranscriptPath('   ')).toBeNull()
    expect(configDirFromTranscriptPath(undefined as unknown as string)).toBeNull()
    // A sibling-prefix segment is not a `projects` segment.
    expect(configDirFromTranscriptPath('/home/u/.claude/projects-evil/s.jsonl')).toBeNull()
  })

  it('takes an explicit dialect when the caller knows the owning filesystem', () => {
    // A relative Windows path has no drive letter to detect, so the caller must say.
    expect(configDirFromTranscriptPath('x\\.claude\\projects\\s\\id.jsonl', 'win32')).toBe(
      'x\\.claude'
    )
    // …and the same string read as POSIX is one segment with backslashes IN ITS NAME.
    expect(configDirFromTranscriptPath('x\\.claude\\projects\\s\\id.jsonl', 'posix')).toBeNull()
  })
})

describe('normalizeLinkedConfigDir', () => {
  it('accepts an absolute path and normalizes it', () => {
    expect(normalizeLinkedConfigDir('/home/u/.claude-2')).toBe('/home/u/.claude-2')
    expect(normalizeLinkedConfigDir('/home/u/.claude-2/')).toBe('/home/u/.claude-2')
    expect(normalizeLinkedConfigDir('  /home/u//./.claude-2  ')).toBe('/home/u/.claude-2')
    expect(normalizeLinkedConfigDir('C:\\Users\\x\\.claude-2\\')).toBe('C:\\Users\\x\\.claude-2')
    expect(normalizeLinkedConfigDir('C:/Users/x/.claude-2')).toBe('C:\\Users\\x\\.claude-2')
  })

  it('never strips a path down INTO its root', () => {
    expect(normalizeLinkedConfigDir('/')).toBe('/')
    expect(normalizeLinkedConfigDir('C:\\')).toBe('C:\\')
  })

  it('refuses anything that is not an absolute, `..`-free string', () => {
    expect(normalizeLinkedConfigDir('.claude-2')).toBeNull()
    expect(normalizeLinkedConfigDir('~/.claude-2')).toBeNull() // `~` is the caller's to expand
    expect(normalizeLinkedConfigDir('../.claude-2')).toBeNull()
    expect(normalizeLinkedConfigDir('')).toBeNull()
    expect(normalizeLinkedConfigDir('   ')).toBeNull()
    expect(normalizeLinkedConfigDir(undefined)).toBeNull()
    expect(normalizeLinkedConfigDir(null)).toBeNull()
    expect(normalizeLinkedConfigDir(42)).toBeNull()
    expect(normalizeLinkedConfigDir({ configDir: '/x' })).toBeNull()
  })

  it('resolves a `..` that normalize can absorb rather than refusing it', () => {
    expect(normalizeLinkedConfigDir('/home/u/x/../.claude-2')).toBe('/home/u/.claude-2')
    // …and one that walks past the root is clamped by normalize, never left as `..`.
    expect(normalizeLinkedConfigDir('/../../etc')).toBe('/etc')
  })
})

describe('classifyClaudeConfigDir', () => {
  const homeDir = '/home/u'
  const userDataDir = '/home/u/.config/nodeterm'
  const linked: ClaudeAccount = {
    id: 'linked-1',
    label: 'second',
    configDir: '/home/u/.claude-2',
    createdAt: 0
  }
  const at = (dir: string, accounts: ClaudeAccount[] = [linked]) =>
    classifyClaudeConfigDir(dir, { homeDir, userDataDir, accounts })

  it('names a MANAGED local dir by its id, without consulting settings', () => {
    // The path IS nodeterm's own root, so the id in it is the id nodeterm minted — including for
    // an account still `pending` its login, whose login node is the session posting from there.
    expect(at(`${userDataDir}/claude-accounts/abc-1`, [])).toEqual({
      configDir: `${userDataDir}/claude-accounts/abc-1`,
      accountId: 'abc-1',
      known: true
    })
  })

  it('names a MANAGED REMOTE dir by its id (an SSH node posts the host path)', () => {
    expect(at('/home/enes/.nodeterm/claude-accounts/xyz_2', [])).toEqual({
      configDir: '/home/enes/.nodeterm/claude-accounts/xyz_2',
      accountId: 'xyz_2',
      known: true
    })
  })

  it('names a LINKED dir by its account id, trailing slash and `.`-segments included', () => {
    for (const p of ['/home/u/.claude-2', '/home/u/.claude-2/', '/home/u/./.claude-2']) {
      expect(at(p)).toEqual({ configDir: '/home/u/.claude-2', accountId: 'linked-1', known: true })
    }
  })

  it('ignores a linked row that is pending, host-scoped, or holds an unusable path', () => {
    const unusable: ClaudeAccount[] = [
      { ...linked, id: 'p', pending: true },
      { ...linked, id: 'h', host: 'u@example' },
      { ...linked, id: 'rel', configDir: '.claude-2' },
      { ...linked, id: 'dots', configDir: '/home/u/../u/.claude-2' } // normalizes to the same dir
    ]
    // The first three contribute nothing; the fourth normalizes onto the observed dir and wins.
    expect(at('/home/u/.claude-2', unusable).accountId).toBe('dots')
    expect(at('/home/u/.claude-2', unusable.slice(0, 3))).toEqual({
      configDir: '/home/u/.claude-2',
      accountId: null,
      known: false
    })
  })

  it('calls the system dir system — this machine`s and a remote host`s alike', () => {
    expect(at('/home/u/.claude')).toEqual({
      configDir: '/home/u/.claude',
      accountId: null,
      known: true
    })
    // The classifier is host-agnostic on purpose: an SSH node's `<remoteHome>/.claude` is that
    // host's system account, and the observed dir is a label — nothing branches on it for
    // permission. (Which MACHINE the dir is on is the renderer's to record; see
    // `ObservedClaudeAccount.remote`.)
    expect(at('/home/enes/.claude')).toEqual({
      configDir: '/home/enes/.claude',
      accountId: null,
      known: true
    })
  })

  it('prefers a LINKED match over the `.claude` basename rule', () => {
    const odd: ClaudeAccount = { id: 'odd', label: 'o', configDir: '/opt/profiles/.claude', createdAt: 0 }
    expect(at('/opt/profiles/.claude', [odd]).accountId).toBe('odd')
  })

  it('leaves an unrecorded dir unknown — and never reads it', () => {
    // The real motivating case BEFORE the user links it: the chip labels it `.claude-3` by path.
    expect(at('/home/u/.claude-3', [])).toEqual({
      configDir: '/home/u/.claude-3',
      accountId: null,
      known: false
    })
    // A forged POST aiming at a credential tree is unknown too — a label, and nothing is opened.
    expect(at('/home/u/.ssh', [])).toEqual({
      configDir: '/home/u/.ssh',
      accountId: null,
      known: false
    })
    // A bad id segment under the managed root is NOT a managed account.
    expect(at(`${userDataDir}/claude-accounts/a.b`, [])).toEqual({
      configDir: `${userDataDir}/claude-accounts/a.b`,
      accountId: null,
      known: false
    })
    // …nor is a dir two levels down inside one.
    expect(at(`${userDataDir}/claude-accounts/a1/projects`, []).known).toBe(false)
  })

  it('classifies Windows-shaped dirs, case-insensitively as that filesystem is', () => {
    const win = (dir: string, accounts: ClaudeAccount[] = []) =>
      classifyClaudeConfigDir(dir, {
        homeDir: 'C:\\Users\\x',
        userDataDir: 'C:\\Users\\x\\AppData\\Roaming\\nodeterm',
        accounts
      })
    expect(win('C:\\Users\\x\\.claude')).toEqual({
      configDir: 'C:\\Users\\x\\.claude',
      accountId: null,
      known: true
    })
    expect(win('C:\\Users\\x\\AppData\\Roaming\\nodeterm\\claude-accounts\\a1').accountId).toBe('a1')
    expect(
      win('c:\\users\\X\\.claude-2\\', [
        { id: 'w1', label: 'w', configDir: 'C:\\Users\\x\\.claude-2', createdAt: 0 }
      ]).accountId
    ).toBe('w1')
  })

  it('does not match a POSIX dir against a WINDOWS local root (or the reverse)', () => {
    // A Windows desktop classifying an SSH node's POSIX path must not confuse the two trees —
    // and `/home/u/.claude` still reads as a system dir through the host-agnostic basename rule.
    const onWindows = classifyClaudeConfigDir('/home/u/.claude-2', {
      homeDir: 'C:\\Users\\x',
      userDataDir: 'C:\\Users\\x\\AppData\\Roaming\\nodeterm',
      accounts: [{ id: 'w1', label: 'w', configDir: 'C:\\Users\\x\\.claude-2', createdAt: 0 }]
    })
    expect(onWindows).toEqual({ configDir: '/home/u/.claude-2', accountId: null, known: false })
  })
})

describe('transcriptRootFor — linked accounts', () => {
  it('uses the linked config dir`s projects when one is given', () => {
    expect(transcriptRootFor('/Users/x', '/ud', 'a1', '/Users/x/.claude-2')).toBe(
      '/Users/x/.claude-2/projects'
    )
    // A linked root does not need the account id to be resolvable as a managed one.
    expect(transcriptRootFor('/Users/x', null, undefined, '/Users/x/.claude-2')).toBe(
      '/Users/x/.claude-2/projects'
    )
  })
  it('degrades to the managed/system root when the linked value is unusable', () => {
    // "Never something more destructive than the default" — a hand-edited relative path must not
    // resolve against the process cwd.
    expect(transcriptRootFor('/Users/x', '/ud', 'a1', '.claude-2')).toBe(
      '/ud/claude-accounts/a1/projects'
    )
    expect(transcriptRootFor('/Users/x', '/ud', undefined, '')).toBe('/Users/x/.claude/projects')
  })
})

describe('isSafeLocalTranscriptPath — linked config dirs', () => {
  const home = '/home/u'
  const ud = '/home/u/.config/nodeterm'
  const linkedDirs = ['/home/u/.claude-2']

  it('accepts <linkedDir>/projects and everything under it', () => {
    expect(
      isSafeLocalTranscriptPath(`${home}/.claude-2/projects`, home, ud, undefined, undefined, linkedDirs)
    ).toBe(true)
    expect(
      isSafeLocalTranscriptPath(`${home}/.claude-2/projects/-repo/s.jsonl`, home, ud, undefined, undefined, linkedDirs)
    ).toBe(true)
  })

  it('still refuses everything ELSE in that dir — the `.ssh` case §3 names', () => {
    expect(isSafeLocalTranscriptPath(`${home}/.claude-2/.ssh`, home, ud, undefined, undefined, linkedDirs)).toBe(false)
    expect(
      isSafeLocalTranscriptPath(`${home}/.claude-2/.credentials.json`, home, ud, undefined, undefined, linkedDirs)
    ).toBe(false)
    expect(isSafeLocalTranscriptPath(`${home}/.claude-2`, home, ud, undefined, undefined, linkedDirs)).toBe(false)
    // A sibling-prefix root, as for every other allowed root.
    expect(
      isSafeLocalTranscriptPath(`${home}/.claude-2/projects-evil/x`, home, ud, undefined, undefined, linkedDirs)
    ).toBe(false)
    // The PARENT of a linked dir is not opened up by linking the child.
    expect(
      isSafeLocalTranscriptPath(`${home}/projects/x.jsonl`, home, ud, undefined, undefined, linkedDirs)
    ).toBe(false)
  })

  it('contributes no root for a value that fails re-validation at the point of use', () => {
    // Hand-editable settings JSON: a relative or `..`-bearing dir is ignored, not resolved.
    expect(
      isSafeLocalTranscriptPath(`${home}/.claude-2/projects/s.jsonl`, home, ud, undefined, undefined, ['.claude-2'])
    ).toBe(false)
    expect(isSafeLocalTranscriptPath('/etc/projects/x', home, ud, undefined, undefined, ['/etc/../etc'])).toBe(true)
    expect(isSafeLocalTranscriptPath(`${home}/.ssh/id_rsa`, home, ud, undefined, undefined, ['/'])).toBe(false)
  })

  it('is bit-for-bit the old predicate when no linked dirs are passed', () => {
    expect(isSafeLocalTranscriptPath(`${home}/.claude-2/projects/s.jsonl`, home, ud)).toBe(false)
    expect(
      isSafeLocalTranscriptPath(`${home}/.claude-2/projects/s.jsonl`, home, ud, undefined, undefined, [])
    ).toBe(false)
    expect(
      isSafeLocalTranscriptPath(`${home}/.claude/projects/s.jsonl`, home, ud, undefined, undefined, linkedDirs)
    ).toBe(true)
  })
})

describe('linked config dir path helpers (link refusals on every dialect)', () => {
  it('expands ~ and ~/ everywhere, ~\\ only in the win32 dialect', () => {
    expect(expandTildeLinkedDir('~/.claude-2', '/home/u', 'posix')).toBe('/home/u/.claude-2')
    expect(expandTildeLinkedDir('~', '/home/u', 'posix')).toBe('/home/u')
    // POSIX: a backslash is filename text — left literal (then refused as relative).
    expect(expandTildeLinkedDir('~\\.claude-2', '/home/u', 'posix')).toBe('~\\.claude-2')
    expect(expandTildeLinkedDir('~\\.claude-2', 'C:\\Users\\X', 'win32')).toBe('C:\\Users\\X\\.claude-2')
    expect(expandTildeLinkedDir('~/.claude-2', 'C:\\Users\\X', 'win32')).toBe('C:\\Users\\X\\.claude-2')
    expect(expandTildeLinkedDir('/abs/~/x', '/home/u', 'posix')).toBe('/abs/~/x')
    expect(expandTildeLinkedDir('~other/x', '/home/u', 'posix')).toBe('~other/x')
  })

  it('sameLinkedConfigDir is case-insensitive on win32 only', () => {
    expect(sameLinkedConfigDir('C:\\Users\\X\\.claude', 'c:\\users\\x\\.CLAUDE\\')).toBe(true)
    expect(sameLinkedConfigDir('C:/Users/X/.claude', 'c:\\users\\x\\.claude')).toBe(true)
    expect(sameLinkedConfigDir('/home/u/.claude', '/home/u/.claude/')).toBe(true)
    expect(sameLinkedConfigDir('/home/u/.claude', '/home/u/.CLAUDE')).toBe(false)
    expect(sameLinkedConfigDir('/home/u/.claude', 'relative')).toBe(false)
    expect(sameLinkedConfigDir(undefined, undefined)).toBe(false)
  })

  it('isUnderLinkedConfigDir is a strict, separator-bounded, dialect-correct prefix', () => {
    const root = 'C:\\Users\\X\\AppData\\Roaming\\nodeterm\\claude-accounts'
    expect(isUnderLinkedConfigDir('c:\\users\\x\\appdata\\roaming\\NODETERM\\claude-accounts\\abc', root)).toBe(
      true
    )
    expect(isUnderLinkedConfigDir(root, root)).toBe(false)
    expect(isUnderLinkedConfigDir(`${root}-evil\\abc`, root)).toBe(false)
    expect(isUnderLinkedConfigDir('/data/claude-accounts/abc', '/data/claude-accounts')).toBe(true)
    expect(isUnderLinkedConfigDir('/data/Claude-accounts/abc', '/data/claude-accounts')).toBe(false)
    expect(isUnderLinkedConfigDir('/data/claude-accounts-x/abc', '/data/claude-accounts')).toBe(false)
    expect(isUnderLinkedConfigDir('C:\\a\\b', '/a')).toBe(false)
  })
})

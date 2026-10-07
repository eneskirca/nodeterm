import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  linkSync,
  rmSync,
  statSync,
  symlinkSync
} from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ACCOUNT_ID_RE,
  assertCodexAccountId,
  isSafeAccountId,
  codexAccountHome,
  codexHomeForAccount,
  codexSessionEnv,
  codexSocketForAccount,
  codexTmuxEnvArgs,
  codexUsageAccounts,
  ensureSharedCodexDaemon,
  legacyCodexAccountHome,
  migrateLegacyCodexAccountHome,
  migrateLegacyCodexAccountHomes,
  needsCodexAccountScope,
  remoteCodexHome,
  remoteCodexSocket,
  remoteCodexTmuxEnvArgs,
  systemCodexHome,
  AUTH_ENV_STRIP,
  stripCodexAuthEnv,
  planCodexRolloutExposure,
  commitCodexRolloutExposure,
  type CodexRolloutExposurePlan
} from './codex-accounts-core'

describe('Codex account id validation (supply-chain guard)', () => {
  it.each(['a', 'A0', 'account-a', 'be28d3d4-c18c-430c-a257-ae550d3dd7ed', 'a.b_c-1'])(
    'accepts safe id %s',
    (id) => {
      expect(isSafeAccountId(id)).toBe(true)
      expect(() => assertCodexAccountId(id)).not.toThrow()
    }
  )

  it.each(['', '.', '..', 'a/b', '/absolute', '../escape', '.hidden', '-lead', 'space name', 'a\nb'])(
    'refuses traversal / unsafe id %j',
    (id) => {
      expect(isSafeAccountId(id)).toBe(false)
      expect(() => assertCodexAccountId(id)).toThrow('Invalid Codex account id')
    }
  )

  it('exposes the same regex the renderer validates against (one definition)', () => {
    expect(ACCOUNT_ID_RE.source).toBe('^[A-Za-z0-9][A-Za-z0-9._-]*$')
  })
})

describe('managed Codex account paths', () => {
  it('isolates two accounts under distinct homes and shared-server sockets', () => {
    const userData = '/isolated/nodeterm'
    expect(codexAccountHome(userData, 'account-a')).not.toBe(
      legacyCodexAccountHome(userData, 'account-a')
    )
    expect(codexHomeForAccount(userData, 'account-a')).not.toBe(
      codexHomeForAccount(userData, 'account-b')
    )
    expect(codexSocketForAccount(userData, 'account-a')).not.toBe(
      codexSocketForAccount(userData, 'account-b')
    )
  })

  it('folds userDataDir into the digest so separate profiles never collide', () => {
    expect(codexAccountHome('/profile-one', 'account-a')).not.toBe(
      codexAccountHome('/profile-two', 'account-a')
    )
  })

  it.each(['', '../escape', 'space name', '/absolute'])(
    'rejects unsafe account id %j at the home builder',
    (id) => {
      expect(() => codexAccountHome('/isolated/nodeterm', id)).toThrow('Invalid Codex account id')
    }
  )

  // A NON-EMPTY unsafe id reaches the socket builder through `codexAccountHome` and throws; an
  // empty id is the system account (falsy ⇒ `~/.codex`), which is the intended semantics.
  it.each(['../escape', 'space name', '/absolute'])(
    'rejects a non-empty unsafe account id %j at the socket builder',
    (id) => {
      expect(() => codexSocketForAccount('/isolated/nodeterm', id)).toThrow(
        'Invalid Codex account id'
      )
    }
  )

  it('treats an empty id as the system account, not a traversal', () => {
    expect(codexHomeForAccount('/isolated/nodeterm', '')).toBe(systemCodexHome())
    expect(codexSocketForAccount('/isolated/nodeterm', '')).toBe(
      path.join(systemCodexHome(), 'app-server-control', 'app-server-control.sock')
    )
  })

  it('system account resolves to $CODEX_HOME (absolute) or ~/.codex', () => {
    const prev = process.env.CODEX_HOME
    try {
      delete process.env.CODEX_HOME
      expect(systemCodexHome()).toBe(path.join(os.homedir(), '.codex'))
      expect(codexHomeForAccount('/isolated/nodeterm')).toBe(systemCodexHome())
      process.env.CODEX_HOME = 'relative-ignored'
      expect(systemCodexHome()).toBe(path.join(os.homedir(), '.codex'))
      process.env.CODEX_HOME = '/custom/codex'
      expect(systemCodexHome()).toBe('/custom/codex')
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = prev
    }
  })

  it('keeps the managed daemon socket below macOS SUN_LEN', () => {
    const userData = '/Users/example/Library/Application Support/node-terminal'
    // The short root hangs off the HOME, so the claim is about a real macOS home — not the test
    // run's sandboxed one (test/setup/home-sandbox.ts), which sits much deeper in the temp dir.
    const home = vi.spyOn(os, 'homedir').mockReturnValue('/Users/example')
    const accountId = 'be28d3d4-c18c-430c-a257-ae550d3dd7ed'
    try {
      expect(Buffer.byteLength(codexSocketForAccount(userData, accountId))).toBeLessThan(104)
    } finally {
      home.mockRestore()
    }
  })
})

describe('per-session Codex env', () => {
  it('overwrites inherited account scope for system and managed sessions', () => {
    const accountHome = codexAccountHome('/isolated/nodeterm', 'account-a')
    expect(codexSessionEnv('/isolated/nodeterm')).toMatchObject({ NODETERM_CODEX_ACCOUNT_ID: '' })
    expect(codexSessionEnv('/isolated/nodeterm', 'account-a')).toEqual({
      CODEX_HOME: accountHome,
      NODETERM_CODEX_ACCOUNT_ID: 'account-a'
    })
    expect(codexTmuxEnvArgs('/isolated/nodeterm', 'account-a')).toEqual([
      '-e',
      `CODEX_HOME=${accountHome}`,
      '-e',
      'NODETERM_CODEX_ACCOUNT_ID=account-a'
    ])
  })

  it('scopes Codex agents and managed-CODEX-id login terminals, nothing else', () => {
    const isCodex = (id: string): boolean => id === 'codex-a'
    // A Codex agent always needs a scope — system account included, so the id may be absent.
    expect(needsCodexAccountScope('codex', undefined, isCodex)).toBe(true)
    // The agent-less `codex login` terminal: no agent, but a managed CODEX id.
    expect(needsCodexAccountScope(undefined, 'codex-a', isCodex)).toBe(true)
    // …and the `claude /login` terminal right beside it must NOT be caught (#345): same shape,
    // an id from the OTHER list. Answering by id shape instead of by list is what broke it.
    expect(needsCodexAccountScope(undefined, 'claude-a', isCodex)).toBe(false)
    expect(needsCodexAccountScope('claude', 'claude-a', isCodex)).toBe(false)
    expect(needsCodexAccountScope(undefined, undefined, isCodex)).toBe(false)
    expect(needsCodexAccountScope('bash', undefined, isCodex)).toBe(false)
  })
})

describe('remote managed Codex homes', () => {
  it('isolates remote accounts under short host-local homes (digest over id only)', () => {
    const remoteHome = '/home/corvin'
    const first = remoteCodexHome(remoteHome, 'account-a')
    const second = remoteCodexHome(remoteHome, 'account-b')
    expect(first).not.toBe(second)
    expect(remoteCodexHome(remoteHome)).toBe('/home/corvin/.codex')
    expect(remoteCodexSocket(remoteHome, 'account-a')).toBe(
      `${first}/app-server-control/app-server-control.sock`
    )
    expect(remoteCodexTmuxEnvArgs(remoteHome, 'account-a')).toEqual([
      '-e',
      `CODEX_HOME=${first}`,
      '-e',
      'NODETERM_CODEX_ACCOUNT_ID=account-a'
    ])
  })

  it('rejects a relative remote home and unsafe account id', () => {
    expect(() => remoteCodexHome('relative', 'account-a')).toThrow('Remote home must be absolute')
    expect(() => remoteCodexHome('/home/corvin', '../escape')).toThrow('Invalid Codex account id')
  })
})

describe('legacy home migration (real fs, fail closed)', () => {
  it('moves an existing long managed home to its deterministic short home', () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), 'nodeterm-codex-home-'))
    try {
      const userData = path.join(fixture, 'Library', 'Application Support', 'node-terminal')
      const shortRoot = path.join(fixture, 'cx')
      const legacy = legacyCodexAccountHome(userData, 'account-a')
      mkdirSync(legacy, { recursive: true })
      writeFileSync(path.join(legacy, 'auth.json'), 'fixture')

      const target = migrateLegacyCodexAccountHome(userData, 'account-a', shortRoot)

      expect(target).toBe(codexAccountHome(userData, 'account-a', shortRoot))
      expect(readFileSync(path.join(target, 'auth.json'), 'utf8')).toBe('fixture')
      expect(existsSync(legacy)).toBe(false)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('never overwrites an existing short home', () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), 'nodeterm-codex-home-keep-'))
    try {
      const userData = path.join(fixture, 'ud')
      const shortRoot = path.join(fixture, 'cx')
      const legacy = legacyCodexAccountHome(userData, 'account-a')
      const target = codexAccountHome(userData, 'account-a', shortRoot)
      mkdirSync(legacy, { recursive: true })
      writeFileSync(path.join(legacy, 'auth.json'), 'legacy')
      mkdirSync(target, { recursive: true })
      writeFileSync(path.join(target, 'auth.json'), 'already-here')

      migrateLegacyCodexAccountHome(userData, 'account-a', shortRoot)

      expect(readFileSync(path.join(target, 'auth.json'), 'utf8')).toBe('already-here')
      expect(existsSync(legacy)).toBe(true)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('sweeps valid entries and leaves an invalid entry untouched (fail closed)', () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), 'nodeterm-codex-sweep-'))
    try {
      const userData = path.join(fixture, 'ud')
      const shortRoot = path.join(fixture, 'cx')
      const legacyRoot = path.join(userData, 'codex-accounts')
      const good = path.join(legacyRoot, 'account-a')
      const bad = path.join(legacyRoot, '.hidden') // fails ACCOUNT_ID_RE -> untouched
      mkdirSync(good, { recursive: true })
      mkdirSync(bad, { recursive: true })
      writeFileSync(path.join(good, 'auth.json'), 'good')
      writeFileSync(path.join(bad, 'auth.json'), 'bad')

      migrateLegacyCodexAccountHomes(userData, shortRoot)

      expect(existsSync(good)).toBe(false)
      expect(
        readFileSync(path.join(codexAccountHome(userData, 'account-a', shortRoot), 'auth.json'), 'utf8')
      ).toBe('good')
      // The invalid id never resolves to a short home and is left exactly where it was.
      expect(readFileSync(path.join(bad, 'auth.json'), 'utf8')).toBe('bad')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('is a no-op when there is no legacy root', () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), 'nodeterm-codex-noop-'))
    try {
      expect(() =>
        migrateLegacyCodexAccountHomes(path.join(fixture, 'ud'), path.join(fixture, 'cx'))
      ).not.toThrow()
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})

describe('auth-env strip (no credential shadows the account login)', () => {
  it('lists the OpenAI/Codex key vars', () => {
    expect([...AUTH_ENV_STRIP]).toEqual(['OPENAI_API_KEY', 'CODEX_API_KEY'])
  })

  it('removes exactly those vars and preserves the rest', () => {
    const stripped = stripCodexAuthEnv({
      OPENAI_API_KEY: 'sk-leak',
      CODEX_API_KEY: 'ck-leak',
      CODEX_HOME: '/home/.codex',
      PATH: '/usr/bin'
    })
    expect(stripped).toEqual({ CODEX_HOME: '/home/.codex', PATH: '/usr/bin' })
    expect('OPENAI_API_KEY' in stripped).toBe(false)
    expect('CODEX_API_KEY' in stripped).toBe(false)
  })
})

describe('usage discovery follows real homes, not the pending marker', () => {
  it('maps records to id/home/label/email regardless of pending', () => {
    expect(
      codexUsageAccounts(
        [{ id: 'account-a', label: 'Pending row', pending: true }],
        (id) => codexAccountHome('/isolated/nodeterm', id)
      )
    ).toEqual([
      {
        id: 'account-a',
        home: codexAccountHome('/isolated/nodeterm', 'account-a'),
        label: 'Pending row',
        email: undefined
      }
    ])
  })
})

describe('shared id predicate stays renderer-safe', () => {
  it('src/shared/codex-account imports nothing from src/core', () => {
    const src = readFileSync(path.join(__dirname, '..', 'shared', 'codex-account.ts'), 'utf8')
    expect(/from ['"](\.\.\/)*core\//.test(src)).toBe(false)
    expect(/from ['"]\.\/codex-accounts-core['"]/.test(src)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Cross-account rollout exposure (S6 §5 property 2 — atomic hardlink, never-overwrite).
// Proven against a REAL temp filesystem: real link(2)/symlink(2)/EEXIST, never a mock. The repo has
// twice shipped a structural test that passed a real defect, so every assertion here runs the real
// primitive under mkdtemp. Mirrors @Corvin's tests in PR #112.
describe('cross-account rollout exposure (atomic, never-overwrite)', () => {
  const THREAD = 'be28d3d4-c18c-430c-a257-ae550d3dd7ed'
  // Path of the rollout RELATIVE to the account's `sessions/` root (what a plan reports back).
  const SESSIONS_REL = path.join('2026', '08', '19', `rollout-2026-08-19T00-00-00-${THREAD}.jsonl`)
  const REL = path.join('sessions', SESSIONS_REL)
  const roots: string[] = []

  afterEach(() => {
    while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
  })

  const newRoot = (): string => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cx-rollout-'))
    roots.push(root)
    return root
  }

  /** A real account home whose `sessions/` tree exists; returns the home dir. */
  const makeHome = (root: string, name: string): string => {
    const home = path.join(root, name)
    mkdirSync(path.join(home, 'sessions'), { recursive: true })
    return home
  }

  /** Write a real rollout file at the canonical relative path; returns its absolute path. */
  const writeRollout = (home: string, body = '{"line":1}\n'): string => {
    const file = path.join(home, REL)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, body)
    return file
  }

  it('commits A to B to C as one inode and survives removal of the original account', () => {
    const root = newRoot()
    const homeA = makeHome(root, 'a')
    const homeB = makeHome(root, 'b')
    const homeC = makeHome(root, 'c')
    const sourcePath = writeRollout(homeA)
    const originalIno = statSync(sourcePath).ino

    const planAB = planCodexRolloutExposure(homeA, homeB, sourcePath, THREAD)
    expect(planAB.targetRelativePath).toBe(SESSIONS_REL)
    commitCodexRolloutExposure(planAB)
    expect(statSync(planAB.targetPath).ino).toBe(originalIno)

    // Idempotent re-expose: same inode already present ⇒ no throw, still one inode.
    expect(() => commitCodexRolloutExposure(planAB)).not.toThrow()
    expect(statSync(planAB.targetPath).ino).toBe(originalIno)

    const planBC = planCodexRolloutExposure(homeB, homeC, planAB.targetPath, THREAD)
    commitCodexRolloutExposure(planBC)
    expect(statSync(planBC.targetPath).ino).toBe(originalIno)

    // Deleting the ORIGINAL account home leaves C's link naming the very same inode.
    rmSync(homeA, { recursive: true, force: true })
    expect(existsSync(planBC.targetPath)).toBe(true)
    expect(statSync(planBC.targetPath).ino).toBe(originalIno)
  })

  it('rejects a source path outside the source account', () => {
    const root = newRoot()
    const homeA = makeHome(root, 'a')
    const homeB = makeHome(root, 'b')
    // A real regular file whose name still ends <thread>.jsonl, but OUTSIDE homeA/sessions.
    const outside = path.join(root, `rollout-2026-08-19T00-00-00-${THREAD}.jsonl`)
    writeFileSync(outside, '{}')
    expect(() => planCodexRolloutExposure(homeA, homeB, outside, THREAD)).toThrow(
      'Source Codex rollout is outside its account home'
    )
  })

  it('a rejected plan mutates nothing on disk', () => {
    const root = newRoot()
    const homeA = makeHome(root, 'a')
    const homeB = makeHome(root, 'b')
    const outside = path.join(root, `rollout-2026-08-19T00-00-00-${THREAD}.jsonl`)
    writeFileSync(outside, '{}')
    const before = readdirSync(path.join(homeB, 'sessions'))
    expect(() => planCodexRolloutExposure(homeA, homeB, outside, THREAD)).toThrow()
    // The plan writes nothing: the target account's sessions tree is untouched.
    expect(readdirSync(path.join(homeB, 'sessions'))).toEqual(before)
  })

  it('refuses to overwrite a conflicting target rollout (different inode)', () => {
    const root = newRoot()
    const homeA = makeHome(root, 'a')
    const homeB = makeHome(root, 'b')
    const sourcePath = writeRollout(homeA)
    const plan = planCodexRolloutExposure(homeA, homeB, sourcePath, THREAD)
    // A DIFFERENT rollout (distinct inode) already occupies the target pathname.
    mkdirSync(path.dirname(plan.targetPath), { recursive: true })
    writeFileSync(plan.targetPath, '{"other":true}\n')
    const foreignIno = statSync(plan.targetPath).ino
    expect(() => commitCodexRolloutExposure(plan)).toThrow(
      'Target Codex account already has a different rollout for this thread'
    )
    // Never overwritten: the foreign inode is still what sits at the target.
    expect(statSync(plan.targetPath).ino).toBe(foreignIno)
  })

  it('refuses a target sessions symlink without writing through it', () => {
    const root = newRoot()
    const homeA = makeHome(root, 'a')
    const sourcePath = writeRollout(homeA)
    // homeB/sessions is a SYMLINK pointing at an escape directory.
    const homeB = path.join(root, 'b')
    mkdirSync(homeB, { recursive: true })
    const escape = path.join(root, 'escape')
    mkdirSync(escape, { recursive: true })
    symlinkSync(escape, path.join(homeB, 'sessions'))

    const plan = planCodexRolloutExposure(homeA, homeB, sourcePath, THREAD)
    expect(() => commitCodexRolloutExposure(plan)).toThrow(
      'Target Codex rollout path contains an unsafe directory'
    )
    // Nothing was written THROUGH the symlink into the escape directory.
    expect(readdirSync(escape)).toEqual([])
  })

  it('refuses a symlink at a DEEPER target segment without writing through it', () => {
    const root = newRoot()
    const homeA = makeHome(root, 'a')
    const sourcePath = writeRollout(homeA)
    // homeB/sessions is a real dir, but homeB/sessions/2026 is a symlink to an escape directory.
    const homeB = makeHome(root, 'b')
    const escape = path.join(root, 'escape')
    mkdirSync(escape, { recursive: true })
    symlinkSync(escape, path.join(homeB, 'sessions', '2026'))

    const plan = planCodexRolloutExposure(homeA, homeB, sourcePath, THREAD)
    expect(() => commitCodexRolloutExposure(plan)).toThrow(
      'Target Codex rollout path contains an unsafe directory'
    )
    // The deeper-segment guard also refuses to write through: the escape tree stays empty.
    expect(readdirSync(escape)).toEqual([])
  })

  it('refuses a symlinked source rollout (plan, never followed)', () => {
    const root = newRoot()
    const homeA = makeHome(root, 'a')
    const homeB = makeHome(root, 'b')
    // A real rollout file elsewhere, and a symlink to it sitting at the canonical source pathname.
    const realFile = path.join(root, 'real.jsonl')
    writeFileSync(realFile, '{"line":1}\n')
    const symlinkedSource = path.join(homeA, REL)
    mkdirSync(path.dirname(symlinkedSource), { recursive: true })
    symlinkSync(realFile, symlinkedSource)

    expect(() => planCodexRolloutExposure(homeA, homeB, symlinkedSource, THREAD)).toThrow(
      'Source Codex rollout is not a regular file'
    )
  })

  it('removes its temporary link when the source inode changes before link creation', () => {
    const root = newRoot()
    const homeA = makeHome(root, 'a')
    const homeB = makeHome(root, 'b')
    const sourcePath = writeRollout(homeA)
    const plan = planCodexRolloutExposure(homeA, homeB, sourcePath, THREAD)
    // A pre-created, kept-alive file gives a distinct inode that cannot be recycled from the freed
    // original (which would defeat the race we are simulating).
    const replacement = path.join(root, 'replacement.jsonl')
    writeFileSync(replacement, '{"line":2}\n')
    // Race: just before the source→temp link, the source pathname is swapped to that OTHER inode.
    // The temp link then names the wrong inode, the pre-publish verify fails, and the temp is cleaned up.
    let swapped = false
    const racingLink: typeof linkSync = (from, to) => {
      if (!swapped) {
        swapped = true
        rmSync(sourcePath)
        linkSync(replacement, sourcePath) // sourcePath now names replacement's distinct inode
      }
      return linkSync(from as string, to as string)
    }
    expect(() => commitCodexRolloutExposure(plan, racingLink)).toThrow(
      'Temporary Codex rollout did not preserve the verified source inode'
    )
    // No orphaned .nodeterm-link temp file is left behind, and no target was published.
    const targetDir = path.dirname(plan.targetPath)
    const leftover = existsSync(targetDir)
      ? readdirSync(targetDir).filter((n) => n.endsWith('.nodeterm-link'))
      : []
    expect(leftover).toEqual([])
    expect(existsSync(plan.targetPath)).toBe(false)
  })

  it('re-verifies the inode after publishing and refuses a raced-in wrong inode', () => {
    const root = newRoot()
    const homeA = makeHome(root, 'a')
    const homeB = makeHome(root, 'b')
    const sourcePath = writeRollout(homeA)
    const decoy = path.join(root, 'decoy.jsonl')
    writeFileSync(decoy, '{"decoy":true}\n')
    const plan = planCodexRolloutExposure(homeA, homeB, sourcePath, THREAD)
    // The private source→temp link is honest; the publish link is hijacked to a DIFFERENT inode,
    // so ONLY the post-link re-verify can catch that the target is not our rollout.
    const hijackPublish: typeof linkSync = (from, to) => {
      if (to === plan.targetPath) return linkSync(decoy, to as string)
      return linkSync(from as string, to as string)
    }
    expect(() => commitCodexRolloutExposure(plan, hijackPublish)).toThrow(
      'Target Codex rollout did not preserve the verified source inode'
    )
    // Rollback: a failed commit leaves NOTHING published — the wrongly-linked target is removed, so
    // no foreign inode is left permanently occupying the target account's real sessions path.
    expect(existsSync(plan.targetPath)).toBe(false)
  })

  it('surfaces a named error on a cross-mount (EXDEV) link — no silent copy fallback', () => {
    const root = newRoot()
    const homeA = makeHome(root, 'a')
    const homeB = makeHome(root, 'b')
    const sourcePath = writeRollout(homeA)
    const plan = planCodexRolloutExposure(homeA, homeB, sourcePath, THREAD)
    const crossMount: typeof linkSync = () => {
      const error = new Error('cross-device link not permitted') as NodeJS.ErrnoException
      error.code = 'EXDEV'
      throw error
    }
    expect(() => commitCodexRolloutExposure(plan, crossMount)).toThrow(
      'Codex rollout accounts must share a filesystem; cross-mount rollout copy is not supported'
    )
    // Fails closed: the target rollout is not created.
    expect(existsSync(plan.targetPath)).toBe(false)
  })

  it('plan captures the source dev/ino identity', () => {
    const root = newRoot()
    const homeA = makeHome(root, 'a')
    const homeB = makeHome(root, 'b')
    const sourcePath = writeRollout(homeA)
    const plan: CodexRolloutExposurePlan = planCodexRolloutExposure(homeA, homeB, sourcePath, THREAD)
    const stat = statSync(sourcePath)
    expect(plan.sourceDev).toBe(stat.dev)
    expect(plan.sourceIno).toBe(stat.ino)
  })
})

describe('ensureSharedCodexDaemon: reuse-if-reachable-else-start-once (§2.2)', () => {
  it('does NOT start when the app-server is already reachable', async () => {
    let started = 0
    await ensureSharedCodexDaemon(
      async () => true,
      async () => {
        started++
      }
    )
    expect(started).toBe(0)
  })

  it('starts exactly once when the app-server is not reachable', async () => {
    let started = 0
    await ensureSharedCodexDaemon(
      async () => false,
      async () => {
        started++
      }
    )
    expect(started).toBe(1)
  })
})

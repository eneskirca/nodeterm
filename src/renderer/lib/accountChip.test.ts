import { describe, it, expect } from 'vitest'
import type { ClaudeAccount, ObservedClaudeAccount } from '@shared/types'
import {
  accountChipFor,
  accountKey,
  configDirLabel,
  observationIsRemote,
  distinctAccountKeys,
  effectiveAccountId,
  hasMultipleAccountKeys,
  SYSTEM_ACCOUNT_KEY,
  configDirsMatch,
  resolveObserved,
  unlinkedConfigDirs
} from './accountChip'

const acct = (over: Partial<ClaudeAccount> = {}): ClaudeAccount => ({
  id: 'a1',
  label: 'work@example.com',
  email: 'work@example.com',
  createdAt: 0,
  ...over
})

const observed = (over: Partial<ObservedClaudeAccount> = {}): ObservedClaudeAccount => ({
  configDir: '/home/me/.claude',
  accountId: null,
  known: true,
  ...over
})

const system = observed()
const managed = observed({ configDir: '/data/claude-accounts/a1', accountId: 'a1' })
const unlinked = observed({ configDir: '/home/me/.claude-2', accountId: null, known: false })

describe('effectiveAccountId (which account a node’s readers use)', () => {
  it('prefers the node\u2019s own account over the observed one', () => {
    // Launch identity is what the env actually injected; an observation cannot outrank it.
    expect(effectiveAccountId('a1', managed)).toBe('a1')
    expect(effectiveAccountId('a1', system)).toBe('a1')
  })

  it('falls back to a KNOWN observed account for a node created without one', () => {
    // The account list is what keeps a known observation known — see `resolveObserved`.
    expect(effectiveAccountId(undefined, managed, [acct()])).toBe('a1')
  })

  it('resolves to nothing for the system account and for an unknown dir', () => {
    // Both must read the system account's transcripts, not a stranger's.
    expect(effectiveAccountId(undefined, system)).toBeUndefined()
    expect(effectiveAccountId(undefined, unlinked)).toBeUndefined()
    expect(effectiveAccountId(undefined, undefined)).toBeUndefined()
  })
})

describe('accountKey (the identity a node counts as)', () => {
  it('keys the system account as "sys" only when it is actually observed', () => {
    expect(accountKey(undefined, system)).toBe(SYSTEM_ACCOUNT_KEY)
    // Unobserved is NOT the system account: a plain shell nobody ran claude in must not count as
    // a second identity, or one open terminal would chip every pane on the canvas.
    expect(accountKey(undefined, undefined)).toBeNull()
  })

  it('keys a managed/linked account by id, from either source', () => {
    expect(accountKey('a1', undefined)).toBe('a1')
    expect(accountKey(undefined, managed, [acct()])).toBe('a1')
  })

  it('keys an unlinked dir by its path', () => {
    expect(accountKey(undefined, unlinked)).toBe('ext:/home/me/.claude-2')
    // Two different unlinked dirs are two identities.
    expect(accountKey(undefined, observed({ configDir: '/home/me/.claude-3', known: false })))
      .toBe('ext:/home/me/.claude-3')
  })

  it('refuses to key an unknown observation with no dir', () => {
    expect(accountKey(undefined, observed({ configDir: '', known: false }))).toBeNull()
  })
})

describe('distinctAccountKeys', () => {
  it('counts identities and ignores unknown nodes', () => {
    const keys = distinctAccountKeys([
      { observed: system },
      { observed: system },
      { observed: unlinked },
      { dataAccountId: 'a1' },
      {} // an unobserved plain terminal contributes nothing
    ])
    expect([...keys].sort()).toEqual(['a1', 'ext:/home/me/.claude-2', 'sys'])
  })
})

describe('hasMultipleAccountKeys (the selector form)', () => {
  it('is false while one identity is in play', () => {
    expect(hasMultipleAccountKeys({ n1: { account: system }, n2: { account: system } })).toBe(false)
    expect(hasMultipleAccountKeys({ n1: {}, n2: {} })).toBe(false)
  })

  it('is true once a second identity appears — the real two-logins case', () => {
    // ~/.claude in one pane, ~/.claude-2 in another: exactly what the feature exists for.
    expect(hasMultipleAccountKeys({ n1: { account: system }, n2: { account: unlinked } })).toBe(true)
  })

  it('counts THIS node\u2019s creation-time account too', () => {
    // The store only holds observed accounts, so a managed node that has posted no hook yet is
    // only visible through its own `data.accountId`.
    expect(hasMultipleAccountKeys({ n1: { account: system } }, 'a1')).toBe(true)
    expect(hasMultipleAccountKeys({ n1: { account: managed } }, 'a1', [acct()])).toBe(false)
  })
})

describe('configDirLabel', () => {
  it('names a POSIX dir by its last segment, trailing slash or not', () => {
    expect(configDirLabel('/home/me/.claude-2')).toBe('.claude-2')
    expect(configDirLabel('/home/me/.claude-2/')).toBe('.claude-2')
  })

  it('names a Windows-shaped dir by its last segment', () => {
    // Windows is a delivery target and an SSH node can report a remote path either way.
    expect(configDirLabel('C:\\Users\\me\\.claude-2')).toBe('.claude-2')
    expect(configDirLabel('\\\\server\\share\\.claude-2')).toBe('.claude-2')
  })

  it('keeps a POSIX backslash as filename text, not as a separator', () => {
    // A backslash is legal in a POSIX filename; splitting on it would mislabel the dir.
    expect(configDirLabel('/home/me/weird\\name')).toBe('weird\\name')
  })

  it('falls back to the whole string when there is no segment', () => {
    expect(configDirLabel('/')).toBe('/')
  })
})

describe('accountChipFor (chip visibility, and naming an unlinked dir)', () => {

  it('names an SSH pane\'s system account after the HOST, never this machine', () => {
    const base = { observed: system, accounts, systemLabel: 'Personal', systemEmail: 'me@x.com', multiple: true }
    const unknown = accountChipFor({ ...base, hostKey: 'root@box' })
    expect(unknown?.short).toBe('System')
    expect(unknown?.tooltip).toContain('System account (root@box)')
    expect(unknown?.tooltip).not.toContain('Personal')
    const known = accountChipFor({ ...base, hostKey: 'root@box', remoteSystemEmail: 'ops@server.dev' })
    expect(known?.tooltip).toContain('ops@server.dev')
    expect(known?.tooltip).toContain('~/.claude on root@box')
  })
  const accounts = [acct(), acct({ id: 'a2', label: 'personal', email: undefined, configDir: '/home/me/.claude-2' })]

  it('shows no chip for a system node while one identity is in play', () => {
    expect(accountChipFor({ observed: system, accounts, multiple: false })).toBeNull()
  })

  it('shows the system chip once a second identity is in play', () => {
    const chip = accountChipFor({
      observed: system,
      accounts,
      systemLabel: '',
      systemEmail: 'me@example.com',
      multiple: true
    })
    expect(chip).toEqual({
      short: 'me',
      tooltip: 'me@example.com — system Claude account (~/.claude)',
      kind: 'system'
    })
  })

  it('prefers the user\u2019s own system label over the detected email', () => {
    expect(
      accountChipFor({ observed: system, accounts, systemLabel: 'Personal', systemEmail: 'me@x.com', multiple: true })
        ?.short
    ).toBe('Personal')
  })

  it('chips a managed account whatever the count — the exception is what must be seen', () => {
    expect(accountChipFor({ dataAccountId: 'a1', accounts, multiple: false })).toEqual({
      short: 'work',
      tooltip: 'work@example.com (work@example.com)',
      kind: 'managed'
    })
  })

  it('marks an account that carries a linked config dir as linked', () => {
    expect(accountChipFor({ dataAccountId: 'a2', accounts, multiple: false })).toEqual({
      short: 'personal',
      tooltip: 'personal',
      kind: 'linked'
    })
  })

  it('names an unlinked dir by its last segment and says how to link it', () => {
    // A dir NO account claims. (`unlinked` above is `.claude-2`, which `accounts` here has since
    // linked as `a2` — that case is the "linking flows through every reader" block below.)
    const stranger = observed({ configDir: '/home/me/.claude-7', known: false })
    expect(accountChipFor({ observed: stranger, accounts, multiple: false })).toEqual({
      short: '.claude-7',
      tooltip: 'Unlinked Claude config dir /home/me/.claude-7 — link it in Settings → Accounts',
      kind: 'unlinked'
    })
  })

  it('follows a dir that has since been LINKED to its account, with no new event', () => {
    // The smoke-test regression: the store still holds `{known:false}` from before the link.
    expect(accountChipFor({ observed: unlinked, accounts, multiple: false })).toEqual({
      short: 'personal',
      tooltip: 'personal',
      kind: 'linked'
    })
  })

  it('shows nothing for a node whose account is unknown', () => {
    expect(accountChipFor({ accounts, multiple: true })).toBeNull()
  })

  it('follows the observed account when the node was created without one', () => {
    // The plain-terminal case: nodeterm never launched this claude, so the chip is the only place
    // the identity shows up at all.
    expect(accountChipFor({ observed: managed, accounts, multiple: false })?.short).toBe('work')
  })
})

describe('unlinkedConfigDirs (Settings → Accounts “Detected config dirs”)', () => {
  it('lists each unknown dir once, sorted, and never a known one', () => {
    expect(
      unlinkedConfigDirs(
        {
          n1: { account: unlinked },
          n2: { account: unlinked }, // same dir, two panes
          n3: { account: observed({ configDir: '/home/me/.claude-3', known: false }) },
          n4: { account: system }, // known: not a candidate
          n5: { account: managed },
          n6: {}
        },
        [acct()] // …and `managed`'s account still exists, so it stays known
      )
    ).toEqual(['/home/me/.claude-2', '/home/me/.claude-3'])
  })

  it('drops a dir that is already linked', () => {
    const byId = { n1: { account: unlinked } }
    expect(unlinkedConfigDirs(byId, [acct({ configDir: '/home/me/.claude-2' })])).toEqual([])
    // …and tolerates the undefined `configDir` every MANAGED account has.
    expect(unlinkedConfigDirs(byId, [acct()])).toEqual(['/home/me/.claude-2'])
  })
})

// ── Follow-up 1: an observation classified BEFORE the user linked its dir ──────────────────────
// The hook server stamps `known:false` at POST time and a quiet pane may not post again for hours,
// so linking has to repaint from the renderer side or the chip lies until the next turn.
describe('resolveObserved (a dir linked since the observation)', () => {
  const linkedAcct = acct({ id: 'lnk', label: 'second', email: undefined, configDir: '/home/me/.claude-2' })

  it('upgrades an unknown dir to the account that now owns it', () => {
    expect(resolveObserved(unlinked, [linkedAcct])).toEqual({
      configDir: '/home/me/.claude-2',
      accountId: 'lnk',
      known: true
    })
  })

  it('leaves an unknown dir alone when nothing matches', () => {
    expect(resolveObserved(unlinked, [acct({ configDir: '/home/me/.claude-9' })])).toBe(unlinked)
    expect(resolveObserved(unlinked, [acct()])).toBe(unlinked) // a MANAGED account has no configDir
  })

  it('leaves a known observation alone while its account is still listed', () => {
    // Core classified these against the managed layout; a dir match cannot outrank that.
    expect(resolveObserved(system, [linkedAcct])).toBe(system)
    expect(resolveObserved(managed, [linkedAcct, acct()])).toBe(managed)
  })
})

describe('configDirsMatch (one comparison, both sides normalized)', () => {
  it('ignores a trailing separator', () => {
    expect(configDirsMatch('/home/me/.claude-2/', '/home/me/.claude-2')).toBe(true)
  })

  it('is case- and separator-insensitive for Windows-shaped paths only', () => {
    expect(configDirsMatch('C:\\Users\\Me\\.claude-2', 'c:/users/me/.claude-2')).toBe(true)
    // POSIX: case and backslash are both significant filename text, so these are DIFFERENT dirs.
    expect(configDirsMatch('/home/me/.Claude-2', '/home/me/.claude-2')).toBe(false)
  })

  it('never matches on an absent dir (every managed account has none)', () => {
    expect(configDirsMatch(undefined, undefined)).toBe(false)
    expect(configDirsMatch('', '/home/me/.claude-2')).toBe(false)
  })
})

describe('linking flows through every reader of the observation', () => {
  const linkedAcct = acct({ id: 'lnk', label: 'second', email: undefined, configDir: '/home/me/.claude-2/' })

  it('gives the readers the account id (no new hook event needed)', () => {
    expect(effectiveAccountId(undefined, unlinked)).toBeUndefined()
    expect(effectiveAccountId(undefined, unlinked, [linkedAcct])).toBe('lnk')
  })

  it('keys the pane by account instead of by path', () => {
    expect(accountKey(undefined, unlinked)).toBe('ext:/home/me/.claude-2')
    expect(accountKey(undefined, unlinked, [linkedAcct])).toBe('lnk')
  })

  it('stops counting the linked pane as a second identity next to its own account', () => {
    // A node created under the account and a pane observed on its dir are ONE identity.
    expect(hasMultipleAccountKeys({ n1: { account: unlinked } }, 'lnk')).toBe(true)
    expect(hasMultipleAccountKeys({ n1: { account: unlinked } }, 'lnk', [linkedAcct])).toBe(false)
  })

  it('flips the chip to the account\u2019s own label and kind', () => {
    const chip = accountChipFor({ observed: unlinked, accounts: [linkedAcct], multiple: false })
    expect(chip).toEqual({ short: 'second', tooltip: 'second', kind: 'linked' })
  })

  it('leaves a dir nobody linked dashed and unlinked', () => {
    const chip = accountChipFor({
      observed: unlinked,
      accounts: [acct({ id: 'other', configDir: '/home/me/.claude-9' })],
      multiple: false
    })
    expect(chip?.kind).toBe('unlinked')
    expect(chip?.short).toBe('.claude-2')
  })

  it('drops the dir from the detected list the moment it is linked', () => {
    const byId = { n1: { account: unlinked } }
    expect(unlinkedConfigDirs(byId, [acct({ configDir: '/home/me/.claude-2/' })])).toEqual([]) // trailing slash
    expect(unlinkedConfigDirs(byId, [acct({ configDir: '/home/me/.claude-9' })])).toEqual([
      '/home/me/.claude-2'
    ])
  })

  it('excludes a Windows-shaped linked dir whatever its case', () => {
    const byId = { n1: { account: observed({ configDir: 'C:\\Users\\Me\\.claude-2', known: false }) } }
    expect(unlinkedConfigDirs(byId, [acct({ configDir: 'c:/users/me/.claude-2' })])).toEqual([])
  })
})

describe('the system chip has nothing to truncate', () => {
  it('says "System" rather than the 10-char cut of the generic display', () => {
    // "System account" through the chip cap reads "System acc…", an ellipsis promising a longer
    // name that does not exist.
    const chip = accountChipFor({ observed: system, accounts: [], multiple: true })
    expect(chip?.short).toBe('System')
    expect(chip?.tooltip).toContain('System account')
  })
})

// ── Follow-up 2: the account was UNLINKED (or removed) after the observation ───────────────────
// The store still holds `{known:true, accountId}` from before. Left alone it chipped "Unknown
// account" and the dir vanished from Settings → Detected, so there was no way back to Link.
describe('resolveObserved (an account that has since gone away)', () => {
  const observedLinked: ObservedClaudeAccount = {
    configDir: '/home/me/.claude-2',
    accountId: 'lnk',
    known: true
  }

  it('degrades to the bare dir when nothing carries that id any more', () => {
    expect(resolveObserved(observedLinked, [])).toEqual({
      configDir: '/home/me/.claude-2',
      accountId: null,
      known: false
    })
    expect(resolveObserved(observedLinked, [acct({ id: 'other' })])).toEqual({
      configDir: '/home/me/.claude-2',
      accountId: null,
      known: false
    })
  })

  it('keeps the observation while the account is still listed — pending included', () => {
    const live = [acct({ id: 'lnk', configDir: '/home/me/.claude-2' })]
    expect(resolveObserved(observedLinked, live)).toBe(observedLinked)
    // A row still finishing `claude /login` is present, not gone.
    expect(resolveObserved(observedLinked, [acct({ id: 'lnk', pending: true })])).toBe(observedLinked)
  })

  it('re-adopts the dir when it is linked again under a NEW id', () => {
    // Unlink → Link mints a fresh account; the DIR is what carries identity across that gap.
    expect(resolveObserved(observedLinked, [acct({ id: 'lnk2', configDir: '/home/me/.claude-2/' })]))
      .toEqual({ configDir: '/home/me/.claude-2', accountId: 'lnk2', known: true })
  })

  it('leaves a dangling id alone when there is no dir to fall back to', () => {
    // A MANAGED observation whose dir the classifier did not report: nothing better to say.
    const noDir: ObservedClaudeAccount = { configDir: '', accountId: 'gone', known: true }
    expect(resolveObserved(noDir, [])).toBe(noDir)
  })

  it('never touches the system account', () => {
    expect(resolveObserved(system, [])).toBe(system)
  })
})

describe('unlinking flows through every reader of the observation', () => {
  const observedLinked: ObservedClaudeAccount = {
    configDir: '/home/me/.claude-2',
    accountId: 'lnk',
    known: true
  }
  const live = [acct({ id: 'lnk', label: 'second', email: undefined, configDir: '/home/me/.claude-2' })]

  it('falls back to the dashed dir chip instead of "Unknown account"', () => {
    expect(accountChipFor({ observed: observedLinked, accounts: live, multiple: false })).toEqual({
      short: 'second',
      tooltip: 'second',
      kind: 'linked'
    })
    expect(accountChipFor({ observed: observedLinked, accounts: [], multiple: false })).toEqual({
      short: '.claude-2',
      tooltip: 'Unlinked Claude config dir /home/me/.claude-2 — link it in Settings → Accounts',
      kind: 'unlinked'
    })
  })

  it('puts the dir back in the detected list, ready to link again', () => {
    const byId = { n1: { account: observedLinked } }
    expect(unlinkedConfigDirs(byId, live)).toEqual([])
    expect(unlinkedConfigDirs(byId, [])).toEqual(['/home/me/.claude-2'])
  })

  it('keys the pane by path again and gives the readers nothing', () => {
    expect(accountKey(undefined, observedLinked, [])).toBe('ext:/home/me/.claude-2')
    expect(effectiveAccountId(undefined, observedLinked, [])).toBeUndefined()
    // …so its transcripts are read as the system account's, not as a removed account's.
    expect(effectiveAccountId(undefined, observedLinked, live)).toBe('lnk')
  })

  it('leaves a NODE created under a removed account on the legacy Unknown-account chip', () => {
    // `data.accountId` is a different fact — that binding really is dangling, and saying so is
    // correct. Only the OBSERVATION degrades.
    expect(accountChipFor({ dataAccountId: 'lnk', accounts: [], multiple: false })).toEqual({
      short: 'Unknown account',
      tooltip: 'Unknown account',
      kind: 'managed'
    })
  })
})

// ── A pane on an SSH host reports a dir on the HOST's filesystem ───────────────────────────────
// The hook server's classifier is host-agnostic on purpose (two of its rules exist to name a
// remote dir), and core cannot tell which machine posted — so the renderer stamps `remote` at the
// one point the label enters the store, and every LOCAL affordance below must refuse it. The dirs
// here deliberately spell the SAME absolute path on both machines: that is the ordinary case
// whenever the two share a username, not a corner one.
describe('a REMOTE observation is never treated as a dir on this machine', () => {
  const remoteUnlinked = observed({ configDir: '/home/me/.claude-2', known: false, remote: true })

  it('never offers an SSH node’s unknown dir for linking', () => {
    // The named test. Settings → Accounts spends this list on `claudeAccounts.link`, which
    // `stat`s and writes where the CORE runs — so a Link button here either errors on a path that
    // is absent locally or, worse, silently adopts a different directory of the same name.
    expect(unlinkedConfigDirs({ n1: { account: remoteUnlinked } })).toEqual([])
    // …while the identical dir seen on a LOCAL pane is still a candidate, so this narrows exactly
    // one thing and nothing else.
    expect(unlinkedConfigDirs({ n1: { account: unlinked } })).toEqual(['/home/me/.claude-2'])
  })

  it('tells the user what the dir is instead of pointing at a Link it cannot perform', () => {
    const accounts: ClaudeAccount[] = []
    const chip = accountChipFor({ observed: remoteUnlinked, accounts, multiple: true })
    expect(chip?.kind).toBe('unlinked') // the chip stays: naming what a session runs as is true
    expect(chip?.short).toBe('.claude-2') // …by the same path rule as a local one
    expect(chip?.tooltip).toContain('/home/me/.claude-2')
    expect(chip?.tooltip).toContain('remote host')
    expect(chip?.tooltip).not.toContain('Settings')
    // The LOCAL wording is byte-identical to before the flag existed.
    expect(accountChipFor({ observed: unlinked, accounts, multiple: true })?.tooltip).toBe(
      'Unlinked Claude config dir /home/me/.claude-2 — link it in Settings → Accounts'
    )
  })

  // `ClaudeAccount.configDir` is written by `claudeAccounts.link`, a LOCAL adoption, so a linked
  // account's `/home/me/.claude-2` is a directory on THIS machine. Matching the host's dir to it
  // labels the remote pane with a local identity — and `effectiveAccountId` then aims the local
  // transcript / session-name / usage readers at that account's dir.
  //
  // There are TWO orderings and they arrive here in different shapes, which is the whole point of
  // splitting them: the account may be linked AFTER the observation was captured (the dir was
  // unknown at POST time, so `known: false`), or BEFORE it (core's classifier already matched the
  // path and stamped the id, so `known: true`). Only the second is what the hook server emits for
  // a user who has both a linked account and an SSH project — the ordinary case.
  const localLink = acct({ id: 'lnk', label: 'second', email: undefined, configDir: '/home/me/.claude-2' })

  it('is never matched against a local account linked AFTER the observation was captured', () => {
    // `known: false` — nothing claimed this dir when the hook posted, so the classifier could only
    // report the bare path. Re-resolution against the CURRENT list is what would otherwise adopt
    // it, and that is the direction this case pins.
    expect(resolveObserved(remoteUnlinked, [localLink])).toBe(remoteUnlinked)
    expect(effectiveAccountId(undefined, remoteUnlinked, [localLink])).toBeUndefined()
    // The local pane on the same path still upgrades — the refusal is about remoteness, not the
    // path, so linking has not been broken for the case it exists for.
    expect(resolveObserved(unlinked, [localLink])?.accountId).toBe('lnk')
  })

  it('refuses the id CORE already stamped when the account was linked BEFORE the observation', () => {
    // The shape the hook server actually emits in this situation, and the one the `known: false`
    // case above cannot stand in for. `classifyClaudeConfigDir`'s linked rule is host-agnostic and
    // runs at POST time, before the renderer stamps `remote`: the host's `/home/me/.claude-2` is
    // string-equal to the local linked account's dir, so the observation arrives ALREADY resolved
    // to `lnk` with `known: true`, and `resolveObserved`'s id branch returns before any dir-match
    // refusal is consulted. Without the demotion the pane is labelled with the local identity and
    // every local reader is aimed at that account's directory.
    const remoteStamped = observed({
      configDir: '/home/me/.claude-2',
      accountId: 'lnk',
      known: true,
      remote: true
    })
    expect(resolveObserved(remoteStamped, [localLink])).toEqual({
      ...remoteStamped,
      accountId: null,
      known: false
    })
    // Which is what the consumers must see: no local account for the readers…
    expect(effectiveAccountId(undefined, remoteStamped, [localLink])).toBeUndefined()
    // …the dir as its own identity rather than the account's…
    expect(accountKey(undefined, remoteStamped, [localLink])).toBe('ext:/home/me/.claude-2')
    const chip = accountChipFor({ observed: remoteStamped, accounts: [localLink], multiple: true })
    expect(chip?.kind).toBe('unlinked')
    expect(chip?.tooltip).toContain('remote host')
    expect(chip?.tooltip).not.toContain('Settings')
    // …and no Link offer, since the button would `stat` this machine.
    expect(unlinkedConfigDirs({ n1: { account: remoteStamped } }, [localLink])).toEqual([])
    // The identical observation from a LOCAL pane keeps the account: the demotion is about
    // remoteness alone, so a linked account still labels the panes it exists for.
    const localStamped = observed({ configDir: '/home/me/.claude-2', accountId: 'lnk', known: true })
    expect(resolveObserved(localStamped, [localLink])).toBe(localStamped)
    expect(effectiveAccountId(undefined, localStamped, [localLink])).toBe('lnk')
  })

  it('demotes a linked id whatever state the settings row is in — but never a MANAGED one', () => {
    // `isLocallyLinkedAccount` asks only "does this id stand for a directory on this machine".
    // A `pending` linked row still claims one (core's own dir-match rule skips pending rows, so
    // this id can only have been stamped by an earlier settled state or a hand edit — either way
    // the path is local), and settings.json is hand-editable, so a `configDir` too broken to use
    // is still that declaration. Both widenings demote MORE, never less.
    const pendingLink = acct({ id: 'lnk', configDir: '/home/me/.claude-2', pending: true })
    const remoteStamped = observed({
      configDir: '/home/me/.claude-2',
      accountId: 'lnk',
      known: true,
      remote: true
    })
    expect(resolveObserved(remoteStamped, [pendingLink])?.known).toBe(false)
    const brokenLink = acct({ id: 'lnk', configDir: 'not/absolute' })
    expect(resolveObserved(remoteStamped, [brokenLink])?.known).toBe(false)
    // A MANAGED local account has no `configDir`: its id came from `<userData>/claude-accounts/`,
    // not from a path the user declared, and reaching one from a remote observation would take a
    // host that holds this machine's entire userData path. Left alone on purpose — demoting it
    // would be paid by every managed pane whose node the canvas can no longer place.
    const managedRemoteObs = observed({
      configDir: '/data/claude-accounts/a1',
      accountId: 'a1',
      known: true,
      remote: true
    })
    expect(resolveObserved(managedRemoteObs, [acct()])).toBe(managedRemoteObs)
    expect(effectiveAccountId(undefined, managedRemoteObs, [acct()])).toBe('a1')
  })

  it('does not dir-match on the fallback path either, when the observed id has gone away', () => {
    // `resolveObserved`'s other direction: a known id that no longer exists falls back to its dir.
    // A remote one must degrade to the bare dir rather than re-home on a local account.
    const goneRemote = observed({ configDir: '/home/me/.claude-2', accountId: 'old', known: true, remote: true })
    expect(resolveObserved(goneRemote, [localLink])).toEqual({ ...goneRemote, accountId: null, known: false })
  })

  it('still resolves a MANAGED REMOTE account — the thing that must not regress', () => {
    // The classifier's managed-remote rule (`~/.nodeterm/claude-accounts/<id>`) reports a real id
    // with `known: true`, and a remote account is in the account list with `host` set. That route
    // is ID-based, never path-based, so the refusal above cannot reach it.
    const remoteAcct = acct({ id: 'r1', label: 'ops@example.com', host: 'me@host.example.com' })
    const managedRemote = observed({
      configDir: '/home/me/.nodeterm/claude-accounts/r1',
      accountId: 'r1',
      known: true,
      remote: true
    })
    expect(resolveObserved(managedRemote, [remoteAcct])).toBe(managedRemote)
    expect(effectiveAccountId(undefined, managedRemote, [remoteAcct])).toBe('r1')
    expect(accountKey(undefined, managedRemote, [remoteAcct])).toBe('r1')
    expect(accountChipFor({ observed: managedRemote, accounts: [remoteAcct], multiple: false })?.kind).toBe(
      'managed'
    )
    // …and it is never a Link candidate, because it is a known account.
    expect(unlinkedConfigDirs({ n1: { account: managedRemote } }, [remoteAcct])).toEqual([])
  })

  it('leaves the host’s own system account reading the system root', () => {
    const remoteSystem = observed({ configDir: '/home/me/.claude', accountId: null, known: true, remote: true })
    expect(effectiveAccountId(undefined, remoteSystem, [acct()])).toBeUndefined()
    expect(accountKey(undefined, remoteSystem)).toBe(SYSTEM_ACCOUNT_KEY)
  })
})

describe('observationIsRemote (which machine the observed dir is on)', () => {
  it('asks the node and the project, and either one is enough', () => {
    // `data.ssh` / `data.sshRemoteTmux` is the precise answer…
    expect(observationIsRemote({ node: { ssh: { host: 'h' } }, projectIsSsh: false })).toBe(true)
    expect(observationIsRemote({ node: { sshRemoteTmux: true }, projectIsSsh: false })).toBe(true)
    // …but a node created before its project's ControlMaster came up carries neither yet, so the
    // project has to answer for it.
    expect(observationIsRemote({ node: {}, projectIsSsh: true })).toBe(true)
    expect(observationIsRemote({ node: undefined, projectIsSsh: true })).toBe(true)
  })

  it('is false for an ordinary local node — the byte-identical case', () => {
    expect(observationIsRemote({ node: {}, projectIsSsh: false })).toBe(false)
    expect(observationIsRemote({ node: { ssh: undefined }, projectIsSsh: false })).toBe(false)
  })

  it('treats a node it cannot place as REMOTE', () => {
    // Hook events for a node id no canvas holds — a tmux session outliving the node that named it.
    // A wrong `false` puts a Link button on a directory that is not here; a wrong `true` costs one
    // withheld offer. Only one of those two guesses is destructive, so it is the one not made.
    expect(observationIsRemote(undefined)).toBe(true)
  })
})

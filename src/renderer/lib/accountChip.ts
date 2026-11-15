import type { ClaudeAccount, ObservedClaudeAccount } from '@shared/types'
import { isRemoteSessionNode } from '@shared/worktree'
import { accountChipLabel, systemAccountDisplayOn } from '../state/workspace'

/**
 * Per-node Claude account labelling — the pure half of the account chip.
 *
 * A node's account has TWO possible sources and they routinely disagree:
 *  - `data.accountId` — the managed/linked account the node was CREATED with. Immutable, and the
 *    only thing that steers `CLAUDE_CONFIG_DIR` at spawn.
 *  - `ObservedClaudeAccount` — what the RUNNING session's hooks reported (agent-status store).
 *    For a plain terminal where the user ran `export CLAUDE_CONFIG_DIR=~/.claude-2; claude`, this
 *    is the only identity that exists anywhere.
 *
 * Everything here is pure and display/read-only. An observed account is a LABEL (see the
 * `ObservedClaudeAccount` doc comment in shared/types): it may decide what we SHOW and whose
 * transcripts we READ, never what is permitted — so nothing in this module is a gate.
 *
 * PASS THE LIVE `accounts` LIST AT EVERY CALL SITE. It is optional only so the parameter could be
 * added without touching every caller, and the default `[]` is not "don't resolve" — it means "no
 * accounts exist", which is a real state (the user just unlinked their only one) and makes
 * `resolveObserved` degrade every observed id to its bare dir. Omitting it therefore reads as
 * "every account was removed", which is exactly wrong in the one case it matters.
 */

/** The account key for the system default (`~/.claude`), which has no `ClaudeAccount` record. */
export const SYSTEM_ACCOUNT_KEY = 'sys'

/** Chip labels are ~one word wide; the same cap `accountChipLabel` applies to a managed label. */
const MAX_CHIP_LABEL = 10

/** `systemAccountDisplay`'s generic fallback, mirrored so the chip can recognise "there is no
 *  identity here to shorten" (see `accountChipFor`). */
const GENERIC_SYSTEM_DISPLAY = 'System account'

/**
 * Is this path string Windows-shaped? The owning filesystem is NOT known here — a config dir may
 * come from this machine, an SSH host, or Windows — so the shape of the string decides, rather
 * than treating `/` and `\` as interchangeable: on POSIX a backslash is legal filename text
 * (CONTRIBUTING). A drive letter, a UNC prefix, or backslashes with no forward slash is Windows.
 */
function isWindowsShapedPath(dir: string): boolean {
  return (
    /^[a-zA-Z]:[\\/]/.test(dir) ||
    dir.startsWith('\\\\') ||
    (dir.includes('\\') && !dir.includes('/'))
  )
}

/**
 * The comparable form of a config dir. ONE function, used on BOTH sides of every config-dir
 * comparison in this module (CONTRIBUTING: "normalize BOTH sides of a path comparison, through one
 * function" — the half-normalized version of this is issue #558).
 *
 * Trims, drops trailing separators, and — only for a Windows-shaped path — folds separators to `\`
 * and lowercases, because Windows paths are case-insensitive and `C:/x` and `C:\x` name the same
 * dir. A POSIX path is left case- and backslash-sensitive, because there both are significant.
 *
 * This is a LABEL comparison (which account name to show, whose transcripts to read); the jail and
 * every real permission check live in core and are unaffected by it.
 */
export function normalizeConfigDirForCompare(dir: string | undefined | null): string {
  const trimmed = (dir ?? '').trim()
  if (!trimmed) return ''
  const windows = isWindowsShapedPath(trimmed)
  let out = windows ? trimmed.replace(/\//g, '\\') : trimmed
  const sep = windows ? '\\' : '/'
  while (out.length > 1 && out.endsWith(sep)) out = out.slice(0, -1)
  return windows ? out.toLowerCase() : out
}

/** Do these two config dirs name the same directory? Empty never matches — an absent `configDir`
 *  (every managed account has none) must not collide with an unlinked observation. */
export function configDirsMatch(a: string | undefined | null, b: string | undefined | null): boolean {
  const left = normalizeConfigDirForCompare(a)
  return !!left && left === normalizeConfigDirForCompare(b)
}

/**
 * Is this account's IDENTITY a directory on THIS machine — i.e. is it a LINKED account
 * (`configDir` set, no `host`)?
 *
 * `claudeAccounts.link` is a LOCAL adoption, so a linked row's `configDir` names a directory on the
 * machine the core runs on. That is what makes such an id unsafe for an observation from another
 * machine: the id was derived FROM THAT PATH, by `classifyClaudeConfigDir`'s linked rule in core,
 * which is host-agnostic on purpose and runs before `remote` exists (see `resolveObserved`).
 * `host` is what separates it from a managed-remote account, whose id came from the path SHAPE
 * (`~/.nodeterm/claude-accounts/<id>`) and so means the same thing on whichever machine posted it.
 *
 * Two deliberate widenings, both of which demote MORE rather than less — this module's standing
 * failure direction (one chip fewer, never a wrong one):
 *  - `pending` is NOT excluded (core's own `linkedDirOf` excludes it): the question here is not
 *    "may this row be dir-matched" but "does this id stand for a local directory", and a linked row
 *    still waiting on its login claims one just as much.
 *  - the raw field's truthiness decides, not `normalizeLinkedConfigDir`: settings.json is
 *    hand-editable, and a value too broken to USE is still the user declaring this account local.
 */
function isLocallyLinkedAccount(a: ClaudeAccount): boolean {
  return !!a.configDir && !a.host
}

/** The two facts about the node an observation arrived for, as the renderer can see them. */
export interface ObservationOrigin {
  /** The node itself — the live React Flow `node.data` for the active project, or the serialized
   *  `CanvasNodeState` for any other. Both carry `ssh` / `sshRemoteTmux`. */
  node?: { ssh?: unknown; sshRemoteTmux?: unknown }
  /** Does the project that owns the node run on an SSH host? */
  projectIsSsh: boolean
}

/**
 * Is this observation's filesystem on ANOTHER machine? (`ObservedClaudeAccount.remote`)
 *
 * Two independent claims are OR-ed, and both are needed. `isRemoteSessionNode` asks the node
 * (`data.ssh` / `data.sshRemoteTmux` — never `data.remote`, a field nothing on a canvas node
 * sets), which is the precise answer; but a node created before its project's ControlMaster came
 * up does not carry those yet, so the project's own SSH-ness has to answer for it. Same shape as
 * `session-memory-service.ts`'s two claims of remoteness, for the same reason: a source that says
 * "no" while momentarily uninformed would publish another machine's dir as this one's.
 *
 * **`undefined` — we cannot say whose node this is — is REMOTE.** Every consumer of the flag
 * degrades a remote observation to "show the label, offer nothing local", while a wrong `false`
 * puts a Link button on a directory that does not exist here: the failure the flag was added to
 * stop. Guessing local is the only guess with a destructive outcome, so it is the guess not made.
 * The case is narrow — hook events for a node id no canvas holds, i.e. a tmux session outliving
 * the node that named it — and a stored observation captured while the node DID exist keeps the
 * `remote: false` it was captured with, so nothing already detected is retracted by this.
 */
export function observationIsRemote(origin: ObservationOrigin | undefined): boolean {
  if (!origin) return true
  return origin.projectIsSsh || isRemoteSessionNode(origin.node)
}

/**
 * Re-resolve an observation against the CURRENT account list.
 *
 * The hook server classifies `transcript_path` at POST time, so an observation is frozen as of the
 * account list that existed then — and nothing else would ever revisit it: a quiet pane may not
 * post another hook for hours. Linking and unlinking are settings edits, so the renderer is the
 * only place that can notice, and this is where it does. Everything else in this module goes
 * through it, so the chip, the keys, the detected list and the readers cannot disagree about the
 * same dir.
 *
 * Two directions, and both are about the DIR, which is the one fact that outlives the record:
 *  - unknown dir + an account now claiming it  ⇒ that account (the link case);
 *  - a known id that no longer exists          ⇒ back to the bare dir, `known: false` (the unlink
 *    or remove case). Without this the pane showed "Unknown account" and its dir vanished from
 *    Settings → Detected, so there was no way back to Link short of waiting for the next turn.
 *    A re-link under a NEW id is picked up by the same dir match, hence one code path.
 *
 * The system account (`known` with `accountId: null`) is never touched: it has no record to lose.
 * `data.accountId` is likewise untouched — a NODE created under a removed account still reads
 * "Unknown account", which is correct: that binding really is dangling.
 *
 * **A REMOTE observation is never dir-matched against a local account** (`observed.remote`), in
 * either direction. `ClaudeAccount.configDir` is set only by `claudeAccounts.link`, which is a
 * LOCAL adoption — the path it stores names a directory on this machine — while a remote pane's
 * dir names one on its host, and `~/.claude-2` on a server and `~/.claude-2` here spell the same
 * string whenever the two machines share a username, which is the ordinary case rather than a
 * corner. Matching them would label the remote pane with a local account's identity, and
 * `effectiveAccountId` would then hand that id to the LOCAL transcript, session-name and usage
 * readers.
 *
 * **An id is not automatically safer than a path — it depends on where the id came from.** The
 * dir-match refusal above is not the whole story, because the FIRST dir match already happened in
 * core: `classifyClaudeConfigDir`'s linked rule compares the posted dir against every linked
 * account's `configDir`, is host-agnostic by design, and runs at POST time, before the renderer
 * has stamped `remote`. So when a local linked account holds `/home/me/.claude-2` and an SSH
 * pane posts a transcript under the host's `/home/me/.claude-2`, the observation arrives here
 * ALREADY `{known: true, accountId: '<the local linked id>'}` — it never reaches the dir-match
 * refusal, because the id branch returns first. A remote observation resolving to a LINKED account
 * (`isLocallyLinkedAccount`) is therefore demoted to the bare dir, which is exactly the answer the
 * dir-match refusal would have given had core not got there first.
 *
 * Managed-remote observations are unaffected, and that is the non-regression: they arrive
 * `known: true` carrying a real `accountId` (classifier rule 2, `~/.nodeterm/claude-accounts/<id>`)
 * whose account row has `host` set, so it is an id derived from a path SHAPE that means the same
 * thing on either machine — not a claim about a directory on this one. Managed LOCAL accounts
 * (rule 1, no `configDir`) are left alone too, deliberately: reaching one from a remote path would
 * take a host holding this machine's whole `<userData>/claude-accounts` path, while demoting them
 * would be paid regularly by the case below.
 *
 * **The cost, stated plainly:** `remote` is one boolean and `observationIsRemote(undefined)` is
 * TRUE, so a LOCAL linked pane whose node no canvas holds any more (a tmux session outliving the
 * node that named it) is demoted here too — its chip becomes the bare dir and its readers fall
 * back to the system root. That is the same trade the flag was introduced under: one label fewer,
 * never a wrong one. Splitting "on a host" from "cannot place this node" to recover it would
 * reinstate exactly the "unknown ⇒ local" guess `observationIsRemote` refuses to make.
 */
export function resolveObserved(
  observed: ObservedClaudeAccount | undefined,
  accounts: readonly ClaudeAccount[] = []
): ObservedClaudeAccount | undefined {
  if (!observed) return observed
  // A dir on another machine may never be matched against a local account's dir; the id-based
  // resolution below it is safe for both, because an id is not a path.
  const dirMatchable = !observed.remote
  if (observed.known) {
    if (!observed.accountId) return observed // the system default — nothing to lose
    const held = accounts.find((a) => a.id === observed.accountId)
    if (held) {
      // The id still resolves — but a REMOTE observation carrying a LINKED account's id is an id
      // that core derived from a LOCAL path (classifier rule 3), so it says nothing about the
      // machine that posted it. Demote it to the bare dir, the same answer the dir-match refusal
      // below gives; otherwise `effectiveAccountId` hands a local account id to the LOCAL
      // transcript / session-name / usage readers for a session whose filesystem is elsewhere.
      // Managed accounts (no `configDir`) and managed-remote ones (`host` set) fall through
      // untouched — their ids are not claims about a directory here.
      if (observed.remote && isLocallyLinkedAccount(held)) {
        return { ...observed, accountId: null, known: false }
      }
      return observed
    }
    // The id is gone (unlinked/removed since the observation). Fall back to the dir — unless there
    // is none, in which case there is nothing better to say than the id we already have.
    if (!observed.configDir) return observed
    const relinked = dirMatchable
      ? accounts.find((a) => configDirsMatch(a.configDir, observed.configDir))
      : undefined
    return relinked
      ? { ...observed, accountId: relinked.id, known: true }
      : { ...observed, accountId: null, known: false }
  }
  if (!observed.configDir || !dirMatchable) return observed
  const match = accounts.find((a) => configDirsMatch(a.configDir, observed.configDir))
  return match ? { ...observed, accountId: match.id, known: true } : observed
}

/**
 * The account a node's READERS (transcript root, session name, context meter, ⌘M chat) must use:
 * the node's own account when it has one, else whatever the session was observed running as.
 *
 * `known` is what makes the observed id meaningful: an unrecognised config dir reports
 * `accountId: null`, and must resolve to `undefined` (→ the system account's readers) rather than
 * to some other account's transcripts. Deliberately NOT used for spawn/env — launch identity stays
 * creation-time.
 *
 * A REMOTE observation needs no branch of its own here, because `resolveObserved` already refuses
 * every route by which one could reach a LOCAL account's id: it dir-matches no remote dir, and it
 * demotes a remote observation that arrived already carrying a LINKED account's id (core matched
 * that path before the `remote` flag existed — see `resolveObserved`). Both leave `known: false`,
 * which yields `undefined` here. What a remote observation can still yield is an id from the two
 * routes that do not name a directory on this machine, and both are right — a managed-remote
 * account (`~/.nodeterm/claude-accounts/<id>`) is a real record whose reads are scoped by that id
 * on whichever host runs them, and the host's own system `~/.claude` yields `undefined`, which is
 * the system root on either machine.
 */
export function effectiveAccountId(
  dataAccountId?: string,
  observed?: ObservedClaudeAccount,
  /** The current account list, so a dir linked SINCE the observation resolves to its account
   *  without waiting for the pane's next hook event (see `resolveObserved`). */
  accounts: readonly ClaudeAccount[] = []
): string | undefined {
  if (dataAccountId) return dataAccountId
  const known = resolveObserved(observed, accounts)
  if (known?.known && known.accountId) return known.accountId
  return undefined
}

/**
 * The identity key a node counts as, for "is more than one account in play?".
 *
 *  - `<accountId>` — a managed or linked account (from the node, or observed);
 *  - `'sys'`       — the system default (`~/.claude`), which has no id of its own;
 *  - `ext:<dir>`   — a config dir nodeterm has no record of, keyed by its path because that is the
 *                    only thing that tells two unlinked dirs apart;
 *  - `null`        — nothing is known about this node's account. NOT a key: an unobserved plain
 *                    terminal must not count as a second identity (it would put a chip on every
 *                    system pane the moment one shell was opened), and it gets no chip.
 *
 * A REMOTE observation keys exactly like a local one, deliberately. The key is an opaque identity
 * token — it is never spent on a filesystem action and, since `resolveObserved` refuses to
 * dir-match a remote observation, it can no longer be produced by mistaking a host's dir for a
 * local account's. The residual is a COLLISION: a host's `/home/u/.claude-2` and this machine's
 * `/home/u/.claude-2`, both unlinked, key the same and count as one identity. That is accepted,
 * not overlooked. It costs at most one chip — `multiple` is the only consumer, and it gates the
 * chip on SYSTEM panes alone, so the two dirs themselves still chip (with different tooltips) —
 * which is this module's standing failure direction: one chip fewer, never a wrong one. The
 * alternative, a second key dialect for remote dirs, would mean the chip has to parse two shapes
 * to recover a path, and one resolution feeding chip + keys + detected list is the invariant that
 * keeps them from disagreeing.
 */
export function accountKey(
  dataAccountId?: string,
  observed?: ObservedClaudeAccount,
  /** See `resolveObserved`: a dir linked since the observation keys as its ACCOUNT, so the linked
   *  pane and a node created under that account count as one identity, not two. */
  accounts: readonly ClaudeAccount[] = []
): string | null {
  if (dataAccountId) return dataAccountId
  const resolved = resolveObserved(observed, accounts)
  if (!resolved) return null
  if (resolved.known) return resolved.accountId ?? SYSTEM_ACCOUNT_KEY
  // A `known: false` entry with no dir is not evidence of anything — it names no identity, so it
  // cannot be a distinct key (degrade to nothing, never to something wrong).
  return resolved.configDir ? `ext:${resolved.configDir}` : null
}

/** The distinct account keys across a set of nodes (see `accountKey`); unknown nodes contribute
 *  nothing. `size >= 2` is what the chip means by "more than one identity is in play". */
export function distinctAccountKeys(
  entries: Iterable<{ dataAccountId?: string; observed?: ObservedClaudeAccount }>,
  accounts: readonly ClaudeAccount[] = []
): Set<string> {
  const keys = new Set<string>()
  for (const e of entries) {
    const key = accountKey(e.dataAccountId, e.observed, accounts)
    if (key) keys.add(key)
  }
  return keys
}

/**
 * The selector form of `distinctAccountKeys().size >= 2`, over an agent-status table plus THIS
 * node's own `data.accountId`.
 *
 * Returns a PRIMITIVE on purpose (the `usageScopeKey` rule): a chip subscriber runs this on every
 * hook event of every node, and a Set/array result would give each of them fresh props and
 * re-render every node header on an unrelated status edit. Early-exits at two keys.
 *
 * The store only knows OBSERVED accounts, so other nodes' creation-time `data.accountId` is not
 * counted — a managed node that has never posted a hook is invisible here. That is the cheap,
 * store-only reading of "how many identities" and it fails in the safe direction: one chip fewer,
 * never a wrong one.
 */
export function hasMultipleAccountKeys(
  byId: Record<string, { account?: ObservedClaudeAccount }>,
  ownAccountId?: string,
  accounts: readonly ClaudeAccount[] = []
): boolean {
  const keys = new Set<string>()
  const own = accountKey(ownAccountId, undefined, accounts)
  if (own) keys.add(own)
  for (const entry of Object.values(byId)) {
    const key = accountKey(undefined, entry.account, accounts)
    if (key) keys.add(key)
    if (keys.size >= 2) return true
  }
  return keys.size >= 2
}

/**
 * The config dirs seen running on this core that nodeterm has no account for — Settings →
 * Accounts lists these as one-click "Link" candidates.
 *
 * Derived from OBSERVATIONS only: a dir gets in here because a session posted a hook from it, so
 * the list is a record of what actually ran, and nothing here reads the filesystem (a forged POST
 * must not make us stat anything).
 *
 * Membership is decided by `resolveObserved` — the SAME resolution the chip uses — so a dir can
 * never be both "belongs to an account" (chipped as linked) and "detected" (offered for linking),
 * in either direction: linking removes it from this list at once, and unlinking puts it back at
 * once, with no hook event in between.
 *
 * **A REMOTE observation is skipped** (`observed.remote`). This list is a list of LINK candidates,
 * and Settings → Accounts spends it on `claudeAccounts.link`, which `stat`s and writes on the
 * machine the core runs on. A dir an SSH-project pane reported lives on its HOST, so the button
 * would `stat` a path that is either absent here (an error the user cannot act on) or — with the
 * same username on both machines, the ordinary case — a DIFFERENT directory of the same name,
 * silently adopting the wrong account. The dir is still shown on the pane's own chip: naming what
 * a session runs as is a true statement wherever it runs; only the local offer is withdrawn.
 */
export function unlinkedConfigDirs(
  byId: Record<string, { account?: ObservedClaudeAccount }>,
  accounts: readonly ClaudeAccount[] = []
): string[] {
  const dirs = new Set<string>()
  for (const entry of Object.values(byId)) {
    if (entry.account?.remote) continue
    const a = resolveObserved(entry.account, accounts)
    if (!a || a.known || !a.configDir) continue
    dirs.add(a.configDir)
  }
  // Sorted so the list does not reshuffle itself as unrelated nodes come and go.
  return [...dirs].sort()
}

export interface AccountChipInfo {
  /** Chip text — one short word. */
  short: string
  /** Native tooltip: the full identity, or (unlinked) what to do about it. */
  tooltip: string
  kind: 'system' | 'managed' | 'linked' | 'unlinked'
}

/** `label` → chip text: the part before `@`, capped with an ellipsis. Same rule as
 *  `accountChipLabel` (which owns it for managed accounts and also builds their tooltip); kept
 *  here for the system/unlinked labels rather than importing a cycle back out of `state/`. */
function shortAccountLabel(label: string): string {
  const base = label.split('@')[0]
  return base.length > MAX_CHIP_LABEL ? `${base.slice(0, MAX_CHIP_LABEL)}…` : base
}

/**
 * Last segment of a config dir path, for an unlinked dir's chip: such a dir is named by its path
 * and never read, so its last segment is the only name there is.
 *
 * The owning filesystem is NOT known here: the dir string comes from a hook that may have run on
 * this machine, on an SSH host, or on Windows. So the separator is picked from the SHAPE of the
 * string instead of treating both as interchangeable — on POSIX a backslash is legal filename text
 * (CONTRIBUTING: "do not treat both separators as interchangeable unless the owning filesystem is
 * known to be Windows"). A drive letter, a UNC prefix, or backslashes with no forward slash is
 * Windows-shaped; everything else is POSIX-shaped.
 */
export function configDirLabel(configDir: string): string {
  const dir = configDir.trim()
  if (!dir) return ''
  const windowsShaped = isWindowsShapedPath(dir)
  const sep = windowsShaped ? '\\' : '/'
  const parts = dir.split(sep).filter((p) => p.length > 0)
  // A bare root (`/`, `C:\`) has no segment to name; fall back to the whole string so the chip
  // still says something rather than rendering empty.
  return parts[parts.length - 1] ?? dir
}

/**
 * The chip for one node, or `null` for no chip.
 *
 * Visibility: a node that is NOT on the system account always gets a chip (it is the exception
 * the user needs to see), and system nodes get one only when `multiple` — i.e. when at least two
 * identities are in play, so two panes side by side are always told apart.
 */
export function accountChipFor({
  dataAccountId,
  observed,
  accounts,
  systemLabel,
  systemEmail,
  hostKey,
  remoteSystemEmail,
  multiple
}: {
  dataAccountId?: string
  observed?: ObservedClaudeAccount
  accounts: ClaudeAccount[]
  /** `settings.systemAccountLabel` — the user's own name for the `~/.claude` login. */
  systemLabel?: string
  /** The detected `~/.claude` login email (`state/systemAccount`), when known. */
  systemEmail?: string | null
  /** `user@host` when the pane runs on an SSH host: its system account is the HOST's `~/.claude`,
   *  which this machine's label / email says nothing about. Absent = this machine. */
  hostKey?: string
  /** The host's detected system login email (`state/systemAccount` `remoteEmails`), when known. */
  remoteSystemEmail?: string | null
  /** Are ≥ 2 distinct account keys in play on this core? (`hasMultipleAccountKeys`) */
  multiple?: boolean
}): AccountChipInfo | null {
  // Resolved against the CURRENT list: linking a detected dir must repaint every chip on it
  // immediately, not at that pane's next hook event (see `resolveObserved`).
  const key = accountKey(dataAccountId, observed, accounts)
  if (!key) return null // nothing known — no chip, and nothing counted either
  if (key === SYSTEM_ACCOUNT_KEY) {
    if (!multiple) return null // one identity in play: the system pane is the unremarkable case
    const display = systemAccountDisplayOn(
      hostKey,
      { label: systemLabel, email: systemEmail },
      remoteSystemEmail
    )
    if (hostKey) {
      // The short form cannot carry the host tag, so an unknown host login reads "System" and the
      // tooltip says whose `~/.claude` it is.
      return {
        short: remoteSystemEmail ? shortAccountLabel(display) : 'System',
        tooltip: `${display} — system Claude account (~/.claude on ${hostKey})`,
        kind: 'system'
      }
    }
    return {
      // With neither a custom label nor a detected email the display is the generic "System
      // account", which the 10-char cap turns into "System acc…" — an ellipsis that promises a
      // longer name there isn't one of. Nothing to shorten: say "System".
      short: display === GENERIC_SYSTEM_DISPLAY ? 'System' : shortAccountLabel(display),
      tooltip: `${display} — system Claude account (~/.claude)`,
      kind: 'system'
    }
  }
  if (key.startsWith('ext:')) {
    // An unlinked dir is named by its path and NEVER read (no `stat`, no open — a forged POST must
    // not make us touch the filesystem). The tooltip is the whole affordance, so it must not point
    // anywhere the user cannot go: Settings → Accounts links a dir on the machine the core runs
    // on, which is not the machine a REMOTE pane's dir is on. The chip itself stays either way —
    // naming what the session runs as is true wherever it runs — and the remote wording says whose
    // filesystem the path belongs to instead of offering an impossible action.
    const dir = key.slice('ext:'.length)
    return {
      short: shortAccountLabel(configDirLabel(dir)),
      tooltip: observed?.remote
        ? `Claude config dir ${dir} on the remote host — not a config dir on this machine`
        : `Unlinked Claude config dir ${dir} — link it in Settings → Accounts`,
      kind: 'unlinked'
    }
  }
  const label = accountChipLabel(key, accounts)
  if (!label) return null // unreachable: `key` is a non-empty id here
  // A linked account is a dir the user already owned (`ClaudeAccount.configDir`), which is worth
  // showing differently from a managed one: removing it keeps the folder, and it is the identity a
  // hand-launched `claude` will keep using whatever nodeterm does.
  const linked = !!accounts.find((a) => a.id === key)?.configDir
  return { short: label.short, tooltip: label.tooltip, kind: linked ? 'linked' : 'managed' }
}

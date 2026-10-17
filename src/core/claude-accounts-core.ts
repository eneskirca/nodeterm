// Pure logic for managed Claude accounts (config-dir isolation). No fs/electron imports —
// everything here is unit-tested; the impure lifecycle lives in claude-accounts.ts.
import { createHash } from 'crypto'
import path from 'path'
import { MODEL_GATEWAY_ENV_KEYS } from '../shared/agents/model-gateway'
import type { ClaudeAccount, ObservedClaudeAccount } from '../shared/types'

/** Shape of a valid account id (uuid / opaque token). Shared by every path builder so a bad id
 *  can never traverse out of the accounts root — locally OR on a remote host over ssh. */
const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]+$/
/** The same rule as a predicate, for callers that must REFUSE a bad id rather than throw on it —
 *  `project-node-append` validates the account id a phone sends over the relay before writing it
 *  into a project file. One definition: a second copy of this alphabet would drift out of step
 *  with the path builders it exists to protect. */
export function isSafeAccountId(accountId: string): boolean {
  return ACCOUNT_ID_RE.test(accountId)
}
function assertAccountId(accountId: string): void {
  if (!isSafeAccountId(accountId)) {
    throw new Error(`invalid account id: ${JSON.stringify(accountId)}`)
  }
}

/** Root-relative config dir for a managed account. Rejects ids that could escape the root. */
export function accountConfigDir(userDataPath: string, accountId: string): string {
  assertAccountId(accountId)
  return path.join(userDataPath, 'claude-accounts', accountId)
}

/**
 * Remote (SSH) config dir for a managed account, relative to the remote `$HOME` as a `~`-prefixed
 * path (`~/.nodeterm/claude-accounts/<id>`). Used for ssh EXEC args (mkdir / cat / rm), where
 * `quoteRemotePath` leaves the leading `~` unquoted so the remote shell expands it. NOT for tmux
 * `-e` (tmux does not shell-expand values — use `remoteAccountConfigDirAbs` there). Id-validated so
 * a hostile id can never escape `~/.nodeterm/claude-accounts/` on the remote host.
 */
export function remoteAccountConfigDir(accountId: string): string {
  assertAccountId(accountId)
  return `~/.nodeterm/claude-accounts/${accountId}`
}

/**
 * Absolute remote config dir for a managed account, given the resolved remote `$HOME`. Needed for
 * the tmux `-e CLAUDE_CONFIG_DIR=…` env: tmux copies the value literally (no `$HOME`/`~` expansion),
 * so the path must already be absolute. `remoteHome` is the connection's cached `$HOME`.
 */
export function remoteAccountConfigDirAbs(remoteHome: string, accountId: string): string {
  assertAccountId(accountId)
  return `${remoteHome.replace(/\/+$/, '')}/.nodeterm/claude-accounts/${accountId}`
}

// ---- Observed config dirs (which account a RUNNING session is actually on) ------------------
//
// The hook payload's `transcript_path` is the only account signal that exists for a session
// nodeterm did not launch — a hand-run `CLAUDE_CONFIG_DIR=~/.claude-2 claude` in a plain terminal
// carries `data.accountId: undefined` forever. Everything below is pure string work on that path:
// the observed dir is a LABEL (see `ObservedClaudeAccount`), nothing branches on it for
// permission, so a host-agnostic match is correct and covers SSH nodes without a remote lookup.

/** Which `path` implementation owns a given path string. */
export type PathDialect = 'posix' | 'win32'

/**
 * Dialect of a path string, by SHAPE and only by shape: a drive letter (`C:\…`, `C:/…`) or a UNC
 * prefix (`\\host\share`). Deliberately NOT "contains a backslash" — on POSIX a backslash is legal
 * filename text, and treating the two separators as interchangeable there would split real names
 * apart (CONTRIBUTING: "do not treat both separators as interchangeable unless the owning
 * filesystem is known to be Windows"). Anything else is POSIX, which is also the right answer for
 * the remote paths an SSH node's hooks post.
 */
export function pathDialectOf(p: string): PathDialect {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') ? 'win32' : 'posix'
}

function pathFor(d: PathDialect): typeof path.posix {
  return d === 'win32' ? path.win32 : path.posix
}

/**
 * Normalize a directory path for COMPARISON: dialect-correct `normalize`, then trailing separators
 * stripped down to (but never into) the root. Trailing-slash insensitivity is not cosmetic — the
 * two spellings arrive from different places (a hook payload's `transcript_path` vs. a path the
 * user typed into Settings), and CONTRIBUTING's rule is that BOTH sides of a path comparison go
 * through one function.
 */
function normDir(p: string, d: PathDialect): string {
  const P = pathFor(d)
  let n = P.normalize(p)
  const root = P.parse(n).root
  // On win32 both separators end a path; on POSIX only `/` does (a trailing `\` is a filename).
  const endsWithSep = (s: string): boolean => s.endsWith('/') || (d === 'win32' && s.endsWith('\\'))
  while (n.length > root.length && endsWithSep(n)) n = n.slice(0, -1)
  return n
}

/** Compare two already-`normDir`'d dirs. Case-insensitive on win32 — that IS the filesystem's own
 *  rule there, and a chip that fails to match `C:\Users\X` against `c:\users\x` is a silent miss. */
function sameDir(a: string, b: string, d: PathDialect): boolean {
  return d === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** Split a normalized dir into segments in its own dialect. */
function segmentsOf(p: string, d: PathDialect): string[] {
  return d === 'win32' ? p.split(/[\\/]/) : p.split('/')
}

/**
 * The Claude config dir a `transcript_path` belongs to, or null when the path is not shaped like a
 * Claude transcript. Claude writes `<configDir>/projects/<slug>/<session>.jsonl`, and a SUBAGENT
 * transcript sits deeper under the same `projects` root — so the rule is "walk UP from the file to
 * the nearest segment named `projects`, take its parent".
 *
 * Nearest going UP means the LAST `projects` segment, not the first. A config dir can itself live
 * under a directory called `projects` (`~/projects/.claude/projects/<slug>/<id>.jsonl` is an
 * ordinary layout for someone who keeps their checkouts in `~/projects`), and taking the first
 * match there would name `~` as the config dir — i.e. hand the jail a $HOME-wide root.
 *
 * `dialect` is normally detected from the string (an SSH node posts a POSIX path to a Windows
 * desktop, so the LOCAL platform is the wrong authority — CONTRIBUTING: "the browser's OS is NOT
 * the filesystem's OS"); pass it explicitly when the caller knows the owning filesystem.
 */
export function configDirFromTranscriptPath(p: string, dialect?: PathDialect): string | null {
  if (typeof p !== 'string' || !p.trim()) return null
  const d = dialect ?? pathDialectOf(p)
  const P = pathFor(d)
  const segs = segmentsOf(P.normalize(p.trim()), d)
  const i = segs.lastIndexOf('projects')
  // `i < 1` covers both "no projects segment at all" and a `projects` with no parent to name.
  // The trailing check is the other half of the same honesty: `transcript_path` is a FILE, so a
  // `projects` with nothing under it is not a transcript and answering `/home/u` for `/home/u/
  // projects` would invent a config dir out of an ordinary checkout directory.
  if (i < 1 || i >= segs.length - 1) return null
  // An absolute POSIX path splits to a leading '' — joining ['', 'home', 'x'] yields '/home/x'.
  // `/projects/x.jsonl` slices to [''], which joins to '' and means the root itself.
  const joined = segs.slice(0, i).join(P.sep)
  return normDir(joined || P.sep, d)
}

/**
 * Re-validate a hand-editable `ClaudeAccount.configDir` at the POINT OF USE (CONTRIBUTING: never
 * by its TypeScript type — settings.json is hand-edited and git-shared). Absolute, normalized, no
 * surviving `..`; anything else is `null`, and every caller degrades to the managed-dir default
 * rather than to something wider ("degrade to nothing, never to something wrong").
 *
 * `..` cannot survive `normalize` on an absolute path, so the check is belt-and-braces — kept
 * because this value ends up as a JAIL ROOT, where a survivor would walk straight out of it.
 */
export function normalizeLinkedConfigDir(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s) return null
  const d = pathDialectOf(s)
  if (!pathFor(d).isAbsolute(s)) return null
  const n = normDir(s, d)
  return segmentsOf(n, d).includes('..') ? null : n
}

/**
 * Expand a leading `~` in a config dir TYPED into Settings (no shell ever sees it, so nothing else
 * would). `~` and `~/…` in every dialect; `~\…` too in the win32 dialect only — on POSIX a
 * backslash is filename text, so `~\x` stays the literal (relative, hence refused) name it is.
 */
export function expandTildeLinkedDir(typed: string, home: string, dialect: PathDialect): string {
  const tilde =
    typed === '~' || typed.startsWith('~/') || (dialect === 'win32' && typed.startsWith('~\\'))
  return tilde ? pathFor(dialect).join(home, typed.slice(1)) : typed
}

/** Two linked config dirs name the same directory: both re-validated, same dialect, compared by the
 *  owning filesystem's rule (case-insensitive on win32 — `C:\Users\X\.claude` is
 *  `c:\users\x\.CLAUDE\`). An invalid side is never "the same". */
export function sameLinkedConfigDir(a: unknown, b: unknown): boolean {
  const na = normalizeLinkedConfigDir(a)
  const nb = normalizeLinkedConfigDir(b)
  if (!na || !nb) return false
  const d = pathDialectOf(na)
  return d === pathDialectOf(nb) && sameDir(na, nb, d)
}

/** `child` lies strictly BELOW `root` (both re-validated, same dialect; case-insensitive on win32,
 *  where either separator is accepted by normalization). Equality is `sameLinkedConfigDir`. */
export function isUnderLinkedConfigDir(child: unknown, root: unknown): boolean {
  const c = normalizeLinkedConfigDir(child)
  const r = normalizeLinkedConfigDir(root)
  if (!c || !r) return false
  const d = pathDialectOf(c)
  if (d !== pathDialectOf(r)) return false
  const sep = d === 'win32' ? '\\' : '/'
  const prefix = r.endsWith(sep) ? r : r + sep
  return d === 'win32'
    ? c.length > prefix.length && c.toLowerCase().startsWith(prefix.toLowerCase())
    : c.length > prefix.length && c.startsWith(prefix)
}

/** The settings rows a linked-dir match may consult: local (a linked dir is local by definition —
 *  see §7 of the plan), settled, and carrying a value that survives re-validation. */
function linkedDirOf(acct: ClaudeAccount): string | null {
  if (acct.host || acct.pending) return null
  return normalizeLinkedConfigDir(acct.configDir)
}

/**
 * Classify an observed config dir into an `ObservedClaudeAccount`. PURE string
 * matching — no fs, and deliberately host-agnostic, because the same classification has to answer
 * for a remote path an SSH node's hooks posted:
 *   1. `<userData>/claude-accounts/<id>` — this app's own managed root on THIS machine.
 *   2. `<anything>/.nodeterm/claude-accounts/<id>` — the same thing on a remote host (POSIX).
 *   3. a settings row's linked `configDir` — the user declared this dir an account.
 *   4. any `…/.claude` — the system default, on this machine or on the host (`accountId: null`).
 *   5. anything else — `known: false`; the UI labels it by its last path segment and offers to
 *      link it. NOTHING reads such a dir: a forged POST must not make us open a file.
 *
 * (1) and (2) answer with the id WITHOUT consulting settings: the path IS nodeterm's own root, so
 * the id in it is the id nodeterm minted — including for an account still `pending` its login,
 * whose login node is precisely the session posting from that dir.
 */
export function classifyClaudeConfigDir(
  dir: string,
  ctx: { homeDir: string; userDataDir: string; accounts: readonly ClaudeAccount[] }
): ObservedClaudeAccount {
  const d = pathDialectOf(dir)
  const configDir = normDir(dir, d)
  const P = pathFor(d)

  // 1. Managed, local. Compared in the LOCAL dialect on both sides: a POSIX remote path can never
  //    match a Windows userData root, which is the correct answer, not a miss.
  const udDialect = pathDialectOf(ctx.userDataDir)
  if (udDialect === d) {
    // Joined in the userData path's OWN dialect, not the local platform's: this module is pure
    // path math and the LOCAL `path` is the wrong authority for a string that came off the wire.
    const localRoot = normDir(pathFor(udDialect).join(ctx.userDataDir, 'claude-accounts'), udDialect)
    const base = P.basename(configDir)
    if (sameDir(normDir(P.dirname(configDir), d), localRoot, d) && isSafeAccountId(base)) {
      return { configDir, accountId: base, known: true }
    }
  }
  // 2. Managed, remote (`remoteAccountConfigDir`). Remote hosts are POSIX; matched by SHAPE rather
  //    than against a resolved `$HOME`, because the hook payload is the only thing we have.
  if (d === 'posix') {
    const segs = segmentsOf(configDir, d)
    const [a, b, c] = segs.slice(-3)
    if (segs.length >= 3 && a === '.nodeterm' && b === 'claude-accounts' && isSafeAccountId(c)) {
      return { configDir, accountId: c, known: true }
    }
  }
  // 3. Linked. Before the `.claude` rule below so that linking a dir whose basename happens to be
  //    `.claude` (another user's home, a relocated profile) reports the account the user declared.
  for (const acct of ctx.accounts) {
    const linked = linkedDirOf(acct)
    if (linked && pathDialectOf(linked) === d && sameDir(configDir, linked, d)) {
      return { configDir, accountId: acct.id, known: true }
    }
  }
  // 4. System. `<home>/.claude` is the local one; the basename rule generalizes it to a remote
  //    host's own system account, which is `known` for the same reason — the dir is a label.
  const homeDialect = pathDialectOf(ctx.homeDir)
  if (homeDialect === d && sameDir(configDir, normDir(P.join(ctx.homeDir, '.claude'), d), d)) {
    return { configDir, accountId: null, known: true }
  }
  if (P.basename(configDir) === '.claude') return { configDir, accountId: null, known: true }
  return { configDir, accountId: null, known: false }
}

/**
 * Transcript root for a session lookup: an account's `projects` dir under its config dir, or
 * the system default `~/.claude/projects` when no account. Pure path math (no fs) — the impure
 * wrapper in transcript-reader.ts feeds `os.homedir()` / `app.getPath('userData')`. Reuses
 * `accountConfigDir`'s id validation so a bad account id can never escape the accounts root.
 *
 * `linkedConfigDir` is a LINKED account's own dir (`ClaudeAccount.configDir`): its transcripts
 * live in the user's directory, not under `{userData}`. Trailing and optional, so every
 * pre-existing caller is unchanged. Re-validated here rather than trusted — an unusable value
 * falls back to the managed/system root, which is the pre-existing behavior, never something wider.
 */
export function transcriptRootFor(
  homeDir: string,
  userDataPath: string | null,
  accountId?: string,
  linkedConfigDir?: string
): string {
  const linked = normalizeLinkedConfigDir(linkedConfigDir)
  if (linked) return path.join(linked, 'projects')
  return accountId
    ? path.join(accountConfigDir(userDataPath ?? '', accountId), 'projects')
    : path.join(homeDir, '.claude', 'projects')
}

/**
 * Jail predicate for a hook-reported LOCAL `transcript_path`: hook POSTs can arrive over the
 * remote reverse tunnel, so a forged POST must not make the app read an arbitrary local file.
 * Legitimate local transcripts live under exactly these roots:
 *   - claude's system default `~/.claude/projects`,
 *   - a managed account's `{userData}/claude-accounts/<accountId>/projects`,
 *   - gemini's `~/.gemini/tmp` (its chats are `<project>/chats/session-*.jsonl`), and
 *   - codex's `<codexHome>/sessions` (its rollouts are `YYYY/MM/DD/rollout-*.jsonl`).
 * For the account root the `<accountId>` segment is validated with `ACCOUNT_ID_RE` (dots barred,
 * so `..` can never sneak in) and the very next segment must be `projects` — a prefix match on
 * `{userData}/claude-accounts` alone is NOT enough (it would accept `…/claude-accounts/x/.ssh`).
 * `abs` must already be resolved/normalized by the caller (e.g. `path.resolve(tp)`).
 *
 * `codexHomeDir` is where codex keeps its state — `$CODEX_HOME` when the user has moved it, which
 * `core/usage/codex-usage.ts`'s `codexHome()` already resolves for the usage reader. Trailing and
 * optional, defaulting to `<homeDir>/.codex`, so every pre-existing caller is unchanged. It is a
 * PARAMETER rather than an env read because this module is pure path math: the shells own the env.
 * Getting it wrong fails CLOSED (a relocated codex home would silently never fill its meter, not
 * leak anything) — which is the quieter and therefore worse failure, hence the parameter.
 *
 * `linkedDirs` are the LINKED accounts' config dirs from settings (`ClaudeAccount.configDir`) —
 * user-declared, so `<dir>/projects/**` is legitimate and the meter/subagent cards fill for a pane
 * running `CLAUDE_CONFIG_DIR=~/.claude-2 claude`. Exactly the same two rules as the managed root:
 * the dirs come from SETTINGS and never from the POST (a forged payload cannot name its own jail
 * root), and the segment after the dir must be `projects` — `<linkedDir>/.ssh` and `<linkedDir>`
 * itself stay refused. Each value is re-validated here (absolute, normalized, no `..`) rather than
 * trusted for having a TypeScript type: it is hand-editable settings JSON, and an unusable one
 * simply contributes no root.
 */
export function isSafeLocalTranscriptPath(
  abs: string,
  homeDir: string,
  userDataPath: string,
  codexHomeDir?: string,
  grokHomeDir?: string,
  linkedDirs?: readonly string[]
): boolean {
  const legacyRoot = path.join(homeDir, '.claude', 'projects')
  if (abs === legacyRoot || abs.startsWith(legacyRoot + path.sep)) return true
  // gemini and codex keep their transcripts in their OWN trees, which the context meter for those
  // agents reads (core/gemini-session.ts, core/codex-session.ts). Each root is the narrowest one
  // that holds them — the same directories `handoff/locate.ts` already walks to find a session
  // file. Deliberately NOT `$HOME`: this predicate exists precisely so a forged POST cannot aim a
  // read at `~/.ssh/id_rsa`, and a home-wide allowance would hand that straight back.
  const geminiRoot = path.join(homeDir, '.gemini', 'tmp')
  if (abs === geminiRoot || abs.startsWith(geminiRoot + path.sep)) return true
  const antigravityRoot = path.join(homeDir, '.gemini', 'antigravity-cli', 'brain')
  if (abs === antigravityRoot || abs.startsWith(antigravityRoot + path.sep)) return true
  const codexRoot = path.join(codexHomeDir || path.join(homeDir, '.codex'), 'sessions')
  if (abs === codexRoot || abs.startsWith(codexRoot + path.sep)) return true
  // grok: `$GROK_HOME/sessions/<url-encoded cwd>/<sessionId>/`. `sessions` and not `$GROK_HOME`,
  // because the same tree holds `auth.json` — a home-wide allowance would put the user's bearer
  // token inside the jail this predicate exists to keep it out of. Same parameter discipline as
  // codex: the shells own the env (`grokHomeDir()` in `agents/grok-paths.ts` resolves $GROK_HOME),
  // this module stays pure path math, and getting it wrong fails CLOSED — a relocated grok home
  // means the context link silently never resolves, never a widened read.
  const grokRoot = path.join(grokHomeDir || path.join(homeDir, '.grok'), 'sessions')
  if (abs === grokRoot || abs.startsWith(grokRoot + path.sep)) return true
  // Linked accounts: a config dir the USER already drives (`CLAUDE_CONFIG_DIR=~/.claude-2 claude`)
  // that they adopted in Settings. `<dir>/projects` and below only — the `+ path.sep` is what keeps
  // a sibling-prefix root (`…/projects-evil`) out, exactly as for the roots above. The dirs come
  // from SETTINGS and never from the POST, so a forged payload cannot name its own jail root.
  for (const raw of linkedDirs ?? []) {
    const dir = normalizeLinkedConfigDir(raw)
    if (!dir) continue
    const root = path.join(dir, 'projects')
    if (abs === root || abs.startsWith(root + path.sep)) return true
  }
  const accountsRoot = path.join(userDataPath, 'claude-accounts')
  if (abs !== accountsRoot && !abs.startsWith(accountsRoot + path.sep)) return false
  // Relative to the accounts root: expect `<accountId>/projects[/…]`. Because `abs` is normalized
  // and confirmed under `accountsRoot`, `path.relative` yields no leading `..`.
  const segs = path.relative(accountsRoot, abs).split(path.sep)
  return segs.length >= 2 && ACCOUNT_ID_RE.test(segs[0]) && segs[1] === 'projects'
}

/**
 * Remote analogue of `isSafeLocalTranscriptPath`, for the transcript_path a REMOTE node's hooks
 * POST over the reverse tunnel. Same threat (a forged POST must not make the app read an arbitrary
 * file) and the same two-root shape, but resolved with POSIX semantics (remote hosts are POSIX)
 * and rooted at the project's remote `$HOME`:
 *   - the system default `<remoteHome>/.claude/projects`, and
 *   - a managed REMOTE account's `<remoteHome>/.nodeterm/claude-accounts/<accountId>/projects`
 *     (see `remoteAccountConfigDir`) — jailing to the default root alone dropped every payload
 *     for a remote account, which silently killed the session-name sync, the context meter and
 *     the subagent cards on those nodes.
 * `remoteHome` unknown ⇒ false (fail closed: without a root there is nothing to jail against).
 */
export function isSafeRemoteTranscriptPath(abs: string, remoteHome: string | undefined): boolean {
  if (!abs || !remoteHome) return false
  const p = path.posix.resolve(abs)
  const legacyRoot = path.posix.join(remoteHome, '.claude', 'projects')
  if (p === legacyRoot || p.startsWith(legacyRoot + '/')) return true
  const accountsRoot = path.posix.join(remoteHome, '.nodeterm', 'claude-accounts')
  if (!p.startsWith(accountsRoot + '/')) return false
  // Relative to the accounts root: expect `<accountId>/projects[/…]`. `p` is normalized and
  // confirmed under `accountsRoot`, so `relative` yields no leading `..`.
  const segs = path.posix.relative(accountsRoot, p).split('/')
  return segs.length >= 2 && ACCOUNT_ID_RE.test(segs[0]) && segs[1] === 'projects'
}

/**
 * Claude Code ≥ 2.1 scopes its macOS Keychain service name per config dir:
 * 'Claude Code-credentials-' + first 8 hex chars of sha256(CLAUDE_CONFIG_DIR).
 * (Learned from REF's claude-accounts/keychain.ts — undocumented CLI behavior.)
 */
export function claudeKeychainService(configDir: string): string {
  const suffix = createHash('sha256').update(configDir).digest('hex').slice(0, 8)
  return `Claude Code-credentials-${suffix}`
}

/**
 * Where the usage indicator looks for a Claude OAuth token + identity, per account. With a
 * `configDir` (managed account) the scoped Keychain service comes first — Claude Code ≥ 2.1
 * writes there — with the legacy unscoped services as fallback for older CLIs; the file +
 * identity live under that config dir. Without a `configDir` (system account) it's exactly the
 * legacy layout: unscoped services + `~/.claude`. Pure so it's unit-tested; the impure keychain
 * / fs reads live in claude-usage.ts.
 */
export function usageCredsPaths(
  homeDir: string,
  configDir?: string
): { services: string[]; credsFile: string; identityFile: string } {
  if (configDir) {
    return {
      services: [claudeKeychainService(configDir), 'Claude Code-credentials', 'claudeAiOauth'],
      credsFile: path.join(configDir, '.credentials.json'),
      identityFile: path.join(configDir, '.claude.json')
    }
  }
  return {
    services: ['Claude Code-credentials', 'claudeAiOauth'],
    credsFile: path.join(homeDir, '.claude', '.credentials.json'),
    identityFile: path.join(homeDir, '.claude.json')
  }
}

/** Env vars that would silently shadow the selected account's OAuth login. Stripped at spawn. */
export const AUTH_ENV_STRIP = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN'
] as const

/** Where each supported agent keeps its config, credentials and (for opencode) its plugin code.
 *  One list because they are one hazard — see `isReservedSpawnEnvKey`'s clause on them. */
const AGENT_CONFIG_DIR_ENV: readonly string[] = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME']

/**
 * Names that make a program EXECUTE something it was never asked to, without changing which program
 * was launched. `NODE_OPTIONS`'s exact reserve-reason, one interpreter down and one shell over —
 * three mechanisms, one list because they are one hazard (see `isReservedSpawnEnvKey`'s clause):
 *  - `LD_PRELOAD` / `LD_AUDIT` / `LD_LIBRARY_PATH` — the Linux dynamic loader loads a repo-supplied
 *    `.so` into the CLI's own address space before `main` runs.
 *  - `DYLD_INSERT_LIBRARIES` / `DYLD_LIBRARY_PATH` — the macOS equivalent. macOS strips DYLD_* only
 *    across a SIP-protected or hardened-runtime boundary, and a node/agent CLI is neither: it is a
 *    script run by the user's own `node`, so the pair applies exactly as on Linux.
 *  - `BASH_ENV` / `ENV` — sourced by a NON-interactive shell at startup, which is precisely the
 *    shell every launch line runs in; the file runs before the agent's first byte.
 *  - `GIT_SSH_COMMAND` / `GIT_EXTERNAL_DIFF` — git runs the named command verbatim the moment the
 *    agent (or the user) shells out to git, which an agent pane does constantly.
 * Every one of them renders as an innocuous path or command string in the consent table while
 * granting arbitrary execution inside a binary the user believes untouched — the NODE_OPTIONS
 * bucket, not the PATH bucket. Spec §2 names LD_PRELOAD as attack surface by name.
 *
 * Honest cost, same shape as the `XDG_CONFIG_HOME` overreach documented below: `ENV` and
 * `LD_LIBRARY_PATH` are ALSO ordinary application variables (a project that genuinely wanted
 * `LD_LIBRARY_PATH=./vendor/lib` for its own toolchain cannot set it through project env, and must
 * use custom-agent env or the shell's rc instead). Kept, because a per-key "is this one being used
 * innocently?" judgement is not something the merge point can make, and the failure direction of
 * guessing wrong is arbitrary code execution.
 */
const INJECTION_ENV: readonly string[] = [
  'LD_PRELOAD',
  'LD_AUDIT',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'GIT_SSH_COMMAND',
  'GIT_EXTERNAL_DIFF',
  'BASH_ENV',
  'ENV'
]

/**
 * Env keys a PROJECT's settings document may never contribute to a spawn, however it is sourced
 * and however it was consented to (`makeProjectSpawnOverrides` → `PtyManager.spawnSession`, both
 * the local merge and the ssh `remoteEnvPairs` join).
 *
 * WHY, given the value already passed a trust dialog: consent proves a human saw the PAIRS, not
 * that they understood what each one out-ranks. A project's settings.json is a git-shared file —
 * one commit reaches every clone — and it is merged AFTER the three layers whose entire job is to
 * control these exact names:
 *  - `AUTH_ENV_STRIP` is DELETED from the env when a managed account is selected, precisely so an
 *    inherited API key cannot shadow that account's OAuth login. A project re-adding one silently
 *    routes the session's traffic to a third party.
 *  - AGENT CONFIG DIRS — one clause, three names, because every supported agent has one and a repo
 *    naming any of them redirects that agent's credentials or code loading into itself. All three
 *    read like build directories (`./.tooling`) in a consent table:
 *      · `CLAUDE_CONFIG_DIR` — where claude reads and WRITES credentials (the account path sets it).
 *      · `CODEX_HOME` — the same for codex (`auth.json` lives there; this app emits it in
 *        `usage/codex-usage.ts`, and the launched pane resolves it from its OWN environment, see
 *        `codex-identity-proxy.ts`), so a repo-supplied value captures codex's auth writes.
 *      · `XDG_CONFIG_HOME` — opencode is XDG-respecting and loads its plugins from
 *        `$XDG_CONFIG_HOME/opencode` (`agents/hooks/opencode.ts`), which is where THIS app installs
 *        its managed plugin. A repo pointing that at itself is arbitrary JavaScript executed inside
 *        the agent process — the worst of the three, and the least legible as an env pair.
 *  - `MODEL_GATEWAY_ENV_KEYS` — the provider ROUTING vars (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`,
 *    `COPILOT_PROVIDER_BASE_URL`, and the keys that travel with them). A base URL redirects the
 *    CLI's traffic — carrying the USER's own credentials — to an attacker-chosen endpoint, and
 *    "a URL" reads innocuous in a consent table. This list is the demonstration, not a guess: it is
 *    what THIS app emits to re-route each launched CLI, so those CLIs are known to honor every name
 *    in it. Custom-agent env may still set these — that is the documented proxy use case.
 *  - `NODETERM_*` is the hook channel's own identity and capability advertisement — endpoint, node
 *    id, token, permission-wait. Forging any of them lets one node speak as another.
 *  - `NODE_OPTIONS` — `--require /repo/x.js` loads arbitrary JavaScript into every node-based CLI
 *    (claude first among them) at interpreter start. Same class as the opencode-plugin path above,
 *    and stealthier than PATH: the process still IS the real claude, from the real location, so
 *    nothing downstream — not the pane, not the identity probe — can tell. The dialog shows a flag
 *    string; the grant is code execution.
 *  - `INJECTION_ENV` — the same grant through the DYNAMIC LOADER (`LD_PRELOAD` and friends; the
 *    macOS `DYLD_*` pair, which a non-SIP-protected node/agent CLI honors just as Linux does), the
 *    NON-interactive shell's own startup file (`BASH_ENV` / `ENV`, sourced by the very shell the
 *    launch line runs in), and git's command hooks (`GIT_SSH_COMMAND` / `GIT_EXTERNAL_DIFF`, run
 *    verbatim as soon as the agent shells out to git). One reserve-reason with NODE_OPTIONS: the
 *    process still IS the real CLI, from the real location, and the table showed "a path".
 *
 * WHAT IS DELIBERATELY *NOT* HERE — `PATH`, and every ordinary application variable. Approving
 * `PATH=./bin` is a COHERENT consent: "this project's terminals resolve tools from the repo" is the
 * feature's stated purpose, and the hijack it enables still requires committing a visible binary
 * that a reviewer can see in the tree. `NODE_OPTIONS` fails exactly that test, which is why it sits
 * above and PATH does not — it smuggles execution into a binary the user believes untouched.
 *
 * The reserved list exists only for keys whose implications a dialog CANNOT convey — a credential
 * directory, a silent traffic redirect, a hook identity, an interpreter preload — where what is
 * shown ("a path", "a URL", "a flag") and what is granted are different things. The line is
 * legibility, not danger; a project that wants its own auth belongs in a custom agent.
 *
 * SCOPE, precisely: this filters the project's contribution — BOTH halves of it, the git-shared
 * document AND this machine's local overlay. That is broader than the hostile-input argument
 * strictly requires, and it is the deliberate trade: one rule is auditable where "reserved unless
 * it came from the overlay" would be a provenance check on every key, at the spawn, forever.
 *
 * The same overreach applies by AGENT: `XDG_CONFIG_HOME` is reserved for every pane, including a
 * plain terminal that launches no agent at all and where the opencode-plugin hazard cannot arise.
 * Kept anyway, for the same one-auditable-rule reason — the alternative is a per-agent reserved list
 * evaluated at the spawn, and a pane's agent can change under it. The honest cost: someone who
 * wanted to point a project's shells at repo-local dotfiles through project env cannot, and the
 * local overlay is no workaround because this filter covers that too. What is left is custom-agent
 * env (per-machine configuration the user typed themselves, merged after and over this) for an agent
 * pane, or the shell's own rc for a plain one.
 *
 * Filtered SILENTLY at the merge — a spawn is not a place to raise a second question. So a dropped
 * key is currently invisible to its author; surfacing the skipped keys in the project settings
 * panel is left to the observability wave.
 */
export function isReservedSpawnEnvKey(key: string): boolean {
  return (
    key.startsWith('NODETERM_') ||
    key === 'NODE_OPTIONS' ||
    INJECTION_ENV.includes(key) ||
    AGENT_CONFIG_DIR_ENV.includes(key) ||
    (AUTH_ENV_STRIP as readonly string[]).includes(key) ||
    (MODEL_GATEWAY_ENV_KEYS as readonly string[]).includes(key)
  )
}

/** tmux `-e` pair injecting the account config dir (shared server → per-session env). */
export function accountTmuxEnvArgs(configDir: string): string[] {
  return ['-e', `CLAUDE_CONFIG_DIR=${configDir}`]
}

/** Parse `{configDir}/.claude.json` for a completed login's identity. Null until login lands. */
export function parseLoginCapture(rawClaudeJson: string): { email: string } | null {
  try {
    const j = JSON.parse(rawClaudeJson) as Record<string, any>
    const acct = j.oauthAccount as Record<string, any> | undefined
    const email =
      (acct && typeof acct.emailAddress === 'string' && acct.emailAddress) ||
      (acct && typeof acct.email === 'string' && acct.email) ||
      null
    return email ? { email } : null
  } catch {
    return null
  }
}

/** Claude Code < 2.1 uses one unscoped Keychain service for every config dir → accounts collide. */
export function isSupportedClaudeVersion(versionOutput: string): boolean {
  const m = versionOutput.match(/(\d+)\.(\d+)\./)
  if (!m) return false
  const [major, minor] = [Number(m[1]), Number(m[2])]
  return major > 2 || (major === 2 && minor >= 1)
}

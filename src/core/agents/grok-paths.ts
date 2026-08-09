// The ONE definition of grok's config + session path algebra: `src/main`, `src/core`, `src/server`
// and the SSH installer all import it from here. Drift between two copies of a path rule is exactly
// what made the remote hook installer subscribe gemini to claude's event names for months —
// `core/usage/grok-usage.ts`'s `grokHome()` therefore delegates to `grokHomeDir()` rather than
// re-deriving `$GROK_HOME`.
//
// It lives in `src/core`, NOT `src/shared/agents`, even though its callers span three process
// contexts: it reads `os.homedir()` and measures with `Buffer` (per call — the point is that both
// are node-only APIs, not when they run), and `src/shared` is renderer territory — the renderer imports `shared/agents/*`, and `tsconfig.web.json` carries node
// types, so a renderer import of this file would typecheck cleanly and fail only at bundle or run
// time. `src/core` is node-side by construction (no electron, no renderer), which is exactly this
// file's contract. Should a renderer surface ever need one of these helpers, split the genuinely
// pure half out (the encoding/validation functions) instead of moving the file back.
//
// Layout per grok's shipped 1.0.0 docs (`~/.grok/docs/user-guide/17-sessions.md:18,27`) — NOT observed:
// the branch never had a logged-in session, so no `$GROK_HOME/sessions/` tree ever existed here to
// look at. Every path rule below is therefore a claim about that document:
//   $GROK_HOME/hooks/*.json                     — hook files, all merged; GROK_HOME defaults to ~/.grok
//   $GROK_HOME/sessions/<encoded cwd>/<id>/     — one directory per session, grouped by cwd
//     summary.json  updates.jsonl  chat_history.jsonl  signals.json  plan.json  subagents/
import path from 'path'
import { homedir } from 'os'

export const GROK_HOOK_FILE = 'nodeterm-status.json'
export const GROK_SUMMARY_FILE = 'summary.json'
export const GROK_SIGNALS_FILE = 'signals.json'
export const GROK_UPDATES_FILE = 'updates.jsonl'
export const GROK_CHAT_HISTORY_FILE = 'chat_history.jsonl'

/** grok URL-encodes the cwd to name a session group; past this many BYTES it switches to a
 *  slug+hash directory instead, which we cannot reconstruct — so we resolve nothing there. */
export const GROK_ENCODED_CWD_MAX_BYTES = 255
const GROK_SESSION_ID_MAX = 128
/** Generous cap on a host-reported $GROK_HOME; longer than any real path, short enough to bound. */
const REMOTE_HOME_MAX = 4096

// Deliberately narrow — ONE known key, so a typo'd `{ GROK_HOM: … }` is a compile error instead of
// a silent fall back to `~/.grok`. The cast on the default argument is what that costs: GrokEnv is a
// WEAK type (every property optional), and `NodeJS.ProcessEnv extends Dict<string>` declares only an
// index signature, which the weak-type check does not count as a property in common — so a bare
// `env: GrokEnv = process.env` is TS2559 under tsconfig.node.json (it passes under
// tsconfig.web.json, which has no node types). Widening GrokEnv with an index signature would fix
// the error and take the typo check with it.
type GrokEnv = { GROK_HOME?: string }

/** grok's config directory: `$GROK_HOME`, else `~/.grok`. Hooks AND sessions live under it.
 *
 *  KNOWN TRAP — the env this reads is the APP's, not the user's shell. A desktop app launched from
 *  Finder/Dock/a `.desktop` entry inherits the launcher's environment, which never sourced
 *  `.zshrc`/`.bashrc`; this repo already knows the class, which is why `findTmux()` resolves an
 *  absolute path "because GUI apps don't inherit the shell PATH". So for a user whose only
 *  `export GROK_HOME=…` lives in a shell rc file, the two sides disagree: nodeterm writes the hook
 *  file (and looks for sessions) under `~/.grok`, while the grok CLI — started by the shell inside a
 *  tmux pane, which DID source that rc — reads the exported path. Nothing errors. The hook file is
 *  written successfully, grok never loads it, and the consequence is total and silent: no RUNNING /
 *  NEEDS YOU badge, no unread dot, no completion notification, no session name, ever, with no
 *  diagnostic anywhere.
 *
 *  The REMOTE path is BETTER, not immune, and the difference is worth being precise about: it at least
 *  ASKS the host (`RemoteHooks.installGrokRemote` runs `printf %s "${GROK_HOME:-}"`) and validates the
 *  answer (`isSafeRemoteGrokHome`) before falling back to `$HOME/.grok` deliberately. But that probe
 *  goes over a **plain ssh exec channel**, not a login shell, so it shares this exact blind spot: a
 *  host that exports `GROK_HOME` only from `.bashrc` reports empty and silently gets `~/.grok`. That is
 *  checklist item 26, which exists BECAUSE the remote side has the problem too.
 *
 *  Deliberately NOT fixed here: resolving it means probing the user's login shell for `GROK_HOME`
 *  (a spawn, a cache, and a fail-open policy), which is its own change with its own failure modes —
 *  not a comment. It is item 31 in docs/grok-agent.md's device checklist ("is `GROK_HOME` set in your
 *  shell?") because a device run is what tells us whether anyone actually sets it. */
export function grokHomeDir(env: GrokEnv = process.env as GrokEnv, home: string = homedir()): string {
  const fromEnv = env.GROK_HOME?.trim()
  return fromEnv || path.join(home, '.grok')
}

export function grokSessionsDir(env: GrokEnv = process.env as GrokEnv, home: string = homedir()): string {
  return path.join(grokHomeDir(env, home), 'sessions')
}

/** The session-group directory name for a cwd, or null when grok would not have used this scheme. */
export function grokEncodedCwdDirName(cwd: string): string | null {
  const trimmed = cwd.trim()
  if (!trimmed) return null
  let encoded: string
  try {
    encoded = encodeURIComponent(trimmed)
  } catch {
    return null
  }
  // encodeURIComponent deliberately leaves dots untouched — reject path syntax explicitly.
  if (encoded === '.' || encoded === '..' || encoded.includes('/') || encoded.includes('\\')) return null
  return Buffer.byteLength(encoded, 'utf8') <= GROK_ENCODED_CWD_MAX_BYTES ? encoded : null
}

/** grok's ids are UUIDs; the charset is enforced because this value reaches both a path and (via
 *  `grok --resume <id>`) a shell command line. */
export function isSafeGrokSessionId(sessionId: string): boolean {
  return sessionId.length > 0 && sessionId.length <= GROK_SESSION_ID_MAX && /^[A-Za-z0-9_-]+$/.test(sessionId)
}

/** The session directory for (cwd, sessionId) — both of which every grok hook payload carries, so
 *  nothing has to scan. Null when either half is unusable: a half-resolved path must never leak. */
export function grokSessionDir(a: { sessionsDir: string; cwd: string; sessionId: string }): string | null {
  const encoded = grokEncodedCwdDirName(a.cwd)
  const id = a.sessionId.trim()
  if (!encoded || !isSafeGrokSessionId(id)) return null
  return path.join(a.sessionsDir, encoded, id)
}

/** Validate a $GROK_HOME reported by a REMOTE host before it is used to build remote paths. The
 *  host's answer is data, not truth: only an absolute POSIX path with no backslash or control
 *  character is usable, and the caller falls back to `$HOME/.grok`.
 *
 *  It judges the EXACT string the caller holds — surrounding whitespace is a rejection, not
 *  something this predicate quietly strips. Trimming here would return `true` about a value whose
 *  embedded `\n` is a command separator on the remote command line the caller then builds, which is
 *  the opposite of what the name promises (same rule as `isSafeRemoteTranscriptPath`). Remote reads
 *  trim at the READ site — `ssh-project.ts`'s remote `$HOME` probe does — so the caller passes an
 *  already-trimmed string and a leftover newline means the read went wrong, not that we should cope. */
export function isSafeRemoteGrokHome(p: string | undefined): boolean {
  const v = p?.trim()
  if (!v || v !== p) return false
  if (!v.startsWith('/') || v.includes('\\') || v.length > REMOTE_HOME_MAX) return false
  return !Array.from(v).some((ch) => {
    const c = ch.charCodeAt(0)
    return c <= 0x1f || c === 0x7f
  })
}

// The spawned-env capture the context meter's popover renders (`pty.envInfo`).
//
// WHY CORE, not inline in pty-manager: masking is a security decision, the "is this key a
// credential" rule is one list, and the tmux fallback reader (`show-environment`) is a second
// query path the same rules must cover — a third copy of the rule is exactly the drift class
// CLAUDE.md bans (one definition in core, consumed by every shell).
//
// SECURITY — the renderer never sees a raw credential. The whole map is masked HERE, before the
// session record is written, so even the tmux-source path cannot leak a raw token. The popover has
// no reveal path: once core marks a value secret, only its masked representation crosses IPC.

import type { PtyEnvVar } from '../shared/types'

/**
 * Keys the popover must mask by default. Matched case-insensitively on anything that smells
 * like a credential, plus the gateway/auth attributes by name. Deliberately NAME-based, not a
 * hand list of every var: a future env layer (project env, custom-agent env) can introduce a
 * key name with no ancestor in this file and it still masks.
 */
const SECRET_NAME_PARTS = [
  'token',
  'key',
  'secret',
  'auth',
  'credential',
  'password',
  'passwd',
  'bearer',
  'apikey',
  'cookie'
] as const

/** Exact non-secret names that end in the suspicious suffixes but are nothing of the sort. */
const SECRET_NAME_EXEMPT = new Set([
  'SSH_AGENT_PID',
  'SSH_AUTH_SOCK',
  'NODETERM_HOOK_SOCK',
  'NODETERMPERM'
])

export function isSecretEnvKey(key: string): boolean {
  if (SECRET_NAME_EXEMPT.has(key)) return false
  const k = key.toLowerCase()
  return SECRET_NAME_PARTS.some((p) => k.includes(p))
}

/**
 * Credentials sometimes hide behind innocent names (`DATABASE_URL`, `REDIS_URL`, `SENTRY_DSN`).
 * Inspect the value at the core boundary too: URI userinfo, connection-string password fields,
 * and private-key material must never ride to the renderer merely because their key lacked a
 * familiar suffix. Ordinary endpoint URLs remain visible for the popover's diagnostic purpose.
 */
export function isSecretEnvValue(value: string): boolean {
  if (/-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/.test(value)) return true
  if (/(?:^|[;\s])(?:password|passwd|pwd|token|secret|api[_-]?key)\s*=/i.test(value)) return true
  try {
    const parsed = new URL(value)
    if (parsed.username || parsed.password) return true
  } catch {
    // Fall through to the nested/opaque URI check below.
  }
  // Covers JDBC-style nested schemes that WHATWG URL accepts but parses as an opaque path.
  return /^[A-Za-z][A-Za-z0-9+.-]*:(?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\/[^/\s:@]+(?::[^@\s]*)?@/.test(
    value
  )
}

/** Mask a secret value: first 3 + last 4 chars visible, middle elided. Same shape the terminal
 *  industry uses for masking in logs/printouts. */
function maskSecret(value: string): string {
  if (value.length <= 8) return '•'.repeat(Math.max(value.length, 1))
  return `${value.slice(0, 3)}${'•'.repeat(value.length - 8)}${value.slice(-4)}`
}

/**
 * The mask applied to every var leaving core.
 *
 * Set: rendered verbatim unless secret-marked. Unset (the shell shows the var name but tmux has
 * no value for it): rendered so the popover can say "not set" instead of a blank cell.
 */
export function maskPtyEnvVar(key: string, value: string | undefined, wasSet: boolean): PtyEnvVar {
  if (!wasSet || value === undefined) return { key, value: '(not set)', set: false }
  if (isSecretEnvKey(key) || isSecretEnvValue(value))
    return { key, value: maskSecret(value), secret: true }
  return { key, value }
}

/** Mask a whole composed env map (sorted by key for a stable popover). */
export function maskPtyEnv(env: Record<string, string>): PtyEnvVar[] {
  return Object.keys(env)
    .sort()
    .map((k) => maskPtyEnvVar(k, env[k], true))
}

/** Parse `tmux show-environment -s` without evaluating its shell-formatted output. Values may
 * contain literal newlines, so this must scan the whole buffer rather than split it into lines. */
export function parseTmuxSessionEnv(stdout: string): PtyEnvVar[] {
  const out: PtyEnvVar[] = []
  const seen = new Set<string>()
  let at = 0
  const nameAt = (): string => {
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(stdout.slice(at))
    if (!match) throw new Error('invalid tmux environment variable name')
    at += match[0].length
    return match[0]
  }
  const finishRecord = (): void => {
    if (stdout[at] === '\n') at += 1
    else if (at !== stdout.length) throw new Error('invalid tmux environment record separator')
  }

  while (at < stdout.length) {
    if (stdout.startsWith('unset ', at)) {
      at += 'unset '.length
      const key = nameAt()
      if (stdout.slice(at, at + 1) !== ';') throw new Error('invalid tmux unset record')
      at += 1
      finishRecord()
      if (seen.has(key)) throw new Error('duplicate tmux environment variable')
      seen.add(key)
      out.push(maskPtyEnvVar(key, undefined, false))
      continue
    }

    const key = nameAt()
    if (stdout.slice(at, at + 2) !== '="') throw new Error('invalid tmux assignment record')
    at += 2
    let value = ''
    let closed = false
    while (at < stdout.length) {
      const char = stdout[at++]
      if (char === '"') {
        closed = true
        break
      }
      if (char !== '\\') {
        value += char
        continue
      }
      if (at >= stdout.length) throw new Error('dangling tmux environment escape')
      const escaped = stdout[at++]
      if (escaped !== '"' && escaped !== '\\' && escaped !== '$' && escaped !== '`') {
        throw new Error('unsupported tmux environment escape')
      }
      value += escaped
    }
    if (!closed) throw new Error('unterminated tmux environment value')
    const suffix = `; export ${key};`
    if (stdout.slice(at, at + suffix.length) !== suffix) {
      throw new Error('invalid tmux export record')
    }
    at += suffix.length
    finishRecord()
    if (seen.has(key)) throw new Error('duplicate tmux environment variable')
    seen.add(key)
    out.push(maskPtyEnvVar(key, value, true))
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

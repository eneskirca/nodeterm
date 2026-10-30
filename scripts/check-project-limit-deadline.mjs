#!/usr/bin/env node
// Release guard for the free-tier open-project limit's embedded deadline (docs/project-limit.md).
//
// `PROJECT_LIMIT_DEADLINE_MS` (src/shared/project-limit.ts) is the instant past which a client that
// never heard from the server — DO_NOT_TRACK, NODETERM_TELEMETRY_DISABLED, a blocked host — treats
// the limit as on and asks the server before opening beyond FREE. Until the flip it must be BUMPED
// IN EVERY RELEASE to a date past the planned flip, or those users are gated before anyone else.
// Nobody remembers a checklist item every release, so the release workflow runs this first and
// refuses to build when the deadline is less than 30 days away. At the flip the deadline becomes the
// flip date for good and `PROJECT_LIMIT_DEADLINE_FROZEN = true` switches the deadline check off.
//
// The FLIP release (frozen) also needs owner step O1 done: `PROJECT_ALLOWANCE_PUBLIC_KEY`
// (src/core/project-allowance-key.ts) ships as '' until the owner pastes the public half of the
// server's `PROJECT_ALLOWANCE_PRIVATE_KEY`, and with '' every allowance token verifies to nothing.
// So a frozen release is refused while the key is empty, unreadable, not an Ed25519 public-key PEM,
// or a PRIVATE key. An unfrozen release does not look at the key at all.
//
// It reads the SOURCE TEXT, not the compiled constant, so it runs before `npm ci` with node alone.
// That is why the constants must keep their literal forms on one line:
//   export const PROJECT_LIMIT_DEADLINE_MS = Date.parse('<ISO instant>')
//   export const PROJECT_LIMIT_DEADLINE_FROZEN = true | false
// Anything else is reported as unreadable — never waved through. The test pins these readings to the
// values the app actually compiles.
//
// Usage: node scripts/check-project-limit-deadline.mjs [path/to/project-limit.ts [path/to/project-allowance-key.ts]]
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MIN_LEAD_MS = 30 * 24 * 60 * 60 * 1000
const SOURCE = 'src/shared/project-limit.ts'
const KEY_SOURCE = 'src/core/project-allowance-key.ts'

const DEADLINE_RE = /^export const PROJECT_LIMIT_DEADLINE_MS = Date\.parse\('([^']*)'\)\s*$/m
const FROZEN_RE = /^export const PROJECT_LIMIT_DEADLINE_FROZEN = (true|false)\s*$/m
// '' / "" / a template literal (the shape entitlement-key.ts uses), optionally typed `: string`.
const KEY_RE =
  /^export const PROJECT_ALLOWANCE_PUBLIC_KEY(?:\s*:\s*string)?\s*=\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`([^`]*)`)/m

/**
 * The deadline and the frozen flag as written in the source, or null when either is missing or not in
 * its literal form (or the ISO string does not parse).
 * @param {string} source
 * @returns {{ deadlineMs: number, frozen: boolean } | null}
 */
export function readDeadline(source) {
  const d = DEADLINE_RE.exec(source)
  const f = FROZEN_RE.exec(source)
  if (!d || !f) return null
  const deadlineMs = Date.parse(d[1])
  if (!Number.isFinite(deadlineMs)) return null
  return { deadlineMs, frozen: f[1] === 'true' }
}

/**
 * Why this source must not be released at `now`, or null when it may. A frozen deadline always may;
 * an unreadable one never does.
 * @param {string} source the text of src/shared/project-limit.ts
 * @param {Date} now
 * @returns {string | null}
 */
export function deadlineProblem(source, now) {
  const read = readDeadline(source)
  if (!read) {
    return (
      `could not read PROJECT_LIMIT_DEADLINE_MS / PROJECT_LIMIT_DEADLINE_FROZEN from ${SOURCE} — keep the ` +
      "literal forms `Date.parse('<ISO instant>')` and `true`/`false`, each on one line (docs/project-limit.md)"
    )
  }
  if (read.frozen) return null
  if (read.deadlineMs < now.getTime() + MIN_LEAD_MS) {
    return (
      `PROJECT_LIMIT_DEADLINE (${new Date(read.deadlineMs).toISOString()}) is less than 30 days away — ` +
      `bump it in ${SOURCE} before releasing (docs/project-limit.md)`
    )
  }
  return null
}

/**
 * `PROJECT_ALLOWANCE_PUBLIC_KEY` as written in src/core/project-allowance-key.ts, or null when the
 * constant is missing or not a plain string literal. Only `\n` escapes are decoded in a quoted form.
 * @param {string} source
 * @returns {string | null}
 */
export function readAllowanceKey(source) {
  const m = KEY_RE.exec(source)
  if (!m) return null
  if (m[3] !== undefined) return m[3]
  return (m[1] ?? m[2]).replace(/\\n/g, '\n')
}

/**
 * Why this pair of sources must not be released at `now`, or null when it may: the deadline first
 * (`deadlineProblem`), then — only for a frozen (flip) release — the allowance key.
 * @param {string} source the text of src/shared/project-limit.ts
 * @param {string | null} keySource the text of src/core/project-allowance-key.ts; null = unreadable
 * @param {Date} now
 * @returns {string | null}
 */
export function releaseProblem(source, keySource, now) {
  const deadline = deadlineProblem(source, now)
  if (deadline) return deadline
  if (!readDeadline(source).frozen) return null
  const key = keySource === null ? null : readAllowanceKey(keySource)
  if (key === null) {
    return (
      `could not read PROJECT_ALLOWANCE_PUBLIC_KEY from ${KEY_SOURCE} — the flip release needs it ` +
      '(docs/project-limit.md, O1)'
    )
  }
  if (key === '') {
    return (
      'PROJECT_ALLOWANCE_PUBLIC_KEY is empty — paste the public half of PROJECT_ALLOWANCE_PRIVATE_KEY into ' +
      `${KEY_SOURCE} before the flip release (docs/project-limit.md, O1)`
    )
  }
  // Checked by text first: createPublicKey accepts a PRIVATE key too (it derives the public half).
  if (/PRIVATE KEY/.test(key)) {
    return (
      `PROJECT_ALLOWANCE_PUBLIC_KEY in ${KEY_SOURCE} is a PRIVATE key — remove it, rotate the key pair, ` +
      'and paste only the public half (docs/project-limit.md, O1)'
    )
  }
  let ed25519 = false
  try {
    const k = crypto.createPublicKey(key)
    ed25519 = /-----BEGIN PUBLIC KEY-----/.test(key) && k.type === 'public' && k.asymmetricKeyType === 'ed25519'
  } catch {
    ed25519 = false
  }
  if (!ed25519) {
    return (
      `PROJECT_ALLOWANCE_PUBLIC_KEY in ${KEY_SOURCE} is not an Ed25519 public key (SPKI PEM) — paste the ` +
      'public half of PROJECT_ALLOWANCE_PRIVATE_KEY before the flip release (docs/project-limit.md, O1)'
    )
  }
  return null
}

function fail(message) {
  // An annotation on the run summary when it runs in GitHub Actions, a plain line elsewhere.
  console.error(`${process.env.GITHUB_ACTIONS === 'true' ? '::error::' : ''}${message}`)
  process.exit(1)
}

// Run only as a script — compared through realpaths. Node resolves the main module through
// symlinks (on macOS /var is /private/var, which can put a whole checkout behind one), and a
// path-string compare then read "not main" and exited 0 without checking anything.
const isMain = (() => {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const file = process.argv[2] ?? path.join(root, SOURCE)
  const keyFile = process.argv[3] ?? path.join(root, KEY_SOURCE)
  let source
  try {
    source = fs.readFileSync(file, 'utf8')
  } catch (err) {
    fail(`could not read ${file}: ${err instanceof Error ? err.message : String(err)}`)
  }
  // Unreadable is null, not a failure here: only a frozen release needs the key (releaseProblem).
  let keySource = null
  try {
    keySource = fs.readFileSync(keyFile, 'utf8')
  } catch {
    keySource = null
  }
  const problem = releaseProblem(source, keySource, new Date())
  if (problem) fail(problem)
  const { deadlineMs, frozen } = readDeadline(source)
  console.log(
    `project-limit deadline ${new Date(deadlineMs).toISOString()}${frozen ? ' (frozen)' : ''}: ok to release`
  )
}

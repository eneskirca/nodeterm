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
// server's `PROJECT_ALLOWANCE_PRIVATE_KEY`, and with '' the limit never switches on (core treats a
// keyless build as unlimited, like one from before the limit).
// So a frozen release is refused while the key is empty, unreadable, not an Ed25519 public-key PEM,
// or a PRIVATE key. An unfrozen release does not look at the key at all.
//
// The flip release also ships the Electron hardening fuses (src/main/electron-fuses.test.ts holds the
// decision record): `package.json` `build.electronFuses` stays absent while the limit is dormant and
// is added in the flip-preparation release, set to exactly `scripts/electron-fuses.json` — the one
// definition both that test and this guard read. A frozen release is refused unless package.json
// carries exactly that object; an unfrozen release does not look at the fuses either.
//
// It reads the SOURCE TEXT, not the compiled constant, so it runs before `npm ci` with node alone.
// That is why the constants must keep their literal forms on one line:
//   export const PROJECT_LIMIT_DEADLINE_MS = Date.parse('<ISO instant>')
//   export const PROJECT_LIMIT_DEADLINE_FROZEN = true | false
// Anything else is reported as unreadable — never waved through. The test pins these readings to the
// values the app actually compiles.
//
// Usage: node scripts/check-project-limit-deadline.mjs [path/to/project-limit.ts [path/to/project-allowance-key.ts [path/to/package.json]]]
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MIN_LEAD_MS = 30 * 24 * 60 * 60 * 1000
const SOURCE = 'src/shared/project-limit.ts'
const KEY_SOURCE = 'src/core/project-allowance-key.ts'
const FUSES_SOURCE = 'scripts/electron-fuses.json'

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
 * The fuses the flip release must ship (`scripts/electron-fuses.json`, next to this script), or null
 * when that file cannot be read or is not a JSON object.
 * @returns {Record<string, unknown> | null}
 */
export function readExpectedFuses() {
  try {
    const v = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./electron-fuses.json', import.meta.url)), 'utf8'))
    return isPlainObject(v) ? v : null
  } catch {
    return null
  }
}

/** @param {unknown} v */
function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * JSON deep equality; key order is not a difference.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function jsonEqual(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]))
  }
  return Object.is(a, b)
}

/**
 * Why this package.json's `build.electronFuses` is not the flip release's, or null when it is exactly
 * `expected`.
 * @param {string | null | undefined} packageSource the text of package.json; null/undefined = unreadable
 * @param {Record<string, unknown> | null} expected `readExpectedFuses()`; null = unreadable
 * @returns {string | null}
 */
export function fusesProblem(packageSource, expected) {
  if (!expected) {
    return `could not read ${FUSES_SOURCE} — the flip release ships exactly those fuses (docs/project-limit.md, Release checklist)`
  }
  let build
  try {
    const pkg = JSON.parse(packageSource ?? '')
    if (!isPlainObject(pkg)) throw new Error('not an object')
    build = pkg.build
  } catch {
    build = undefined
  }
  if (!isPlainObject(build)) {
    return (
      'could not read build.electronFuses from package.json — the flip release ships the hardening fuses ' +
      '(docs/project-limit.md, Release checklist)'
    )
  }
  if (!Object.hasOwn(build, 'electronFuses')) {
    return (
      'package.json has no build.electronFuses — the flip release ships the hardening fuses: set it to exactly ' +
      `${FUSES_SOURCE} (docs/project-limit.md, Release checklist)`
    )
  }
  if (!jsonEqual(build.electronFuses, expected)) {
    return (
      `package.json build.electronFuses differs from ${FUSES_SOURCE} — the flip release ships exactly those ` +
      'fuses; a change to them is a decision for src/main/electron-fuses.test.ts (docs/project-limit.md, Release checklist)'
    )
  }
  return null
}

/**
 * Why these sources must not be released at `now`, or null when they may: the deadline first
 * (`deadlineProblem`), then — only for a frozen (flip) release — the allowance key, then the fuses.
 * @param {string} source the text of src/shared/project-limit.ts
 * @param {string | null} keySource the text of src/core/project-allowance-key.ts; null = unreadable
 * @param {Date} now
 * @param {string | null} [packageSource] the text of package.json; null/absent = unreadable
 * @param {Record<string, unknown> | null} [expectedFuses] defaults to `readExpectedFuses()`, read only
 *   for a frozen release
 * @returns {string | null}
 */
export function releaseProblem(source, keySource, now, packageSource, expectedFuses) {
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
  return fusesProblem(packageSource, expectedFuses === undefined ? readExpectedFuses() : expectedFuses)
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
  const pkgFile = process.argv[4] ?? path.join(root, 'package.json')
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
  // Likewise: only a frozen release needs the fuses.
  let packageSource = null
  try {
    packageSource = fs.readFileSync(pkgFile, 'utf8')
  } catch {
    packageSource = null
  }
  const problem = releaseProblem(source, keySource, new Date(), packageSource)
  if (problem) fail(problem)
  const { deadlineMs, frozen } = readDeadline(source)
  console.log(
    `project-limit deadline ${new Date(deadlineMs).toISOString()}${frozen ? ' (frozen)' : ''}: ok to release`
  )
}

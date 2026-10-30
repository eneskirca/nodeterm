#!/usr/bin/env node
// Release guard for the free-tier open-project limit's embedded deadline (docs/project-limit.md).
//
// `PROJECT_LIMIT_DEADLINE_MS` (src/shared/project-limit.ts) is the instant past which a client that
// never heard from the server — DO_NOT_TRACK, NODETERM_TELEMETRY_DISABLED, a blocked host — treats
// the limit as on and asks the server before opening beyond FREE. Until the flip it must be BUMPED
// IN EVERY RELEASE to a date past the planned flip, or those users are gated before anyone else.
// Nobody remembers a checklist item every release, so the release workflow runs this first and
// refuses to build when the deadline is less than 30 days away. At the flip the deadline becomes the
// flip date for good and `PROJECT_LIMIT_DEADLINE_FROZEN = true` switches this guard off.
//
// It reads the SOURCE TEXT, not the compiled constant, so it runs before `npm ci` with node alone.
// That is why the constants must keep their literal forms on one line:
//   export const PROJECT_LIMIT_DEADLINE_MS = Date.parse('<ISO instant>')
//   export const PROJECT_LIMIT_DEADLINE_FROZEN = true | false
// Anything else is reported as unreadable — never waved through. The test pins these readings to the
// values the app actually compiles.
//
// Usage: node scripts/check-project-limit-deadline.mjs [path/to/project-limit.ts]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MIN_LEAD_MS = 30 * 24 * 60 * 60 * 1000
const SOURCE = 'src/shared/project-limit.ts'

const DEADLINE_RE = /^export const PROJECT_LIMIT_DEADLINE_MS = Date\.parse\('([^']*)'\)\s*$/m
const FROZEN_RE = /^export const PROJECT_LIMIT_DEADLINE_FROZEN = (true|false)\s*$/m

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

function fail(message) {
  // An annotation on the run summary when it runs in GitHub Actions, a plain line elsewhere.
  console.error(`${process.env.GITHUB_ACTIONS === 'true' ? '::error::' : ''}${message}`)
  process.exit(1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file =
    process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', SOURCE)
  let source
  try {
    source = fs.readFileSync(file, 'utf8')
  } catch (err) {
    fail(`could not read ${file}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const problem = deadlineProblem(source, new Date())
  if (problem) fail(problem)
  const { deadlineMs, frozen } = readDeadline(source)
  console.log(
    `project-limit deadline ${new Date(deadlineMs).toISOString()}${frozen ? ' (frozen)' : ''}: ok to release`
  )
}

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'fs'
import path from 'path'
import { testTmpDir } from '../src/core/test-tmp'
import { PROJECT_LIMIT_DEADLINE_FROZEN, PROJECT_LIMIT_DEADLINE_MS } from '../src/shared/project-limit'
import { PROJECT_ALLOWANCE_PUBLIC_KEY } from '../src/core/project-allowance-key'
import {
  deadlineProblem,
  readAllowanceKey,
  readDeadline,
  releaseProblem
  // @ts-expect-error -- plain .mjs repo tooling, deliberately outside the typechecked projects.
} from './check-project-limit-deadline.mjs'

const DAY_MS = 24 * 60 * 60 * 1000
const SCRIPT = path.resolve(__dirname, 'check-project-limit-deadline.mjs')
const REAL_SOURCE = fs.readFileSync(path.resolve(__dirname, '../src/shared/project-limit.ts'), 'utf8')
const REAL_KEY_SOURCE = fs.readFileSync(path.resolve(__dirname, '../src/core/project-allowance-key.ts'), 'utf8')

const keyPair = crypto.generateKeyPairSync('ed25519')
const PUBLIC_PEM = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const PRIVATE_PEM = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

/** src/core/project-allowance-key.ts as it ships before O1 (`''`) or after it (a template literal,
 *  the shape entitlement-key.ts uses), with the header comment that mentions the constant. */
function keySource(value: string): string {
  const literal = value === '' ? "''" : `\`${value}\``
  return [
    '// The public half of PROJECT_ALLOWANCE_PRIVATE_KEY; see PROJECT_ALLOWANCE_PUBLIC_KEY below.',
    `export const PROJECT_ALLOWANCE_PUBLIC_KEY: string = ${literal}`,
    ''
  ].join('\n')
}
const EMPTY_KEY =
  'PROJECT_ALLOWANCE_PUBLIC_KEY is empty — paste the public half of PROJECT_ALLOWANCE_PRIVATE_KEY into src/core/project-allowance-key.ts before the flip release (docs/project-limit.md, O1)'

/** The two lines the guard reads, in the shape src/shared/project-limit.ts writes them, wrapped in
 *  the same kind of doc comment (which itself quotes the literal form — it must not be matched). */
function source(iso: string, frozen: boolean): string {
  return [
    '/**',
    " * Keep the literal form `Date.parse('<ISO instant>')` on one line.",
    ' */',
    `export const PROJECT_LIMIT_DEADLINE_MS = Date.parse('${iso}')`,
    '',
    `export const PROJECT_LIMIT_DEADLINE_FROZEN = ${frozen}`,
    ''
  ].join('\n')
}

const NOW = new Date('2026-10-30T12:00:00Z')
const late = (iso: string): string =>
  `PROJECT_LIMIT_DEADLINE (${iso}) is less than 30 days away — bump it in src/shared/project-limit.ts before releasing (docs/project-limit.md)`

describe('deadlineProblem', () => {
  it('passes a deadline far in the future', () => {
    expect(deadlineProblem(source('2027-01-31T00:00:00Z', false), NOW)).toBeNull()
  })

  it('refuses a deadline 10 days away, naming it', () => {
    const iso = new Date(NOW.getTime() + 10 * DAY_MS).toISOString()
    expect(deadlineProblem(source(iso, false), NOW)).toBe(late(iso))
  })

  it('refuses a deadline that has already passed', () => {
    expect(deadlineProblem(source('2026-01-01T00:00:00Z', false), NOW)).toBe(late('2026-01-01T00:00:00.000Z'))
  })

  it('draws the line at exactly 30 days', () => {
    const at = new Date(NOW.getTime() + 30 * DAY_MS).toISOString()
    const justInside = new Date(NOW.getTime() + 30 * DAY_MS - 1).toISOString()
    expect(deadlineProblem(source(at, false), NOW)).toBeNull()
    expect(deadlineProblem(source(justInside, false), NOW)).toBe(late(justInside))
  })

  it('reads the live constants, not a commented-out earlier value', () => {
    const src =
      "// export const PROJECT_LIMIT_DEADLINE_MS = Date.parse('2026-11-01T00:00:00Z')\n" +
      '// export const PROJECT_LIMIT_DEADLINE_FROZEN = true\n' +
      source('2027-01-31T00:00:00Z', false)
    expect(readDeadline(src)).toEqual({ deadlineMs: Date.parse('2027-01-31T00:00:00Z'), frozen: false })
    expect(deadlineProblem(src, NOW)).toBeNull()
  })

  it('passes a frozen deadline, even one in the past (the flip happened; it is the flip date for good)', () => {
    expect(deadlineProblem(source('2026-01-01T00:00:00Z', true), NOW)).toBeNull()
  })

  it.each([
    ['garbage', 'this is not the file you are looking for'],
    ['an empty file', ''],
    ['a deadline that is not a Date.parse literal', source('x', false).replace("Date.parse('x')", '1_800_000_000_000')],
    ['an unparsable ISO literal', source('not-a-date', false)],
    ['no FROZEN constant', source('2027-01-31T00:00:00Z', false).replace(/^export const PROJECT_LIMIT_DEADLINE_FROZEN.*$/m, '')],
    ['a FROZEN value that is not a boolean literal', source('2027-01-31T00:00:00Z', false).replace('= false', '= !0')]
  ])('refuses %s with a message saying it could not read the deadline', (_name, src) => {
    const problem = deadlineProblem(src, NOW)
    expect(problem).toMatch(/^could not read PROJECT_LIMIT_DEADLINE_MS/)
    expect(problem).toContain('src/shared/project-limit.ts')
    expect(problem).toContain('docs/project-limit.md')
  })

  it('refuses a frozen file whose deadline it cannot read (a broken literal is never waved through)', () => {
    expect(deadlineProblem(source('not-a-date', true), NOW)).toMatch(/^could not read/)
  })
})

describe('releaseProblem: the flip release also needs the allowance key (owner step O1)', () => {
  const FAR = source('2027-01-31T00:00:00Z', false)
  const FROZEN = source('2026-01-01T00:00:00Z', true)

  it('refuses a frozen (flip) release while the key is empty', () => {
    expect(releaseProblem(FROZEN, keySource(''), NOW)).toBe(EMPTY_KEY)
  })

  it('passes a frozen release with an Ed25519 public key, as a template literal or a quoted string', () => {
    expect(releaseProblem(FROZEN, keySource(PUBLIC_PEM), NOW)).toBeNull()
    const quoted = `export const PROJECT_ALLOWANCE_PUBLIC_KEY = '${PUBLIC_PEM.replace(/\n/g, '\\n')}'\n`
    expect(releaseProblem(FROZEN, quoted, NOW)).toBeNull()
  })

  it('does not check the key while the deadline is not frozen — not even an unreadable key file', () => {
    expect(releaseProblem(FAR, keySource(''), NOW)).toBeNull()
    expect(releaseProblem(FAR, null, NOW)).toBeNull()
    expect(releaseProblem(FAR, 'garbage', NOW)).toBeNull()
  })

  it('fails closed on a frozen release whose key file is unreadable or has no key constant', () => {
    for (const src of [null, '', 'garbage', 'export const SOMETHING_ELSE = 1\n']) {
      expect(releaseProblem(FROZEN, src, NOW)).toMatch(/^could not read PROJECT_ALLOWANCE_PUBLIC_KEY/)
    }
  })

  it('refuses a frozen release whose key is not an Ed25519 public-key PEM', () => {
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' })
    for (const value of ['not a pem', rsa.toString()]) {
      expect(releaseProblem(FROZEN, keySource(value), NOW)).toMatch(/is not an Ed25519 public key/)
    }
  })

  it('refuses a pasted PRIVATE key outright (it would parse: Node derives the public half)', () => {
    expect(releaseProblem(FROZEN, keySource(PRIVATE_PEM), NOW)).toMatch(/PRIVATE key/)
  })

  it('still reports the deadline first, and deadlineProblem alone never looks at the key', () => {
    const iso = new Date(NOW.getTime() + 10 * DAY_MS).toISOString()
    expect(releaseProblem(source(iso, false), keySource(''), NOW)).toBe(late(iso))
    expect(deadlineProblem(FROZEN, NOW)).toBeNull()
  })
})

describe('the real src/shared/project-limit.ts', () => {
  // Pins the guard to the compiled constants, so a change of literal form fails on the PR that makes
  // it, not on release day.
  it('reads exactly the values the app compiles', () => {
    expect(readDeadline(REAL_SOURCE)).toEqual({
      deadlineMs: PROJECT_LIMIT_DEADLINE_MS,
      frozen: PROJECT_LIMIT_DEADLINE_FROZEN
    })
  })

  it('and the real src/core/project-allowance-key.ts reads as the key the app compiles', () => {
    expect(readAllowanceKey(REAL_KEY_SOURCE)).toBe(PROJECT_ALLOWANCE_PUBLIC_KEY)
  })
})

describe('the CLI the release workflow runs', () => {
  /** Run the CLI on a limit source and a key source (`null` = point it at a key file that is not there). */
  function run(src: string, key: string | null = keySource(PUBLIC_PEM)): { status: number | null; stderr: string } {
    const dir = testTmpDir('nt-limit-deadline-')
    const file = path.join(dir, 'project-limit.ts')
    const keyFile = path.join(dir, 'project-allowance-key.ts')
    fs.writeFileSync(file, src)
    if (key !== null) fs.writeFileSync(keyFile, key)
    const r = spawnSync(process.execPath, [SCRIPT, file, keyFile], { encoding: 'utf8' })
    return { status: r.status, stderr: r.stderr }
  }

  it('exits 1 with the message when the deadline is too close', () => {
    const iso = new Date(Date.now() + 10 * DAY_MS).toISOString()
    const r = run(source(iso, false))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(late(iso))
  })

  it('exits 1 when it cannot read the file it was pointed at', () => {
    const r = spawnSync(process.execPath, [SCRIPT, path.join(testTmpDir('nt-limit-deadline-'), 'missing.ts')], {
      encoding: 'utf8'
    })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('missing.ts')
  })

  it('exits 0 for a far deadline (key unchecked) and for a frozen one with a real key', () => {
    const far = source(new Date(Date.now() + 90 * DAY_MS).toISOString(), false)
    expect(run(far, keySource('')).status).toBe(0)
    expect(run(far, null).status).toBe(0)
    expect(run(source('2026-01-01T00:00:00Z', true)).status).toBe(0)
  })

  it('exits 1 for a frozen release with an empty or missing key file', () => {
    const frozen = source('2026-01-01T00:00:00Z', true)
    const empty = run(frozen, keySource(''))
    expect(empty.status).toBe(1)
    expect(empty.stderr).toContain(EMPTY_KEY)
    const missing = run(frozen, null)
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('could not read PROJECT_ALLOWANCE_PUBLIC_KEY')
  })

  // Skipped on Windows: creating a symlink there needs a privilege CI runners do not grant.
  it.skipIf(process.platform === 'win32')('still runs when invoked through a symlinked path', () => {
    // Node resolves the main module through symlinks (macOS's /var → /private/var does it to a whole
    // checkout), so a path-string entrypoint check read "not main" there and exited 0, checking nothing.
    const dir = testTmpDir('nt-limit-deadline-')
    const link = path.join(dir, 'guard.mjs')
    fs.symlinkSync(SCRIPT, link)
    const garbage = path.join(dir, 'project-limit.ts')
    fs.writeFileSync(garbage, 'not the file')
    const r = spawnSync(process.execPath, [link, garbage], { encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('could not read PROJECT_LIMIT_DEADLINE_MS')
  })

  it('is the first step that runs anything in every build job, right after checkout', () => {
    // First in all three: a refused tag must build and upload nothing anywhere — the Linux and
    // Windows jobs do not wait for the mac one, and each creates the release on its first upload.
    const wf = fs.readFileSync(path.resolve(__dirname, '../.github/workflows/release.yml'), 'utf8')
    const jobs = ['release-mac', 'release-linux', 'release-win', 'publish']
    for (let i = 0; i < 3; i++) {
      const job = wf.slice(wf.indexOf(`\n  ${jobs[i]}:\n`), wf.indexOf(`\n  ${jobs[i + 1]}:\n`))
      const guard = job.indexOf('run: node scripts/check-project-limit-deadline.mjs')
      expect(guard, `${jobs[i]} runs the deadline guard`).toBeGreaterThan(-1)
      expect(guard, `${jobs[i]}: after checkout`).toBeGreaterThan(job.indexOf('uses: actions/checkout@'))
      expect(job.indexOf('run:'), `${jobs[i]}: no step runs before the guard`).toBe(guard)
    }
  })
})

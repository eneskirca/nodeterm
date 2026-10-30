import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'fs'
import path from 'path'
import { testTmpDir } from '../src/core/test-tmp'
import { PROJECT_LIMIT_DEADLINE_FROZEN, PROJECT_LIMIT_DEADLINE_MS } from '../src/shared/project-limit'
// @ts-expect-error -- plain .mjs repo tooling, deliberately outside the typechecked projects.
import { deadlineProblem, readDeadline } from './check-project-limit-deadline.mjs'

const DAY_MS = 24 * 60 * 60 * 1000
const SCRIPT = path.resolve(__dirname, 'check-project-limit-deadline.mjs')
const REAL_SOURCE = fs.readFileSync(path.resolve(__dirname, '../src/shared/project-limit.ts'), 'utf8')

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

describe('the real src/shared/project-limit.ts', () => {
  // Pins the guard to the compiled constants, so a change of literal form fails on the PR that makes
  // it, not on release day.
  it('reads exactly the values the app compiles', () => {
    expect(readDeadline(REAL_SOURCE)).toEqual({
      deadlineMs: PROJECT_LIMIT_DEADLINE_MS,
      frozen: PROJECT_LIMIT_DEADLINE_FROZEN
    })
  })
})

describe('the CLI the release workflow runs', () => {
  function run(src: string): { status: number | null; stderr: string; stdout: string } {
    const dir = testTmpDir('nt-limit-deadline-')
    const file = path.join(dir, 'project-limit.ts')
    fs.writeFileSync(file, src)
    const r = spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' })
    return { status: r.status, stderr: r.stderr, stdout: r.stdout }
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

  it('exits 0 for a far deadline and for a frozen one', () => {
    expect(run(source(new Date(Date.now() + 90 * DAY_MS).toISOString(), false)).status).toBe(0)
    expect(run(source('2026-01-01T00:00:00Z', true)).status).toBe(0)
  })

  it('is the workflow step, after checkout and before npm ci, in the first build job', () => {
    const wf = fs.readFileSync(path.resolve(__dirname, '../.github/workflows/release.yml'), 'utf8')
    const job = wf.slice(wf.indexOf('release-mac:'), wf.indexOf('release-linux:'))
    const guard = job.indexOf('run: node scripts/check-project-limit-deadline.mjs')
    expect(guard, 'release-mac runs the deadline guard').toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(job.indexOf('uses: actions/checkout@'))
    expect(guard).toBeLessThan(job.indexOf('run: caffeinate -dims npm ci'))
  })
})

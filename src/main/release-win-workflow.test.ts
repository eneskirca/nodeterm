import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * Release guard for the unsigned Windows beta's update notice. `release-win` must build with the
 * `manual` marker (`dist:win:release`) and upload `latest.yml` — without it the shipped app can
 * never learn a new version exists — and must NOT upload blockmaps: differential downloads belong
 * to the self-install story that waits on code signing. Text-level, like the job's own
 * artifact-contract step; no YAML parser needed for a job block this regular.
 */
const WORKFLOW = path.resolve(__dirname, '../../.github/workflows/release.yml')

function jobBlock(text: string, job: string): string {
  const start = text.indexOf(`\n  ${job}:\n`)
  expect(start, `job ${job} not found in release.yml`).toBeGreaterThanOrEqual(0)
  const rest = text.slice(start + 1)
  // The next top-level job: a line indented exactly two spaces that names a key.
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/)
  return next < 0 ? rest : rest.slice(0, next + 1)
}

/** Only the shell lines — comments explain the omissions and would match the negative checks. */
function commands(block: string): string {
  return block
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')
}

describe('release.yml release-win', () => {
  const text = fs.readFileSync(WORKFLOW, 'utf8')
  const job = commands(jobBlock(text, 'release-win'))

  it('builds the manual-marker package, not the local never-polling one', () => {
    expect(job).toMatch(/run: npm run dist:win:release\s*\n/)
    expect(job).not.toMatch(/run: npm run dist:win\s*\n/)
  })

  it('fails the job when latest.yml was not produced', () => {
    expect(job).toContain('test -f dist/latest.yml')
  })

  it('uploads latest.yml beside the installer and zip', () => {
    const upload = job.split('\n').find((l) => l.includes('gh release upload'))
    expect(upload).toBeDefined()
    expect(upload).toContain('dist/nodeterm-Setup-*.exe')
    expect(upload).toContain('dist/nodeterm-*-win.zip')
    expect(upload).toContain('dist/latest.yml')
  })

  it('uploads no blockmap and no broad yml glob', () => {
    expect(job).not.toContain('blockmap')
    expect(job).not.toContain('dist/*.yml')
  })

  it('is still not a gate on the mac+linux publish', () => {
    const publish = commands(jobBlock(text, 'publish'))
    expect(publish).toMatch(/needs: \[release-mac, release-linux\]/)
    expect(publish).not.toContain('release-win')
  })
})

// U2: the feed the apps read is a mirror outside this repo; this job is the only thing that
// notices when it does not serve a release's latest*.yml.
describe('release.yml verify-feed', () => {
  const text = fs.readFileSync(WORKFLOW, 'utf8')
  const job = commands(jobBlock(text, 'verify-feed'))

  it('runs after the promote, even when the best-effort Windows job did not succeed', () => {
    expect(job).toMatch(/needs: \[publish, release-win\]/)
    expect(job).toContain("if: ${{ always() && needs.publish.result == 'success' }}")
  })

  it('checks every platform feed file against the tag on the real update URL', () => {
    expect(job).toContain('FEED: https://nodeterm.dev/updates')
    expect(job).toMatch(/STRICT: latest-mac\.yml latest-linux\.yml/)
    expect(job).toMatch(/ADVISORY: latest\.yml/)
    expect(job).toContain('want="${GITHUB_REF_NAME#v}"')
    expect(job).toContain('curl -fsSL')
    expect(job).toMatch(/s\/\^version:/)
  })

  it('retries for mirror delay, fails only on strict files, and never gates publish', () => {
    expect(job).toMatch(/while \[ "\$n" -le 10 \]/)
    expect(job).toContain('::$level::')
    expect(job).toContain('exit "$fail"')
    const publish = commands(jobBlock(text, 'publish'))
    expect(publish).not.toContain('verify-feed')
  })
})

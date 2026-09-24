import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { legacyEndpointMigration } from './legacy-hook-endpoint'

const dirs: string[] = []
function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nt-legacy-' space-"))
  dirs.push(dir)
  return path.join(dir, 'legacy.env')
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
const old = "NODETERM_HOOK_TOKEN='old-secret'\nNODETERM_HOOK_SOCK='/dead'\n"
const fresh = "NODETERM_HOOK_TOKEN='new-secret'\nNODETERM_HOOK_SOCK='/verified'\n"
describe.skipIf(process.platform === 'win32')('legacy SSH endpoint migration (real shell)', () => {
  it('updates an owned legacy path atomically with private permissions and no argv secrets', () => {
    const file = fixture()
    fs.writeFileSync(file, old)
    const migration = legacyEndpointMigration(file, old, fresh, ['old-secret'])!
    expect(migration.command).not.toContain('old-secret')
    expect(migration.command).not.toContain('new-secret')
    execFileSync('/bin/sh', ['-c', migration.command], { input: migration.stdin })
    expect(fs.readFileSync(file, 'utf8')).toBe(fresh)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(path.dirname(file))).toEqual(['legacy.env'])
  })
  it('refuses an unknown owner and malformed credentials', () => {
    expect(legacyEndpointMigration(fixture(), old, fresh, ['other'])).toBeNull()
    expect(legacyEndpointMigration(fixture(), 'partial', fresh, [''])).toBeNull()
  })
  it.each(['changed', 'symlink', 'locked'])('preserves a %s target after the ownership read', (kind) => {
    const file = fixture()
    fs.writeFileSync(file, old)
    const migration = legacyEndpointMigration(file, old, fresh, ['old-secret'])!
    if (kind === 'changed') fs.writeFileSync(file, 'another owner')
    if (kind === 'symlink') { fs.renameSync(file, `${file}.target`); fs.symlinkSync(`${file}.target`, file) }
    if (kind === 'locked') fs.mkdirSync(`${file}.migration-lock`)
    const result = spawnSync('/bin/sh', ['-c', migration.command], { input: migration.stdin })
    expect(result.status).not.toBe(0)
    expect(fs.readFileSync(file, 'utf8')).toBe(kind === 'changed' ? 'another owner' : old)
    if (kind === 'symlink') expect(fs.lstatSync(file).isSymbolicLink()).toBe(true)
  })
})

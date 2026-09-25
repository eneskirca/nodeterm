import { afterEach, beforeEach, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { IntegrationFiles } from './integration-files'
let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-files-')) })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))
const files = () => new IntegrationFiles(path.join(dir, 'receipts.json'))
it('persists ownership across restarts and removes only its own bytes', () => {
  const file = path.join(dir, 'skills', 'SKILL.md')
  files().reconcile(file, 'ours')
  files().reconcile(file, 'new version')
  expect(fs.readFileSync(file, 'utf8')).toBe('new version')
  files().reconcile(file, null)
  expect(fs.existsSync(file)).toBe(false)
  files().reconcile(file, null)
  expect(fs.existsSync(file)).toBe(false)
})
it('preserves foreign, edited and symlinked skills and reports each', () => {
  const file = path.join(dir, 'SKILL.md')
  files().reconcile(file, 'ours')
  fs.writeFileSync(file, 'my edit')
  for (const next of ['upgrade', null]) {
    const service = files()
    service.reconcile(file, next)
    expect(service.retained).toContain(file)
    expect(fs.readFileSync(file, 'utf8')).toBe('my edit')
  }
  const link = path.join(dir, 'link')
  fs.symlinkSync(file, link)
  const service = files()
  service.reconcile(link, 'ours')
  expect(service.retained).toContain(link)
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
})
it('removes only exactly recognized legacy blocks, preserving surrounding bytes and edits', () => {
  const file = path.join(dir, 'AGENTS.md')
  const block = '<!-- nodeterm:manage-canvas:start -->\nknown\n<!-- nodeterm:manage-canvas:end -->'
  fs.writeFileSync(file, `before\n${block}\nafter\n`)
  files().removeBlocks(file, [block])
  expect(fs.readFileSync(file, 'utf8')).toBe('before\n\nafter\n')
  fs.writeFileSync(file, block.replace('known', 'edited'))
  const service = files()
  service.removeBlocks(file, [block])
  expect(service.retained).toContain(file)
  expect(fs.readFileSync(file, 'utf8')).toContain('edited')
})
it('declining a never-installed integration creates no global files or directories', () => {
  const file = path.join(dir, 'absent', 'SKILL.md')
  files().reconcile(file, null)
  expect(fs.existsSync(path.dirname(file))).toBe(false)
})

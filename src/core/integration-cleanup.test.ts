import { beforeEach, afterEach, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { cleanIntegrationHooks } from './integration-cleanup'
let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-cleanup-')) })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))
it('removes only the exact installed command and preserves adjacent and edited handlers', () => {
  const file = path.join(dir, 'settings.json')
  const command = "sh '/home/u/.nodeterm/agent-hooks/claude.sh'"
  const edited = { type: 'command', command: `${command}; notify-me` }
  const foreign = { type: 'command', command: 'notify-me' }
  fs.writeFileSync(file, JSON.stringify({ model: 'mine', hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command }, foreign, edited] }] } }))
  expect(cleanIntegrationHooks(file, [command])).toEqual([file])
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ model: 'mine', hooks: { Stop: [{ matcher: '*', hooks: [foreign, edited] }] } })
})
it('declining never creates a missing config; malformed content is preserved and reported', () => {
  const file = path.join(dir, 'absent', 'settings.json')
  expect(cleanIntegrationHooks(file, ['ours'])).toEqual([])
  expect(fs.existsSync(path.dirname(file))).toBe(false)
  fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, '{broken')
  expect(cleanIntegrationHooks(file, ['ours'])).toEqual([file])
  expect(fs.readFileSync(file, 'utf8')).toBe('{broken')
})

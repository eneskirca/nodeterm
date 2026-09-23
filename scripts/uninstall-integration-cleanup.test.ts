import { afterEach, beforeEach, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import vm from 'vm'
import { buildManagedHookCommand } from '../src/core/agents/hooks/install-helper'
let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), '744-uninstall-')) })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))
function run(mode: string, file: string, receipts?: string): number {
  // Exercise only the shipped JS cleanup helper, never the process-killing uninstaller shell.
  const shell = fs.readFileSync(path.resolve('scripts/uninstall.sh'), 'utf8')
  const code = shell.split("<<'JSEOF'\n")[1].split('\nJSEOF')[0]
  let status = 0
  try {
    vm.runInNewContext(code, {
      require: (name: string) => name === 'fs' ? fs : name === 'path' ? path : name === 'os' ? { homedir: () => dir } : (() => { throw new Error(name) })(),
      process: { argv: ['node', '-', mode, file, ...(receipts ? [receipts] : [])], stdout: { write() {} }, exit: (code: number) => { status = code; throw new Error('exit') } },
      Buffer
    })
  } catch (e) { if ((e as Error).message !== 'exit') throw e }
  return status
}
it('uninstalls receipted skills but retains user edits and additional files', () => {
  const file = path.join(dir, 'skill', 'SKILL.md')
  fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, 'ours')
  fs.writeFileSync(path.join(dir, 'skill', 'my-notes.md'), 'user notes')
  const receipt = path.join(dir, 'receipts.json')
  fs.writeFileSync(receipt, JSON.stringify({ [file]: 'ours' }))
  expect(run('clean-skill', file, receipt)).toBe(0)
  expect(fs.existsSync(file)).toBe(false)
  expect(fs.readFileSync(path.join(dir, 'skill', 'my-notes.md'), 'utf8')).toBe('user notes')
  fs.writeFileSync(file, 'edited')
  expect(run('clean-skill', file, receipt)).toBe(4)
  expect(fs.readFileSync(file, 'utf8')).toBe('edited')
})
it('a command merely mentioning agent-hooks is not an owned hook', () => {
  const file = path.join(dir, 'settings.json')
  const command = buildManagedHookCommand(path.join(dir, '.nodeterm', 'agent-hooks', 'claude.sh'))
  const edited = { type: 'command', command: command + '; my-hook' }
  fs.writeFileSync(file, JSON.stringify({ model: 'mine', hooks: { Stop: [{ hooks: [{ type: 'command', command }, edited] }] } }))
  expect(run('clean-hooks', file)).toBe(0)
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.Stop[0].hooks).toEqual([edited])
})

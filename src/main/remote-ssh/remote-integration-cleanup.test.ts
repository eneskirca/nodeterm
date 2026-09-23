import { afterEach, beforeEach, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { RemoteHooks } from './remote-hooks'
import { setIntegrationConsent } from '../../core/integration-policy'
import { integrationHostKey } from '../../shared/agent-integrations'
import { buildManagedHookCommand } from '../../core/agents/hooks/install-helper'
const conn = { host: 'fixture', user: 'fixture' }
let home: string
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), '744-remote-cleanup-')) })
afterEach(() => { setIntegrationConsent(undefined); fs.rmSync(home, { recursive: true, force: true }) })
it('remote decline removes only the exact owned hook, leaves edits, and stays declined', async () => {
  const file = path.join(home, '.claude', 'settings.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const command = buildManagedHookCommand(`${home}/.nodeterm/agent-hooks/claude.sh`)
  const foreign = { type: 'command', command: 'user-hook' }
  const edited = { type: 'command', command: `${command}; user-change` }
  fs.writeFileSync(file, JSON.stringify({ model: 'user-model', hooks: { Stop: [{ hooks: [{ type: 'command', command }, foreign, edited] }] } }))
  const hooks = new RemoteHooks({ run: async (args, input) => {
    const result = spawnSync('/bin/sh', ['-c', args.at(-1)!], { input, encoding: 'utf8' })
    if (result.error) throw result.error
    return { code: result.status ?? 1, stdout: result.stdout }
  } })
  setIntegrationConsent({ remote: { [integrationHostKey(conn)]: { claude: false } } })
  await hooks.reconcileIntegrations(conn, '/fixture-control', home)
  await hooks.reconcileIntegrations(conn, '/fixture-control', home)
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ model: 'user-model', hooks: { Stop: [{ hooks: [foreign, edited] }] } })
  expect(fs.existsSync(path.join(home, '.gemini'))).toBe(false)
})

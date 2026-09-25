import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { SettingsStore } from './settings-store'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { DEFAULT_SETTINGS } from '../shared/types'
import { agentIntegrationAllowed, setIntegrationConsent } from './integration-policy'
const calls = vi.hoisted(() => ({ installed: [] as string[], removed: [] as string[] }))
vi.mock('./agents/hooks', () => ({
  installManagedAgentHooks: (allowed: (agent: string) => boolean) => {
    for (const a of ['claude', 'codex', 'gemini']) if (allowed(a)) calls.installed.push(a)
  },
  MANAGED_HOOK_REMOVERS: ['claude', 'codex', 'gemini'].map((a) => [a, () => calls.removed.push(a)])
}))
vi.mock('./claude-accounts-service', () => ({ installHooksIntoLocalAccounts: vi.fn() }))
import { initAgentIntegrations } from './agent-integrations'
let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-consent-'))
  vi.spyOn(os, 'homedir').mockReturnValue(path.join(dir, 'home'))
  initPlatform(fakePlatform({ userDataDir: dir }))
  calls.installed = []; calls.removed = []
})
afterEach(() => { setIntegrationConsent(undefined); resetPlatformForTests(); vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }) })
it('old installations are not consent; a saved decline survives restart without writes or reinstalls', async () => {
  const store = new SettingsStore(); store.init()
  const stop = initAgentIntegrations(store)
  expect(calls.installed).toEqual([])
  expect(calls.removed).toEqual([])
  expect(fs.existsSync(path.join(dir, 'home'))).toBe(false)
  await store.save({ ...DEFAULT_SETTINGS, agentIntegrations: { local: { codex: false } } })
  expect(calls.removed).toEqual(['codex'])
  stop()
  const restarted = new SettingsStore(); restarted.init()
  initAgentIntegrations(restarted)
  expect(calls.installed).toEqual([])
  expect(agentIntegrationAllowed('codex')).toBe(false)
  expect(fs.existsSync(path.join(dir, 'home'))).toBe(false)
})
it('installs only explicitly enabled agents after save; disabling removes installed discovery', async () => {
  const store = new SettingsStore(); store.init(); initAgentIntegrations(store)
  await store.save({ ...DEFAULT_SETTINGS, agentIntegrations: { local: { codex: true } } })
  expect(calls.installed).toEqual(['codex'])
  const skill = path.join(dir, 'home', '.agents', 'skills', 'manage-nodeterm-canvas', 'SKILL.md')
  expect(fs.readFileSync(skill, 'utf8')).toContain('name: manage-nodeterm-canvas')
  expect(fs.existsSync(path.join(dir, 'home', '.codex', 'AGENTS.md'))).toBe(false)
  await store.save({ ...DEFAULT_SETTINGS, agentIntegrations: { local: { codex: false } } })
  expect(fs.existsSync(skill)).toBe(false)
  expect(calls.installed).toEqual(['codex'])
})
it('server hard veto overrides saved grants and never installs on later settings saves', async () => {
  const store = new SettingsStore(); store.init(); initAgentIntegrations(store, false)
  await store.save({ ...DEFAULT_SETTINGS, agentIntegrations: { local: { claude: true } } })
  expect(calls.installed).toEqual([])
  expect(agentIntegrationAllowed('claude')).toBe(false)
})
it('failed persistence cannot authorize integration writes', async () => {
  const store = new SettingsStore(); store.init(); initAgentIntegrations(store)
  fs.mkdirSync(path.join(dir, 'settings.json')) // a fixture obstruction, never the host settings
  await expect(store.save({ ...DEFAULT_SETTINGS, agentIntegrations: { local: { claude: true } } })).rejects.toThrow()
  expect(calls.installed).toEqual([])
  expect(agentIntegrationAllowed('claude')).toBe(false)
})

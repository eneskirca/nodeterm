import { expect, it } from 'vitest'
import { integrationChoice, integrationHostKey } from './agent-integrations'
const conn = { host: 'server', user: 'u' }
it('requires literal explicit opt-in for each integration and machine', () => {
  for (const consent of [undefined, {}, { local: { claude: 'true' } }]) {
    expect(integrationChoice(consent as never, 'claude')).toBeUndefined()
  }
  const consent = { local: { claude: true, codex: false } }
  expect(integrationChoice(consent, 'claude')).toBe(true)
  expect(integrationChoice(consent, 'codex')).toBe(false)
  expect(integrationChoice(consent, 'claude', conn)).toBeUndefined()
  expect(integrationChoice(consent, 'gemini')).toBeUndefined()
})
it('never carries remote consent to another login, endpoint, or SSH route', () => {
  const consent = { remote: { [integrationHostKey(conn)]: { claude: true } } }
  expect(integrationChoice(consent, 'claude', { ...conn, port: 22 })).toBe(true)
  for (const other of [{ ...conn, user: 'other' }, { ...conn, host: 'other' }, { ...conn, port: 2222 }, { ...conn, extraArgs: '-J elsewhere' }]) {
    expect(integrationChoice(consent, 'claude', other)).toBeUndefined()
  }
  expect(integrationChoice(consent, 'claude')).toBeUndefined()
})

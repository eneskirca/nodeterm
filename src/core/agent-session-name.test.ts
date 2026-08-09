// The ROUTER, tested against both real readers — the point being that neither one is ever asked
// about the other's storage. See the provenance note in grok-session.test.ts for the fixture story.
import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { readAgentSessionName } from './agent-session-name'
import { rememberGrokSessionDir, forgetGrokSession } from './grok-session'

const root = mkdtempSync(path.join(tmpdir(), 'agent-session-name-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('readAgentSessionName', () => {
  it("routes grok to grok's session metadata", async () => {
    const dir = path.join(root, 'gs1')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ generated_title: 'Grok named it' }))
    rememberGrokSessionDir('gs1', dir)
    expect(await readAgentSessionName('gs1', undefined, 'grok')).toBe('Grok named it')
    // The account id is claude's concept; passing one must not change grok's answer.
    expect(await readAgentSessionName('gs1', 'acct-2', 'grok')).toBe('Grok named it')
    forgetGrokSession('gs1')
  })

  it('sends everything else to the claude transcript reader', async () => {
    // No transcript exists for this id under any root, so the honest answer is null — the assertion
    // that matters is that it did NOT come back with the grok session's name below.
    rememberGrokSessionDir('shared-id', path.join(root, 'gs1'))
    expect(await readAgentSessionName('shared-id', undefined, 'claude')).toBeNull()
    expect(await readAgentSessionName('shared-id')).toBeNull()
    expect(await readAgentSessionName('shared-id', undefined, 'codex')).toBeNull()
    forgetGrokSession('shared-id')
  })

  it('answers null for an empty session id without asking either reader', async () => {
    expect(await readAgentSessionName('', undefined, 'grok')).toBeNull()
    expect(await readAgentSessionName('')).toBeNull()
  })
})

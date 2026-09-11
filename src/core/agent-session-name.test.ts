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

  it('reads a REMOTE grok session on its host, not on this machine', async () => {
    // §8.4: for an SSH node the shells derive the session directory from the LOCAL sessions root
    // while the payload's `cwd` came from the host — a path on the wrong machine. The remote reader
    // answers first, and its answer is final.
    const dir = path.join(root, 'gs-remote')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ generated_title: 'LOCAL NAME' }))
    rememberGrokSessionDir('gs-remote', dir)
    const remote = async () => ({
      text: JSON.stringify({ generated_title: 'name from the host' })
    })
    expect(await readAgentSessionName('gs-remote', undefined, 'grok', { grokRemoteSummary: remote }))
      .toBe('name from the host')
    forgetGrokSession('gs-remote')
  })

  it('a remote session that cannot be read yields NO name, never the local one', async () => {
    // The mutation this exists for. "Could not read the host" and "there is nothing" are different
    // facts; answering a question about the host with a fact about this machine is how a node ends
    // up wearing another session's name. An empty body is still an answer from the remote reader.
    const dir = path.join(root, 'gs-remote-2')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ generated_title: 'LOCAL NAME' }))
    rememberGrokSessionDir('gs-remote-2', dir)
    const unreadable = async () => ({ text: '' })
    expect(
      await readAgentSessionName('gs-remote-2', undefined, 'grok', { grokRemoteSummary: unreadable })
    ).toBeNull()
    forgetGrokSession('gs-remote-2')
  })

  it('a reader that does not own the session falls through to the local map', async () => {
    // `null` means "not a remote session" — the only answer that routes locally.
    const dir = path.join(root, 'gs-local')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ generated_title: 'local one' }))
    rememberGrokSessionDir('gs-local', dir)
    const notMine = async () => null
    expect(
      await readAgentSessionName('gs-local', undefined, 'grok', { grokRemoteSummary: notMine })
    ).toBe('local one')
    forgetGrokSession('gs-local')
  })

  it('sends everything else to the claude transcript reader', async () => {
    // No transcript exists for this id under any root, so the honest answer is null — the assertion
    // that matters is that it did NOT come back with the grok session's name below.
    rememberGrokSessionDir('shared-id', path.join(root, 'gs1'))
    expect(await readAgentSessionName('shared-id', undefined, 'claude')).toBeNull()
    expect(await readAgentSessionName('shared-id')).toBeNull()
    forgetGrokSession('shared-id')
  })

  it("routes codex to its app-server reader, never to claude's transcript scan", async () => {
    // codex's name lives in the shared app-server's Thread.name — there is no file to find. With
    // no server listening the honest answer is null; what matters is that it did not fall through
    // to claude's resolver, which SCANS ~/.claude/projects on a cache miss (once a minute, per
    // node, for a guaranteed miss) and can hand back a stranger's session name via its cwd leg.
    process.env.CODEX_HOME = path.join(root, 'no-such-codex-home')
    expect(await readAgentSessionName('thread-1', undefined, 'codex')).toBeNull()
    expect(await readAgentSessionName('thread-1', 'acct-2', 'codex')).toBeNull()
    delete process.env.CODEX_HOME
  })

  it('answers null for an empty session id without asking either reader', async () => {
    expect(await readAgentSessionName('', undefined, 'grok')).toBeNull()
    expect(await readAgentSessionName('')).toBeNull()
  })

  // The gemini leg. Neither reader may ever search the other's tree: claude's resolver SCANS
  // ~/.claude/projects on a cache miss, so an unrouted gemini node would pay that scan on every
  // poll (4s per node, then 15s) for a guaranteed null.
  it("routes a gemini session to its own transcript, via the tail's path", async () => {
    const p = path.join(root, 'session-gem.jsonl')
    // The shape the fixture measures: the name is the `update_topic` tool call's `args.title`.
    writeFileSync(
      p,
      JSON.stringify({
        id: 'm1',
        type: 'gemini',
        toolCalls: [{ id: 'update_topic__a', name: 'update_topic', args: { title: 'Verifying Test Environment' } }]
      }) + '\n'
    )
    const asked: string[] = []
    const name = await readAgentSessionName('gem1', undefined, 'gemini', {
      geminiPathFor: (id) => (asked.push(id), id === 'gem1' ? p : undefined)
    })
    expect(name).toBe('Verifying Test Environment')
    expect(asked).toEqual(['gem1'])
  })

  it('answers null for a gemini session no hook has been seen for', async () => {
    // `pathFor` is fed only by hook POSTs. No path = nothing to read, and null is the honest
    // answer — never a fall-through to claude's reader, which would scan for a foreign id.
    expect(
      await readAgentSessionName('gem-unknown', undefined, 'gemini', { geminiPathFor: () => undefined })
    ).toBeNull()
    // No deps at all (the Server Edition before its tail exists, or any pre-gemini caller).
    expect(await readAgentSessionName('gem-unknown', undefined, 'gemini')).toBeNull()
  })

  it('answers null when the gemini transcript cannot be read, without throwing', async () => {
    expect(
      await readAgentSessionName('gem2', undefined, 'gemini', {
        geminiPathFor: () => path.join(root, 'does-not-exist.jsonl')
      })
    ).toBeNull()
  })

  it("never asks gemini's path resolver for another agent's session", async () => {
    const asked: string[] = []
    const geminiPathFor = (id: string): undefined => {
      asked.push(id)
      return undefined
    }
    await readAgentSessionName('shared-id', undefined, 'claude', { geminiPathFor })
    await readAgentSessionName('shared-id', undefined, 'grok', { geminiPathFor })
    await readAgentSessionName('shared-id', undefined, undefined, { geminiPathFor })
    expect(asked).toEqual([])
  })
})

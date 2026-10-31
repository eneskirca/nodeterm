// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeClaude, normalizeCopilot } from '@shared/agents/normalize'

const KEY = 'nodeterm.nodePrompts'

/** The store hydrates at import, so each case imports a fresh copy after seeding storage. */
async function freshModule() {
  vi.resetModules()
  return import('./nodePrompts')
}
async function freshStore() {
  return (await freshModule()).useNodePrompts
}

const texts = (store: Awaited<ReturnType<typeof freshStore>>, nodeId: string): string[] =>
  (store.getState().byId[nodeId] ?? []).map((p) => p.text)

describe('useNodePrompts', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('records what was typed and persists it', async () => {
    const store = await freshStore()
    store.getState().record('n1', 'fix the login bug')
    store.getState().record('n1', 'now add a test')
    expect(texts(store, 'n1')).toEqual(['fix the login bug', 'now add a test'])
    const saved = JSON.parse(localStorage.getItem(KEY) as string)
    expect(saved.n1.map((p: { text: string }) => p.text)).toEqual(['fix the login bug', 'now add a test'])
  })

  it('survives a reload', async () => {
    const first = await freshStore()
    first.getState().record('n1', 'build the exporter')
    const second = await freshStore()
    expect(texts(second, 'n1')).toEqual(['build the exporter'])
  })

  it('ignores prompts the person did not write', async () => {
    const store = await freshStore()
    store.getState().record('n1', '<task-notification>done</task-notification>')
    store.getState().record('n1', '/rename Something')
    store.getState().record('n1', undefined)
    expect(store.getState().byId.n1).toBeUndefined()
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('does not rewrite storage for a consecutive duplicate', async () => {
    const store = await freshStore()
    store.getState().record('n1', 'check the deploy')
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    store.getState().record('n1', 'check the deploy')
    expect(setItem).not.toHaveBeenCalled()
  })

  it('removes one entry and leaves the others', async () => {
    const store = await freshStore()
    store.getState().record('n1', 'build the exporter')
    store.getState().record('n1', 'proceed')
    const proceed = store.getState().byId.n1.find((p) => p.text === 'proceed')
    store.getState().remove('n1', proceed!.id)
    expect(texts(store, 'n1')).toEqual(['build the exporter'])
  })

  it('drops the node entirely when its last entry is removed', async () => {
    const store = await freshStore()
    store.getState().record('n1', 'proceed')
    store.getState().remove('n1', store.getState().byId.n1[0].id)
    expect(store.getState().byId.n1).toBeUndefined()
    expect(JSON.parse(localStorage.getItem(KEY) as string)).toEqual({})
  })

  it('keeps nodes separate and drops one node on delete', async () => {
    const store = await freshStore()
    store.getState().record('n1', 'one')
    store.getState().record('n2', 'two')
    store.getState().drop('n1')
    expect(texts(store, 'n1')).toEqual([])
    expect(texts(store, 'n2')).toEqual(['two'])
  })

  it('removing from an unknown node or id is a no-op', async () => {
    const store = await freshStore()
    store.getState().record('n1', 'one')
    const before = store.getState().byId
    store.getState().remove('nope', 'x')
    store.getState().remove('n1', 'x')
    store.getState().drop('nope')
    expect(store.getState().byId).toBe(before)
  })

  it('starts empty, and says so, when the saved value is corrupt', async () => {
    localStorage.setItem(KEY, '{not json')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = await freshStore()
    expect(store.getState().byId).toEqual({})
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[prompts]'), expect.anything())
  })

  it('discards malformed entries but keeps the good ones', async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        n1: [{ id: 'a', text: 'good', at: 1 }, { id: 'b', text: '', at: 1 }, 'junk'],
        n2: 'not a list',
        n3: [{ id: 'c' }]
      })
    )
    const store = await freshStore()
    expect(Object.keys(store.getState().byId)).toEqual(['n1'])
    expect(texts(store, 'n1')).toEqual(['good'])
  })

  it('reports a failed save instead of swallowing it, and keeps the in-memory prompt', async () => {
    const store = await freshStore()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    store.getState().record('n1', 'still shown')
    expect(texts(store, 'n1')).toEqual(['still shown'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[prompts]'), expect.anything())
  })
})

describe('recordSubmittedPrompt — real hook payloads through the real normalizer', () => {
  beforeEach(() => localStorage.clear())

  it.each([
    ['claude', normalizeClaude],
    ['copilot', normalizeCopilot]
  ] as const)('remembers a typed %s prompt', async (agentId, normalize) => {
    const { recordSubmittedPrompt, useNodePrompts } = await freshModule()
    const e = normalize({
      nodeId: 'n1',
      agentId,
      payload: { hook_event_name: 'UserPromptSubmit', prompt: 'ship the exporter' }
    })!
    recordSubmittedPrompt(e)
    expect(useNodePrompts.getState().byId.n1.map((p) => p.text)).toEqual(['ship the exporter'])
  })

  it('ignores a queued subagent notification', async () => {
    const { recordSubmittedPrompt, useNodePrompts } = await freshModule()
    const e = normalizeClaude({
      nodeId: 'n1',
      agentId: 'claude',
      payload: { hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>done</task-notification>' }
    })!
    recordSubmittedPrompt(e)
    expect(useNodePrompts.getState().byId.n1).toBeUndefined()
  })

  it('ignores a tool event even when it carries a prompt field', async () => {
    const { recordSubmittedPrompt, useNodePrompts } = await freshModule()
    const e = normalizeClaude({
      nodeId: 'n1',
      agentId: 'claude',
      payload: { hook_event_name: 'PreToolUse', tool_name: 'Bash', prompt: 'ignored' }
    })!
    recordSubmittedPrompt(e)
    expect(useNodePrompts.getState().byId.n1).toBeUndefined()
  })

  it('ignores a turn start that carries no text (codex)', async () => {
    const { recordSubmittedPrompt, useNodePrompts } = await freshModule()
    recordSubmittedPrompt({ nodeId: 'n1', newTurn: true })
    expect(useNodePrompts.getState().byId.n1).toBeUndefined()
  })
})

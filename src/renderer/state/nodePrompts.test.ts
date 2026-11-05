// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeClaude, normalizeCodex, normalizeCopilot, normalizeGemini } from '@shared/agents/normalize'
import { NODE_PROMPT_STORE_MAX_BYTES } from '@shared/node-prompts'

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

  describe('two windows on one origin', () => {
    it("applies a mutation to what is SAVED, so another window's prompts survive", async () => {
      const store = await freshStore()
      store.getState().record('n1', 'mine')
      // The other window saved a prompt for n2 after this store hydrated.
      const saved = JSON.parse(localStorage.getItem(KEY) as string)
      saved.n2 = [{ id: 'theirs', text: 'theirs', at: 1 }]
      localStorage.setItem(KEY, JSON.stringify(saved))

      store.getState().record('n1', 'mine too')
      const after = JSON.parse(localStorage.getItem(KEY) as string)
      expect(after.n2.map((p: { text: string }) => p.text)).toEqual(['theirs'])
      expect(texts(store, 'n1')).toEqual(['mine', 'mine too'])
      expect(texts(store, 'n2')).toEqual(['theirs'])
    })

    it("adopts another window's write through the storage event", async () => {
      const store = await freshStore()
      store.getState().record('n1', 'mine')
      const theirs = JSON.stringify({ n1: [{ id: 'x', text: 'rewritten elsewhere', at: 1 }] })
      localStorage.setItem(KEY, theirs)
      window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: theirs }))
      expect(texts(store, 'n1')).toEqual(['rewritten elsewhere'])
    })

    it('ignores storage events for other keys', async () => {
      const store = await freshStore()
      store.getState().record('n1', 'mine')
      window.dispatchEvent(new StorageEvent('storage', { key: 'nodeterm.other', newValue: '{}' }))
      expect(texts(store, 'n1')).toEqual(['mine'])
    })

    it('falls back to its own copy when storage cannot be read', async () => {
      const store = await freshStore()
      store.getState().record('n1', 'one')
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('blocked')
      })
      store.getState().record('n1', 'two')
      expect(texts(store, 'n1')).toEqual(['one', 'two'])
    })
  })

  describe('bounds', () => {
    it('keeps the whole key under the byte budget by dropping the oldest prompts across nodes', async () => {
      // An over-budget map as an older build (or a long life) could have left it: 12 nodes × 40
      // verbatim 2 KB prompts ≈ 1.9 MB. The next write must bring it under budget, oldest first.
      const big = 'y'.repeat(1900)
      const seeded: Record<string, { id: string; text: string; full: string; at: number }[]> = {}
      let at = 1
      for (let n = 0; n < 12; n++) {
        seeded[`n${n}`] = []
        for (let i = 0; i < 40; i++) {
          const full = `${big} ${n}-${i}`
          seeded[`n${n}`].push({ id: `${n}-${i}`, text: `${full.slice(0, 399)}…`, full, at: at++ })
        }
      }
      localStorage.setItem(KEY, JSON.stringify(seeded))
      expect(localStorage.getItem(KEY)!.length * 2).toBeGreaterThan(NODE_PROMPT_STORE_MAX_BYTES)

      const store = await freshStore()
      store.getState().record('n11', 'the newest of all', at)
      const raw = localStorage.getItem(KEY) as string
      expect(raw.length * 2).toBeLessThanOrEqual(NODE_PROMPT_STORE_MAX_BYTES)
      // The newest survive; the oldest node is what went.
      expect(texts(store, 'n11').at(-1)).toBe('the newest of all')
      expect(store.getState().byId.n11.at(-2)?.full).toBe(`${big} 11-39`)
      expect(store.getState().byId.n0).toBeUndefined()
      expect(store.getState().byId).toEqual(JSON.parse(raw))
    })

    it('retries a full store once with half the budget, then reports', async () => {
      const store = await freshStore()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const real = Storage.prototype.setItem
      let calls = 0
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k, v) {
        calls++
        if (calls === 1) throw new DOMException('full', 'QuotaExceededError')
        real.call(this, k, v)
      })
      store.getState().record('n1', 'kept')
      expect(calls).toBe(2)
      expect(texts(store, 'n1')).toEqual(['kept'])
      expect(JSON.parse(localStorage.getItem(KEY) as string).n1).toHaveLength(1)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('storage was full'), expect.anything())
    })

    it('prunes nodes that are in no project, and refuses when the caller cannot say', async () => {
      const store = await freshStore()
      store.getState().record('live', 'a')
      store.getState().record('gone', 'b')
      store.getState().prune(null)
      expect(Object.keys(store.getState().byId).sort()).toEqual(['gone', 'live'])
      store.getState().prune(new Set(['live', 'other']))
      expect(Object.keys(store.getState().byId)).toEqual(['live'])
      expect(Object.keys(JSON.parse(localStorage.getItem(KEY) as string))).toEqual(['live'])
    })
  })

  describe('expanded (transient)', () => {
    it('is per node, defaults to collapsed, and is never saved', async () => {
      const store = await freshStore()
      store.getState().record('n1', 'a')
      expect(store.getState().expanded.n1).toBeUndefined()
      store.getState().setExpanded('n1', true)
      expect(store.getState().expanded).toEqual({ n1: true })
      store.getState().setExpanded('n1', false)
      expect(store.getState().expanded).toEqual({})
      expect(localStorage.getItem(KEY)).not.toContain('expanded')
    })
  })
})

describe('recordSubmittedPrompt — real hook payloads through the real normalizer', () => {
  beforeEach(() => localStorage.clear())

  it.each([
    ['claude', normalizeClaude, 'UserPromptSubmit'],
    ['copilot', normalizeCopilot, 'UserPromptSubmit'],
    ['codex', normalizeCodex, 'UserPromptSubmit'],
    ['gemini', normalizeGemini, 'BeforeAgent']
  ] as const)('remembers a typed %s prompt', async (agentId, normalize, event) => {
    const { recordSubmittedPrompt, useNodePrompts } = await freshModule()
    const e = normalize({
      nodeId: 'n1',
      agentId,
      payload: { hook_event_name: event, session_id: 's1', prompt: 'ship the exporter' }
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

  it('ignores a turn start that carries no text', async () => {
    const { recordSubmittedPrompt, useNodePrompts } = await freshModule()
    recordSubmittedPrompt({ nodeId: 'n1', newTurn: true })
    expect(useNodePrompts.getState().byId.n1).toBeUndefined()
  })
})

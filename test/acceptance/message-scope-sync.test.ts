import { describe, expect, it, vi } from 'vitest'
import { resolveDeliveryScope } from '../../src/core/agents/agent-message-scope'
import { syncMessageScope } from '../../src/renderer/lib/messageScopeSync'
import fs from 'fs'
import path from 'path'

describe('publishing the canvas before message scope resolution', () => {
  it('wires the barrier before delivery inside the renderer target lock', () => {
    const source = fs.readFileSync(path.resolve('src/renderer/canvas/Canvas.tsx'), 'utf8').replace(/\r\n/g, '\n')
    const start = source.indexOf("if (verb === 'send' || verb === 'reply' || verb === 'notify')")
    const end = source.indexOf('// ── `open-project`', start)
    const block = source.slice(start, end)
    expect(block.indexOf('guardConcurrentRestart(targetId')).toBeLessThan(block.indexOf('await syncMessageScope('))
    expect(block.indexOf('await syncMessageScope(')).toBeLessThan(block.indexOf('await api.agentMessage.deliver('))
    expect(block).toContain('conflict: !!conflictRef.current')
    expect(block).toContain('save: persist')
    expect(block).toContain('if (!scopeSync.ok)')
  })
  it('waits for the core store to see a newly opened node, independent of its cwd', async () => {
    const coordinator = { id: 'coordinator', cwd: 'C:/repo' }
    const architect = { id: 'architect', cwd: 'C:/repo/.opencode/launch/arquiteto' }
    const coder = { id: 'coder', cwd: 'C:/repo/.opencode/launch/coder' }
    const persisted = [{ id: 'project', nodes: [coordinator] }]
    expect(resolveDeliveryScope(persisted, coordinator.id, architect.id).kind).toBe('refused')
    let finish!: () => void
    const saving = syncMessageScope({
      needed: true,
      conflict: false,
      save: () => new Promise<boolean>((resolve) => {
        finish = () => {
          persisted[0].nodes = [coordinator, architect, coder]
          resolve(true)
        }
      })
    })
    let finished = false
    void saving.then(() => { finished = true })
    await Promise.resolve()
    expect(finished).toBe(false)
    finish()
    expect(await saving).toEqual({ ok: true })
    for (const target of [architect, coder]) {
      expect(resolveDeliveryScope(persisted, coordinator.id, target.id)).toEqual({
        kind: 'same-project', projectId: 'project'
      })
    }
    // Publishing a snapshot does not relax either boundary.
    expect(resolveDeliveryScope([...persisted, { id: 'other', nodes: [{ id: 'foreign', cwd: '' }] }],
      coordinator.id, 'foreign')).toMatchObject({ kind: 'refused', reason: 'cross-project' })
    expect(resolveDeliveryScope([...persisted, { id: 'clone', nodes: [architect] }],
      coordinator.id, architect.id)).toMatchObject({ kind: 'refused', reason: 'ambiguous-target-node-id' })
  })

  it('does not save an unrelated active canvas', async () => {
    const save = vi.fn()
    expect(await syncMessageScope({ needed: false, conflict: true, save })).toEqual({ ok: true })
    expect(save).not.toHaveBeenCalled()
  })

  it('does not overwrite an external conflict', async () => {
    const save = vi.fn()
    expect(await syncMessageScope({ needed: true, conflict: true, save })).toMatchObject({ ok: false })
    expect(save).not.toHaveBeenCalled()
  })

  it.each(['refused', 'rejected'] as const)('refuses forwarding after a %s save', async (failure) => {
    const save = failure === 'refused' ? async () => false : async () => { throw new Error('unavailable') }
    expect(await syncMessageScope({ needed: true, conflict: false, save })).toMatchObject({ ok: false })
  })
})

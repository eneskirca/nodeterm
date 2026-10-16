import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  autosaveDelay,
  nextSaveDelivery,
  saveFailureMessage,
  saveRetryDelay,
  shouldFlushOnQuit,
  SAVE_DEBOUNCE_MS,
  SAVE_RETRY_ATTEMPTS,
  type SaveDelivery
} from './savePersistence'
import { decideExternalChange } from './externalChange'
import type { CanvasNodeState, Project } from '@shared/types'

const node = (id: string): CanvasNodeState =>
  ({ id, kind: 'terminal', position: { x: 0, y: 0 }, data: {} }) as unknown as CanvasNodeState

const project = (nodes: CanvasNodeState[]): Project =>
  ({ id: 'p1', name: 'p', color: '#fff', nodes }) as unknown as Project

describe('autosaveDelay — the one rule the debounce effect asks', () => {
  it('does not arm with nothing to save', () => {
    expect(autosaveDelay(false, false, undefined)).toBeNull()
  })

  it('does not arm while a conflict bar owes the user a decision', () => {
    // Unchanged from before the fix: firing here would silently "keep mine".
    expect(autosaveDelay(true, true, undefined)).toBeNull()
  })

  it('arms at the ordinary debounce when nothing has failed', () => {
    expect(autosaveDelay(true, false, undefined)).toBe(SAVE_DEBOUNCE_MS)
  })

  it('RE-ARMS after a refused save, at the backoff delay', () => {
    // The regression this whole module exists for. Before the fix a refusal left `dirty` true with
    // no dep change anywhere, so the timer was never scheduled again and the canvas stopped being
    // written for the life of the tab, silently.
    const first = nextSaveDelivery(undefined, 1)
    expect(first).toEqual({ kind: 'retrying', attempts: 1, at: 1 })
    expect(autosaveDelay(true, false, first)).toBe(saveRetryDelay(1))
    expect(autosaveDelay(true, false, first)).toBeGreaterThan(0)
  })

  it('stops arming once the bounded schedule is spent', () => {
    // Bounded on purpose: a whole-canvas last-writer-wins write must not be retried forever at a
    // destination we already know refuses it. The strip's Retry button is the way back.
    let d: SaveDelivery | undefined
    for (let i = 0; i < SAVE_RETRY_ATTEMPTS; i++) d = nextSaveDelivery(d, i)
    expect(d).toMatchObject({ kind: 'retrying', attempts: SAVE_RETRY_ATTEMPTS })
    const spent = nextSaveDelivery(d, 99)
    expect(spent).toEqual({ kind: 'failed', attempts: SAVE_RETRY_ATTEMPTS + 1, at: 99 })
    expect(autosaveDelay(true, false, spent)).toBeNull()
  })

  it('a cleared delivery (the Retry button) brings the ordinary debounce back', () => {
    expect(autosaveDelay(true, false, undefined)).toBe(SAVE_DEBOUNCE_MS)
  })
})

describe('the failure is stated, not swallowed', () => {
  it('says nothing while there is nothing to report', () => {
    expect(saveFailureMessage(undefined)).toBeNull()
  })

  it('names the consequence and what still holds, in both states', () => {
    const retrying = saveFailureMessage({ kind: 'retrying', attempts: 1, at: 0 })!
    expect(retrying).toContain('not being saved')
    expect(retrying).toContain('Retrying')
    // A card is not its tmux session, and telling the user their terminals died would be a lie.
    expect(retrying).toContain('terminals keep running')
    const failed = saveFailureMessage({ kind: 'failed', attempts: 6, at: 0 })!
    expect(failed).toContain('nothing will retry')
    expect(failed).not.toContain('Retrying.')
  })
})

describe('the trigger: an external change that REMOVES a node freezes the save', () => {
  // This is the 2026-09-02 shape reduced to its two seams. The server published a project whose
  // node list had shrunk (a reap, a git pull, another machine); the renderer was mid-edit.
  const before = project([node('a'), node('b')])
  const after = project([node('a')])

  it('classifies a removal as a conflict while dirty', () => {
    const decision = decideExternalChange({
      dirty: true,
      base: before,
      incoming: after,
      liveNodeIds: ['a', 'b']
    })
    expect(decision.kind).toBe('conflict')
  })

  it('and a conflict is what stops the autosave arming', () => {
    // The two halves joined: conflict ⇒ no timer ⇒ nothing is written until the user answers the
    // bar. Correct as a policy; catastrophic as a SILENT one, which is why the bar now says so.
    expect(autosaveDelay(true, true, undefined)).toBeNull()
  })
})

describe('the call site still honours the rule', () => {
  // Canvas is a monolith with no render harness (see canvas-wiring.test.tsx), so the wiring is
  // pinned by reading it. A source read is weak in general and the only thing standing between a
  // one-character deletion and a silently reintroduced two-and-a-half-hour data freeze here.
  // Normalized: the assertions below slice on '\n' literals and a Windows checkout hands us
  // '\r\n' (issue #578 — line-endings.guard.test.ts enforces this).
  const SRC = fs
    .readFileSync(path.join(__dirname, '..', 'canvas', 'Canvas.tsx'), 'utf8')
    .replace(/\r\n/g, '\n')

  it('drives the debounce through autosaveDelay, not an inline condition', () => {
    expect(SRC).toContain('const delay = autosaveDelay(dirty, !!conflict, saveDelivery)')
    expect(SRC).not.toContain('if (!dirty || conflict) return')
  })

  it('keeps saveDelivery in the effect deps, or a refusal never re-arms', () => {
    expect(SRC).toContain('}, [dirty, conflict, persist, resaveTick, saveDelivery])')
  })

  it('catches the save rejection instead of letting `void` eat it', () => {
    expect(SRC).toContain('setSaveDelivery((prev) => nextSaveDelivery(prev, Date.now()))')
    expect(SRC).toContain('[canvas] workspace save failed')
  })

  it('clears the delivery only on a save that actually landed', () => {
    // `setSaveDelivery(undefined)` must sit AFTER the await's catch, never before it: clearing it
    // first would hide the very failure the strip exists to show.
    const catchAt = SRC.indexOf('[canvas] workspace save failed')
    const clearAt = SRC.indexOf('setSaveDelivery(undefined)\n    if (canClearDirty')
    expect(catchAt).toBeGreaterThan(0)
    expect(clearAt).toBeGreaterThan(catchAt)
  })

  it('renders the strip', () => {
    expect(SRC).toContain('<SaveFailureBar')
  })

  it('leaves no bare `void api.workspace.save(` anywhere', () => {
    // That spelling IS the bug: it discards the rejection AND the exception. Every save must
    // either be awaited by a caller that reports, or carry its own .catch.
    expect(SRC).not.toContain('void api.workspace.save(')
  })
})

describe('shouldFlushOnQuit', () => {
  it('writes only dirty edits, and never over an open conflict bar', () => {
    expect(shouldFlushOnQuit(true, false)).toBe(true)
    expect(shouldFlushOnQuit(false, false)).toBe(false)
    expect(shouldFlushOnQuit(true, true)).toBe(false)
    expect(shouldFlushOnQuit(false, true)).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import {
  BOARD_DISPATCH_DEFAULT_CONCURRENT,
  BOARD_DISPATCH_MAX_CONCURRENT,
  dispatchBinding,
  clampConcurrent,
  pruneBoardDispatch,
  sanitizeBoardDispatch
} from './board-dispatch'

describe('sanitizeBoardDispatch (settings.json is hand-editable)', () => {
  it('absent or garbage is off everywhere, not paused', () => {
    for (const raw of [undefined, null, 5, 'x', [], { projects: [] }, { projects: 'x' }]) {
      expect(sanitizeBoardDispatch(raw)).toEqual({ paused: false, projects: {} })
    }
  })

  it('keeps a well-formed entry', () => {
    const out = sanitizeBoardDispatch({
      paused: false,
      projects: { p1: { columnId: 'col-a', agentId: 'claude', accountId: 'acc1', maxConcurrent: 3, binding: 'b' } }
    })
    expect(out.projects.p1).toEqual({ columnId: 'col-a', agentId: 'claude', accountId: 'acc1', maxConcurrent: 3, binding: 'b' })
  })

  it('drops an entry with no column, an unsafe agent id or no consent binding — it is OFF, never guessed', () => {
    const out = sanitizeBoardDispatch({
      projects: {
        a: { agentId: 'claude', maxConcurrent: 1, binding: 'b' },
        b: { columnId: 'c', agentId: 'claude; rm -rf ~', binding: 'b' },
        c: { columnId: 'c', agentId: 42, binding: 'b' },
        d: { columnId: 'c', agentId: 'custom:3f2a', binding: 'b' },
        e: { columnId: 'c', agentId: 'claude' },
        f: { columnId: 'c', agentId: 'claude', binding: 7 }
      }
    })
    expect(Object.keys(out.projects)).toEqual(['d'])
  })

  it('drops an unsafe account id but keeps the entry (project default)', () => {
    const out = sanitizeBoardDispatch({ projects: { p: { columnId: 'c', agentId: 'codex', accountId: '../x', binding: 'b' } } })
    expect(out.projects.p).toEqual({ columnId: 'c', agentId: 'codex', maxConcurrent: 1, binding: 'b' })
  })

  it('clamps the cap DOWN on anything unreadable, and never above the max', () => {
    expect(clampConcurrent('9')).toBe(1)
    expect(clampConcurrent(NaN)).toBe(1)
    expect(clampConcurrent(0)).toBe(1)
    expect(clampConcurrent(-3)).toBe(1)
    expect(clampConcurrent(2.9)).toBe(2)
    expect(clampConcurrent(999)).toBe(BOARD_DISPATCH_MAX_CONCURRENT)
  })

  it('the kill switch is on only for a literal true', () => {
    expect(sanitizeBoardDispatch({ paused: true }).paused).toBe(true)
    expect(sanitizeBoardDispatch({ paused: 'true' }).paused).toBe(false)
    expect(sanitizeBoardDispatch({ paused: 1 }).paused).toBe(false)
  })
})

describe('pruneBoardDispatch', () => {
  it('drops projects this machine no longer has, keeps the switch', () => {
    const value = sanitizeBoardDispatch({
      paused: true,
      projects: { keep: { columnId: 'c', agentId: 'claude', binding: 'b' }, gone: { columnId: 'c', agentId: 'claude', binding: 'b' } }
    })
    const out = pruneBoardDispatch(value, new Set(['keep']))
    expect(out.paused).toBe(true)
    expect(Object.keys(out.projects)).toEqual(['keep'])
  })
})

describe('dispatchBinding / default cap', () => {
  it('binds repository (case-insensitive), column title and label; any unknown part is no binding', () => {
    expect(dispatchBinding('Acme/App', 'Agent', 'status:agent')).toBe(dispatchBinding('acme/app', 'Agent', 'status:agent'))
    expect(dispatchBinding('acme/app', 'Agent', 'status:agent')).not.toBe(dispatchBinding('acme/app', 'In Progress', 'status:agent'))
    expect(dispatchBinding(undefined, 'Agent', 'status:agent')).toBeUndefined()
    expect(dispatchBinding('acme/app', undefined, 'status:agent')).toBeUndefined()
    expect(dispatchBinding('acme/app', 'Agent', undefined)).toBeUndefined()
  })
  it('defaults to one run at a time: dispatched runs share one checkout', () => {
    expect(BOARD_DISPATCH_DEFAULT_CONCURRENT).toBe(1)
  })
})

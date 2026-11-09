import { describe, expect, it } from 'vitest'
import {
  ORPHAN_STATUS_GRACE_MS,
  countUnreadInProjects,
  liveNodeIds,
  orphanStatusIds,
  unreadIdSet,
  unreadIdsSig
} from './unreadBadge'
import { LAST_SEEN_MAX_AGE_MS } from '../state/agentStatus'

const DAY = 24 * 60 * 60_000
const NOW = 1_800_000_000_000

describe('countUnreadInProjects (the Dock / taskbar / tray count)', () => {
  it('counts only unread entries whose node a project holds — the field report: 20 unread, 1 live', () => {
    const byId: Record<string, { unread: boolean }> = { live: { unread: true }, read: { unread: false } }
    for (let i = 0; i < 19; i++) byId[`gone-${i}`] = { unread: true }
    const projects = [{ nodes: [{ id: 'live' }, { id: 'read' }] }, { nodes: [{ id: 'other' }] }]
    const unread = unreadIdSet(unreadIdsSig(byId))
    expect(unread.size).toBe(20)
    expect(countUnreadInProjects(projects, unread)).toBe(1)
  })

  it('counts a closed project too (its sessions still run), and a node held by two projects once', () => {
    const projects = [
      { nodes: [{ id: 'a' }] },
      { closed: true, nodes: [{ id: 'b' }, { id: 'a' }] }
    ]
    expect(countUnreadInProjects(projects, new Set(['a', 'b']))).toBe(2)
  })

  it('is 0 with no projects loaded', () => {
    expect(countUnreadInProjects([], new Set(['a']))).toBe(0)
  })
})

describe('liveNodeIds (the completeness guard every boot sweep shares)', () => {
  it('collects every node of every project, closed ones included', () => {
    const live = liveNodeIds([{ nodes: [{ id: 'a' }] }, { nodes: [{ id: 'b' }, { id: 'c' }] }])
    expect([...live!].sort()).toEqual(['a', 'b', 'c'])
  })

  it('answers null — judge nothing — for no projects or an unreadable one', () => {
    expect(liveNodeIds([])).toBeNull()
    expect(liveNodeIds([{ nodes: [{ id: 'a' }] }, { unavailable: true, nodes: [] }])).toBeNull()
  })
})

describe('orphanStatusIds (the boot sweep)', () => {
  const projects = [{ nodes: [{ id: 'live' }] }]

  it('drops an entry whose node is in no project, with no clock or an old one', () => {
    const byId = {
      live: { unread: true },
      noClock: { unread: true },
      old: { lastSeen: { at: NOW - ORPHAN_STATUS_GRACE_MS - 1 } }
    }
    expect(orphanStatusIds(byId, projects, NOW).sort()).toEqual(['noClock', 'old'])
  })

  it('keeps a recently-seen orphan (an SSH cache that lags, a canvas a checkout may restore)', () => {
    const byId = { recent: { unread: true, lastSeen: { at: NOW - 2 * DAY } } }
    expect(orphanStatusIds(byId, projects, NOW)).toEqual([])
  })

  it('keeps an orphan for weeks, not days — a folder re-opened after an index rebuild keeps its node ids', () => {
    const byId = { weeks: { unread: true, lastSeen: { at: NOW - 30 * DAY } } }
    expect(orphanStatusIds(byId, projects, NOW)).toEqual([])
  })

  it('drops an orphan exactly when its clock would age out on load, never earlier', () => {
    expect(ORPHAN_STATUS_GRACE_MS).toBe(LAST_SEEN_MAX_AGE_MS)
  })

  it('judges nothing when the load is incomplete: no projects, or an unreadable one', () => {
    const byId = { x: { unread: true } }
    expect(orphanStatusIds(byId, [], NOW)).toEqual([])
    expect(orphanStatusIds(byId, [...projects, { unavailable: true, nodes: [] }], NOW)).toEqual([])
  })
})

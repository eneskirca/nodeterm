import { describe, it, expect, vi } from 'vitest'
import type { RelayClosedReason } from '@shared/types'
import { JOIN_CODE_PREFIX } from '@shared/relay-join-code'
import { createHostedJoiner, type HostedJoinerDeps, type HostedMountOutcome, type HostedNotice } from './hostedJoin'
import type { HostedAttemptRequest } from './hostedAttempts'
import { RelayApprovalError, THROTTLED_NOTICE } from './hostedTeam'
import { WAITING_NOTICE_DELAY_MS } from './hostedJoin'

const wrap = (m: string) => new Error(`Error invoking remote method 'relay:client:connect': Error: ${m}`)
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}
const codeFor = (hostId: string, label = 'box') => JOIN_CODE_PREFIX + Buffer.from(JSON.stringify({ v: 1, hostId, label })).toString('base64url')

type Bookmark = { hostId: string; label: string; approved: boolean; code: string }

function harness(bookmarks: Bookmark[] = []) {
  const connects: Array<{ code: string; resolve: (id: string) => void; reject: (e: Error) => void }> = []
  const mounts: Array<{ id: string; req: HostedAttemptRequest; resolve: (o: HostedMountOutcome) => void; hooks: { sasConfirmed(): void } }> = []
  const sasCbs = new Map<string, () => void>()
  const closeCbs = new Map<string, (reason?: RelayClosedReason) => void>()
  const notices: HostedNotice[] = []
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
  const open = new Set<string>()
  const approvedCbs = new Map<string, () => void>()
  const cleared: string[] = []
  let list = [...bookmarks]
  const deps: HostedJoinerDeps = {
    onApproved: (id, cb) => {
      approvedCbs.set(id, cb)
      return () => approvedCbs.delete(id)
    },
    clearNotice: (text) => cleared.push(text),
    connect: (code) => new Promise((resolve, reject) => connects.push({ code, resolve, reject })),
    onClosed: (id, cb) => {
      closeCbs.set(id, cb)
      return () => closeCbs.delete(id)
    },
    disconnect: vi.fn(),
    bookmarks: vi.fn(async () => list),
    removeBookmark: vi.fn(async (hostId: string) => {
      list = list.filter((b) => b.hostId !== hostId)
    }),
    mount: (id, req, hooks) => new Promise((resolve) => mounts.push({ id, req, resolve, hooks })),
    onSas: (id, cb) => {
      sasCbs.set(id, cb)
      return () => sasCbs.delete(id)
    },
    tabOpen: (projectId) => open.has(projectId),
    notify: (n) => notices.push(n),
    promptForCode: vi.fn(async () => null as string | null),
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false }
      timers.push(t)
      return t
    },
    clearTimer: (t) => {
      ;(t as { cleared: boolean }).cleared = true
    }
  }
  return { deps, connects, mounts, closeCbs, notices, timers, open, approvedCbs, cleared, sasCbs, setList: (l: Bookmark[]) => { list = l } }
}

/** Connect + mount one attempt to a live tab. */
async function goLive(h: ReturnType<typeof harness>, i: number, projectId: string) {
  h.connects[i].resolve(`c${i}`)
  await flush()
  h.open.add(projectId)
  h.mounts[h.mounts.length - 1].resolve({ projectId })
  await flush()
}

describe('hosted joiner', () => {
  it('boot reconnects only APPROVED bookmarks, each as an unattended, retrying, background attempt', async () => {
    const h = harness([
      { hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') },
      { hostId: 'H2', label: 'lab', approved: false, code: codeFor('H2') }
    ])
    const j = createHostedJoiner(h.deps)
    await j.bootReconnect()
    expect(h.connects.map((c) => c.code)).toEqual([codeFor('H1')])
    await goLive(h, 0, 'proj-1')
    expect(h.mounts[0].req).toMatchObject({ hostId: 'H1', label: 'box', manual: false, retry: true })
  })

  it('a pasted code runs NOW, does not loop, and a second paste for the same team is refused politely', async () => {
    const h = harness()
    const j = createHostedJoiner(h.deps)
    j.joinWithCode(`  ${codeFor('H1', 'box')} `)
    expect(h.connects).toHaveLength(1)
    j.joinWithCode(codeFor('H1', 'box'))
    expect(h.connects).toHaveLength(1)
    expect(h.notices.at(-1)).toMatchObject({ kind: 'info', text: 'Already connecting to box…' })
    await goLive(h, 0, 'proj-1')
    expect(h.mounts[0].req).toMatchObject({ manual: true, retry: false })
    j.joinWithCode(codeFor('H1', 'box'))
    expect(h.notices.at(-1)).toMatchObject({ kind: 'info', text: "You're already connected to box." })
    expect(h.connects).toHaveLength(1)
  })

  it('R46: a code pasted into a Team Access tab\'s reconnect prompt never rebinds that tab — refused, and said where it goes', async () => {
    // A greyed tab this joiner never opened is a Team Access tab (a hosted tab reconnects from its
    // bookmark and never reaches the pairing prompt). Rebinding it would mount the team inside it,
    // under its name, with no cross-team check (there is no team to check against).
    const h = harness()
    h.open.add('proj-7') // the Team Access tab the prompt was raised on
    const j = createHostedJoiner(h.deps)
    const refused = {
      kind: 'error',
      text: 'That is a hosted team invite code — paste it with New Remote Connection to open the team in its own tab.'
    }
    j.joinWithCode(codeFor('H1'), 'proj-7')
    expect(h.connects).toHaveLength(0)
    expect(h.notices.at(-1)).toMatchObject(refused)
    // An unreadable code is refused there too: whatever main made of it, it would land in that tab.
    j.joinWithCode(`${JOIN_CODE_PREFIX}%%%`, 'proj-7')
    expect(h.connects).toHaveLength(0)
    expect(h.notices.at(-1)).toMatchObject(refused)
    // The same code from New Remote Connection opens the team in its own tab.
    j.joinWithCode(codeFor('H1'))
    h.connects[0].resolve('c0')
    await flush()
    expect(h.mounts[0].req).toMatchObject({ hostId: 'H1', manual: true, retry: false })
    expect(h.mounts[0].req.reconnectProjectId).toBeUndefined()
  })

  it('a pasted code the renderer cannot read is still handed to main, which answers for it', async () => {
    const h = harness()
    const j = createHostedJoiner(h.deps)
    j.joinWithCode(`${JOIN_CODE_PREFIX}%%%`)
    h.connects[0].reject(wrap('[E_JOIN_BAD_CODE] That team code is invalid.'))
    await flush()
    expect(h.notices.at(-1)).toMatchObject({ kind: 'error', text: 'The invite code for the team is not valid. Ask an owner for a fresh code.' })
  })

  it('a dropped tab reconnects in place, in the background, while its team is still bookmarked and approved', async () => {
    const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
    const j = createHostedJoiner(h.deps)
    await j.bootReconnect()
    await goLive(h, 0, 'proj-1')
    h.closeCbs.get('c0')!(undefined)
    await flush()
    // R41: never at once — the first rung (1 s) first, so a host that approves and drops cannot spin.
    expect(h.connects).toHaveLength(1)
    expect(h.timers.filter((t) => !t.cleared && t.ms !== WAITING_NOTICE_DELAY_MS).map((t) => t.ms)).toEqual([1000])
    fireRetry(h)
    expect(h.connects).toHaveLength(2)
    await goLive(h, 1, 'proj-1')
    expect(h.mounts[1].req).toMatchObject({ reconnectProjectId: 'proj-1', manual: false, retry: true })
    expect(h.notices).toEqual([])
  })

  it('a drop does NOT reconnect a tab the user closed, a team they forgot, or one no longer approved', async () => {
    for (const setup of ['closed', 'forgotten', 'unapproved'] as const) {
      const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
      const j = createHostedJoiner(h.deps)
      await j.bootReconnect()
      await goLive(h, 0, 'proj-1')
      if (setup === 'closed') h.open.delete('proj-1')
      if (setup === 'forgotten') h.setList([])
      if (setup === 'unapproved') h.setList([{ hostId: 'H1', label: 'box', approved: false, code: codeFor('H1') }])
      h.closeCbs.get('c0')!(undefined)
      await flush()
      expect(h.connects, setup).toHaveLength(1)
    }
  })

  it('the user closing the tab (our own disconnect) ends the connection and never reconnects', async () => {
    // Canvas disposes the tab's session (which announces the close synchronously) and marks the
    // project closed right after, in the same tick: the reconnect decision must see the latter.
    const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
    const j = createHostedJoiner(h.deps)
    await j.bootReconnect()
    await goLive(h, 0, 'proj-1')
    h.closeCbs.get('c0')!(undefined)
    h.open.delete('proj-1')
    await flush()
    expect(h.connects).toHaveLength(1)
    // …and the team is free again: a later paste of its code connects instead of "already connected".
    j.joinWithCode(codeFor('H1'))
    expect(h.connects).toHaveLength(2)
  })

  it('a close the host explained is told once and never reconnects', async () => {
    const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
    const j = createHostedJoiner(h.deps)
    await j.bootReconnect()
    await goLive(h, 0, 'proj-1')
    h.closeCbs.get('c0')!('removed')
    await flush()
    expect(h.connects).toHaveLength(1)
    expect(h.notices).toEqual([{ kind: 'error', text: 'box: Your access to this team was removed by an owner.' }])
  })

  it('clicking a greyed hosted tab reconnects it in place now; a tab it never opened is not its business', async () => {
    const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
    const j = createHostedJoiner(h.deps)
    expect(j.reconnectTab('proj-1')).toBe(false)
    await j.bootReconnect()
    await goLive(h, 0, 'proj-1')
    h.setList([]) // forgotten: the automatic reconnect stays off…
    h.closeCbs.get('c0')!(undefined)
    await flush()
    expect(j.isHostedTab('proj-1')).toBe(true)
    expect(j.reconnectTab('proj-1')).toBe(true) // …but the user asked
    expect(h.connects).toHaveLength(2)
    h.connects[1].resolve('c1')
    await flush()
    expect(h.mounts[1].req).toMatchObject({ reconnectProjectId: 'proj-1', manual: true, retry: true })
  })

  it('REVOKED stops and offers "remove and rejoin": forget the bookmark, ask for a fresh code, join with it', async () => {
    const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
    ;(h.deps.promptForCode as ReturnType<typeof vi.fn>).mockResolvedValue(codeFor('H9', 'box'))
    const j = createHostedJoiner(h.deps)
    await j.bootReconnect()
    h.connects[0].reject(wrap("[E_JOIN_REVOKED] This device's relay access was revoked."))
    await flush()
    const n = h.notices.at(-1)!
    expect(n.kind).toBe('error')
    expect(n.text).toMatch(/revoked/)
    expect(n.action?.label).toBe('Remove and rejoin')
    n.action!.run()
    await flush()
    expect(h.deps.removeBookmark).toHaveBeenCalledWith('H1')
    expect(h.deps.promptForCode).toHaveBeenCalledWith('box')
    expect(h.connects.at(-1)!.code).toBe(codeFor('H9', 'box'))
  })

  it('a stop is told in one sentence; BUSY is never told', async () => {
    const h = harness()
    const j = createHostedJoiner(h.deps)
    j.joinWithCode(codeFor('H1'))
    h.connects[0].reject(wrap('[E_JOIN_BUSY] Already joining this team.'))
    await flush()
    expect(h.notices).toEqual([])
    j.joinWithCode(codeFor('H1'))
    h.connects[1].reject(wrap('[E_JOIN_REFUSED] The hosted-team bookmarks file /u/relay-bookmarks.json cannot be read or safely rewritten; fix or remove it, then join again.'))
    await flush()
    expect(h.notices).toEqual([
      { kind: 'error', text: 'Could not join box: The hosted-team bookmarks file /u/relay-bookmarks.json cannot be read or safely rewritten; fix or remove it, then join again.' }
    ])
  })

  it('a tab that never opened: an unattended attempt retries silently; a pasted code is told why', async () => {
    const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
    const j = createHostedJoiner(h.deps)
    await j.bootReconnect()
    h.connects[0].resolve('c0')
    await flush()
    h.mounts[0].resolve({ error: new RelayApprovalError('The relay connection closed before it was approved.'), declined: false })
    await flush()
    expect(h.notices).toEqual([])
    expect(h.timers.filter((t) => !t.cleared)).toHaveLength(1)

    const p = harness()
    const jp = createHostedJoiner(p.deps)
    jp.joinWithCode(codeFor('H2', 'lab'))
    p.connects[0].resolve('c0')
    await flush()
    p.mounts[0].resolve({ error: new RelayApprovalError('An owner declined the request.', 'denied'), declined: false })
    await flush()
    expect(p.notices).toEqual([{ kind: 'error', text: 'Could not open lab: An owner declined the request.' }])
    // A SAS the user declined is their own answer: nothing to tell.
    jp.joinWithCode(codeFor('H2', 'lab'))
    p.connects[1].resolve('c1')
    await flush()
    p.mounts[1].resolve({ error: new Error('closed'), declined: true })
    await flush()
    expect(p.notices).toHaveLength(1)
  })

  it('forgetting a team stops its reconnect loop and removes the bookmark; it is refused while connecting', async () => {
    const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
    const j = createHostedJoiner(h.deps)
    await j.bootReconnect()
    await j.forget('H1', 'box')
    expect(h.deps.removeBookmark).not.toHaveBeenCalled()
    expect(h.notices.at(-1)).toMatchObject({ kind: 'info', text: 'Still connecting to box; forget it once that finishes.' })
    h.connects[0].reject(wrap('[E_JOIN_NETWORK] x'))
    await flush()
    expect(h.timers.filter((t) => !t.cleared)).toHaveLength(1) // backing off
    await j.forget('H1', 'box')
    expect(h.timers.filter((t) => !t.cleared)).toHaveLength(0) // the loop is gone
    expect(h.deps.removeBookmark).toHaveBeenCalledWith('H1')
    expect(h.notices.at(-1)).toMatchObject({ kind: 'info', text: 'Forgot box. This device will not reconnect to it.' })
  })

  it('main\'s refusal to forget (a join still in flight there) is shown in its own words', async () => {
    const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
    ;(h.deps.removeBookmark as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Error invoking remote method 'relay:hosted:bookmark-remove': Error: Still joining this team; forget it once that attempt finishes.")
    )
    const j = createHostedJoiner(h.deps)
    await j.forget('H1', 'box')
    expect(h.notices.at(-1)).toEqual({ kind: 'error', text: 'Could not forget box: Still joining this team; forget it once that attempt finishes.' })
  })

  it('dispose stops every loop', async () => {
    const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
    const j = createHostedJoiner(h.deps)
    await j.bootReconnect()
    h.connects[0].reject(wrap('[E_JOIN_NETWORK] x'))
    await flush()
    j.dispose()
    expect(h.timers.filter((t) => !t.cleared)).toHaveLength(0)
  })

  // ── R40 ─────────────────────────────────────────────────────────────────────────────────────────
  it('the waiting-notice delay is none of the retry ladder\'s steps (the helper below tells them apart by it)', () => {
    expect([1000, 2000, 4000, 8000, 15000, 60000]).not.toContain(WAITING_NOTICE_DELAY_MS)
  })

  /** Fire the newest armed timer that is not the waiting-notice one. */
  const fireRetry = (h: ReturnType<typeof harness>) => {
    const t = h.timers.filter((x) => !x.cleared && x.ms !== WAITING_NOTICE_DELAY_MS).pop()
    if (!t) throw new Error('no armed retry')
    t.cleared = true
    t.fn()
  }

  it('R40: a dropped tab that cannot come back gives up after 5 quick tries with ONE notice naming the team', async () => {
    const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
    const j = createHostedJoiner(h.deps)
    await j.bootReconnect()
    await goLive(h, 0, 'proj-1')
    h.closeCbs.get('c0')!(undefined) // the drop
    await flush()
    fireRetry(h) // the first rung (1 s) is the budget's first retry (R41)
    for (let i = 1; i <= 5; i++) {
      h.connects[i].resolve(`c${i}`)
      await flush()
      h.mounts[i].resolve({ error: new RelayApprovalError('The relay connection closed before it was approved.'), declined: false })
      await flush()
      if (i < 5) fireRetry(h)
    }
    expect(h.connects).toHaveLength(6) // the first connection + 5 tries after the drop (1/2/4/8/15 s)
    expect(h.notices).toEqual([{ kind: 'error', text: "Couldn't reconnect to box. Click its tab to try again." }])
    expect(h.timers.filter((t) => !t.cleared && t.ms !== WAITING_NOTICE_DELAY_MS)).toEqual([])
    // The tab stays greyed and clickable: a click is a fresh try.
    expect(j.reconnectTab('proj-1')).toBe(true)
    expect(h.connects).toHaveLength(7)
  })

  it('R40: a boot reconnect that gives up (no tab yet) says how to try again', async () => {
    const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
    const j = createHostedJoiner(h.deps)
    await j.bootReconnect()
    for (let i = 0; i <= 5; i++) {
      h.connects[i].resolve(`c${i}`)
      await flush()
      h.mounts[i].resolve({ error: new RelayApprovalError('closed'), declined: false })
      await flush()
      if (i < 5) fireRetry(h)
    }
    expect(h.notices).toEqual([{ kind: 'error', text: "Couldn't reconnect to box. Paste its invite code to try again." }])
  })

  it('R40: closing the tab while its reconnect backs off stops the loop — no further connect', async () => {
    const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
    const j = createHostedJoiner(h.deps)
    await j.bootReconnect()
    await goLive(h, 0, 'proj-1')
    h.closeCbs.get('c0')!(undefined)
    await flush()
    fireRetry(h)
    h.connects[1].reject(wrap('[E_JOIN_NETWORK] x'))
    await flush()
    j.tabClosed('proj-1')
    h.open.delete('proj-1')
    expect(h.timers.filter((t) => !t.cleared && t.ms !== WAITING_NOTICE_DELAY_MS)).toEqual([])
    await flush()
    expect(h.connects).toHaveLength(2)
    // The slot is free: a later paste is a fresh join, not "already connected".
    j.joinWithCode(codeFor('H1'))
    expect(h.connects).toHaveLength(3)
    expect(h.notices).toEqual([])
  })

  it('R40: deleting the tab while its connect is in flight: no mount, the connection closed, the slot released', async () => {
    const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
    const j = createHostedJoiner(h.deps)
    await j.bootReconnect()
    await goLive(h, 0, 'proj-1')
    h.closeCbs.get('c0')!(undefined)
    await flush()
    fireRetry(h)
    expect(h.connects).toHaveLength(2) // the in-place reconnect is connecting
    j.tabClosed('proj-1')
    h.open.delete('proj-1')
    h.connects[1].resolve('c1')
    await flush()
    expect(h.mounts).toHaveLength(1) // only the first, long-gone mount
    expect(h.deps.disconnect).toHaveBeenCalledWith('c1')
    j.joinWithCode(codeFor('H1'))
    expect(h.connects).toHaveLength(3)
  })

  it('R40: a reconnect whose tab closed while it waited for approval ends silently (it was closed for it)', async () => {
    const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
    const j = createHostedJoiner(h.deps)
    await j.bootReconnect()
    await goLive(h, 0, 'proj-1')
    h.closeCbs.get('c0')!(undefined)
    await flush()
    fireRetry(h)
    h.connects[1].resolve('c1')
    await flush()
    j.tabClosed('proj-1')
    h.open.delete('proj-1')
    expect(h.deps.disconnect).toHaveBeenCalledWith('c1')
    h.mounts[1].resolve({ error: new Error('The tab this reconnect was for is gone.'), declined: false })
    await flush()
    expect(h.notices).toEqual([])
    expect(j.isHostedTab('proj-1')).toBe(false)
  })

  it('R40: after "forget", the greyed tab asks for a code instead of rejoining with the stored one', async () => {
    const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
    ;(h.deps.promptForCode as ReturnType<typeof vi.fn>).mockResolvedValue(codeFor('H1', 'box'))
    const j = createHostedJoiner(h.deps)
    await j.bootReconnect()
    await goLive(h, 0, 'proj-1')
    h.setList([]) // no automatic reconnect after the drop
    h.closeCbs.get('c0')!(undefined)
    await flush()
    await j.forget('H1', 'box')
    expect(j.reconnectTab('proj-1')).toBe(true)
    expect(h.connects).toHaveLength(1) // nothing re-minted from the stored code
    await flush()
    expect(h.deps.promptForCode).toHaveBeenCalledWith('box')
    // The code the user pasted reconnects THAT tab.
    expect(h.connects).toHaveLength(2)
    h.connects[1].resolve('c1')
    await flush()
    expect(h.mounts[1].req).toMatchObject({ reconnectProjectId: 'proj-1', manual: true })
  })

  it('R40: a cancelled "Remove and rejoin" also leaves the tab asking for a code', async () => {
    const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
    const j = createHostedJoiner(h.deps)
    await j.bootReconnect()
    await goLive(h, 0, 'proj-1')
    h.setList([])
    h.closeCbs.get('c0')!(undefined)
    await flush()
    j.reconnectTab('proj-1')
    h.connects[1].reject(wrap("[E_JOIN_REVOKED] revoked"))
    await flush()
    h.notices.at(-1)!.action!.run() // promptForCode answers null: cancelled
    await flush()
    expect(h.deps.removeBookmark).toHaveBeenCalledWith('H1')
    ;(h.deps.promptForCode as ReturnType<typeof vi.fn>).mockClear()
    expect(j.reconnectTab('proj-1')).toBe(true)
    await flush()
    expect(h.deps.promptForCode).toHaveBeenCalledWith('box')
    expect(h.connects).toHaveLength(2)
  })

  it('M8: a code for ANOTHER team pasted into a greyed tab\'s prompt never rebinds that tab — refused, and said why', async () => {
    const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
    ;(h.deps.promptForCode as ReturnType<typeof vi.fn>).mockResolvedValue(codeFor('H2', 'lab'))
    const j = createHostedJoiner(h.deps)
    await j.bootReconnect()
    await goLive(h, 0, 'proj-1')
    h.setList([])
    h.closeCbs.get('c0')!(undefined)
    await flush()
    await j.forget('H1', 'box')
    // The greyed tab asks for a code, and the user pastes one for a different team.
    expect(j.reconnectTab('proj-1')).toBe(true)
    await flush()
    expect(h.connects).toHaveLength(1) // nothing connected: no second team inside box's tab
    expect(h.notices.at(-1)).toMatchObject({
      kind: 'error',
      text: 'That invite code is for lab, not box. To join lab, paste the code in New Remote Connection.'
    })
    // The same team's code still reconnects the tab in place.
    j.joinWithCode(codeFor('H1', 'box'), 'proj-1')
    h.connects[1].resolve('c1')
    await flush()
    expect(h.mounts.at(-1)!.req).toMatchObject({ hostId: 'H1', reconnectProjectId: 'proj-1' })
  })

  it('M8: two teams with the same name are told apart without naming the other one twice', async () => {
    const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
    const j = createHostedJoiner(h.deps)
    await j.bootReconnect()
    await goLive(h, 0, 'proj-1')
    j.joinWithCode(codeFor('H2', 'box'), 'proj-1')
    expect(h.connects).toHaveLength(1)
    expect(h.notices.at(-1)).toMatchObject({
      kind: 'error',
      text: 'That invite code is for a different team than box. To join it, paste the code in New Remote Connection.'
    })
  })

  it('M8: an unreadable code pasted into that prompt still goes to main, which answers for it', async () => {
    const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
    const j = createHostedJoiner(h.deps)
    await j.bootReconnect()
    await goLive(h, 0, 'proj-1')
    j.joinWithCode(`${JOIN_CODE_PREFIX}%%%`, 'proj-1')
    expect(h.connects).toHaveLength(2)
  })

  it('R40: a code pasted for a team whose tab is greyed reconnects that tab, never a second one', async () => {
    const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
    const j = createHostedJoiner(h.deps)
    await j.bootReconnect()
    await goLive(h, 0, 'proj-1')
    h.setList([])
    h.closeCbs.get('c0')!(undefined)
    await flush()
    j.joinWithCode(codeFor('H1'))
    h.connects[1].resolve('c1')
    await flush()
    expect(h.mounts[1].req.reconnectProjectId).toBe('proj-1')
  })

  it('R40: every hosted mount still waiting for approval says so after a moment — a bookmarked reconnect too', async () => {
    const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
    const j = createHostedJoiner(h.deps)
    await j.bootReconnect()
    h.connects[0].resolve('c0')
    await flush()
    const wait = h.timers.find((t) => t.ms === WAITING_NOTICE_DELAY_MS && !t.cleared)!
    wait.cleared = true
    wait.fn()
    expect(h.notices).toEqual([{ kind: 'info', text: 'Waiting for an owner of box to approve this device…', sticky: true }])
    h.approvedCbs.get('c0')!()
    expect(h.cleared).toEqual(['Waiting for an owner of box to approve this device…'])
    h.mounts[0].resolve({ projectId: 'proj-1' })
    await flush()
    expect(h.approvedCbs.has('c0')).toBe(false) // unsubscribed once settled
  })

  it('R40: once approved, the waiting notice never appears — even while the tab is still loading', async () => {
    const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
    const j = createHostedJoiner(h.deps)
    await j.bootReconnect()
    h.connects[0].resolve('c0')
    await flush()
    h.approvedCbs.get('c0')!() // approved; the mount is still loading the workspace
    // The approval disarmed the clock: nothing is left to fire, however long the load takes…
    expect(h.timers.filter((t) => t.ms === WAITING_NOTICE_DELAY_MS && !t.cleared)).toEqual([])
    // …and a confirm that lands after it (a SAS answered late) does not re-arm it.
    h.mounts[0].hooks.sasConfirmed()
    expect(h.timers.filter((t) => t.ms === WAITING_NOTICE_DELAY_MS && !t.cleared)).toEqual([])
    expect(h.notices).toEqual([])
  })

  it('R40: an approval that lands quickly never shows the waiting notice', async () => {
    const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
    const j = createHostedJoiner(h.deps)
    await j.bootReconnect()
    h.connects[0].resolve('c0')
    await flush()
    h.approvedCbs.get('c0')!()
    h.mounts[0].resolve({ projectId: 'proj-1' })
    await flush()
    expect(h.timers.filter((t) => t.ms === WAITING_NOTICE_DELAY_MS).every((t) => t.cleared)).toBe(true)
    expect(h.notices).toEqual([])
    expect(h.cleared).toEqual([])
  })

  // ── R41 ─────────────────────────────────────────────────────────────────────────────────────────
  it('R41: a throttled reconnect says so ONCE ("retrying in a minute") and keeps trying', async () => {
    const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
    const j = createHostedJoiner(h.deps)
    await j.bootReconnect()
    for (let i = 0; i < 3; i++) {
      h.connects[i].reject(wrap('[E_JOIN_THROTTLED] The nodeterm service is limiting requests from this network.'))
      await flush()
      fireRetry(h)
    }
    expect(h.notices).toEqual([{ kind: 'info', text: THROTTLED_NOTICE }])
    expect(h.connects).toHaveLength(4)
  })

  it('R41: a first join arms the waiting notice only after its SAS was confirmed — never before the prompt', async () => {
    const h = harness()
    const j = createHostedJoiner(h.deps)
    j.joinWithCode(codeFor('H1'))
    h.connects[0].resolve('c0')
    await flush()
    const waits = () => h.timers.filter((t) => t.ms === WAITING_NOTICE_DELAY_MS && !t.cleared)
    expect(waits()).toEqual([]) // the SAS prompt has not even come up yet
    h.sasCbs.get('c0')!() // the SAS arrives (the prompt is on screen)
    expect(waits()).toEqual([])
    h.mounts[0].hooks.sasConfirmed() // the user compared and confirmed
    expect(waits()).toHaveLength(1)
    const t = waits()[0]
    t.cleared = true
    t.fn()
    expect(h.notices).toEqual([{ kind: 'info', text: 'Waiting for an owner of box to approve this device…', sticky: true }])
  })

  it('D3: a PASTED code for a team this device already has an approved bookmark for arms the notice too', async () => {
    // Main auto-confirms such a join (the bookmark's approval, for the same host key), so no SAS
    // prompt comes and no `sasConfirmed` ever fires: the clock must start when the connect resolves.
    const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
    const j = createHostedJoiner(h.deps)
    j.joinWithCode(codeFor('H1', 'box'))
    h.connects[0].resolve('c0')
    await flush()
    const waits = h.timers.filter((t) => t.ms === WAITING_NOTICE_DELAY_MS && !t.cleared)
    expect(waits).toHaveLength(1)
    waits[0].cleared = true
    waits[0].fn()
    expect(h.notices).toEqual([{ kind: 'info', text: 'Waiting for an owner of box to approve this device…', sticky: true }])
  })

  it('D3: a pasted code for a bookmark that is NOT approved still waits for the SAS confirm', async () => {
    const h = harness([{ hostId: 'H1', label: 'box', approved: false, code: codeFor('H1') }])
    const j = createHostedJoiner(h.deps)
    j.joinWithCode(codeFor('H1', 'box'))
    h.connects[0].resolve('c0')
    await flush()
    expect(h.timers.filter((t) => t.ms === WAITING_NOTICE_DELAY_MS && !t.cleared)).toEqual([])
  })

  it('D3: a SAS that shows up before the bookmark lookup answers wins — the lookup does not arm the notice', async () => {
    const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
    let answer!: (l: Array<{ hostId: string; label: string; approved: boolean; code: string }>) => void
    ;(h.deps.bookmarks as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise((r) => (answer = r)))
    const j = createHostedJoiner(h.deps)
    j.joinWithCode(codeFor('H1', 'box'))
    h.connects[0].resolve('c0')
    await flush()
    h.sasCbs.get('c0')!() // the host asked for a comparison after all
    answer([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
    await flush()
    expect(h.timers.filter((t) => t.ms === WAITING_NOTICE_DELAY_MS && !t.cleared)).toEqual([])
  })

  it('R41: a bookmarked reconnect arms it when its connect resolves; a SAS that shows up after all disarms it', async () => {
    const h = harness([{ hostId: 'H1', label: 'box', approved: true, code: codeFor('H1') }])
    const j = createHostedJoiner(h.deps)
    await j.bootReconnect()
    h.connects[0].resolve('c0')
    await flush()
    const waits = () => h.timers.filter((t) => t.ms === WAITING_NOTICE_DELAY_MS && !t.cleared)
    expect(waits()).toHaveLength(1)
    h.sasCbs.get('c0')!() // the host asked for a comparison after all (its approval was withdrawn)
    expect(waits()).toEqual([])
    h.mounts[0].hooks.sasConfirmed()
    expect(waits()).toHaveLength(1)
  })
})

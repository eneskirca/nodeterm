import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import {
  OFFSCREEN_DISPOSE_MS_DEFAULT,
  offscreenDisposeMs,
  releaseStillEnabled,
  mayDisposeOffscreen,
  offscreenCoreIsRemote,
  planOffscreenVisibility,
  shouldDeferReleaseForEco,
  shouldDeferReleaseForLiveWork
} from './offscreen-policy'

describe('offscreen dispose policy', () => {
  it('default is 10 minutes; 0 disables; undefined falls back to default', () => {
    expect(OFFSCREEN_DISPOSE_MS_DEFAULT).toBe(600_000)
    expect(offscreenDisposeMs(undefined)).toBe(600_000)
    expect(offscreenDisposeMs(10)).toBe(600_000)
    expect(offscreenDisposeMs(0)).toBeNull()
    expect(offscreenDisposeMs(-3)).toBeNull()
    expect(offscreenDisposeMs(2)).toBe(120_000)
  })
  it('never disposes a visible, selected, or remote terminal', () => {
    expect(mayDisposeOffscreen({ visible: false, remote: false, selected: false })).toBe(true)
    expect(mayDisposeOffscreen({ visible: true, remote: false, selected: false })).toBe(false)
    expect(mayDisposeOffscreen({ visible: false, remote: true, selected: false })).toBe(false)
    expect(mayDisposeOffscreen({ visible: false, remote: false, selected: true })).toBe(false)
  })
  // The second link in "a relay-sourced node never disposes": this predicate answers `true`, and
  // the row above proves `remote: true` refuses. Pinned as a test rather than as a comment because
  // the first attempt at this gate read a node field (`data.remote`) that is only ever set on a
  // PROJECT — a constant `false` that no type could catch and no test then covered.
  it('a session whose core is on another machine is remote; both local surfaces are not', () => {
    expect(offscreenCoreIsRemote('relay')).toBe(true)
    expect(offscreenCoreIsRemote('server')).toBe(true)
    // Electron's own session AND the Server Edition's browser session: the core is at the other end
    // of a preload / a same-machine socket, up whenever the UI is.
    expect(offscreenCoreIsRemote('local')).toBe(false)
  })
})

describe('planOffscreenVisibility', () => {
  const ms = 600_000
  it('arms the timer once when a live terminal goes offscreen', () => {
    expect(
      planOffscreenVisibility({ visible: false, down: false, timerArmed: false, disposeMs: ms })
    ).toEqual({ cancelTimer: false, armTimer: true, revive: false })
  })
  it('never re-arms while a timer is already armed (a pan fires the observer repeatedly)', () => {
    expect(
      planOffscreenVisibility({ visible: false, down: false, timerArmed: true, disposeMs: ms })
    ).toEqual({ cancelTimer: false, armTimer: false, revive: false })
  })
  it('arms nothing while already down, and nothing when the feature is off', () => {
    expect(
      planOffscreenVisibility({ visible: false, down: true, timerArmed: false, disposeMs: ms })
    ).toEqual({ cancelTimer: false, armTimer: false, revive: false })
    expect(
      planOffscreenVisibility({ visible: false, down: false, timerArmed: false, disposeMs: null })
    ).toEqual({ cancelTimer: false, armTimer: false, revive: false })
  })
  it('cancels an armed timer the moment the node is visible again', () => {
    expect(
      planOffscreenVisibility({ visible: true, down: false, timerArmed: true, disposeMs: ms })
    ).toEqual({ cancelTimer: true, armTimer: false, revive: false })
  })
  it('revives a downed node on visibility — even with the feature switched off meanwhile', () => {
    expect(
      planOffscreenVisibility({ visible: true, down: true, timerArmed: false, disposeMs: ms })
    ).toEqual({ cancelTimer: false, armTimer: false, revive: true })
    expect(
      planOffscreenVisibility({ visible: true, down: true, timerArmed: false, disposeMs: null })
    ).toEqual({ cancelTimer: false, armTimer: false, revive: true })
  })
  // The sequence a real node walks, driven the way the (mount-stable) observer drives it. Its
  // point is the LAST step: the revive is decided from `down` + `visible` alone — no armed timer,
  // no live setting, nothing that the down transition consumed. Which is also why the observer
  // that delivers that last verdict may not be owned by the effect the dispose tears down.
  it('walks hidden → armed → down → visible → revived', () => {
    let down = false
    let timerArmed = false
    const step = (visible: boolean): void => {
      const p = planOffscreenVisibility({ visible, down, timerArmed, disposeMs: ms })
      if (p.cancelTimer) timerArmed = false
      if (p.armTimer) timerArmed = true
      if (p.revive) down = false
    }
    step(false)
    expect(timerArmed).toBe(true)
    step(false) // a pan keeps reporting hidden; the deadline must not move
    expect(timerArmed).toBe(true)
    // …the timer fires: the node goes down and the timer is spent.
    timerArmed = false
    down = true
    step(true)
    expect(down).toBe(false)
    expect(timerArmed).toBe(false)
  })
  it('a visible node with nothing pending owes nothing', () => {
    expect(
      planOffscreenVisibility({ visible: true, down: false, timerArmed: false, disposeMs: ms })
    ).toEqual({ cancelTimer: false, armTimer: false, revive: false })
  })
})

describe('shouldDeferReleaseForEco — hibernate first, then release the viewer', () => {
  // Defaults: the release fires at 10 minutes, the idle window closes at 30. Without the deferral
  // the release wins, unwires the node, and "finish a turn and pan away" never hibernates at all.
  const base = {
    ecoEnabled: true,
    resumableAgent: true,
    hibernated: false,
    idleKnown: true,
    offscreenElapsedMs: 10 * 60_000,
    idleMinutes: 30,
    offscreenMinutes: 10
  }

  it('defers at the release deadline, so the bigger prize (the CLI) is still reachable', () => {
    expect(shouldDeferReleaseForEco(base)).toBe(true)
  })

  it('stops deferring once the node HAS hibernated — the pane is a plain shell now', () => {
    expect(shouldDeferReleaseForEco({ ...base, hibernated: true })).toBe(false)
  })

  it('never defers with Eco off, or for a CLI that can never be quit + resumed', () => {
    expect(shouldDeferReleaseForEco({ ...base, ecoEnabled: false })).toBe(false)
    expect(shouldDeferReleaseForEco({ ...base, resumableAgent: false })).toBe(false)
  })

  it('never defers while the idle clock is UNKNOWN — the policy refuses those nodes anyway', () => {
    // `lastEventAt` is transient by design, so after every app restart a warm agent node has no
    // clock until it takes a turn — and `planHibernation`'s "unknown idle is not idle" rule
    // refuses it. Deferring for it would hold every warm node's viewer for the whole cap, i.e.
    // switching Eco ON would mean a memory REGRESSION for the first stretch of each session.
    expect(shouldDeferReleaseForEco({ ...base, idleKnown: false })).toBe(false)
    expect(shouldDeferReleaseForEco({ ...base, idleKnown: true })).toBe(true)
  })

  it('never defers on an unusable idle window (planHibernation refuses those outright)', () => {
    for (const idleMinutes of [0, -5, NaN])
      expect(shouldDeferReleaseForEco({ ...base, idleMinutes }), String(idleMinutes)).toBe(false)
  })

  it('caps the wait at idle + offscreen, so a node that can NEVER hibernate is not stranded', () => {
    // A /cron node, one with a live subagent, one whose session id never arrived: nothing here
    // knows that, and the cap is what makes not knowing safe.
    expect(shouldDeferReleaseForEco({ ...base, offscreenElapsedMs: 40 * 60_000 - 1 })).toBe(true)
    expect(shouldDeferReleaseForEco({ ...base, offscreenElapsedMs: 40 * 60_000 })).toBe(false)
    expect(shouldDeferReleaseForEco({ ...base, offscreenElapsedMs: 90 * 60_000 })).toBe(false)
  })
})

describe('shouldDeferReleaseForLiveWork — the fourth kill lever behind issue #126', () => {
  it('defers a PLAIN-SHELL terminal whose agent is mid-task, where the release would end it', () => {
    for (const agentState of ['working', 'waiting', 'blocked'] as const) {
      expect(shouldDeferReleaseForLiveWork({ tmuxBacked: false, agentState })).toBe(true)
    }
  })

  it('releases the same terminal once the agent goes idle — the deferral drains itself', () => {
    // The retry cadence re-asks, so "protected" is a state the node LEAVES; nothing has to
    // remember that it was ever deferred.
    expect(shouldDeferReleaseForLiveWork({ tmuxBacked: false, agentState: 'working' })).toBe(true)
    expect(shouldDeferReleaseForLiveWork({ tmuxBacked: false, agentState: 'done' })).toBe(false)
  })

  it('never defers a TMUX-BACKED terminal, even one mid-turn — that release is safe', () => {
    // The whole point of the distinction: with tmux the dispose detaches a client and the CLI
    // keeps working. Deferring here would forfeit the memory this feature exists to reclaim, on
    // the setups where reclaiming it is free.
    expect(shouldDeferReleaseForLiveWork({ tmuxBacked: true, agentState: 'working' })).toBe(false)
    expect(shouldDeferReleaseForLiveWork({ tmuxBacked: true, agentState: 'waiting' })).toBe(false)
  })

  it('never defers a plain terminal or an agent-less node', () => {
    expect(shouldDeferReleaseForLiveWork({ tmuxBacked: false })).toBe(false)
  })

  /**
   * UNCAPPED, unlike the Eco deferral one screen up — and that is a decision, not an oversight, so
   * it is pinned rather than described. `shouldDeferReleaseForEco` takes `offscreenElapsedMs` and
   * gives up at a cap because it waits for a hibernation that may never come; this one waits for
   * the user's own turn to end, and "give up and release anyway" is precisely the bug (#126).
   *
   * A behavioural test cannot state this: the claim is about an input that must NOT exist, and any
   * argument object a test writes itself passes trivially. So it is pinned over the source — the
   * same move `canvas/agent-status-rescue.test.ts` and `core/no-electron.test.ts` make for
   * invariants no call can express — and it fails the moment someone threads a clock through.
   */
  it('is UNCAPPED: no clock reaches the predicate, so no caller can grow a cap', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'offscreen-policy.ts'), 'utf8')
    const start = src.indexOf('export function shouldDeferReleaseForLiveWork')
    expect(start, 'the predicate must still exist').toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf('\n}', start))
    // Its whole input is LiveWorkInput (tmuxBacked + agentState). Nothing time-shaped may appear:
    // an elapsed reading, a deadline, a Date.now() — each of those is a cap in the making.
    expect(body).toMatch(/shouldDeferReleaseForLiveWork\(\s*i: LiveWorkInput\s*\)/)
    expect(body).not.toMatch(/elapsed|Ms\b|Date\.now|cap|minutes/i)
    // …and the shared input type itself carries no clock either (the other end of the same claim).
    const live = fs.readFileSync(path.resolve(__dirname, 'live-work.ts'), 'utf8')
    const iface = live.slice(live.indexOf('export interface LiveWorkInput'))
    expect(iface.slice(0, iface.indexOf('\n}'))).not.toMatch(/elapsed|Date\.now|cap|minutes/i)
  })
})

describe('releaseStillEnabled — the fire-time re-ask of the setting itself', () => {
  it('refuses a release whose feature was switched off while the timer counted down', () => {
    // A timer armed ten minutes ago outlives the setting that armed it, and the Eco deferral makes
    // that window longer still. Disposing anyway would take the buffer the user just asked us to
    // keep — indistinguishable, from the outside, from the feature being broken.
    expect(releaseStillEnabled(10)).toBe(true)
    expect(releaseStillEnabled(undefined)).toBe(true) // unset = the default window, still on
    expect(releaseStillEnabled(0)).toBe(false)
    expect(releaseStillEnabled(-5)).toBe(false)
  })
})

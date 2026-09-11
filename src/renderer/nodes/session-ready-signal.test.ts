// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isSessionReady, subscribeSessionReady } from './TerminalNode'

/**
 * Issue #569 item 1 — the PTY-ready signal Canvas's armed-launch loop waits on.
 *
 * TerminalNode is impractical to mount in jsdom (xterm, a live PTY, dozens of stores), so the
 * exported CONTRACT is exercised directly and the publish/clear sites are pinned as source
 * tripwires — the same split `status-lifecycle.test.ts` uses.
 */
const src = readFileSync(join(__dirname, 'TerminalNode.tsx'), 'utf8')

describe('the session-ready registry contract', () => {
  it('an unknown node is NOT ready — the safe direction holds the launch instead of burning it', () => {
    expect(isSessionReady('term-never-seen')).toBe(false)
  })

  it('a subscriber can be added and removed without the module retaining it', () => {
    const seen: string[] = []
    const off = subscribeSessionReady((id) => seen.push(id))
    expect(typeof off).toBe('function')
    off()
    off() // idempotent: a double-unsubscribe on unmount must not throw
    expect(seen).toEqual([])
  })
})

describe('where readiness is published (source pins)', () => {
  it('an ADOPTED (parked) terminal is ready immediately; a fresh one starts not-ready', () => {
    // The park→remount path returns before `create()` and would otherwise never publish, leaving
    // an armed node waiting on a session that has been live the whole time.
    expect(src).toContain('setSessionReady(id, !!parked)')
  })

  it('a fresh session is published through the SAME shell settle the initialCommand writer uses', () => {
    // Both write an agent CLI command line into the pane. A line delivered across zsh's rc-file
    // tty flush comes out mangled, which is exactly what `whenShellSettled` exists to avoid — so
    // the armed launch must not be released on a bare create-resolve.
    expect(src).toContain('whenShellSettled(() => setSessionReady(id, true))')
    expect(src).toContain(
      'const writeWhenShellReady = (cmd: string, onSettled?: (outcome: DeliveryOutcome) => void): void => {'
    )
    expect(src).toMatch(/whenShellSettled\(\(\) => \{[\s\S]{0,400}?deliverCommand\(/)
  })

  it('only a REAL teardown clears it — a park keeps the session typeable by name', () => {
    // The park branch returns before this line; a parked tmux session is still addressable by
    // `sendText`, so clearing there would strand a launch that could have been delivered.
    expect(src).toMatch(/life\.dead = true[\s\S]{0,1800}?setSessionReady\(id, false\)/)
    // Exactly three publish sites: mount (adopt-or-not), settle, teardown. A fourth means
    // somebody has taught another path to claim readiness it cannot vouch for.
    expect(src.match(/setSessionReady\(/g)?.length).toBe(4) // 3 call sites + the definition
  })
})

describe('an offscreen release keeps a tmux-backed session READY (source pins)', () => {
  it('the teardown clears readiness only when the session itself is going away', () => {
    // MEASURED (2026-09-02, scratch Server Edition, hook POSTs): an armed node released offscreen
    // — PTY client detached, tmux session alive and typeable by name — reported not-ready, so its
    // dependency going `done` delivered nothing, the badge claimed the terminal "has not started
    // yet", and only a camera travel (revive) ever fired the launch. The release is a viewer
    // teardown, not a session teardown, so it must not withdraw the fact the gate asks about.
    expect(src).toMatch(
      /life\.dead = true[\s\S]{0,1800}?if \(!\(offscreenDownRef\.current && sessionPersistent\)\) setSessionReady\(id, false\)/
    )
  })

  it('a PLAIN-SHELL armed node is not released at all — there the release kills the shell', () => {
    // Fifth lever behind issue #126's rule: the pure predicate decides, the node only asks it, on
    // the same retry cadence the live-work deferral uses.
    expect(src).toMatch(
      /shouldDeferReleaseForHeldLaunch\(\{[\s\S]{0,200}?tmuxBacked: sessionPersistentRef\.current,[\s\S]{0,120}?armed: armedRef\.current/
    )
  })
})

describe('an ARMED node does not cold-start its agent under the hold (source pins)', () => {
  it('the cold-restore relaunch is gated on there being no pendingLaunch', () => {
    // A first open is `fresh` by definition, so without this every `--after` / `verify` node
    // launched a bare CLI on mount — and Canvas's held launch then arrived as TEXT typed into
    // the session the hold existed to prevent.
    // Matched inside the condition rather than as one literal line: the branch also carries the
    // `paused` gate (shouldColdResume), and the two guards are independent refusals that must
    // both survive a reformat.
    expect(src).toMatch(/fresh &&\s*\n?\s*agentId &&\s*\n?\s*canResume\(agentId\) &&\s*\n?\s*!data\.pendingLaunch/)
  })
})

describe('the QUEUED badge carries the delivery state (source pins)', () => {
  it('the badge reads the store and renders the warning variant plus the shared tooltip', () => {
    expect(src).toContain("useLaunchDelivery((s) => s.byId[id])")
    expect(src).toContain('term-node__status--queued-warn')
    // `pendingErroredOn` is the fourth argument since #521 — an errored upstream is idle, so
    // without it the tooltip would promise a wait that never ends.
    expect(src).toContain(
      'launchTooltip(launchDelivery, pendingWaitingOn, pendingLaunch.command, pendingErroredOn)'
    )
  })

  it('the manual ▶ disarms only on a delivery that landed', () => {
    // Dropping `pendingLaunch` unconditionally threw the command away whenever the session was
    // not up — precisely the state a user reaches for this button in.
    expect(src).toMatch(
      /pty\.sendText\(id, pendingLaunch\.command\)\.then\(\(ok\) => \{[\s\S]{0,600}?if \(ok\)[\s\S]{0,300}?pendingLaunch: undefined/
    )
    expect(src).toMatch(/else \{[\s\S]{0,200}?markFailed\(id, 1\)/)
  })
})

describe('the eye button hides cards AND connections (source pins)', () => {
  it('is offered on every terminal node — a plain terminal has ropes too — and says what it hides', () => {
    expect(src).toContain("'Hide cards & connections'")
    expect(src).toContain("'Show cards & connections'")
    expect(src).not.toContain("'Hide subagent/loop cards'")
    // The button no longer requires a fan-out-capable agent; only the user's header-button
    // visibility setting gates it.
    expect(src).toMatch(/\{!isHidden\('hide-fanout', hiddenHeaderButtons\) && \(\s*<Tooltip label=\{hideFanout \? 'Show cards & connections'/)
  })
})

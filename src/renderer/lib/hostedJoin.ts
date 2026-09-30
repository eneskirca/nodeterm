// Every way this desktop (re)joins a hosted team, over ONE attempt owner per team (hostedAttempts.ts):
//  - boot: each APPROVED bookmark reconnects on its own, in the background;
//  - a drop: a live hosted tab whose connection dropped (no host reason) reconnects in place, in the
//    background, while its team is still bookmarked and approved and the tab is still open;
//  - a click on the greyed tab: reconnects in place now (no pairing-code prompt — the bookmark is the
//    credential) — unless the team was forgotten since, and then it asks for a code;
//  - a pasted join code: joins now, into the team's own tab when it has one, and is told why if it
//    cannot;
//  - forgetting a team: stops its loop and removes its bookmark (the host is not touched);
//  - closing or deleting a tab: its team's attempt stops, in any phase (R40).
// And what the user is told for each: one sentence per stop, nothing for a retry in progress, one
// notice when the quick retries of a drop run out, a "remove and rejoin" offer after a revocation,
// and "waiting for an owner" whenever a mount is still unapproved after a moment. Pure over
// injected deps (no React, no window).
// See docs/hosted-team-relay.md.
import type { RelayClosedReason, RelayHostedApi } from '@shared/types'
import { peekJoinCode } from '@shared/relay-join-code'
import { createHostedAttempts, type HostedAttemptRequest, type HostedMountResult } from './hostedAttempts'
import {
  closedReasonMessage,
  joinStopMessage,
  mountFailureMessage,
  mountFailureRetries,
  stripIpcPrefix,
  THROTTLED_NOTICE,
  waitingForOwnerText
} from './hostedTeam'

/** How long a hosted mount waits for approval before it says it is waiting for an owner. A
 *  bookmarked reconnect is normally approved well inside this, so it never flashes the notice; one
 *  whose device the host no longer knows waits for an owner like a first join (R40). */
export const WAITING_NOTICE_DELAY_MS = 2500

/** Said when a hosted team's invite code is pasted into a Team Access tab's reconnect prompt. */
export const HOSTED_CODE_IN_TEAM_ACCESS_TAB =
  'That is a hosted team invite code — paste it with New Remote Connection to open the team in its own tab.'

/** How a mount ended, as the canvas reports it: a live tab, or the error it failed with. `declined`
 *  = this user declined the SAS themselves (nothing to tell them). */
export type HostedMountOutcome = { projectId: string } | { error: unknown; declined: boolean }

export interface HostedNotice {
  kind: 'info' | 'error'
  text: string
  /** Stays until cleared (the waiting-for-an-owner notice). */
  sticky?: boolean
  action?: { label: string; run: () => void }
}

export interface HostedJoinerDeps {
  /** `relayClient.connect` — a join code in, a connection id out (or main's `[E_JOIN_…]` refusal). */
  connect(code: string): Promise<string>
  onClosed(connectionId: string, listener: (reason?: RelayClosedReason) => void): () => void
  /** Both humans approved this connection (`relayClient.onApproved`). */
  onApproved(connectionId: string, listener: () => void): () => void
  /** This connection's SAS arrived, i.e. a comparison prompt is about to show (`relayClient.onSas`). */
  onSas(connectionId: string, listener: () => void): () => void
  /** Close a connection this joiner no longer wants (it must also count as closed locally). */
  disconnect(connectionId: string): void
  bookmarks: RelayHostedApi['bookmarks']
  removeBookmark: RelayHostedApi['removeBookmark']
  /** The SAS (a first join), the owner's approval, the tab. Never rejects on purpose; a rejection
   *  is read as a failure with that error. `hooks.sasConfirmed` is called once this user confirmed
   *  the SAS (only a connection that asked for one). */
  mount(connectionId: string, req: HostedAttemptRequest, hooks: { sasConfirmed(): void }): Promise<HostedMountOutcome>
  /** Is this project still an open tab (not closed, not deleted)? */
  tabOpen(projectId: string): boolean
  notify(notice: HostedNotice): void
  /** Take down the notice with this text, if it is still the one showing. */
  clearNotice(text: string): void
  /** Ask the user for a fresh invite code for `teamLabel`; null = cancelled. */
  promptForCode(teamLabel: string): Promise<string | null>
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

export interface HostedJoiner {
  /** A join code the user pasted: joins now, never loops. `reconnectProjectId` = it was pasted
   *  into a greyed tab's reconnect prompt, so that tab is the one it reconnects. */
  joinWithCode(code: string, reconnectProjectId?: string): void
  /** A greyed tab was clicked. False when it is not a hosted tab this joiner opened (the caller
   *  takes its pairing-code path). */
  reconnectTab(projectId: string): boolean
  isHostedTab(projectId: string): boolean
  /** The user closed or deleted this tab: its team's attempt stops now, in any phase (R40). */
  tabClosed(projectId: string): void
  /** Reconnect every approved bookmark (once, at boot). */
  bootReconnect(): Promise<void>
  /** Forget a team: its loop stops and its bookmark goes. Refused while it is connecting. */
  forget(hostId: string, label: string): Promise<void>
  /** Is this team connecting or waiting for the host right now? */
  connecting(hostId: string): boolean
  dispose(): void
}

const team = (label: string): string => label.trim() || 'the team'

export function createHostedJoiner(deps: HostedJoinerDeps): HostedJoiner {
  /** The team each hosted tab this joiner opened belongs to, by project id. `forgotten` = the user
   *  forgot that team since: the tab asks for a code rather than rejoin with the stored one (which
   *  would mint a fresh device token and bring the bookmark back). */
  const tabs = new Map<string, { hostId: string; code: string; label: string; forgotten?: boolean }>()
  let run: (req: HostedAttemptRequest) => 'started' | 'busy' = () => 'busy'

  /** A reconnect is wanted only while the tab it reconnects is still open (R40). */
  const tabWanted = (req: HostedAttemptRequest): boolean => !req.reconnectProjectId || deps.tabOpen(req.reconnectProjectId)

  /** An open tab this joiner opened for `hostId`, if any. */
  const tabFor = (hostId: string): string | undefined => {
    for (const [projectId, t] of tabs) if (t.hostId === hostId && deps.tabOpen(projectId)) return projectId
    return undefined
  }

  const markForgotten = (hostId: string): void => {
    for (const [projectId, t] of tabs) if (t.hostId === hostId) tabs.set(projectId, { ...t, forgotten: true })
  }

  const attempts = createHostedAttempts({
    connect: deps.connect,
    onClosed: deps.onClosed,
    disconnect: deps.disconnect,
    setTimer: deps.setTimer,
    clearTimer: deps.clearTimer,
    wanted: tabWanted,
    throttled() {
      deps.notify({ kind: 'info', text: THROTTLED_NOTICE })
    },
    exhausted(req) {
      deps.notify({
        kind: 'error',
        text: req.reconnectProjectId
          ? `Couldn't reconnect to ${team(req.label)}. Click its tab to try again.`
          : `Couldn't reconnect to ${team(req.label)}. Paste its invite code to try again.`
      })
    },
    async mount(connectionId, req): Promise<HostedMountResult> {
      // Any hosted mount still waiting for approval after a moment says so — a first join and a
      // bookmarked reconnect alike (the host may no longer know this device and ask an owner). The
      // clock starts when there is nothing left for THIS user to do: once they confirmed the SAS
      // (a first join), or once the connection exists (a bookmarked reconnect, which confirms on
      // its own). Never before a SAS prompt: a comparison that shows up disarms it (R41).
      const waiting = waitingForOwnerText(req.label)
      let approved = false
      let shown = false
      let waitTimer: unknown = null
      const disarm = (): void => {
        if (waitTimer !== null) deps.clearTimer(waitTimer)
        waitTimer = null
        if (shown) {
          shown = false
          deps.clearNotice(waiting)
        }
      }
      const arm = (): void => {
        disarm()
        if (approved) return
        waitTimer = deps.setTimer(() => {
          waitTimer = null
          if (approved) return
          shown = true
          deps.notify({ kind: 'info', text: waiting, sticky: true })
        }, WAITING_NOTICE_DELAY_MS)
      }
      const unApproved = deps.onApproved(connectionId, () => {
        approved = true
        disarm()
      })
      let sasSeen = false
      let settled = false
      const unSas = deps.onSas(connectionId, () => {
        sasSeen = true
        disarm()
      })
      if (req.autoConfirm) arm()
      else {
        // A PASTED code for a team this device holds an APPROVED bookmark for: main confirms that
        // join on its own (the bookmark's approval, for the same host key — a hostId derives from
        // it), so no SAS prompt comes and `sasConfirmed` never fires. Arm when the lookup answers —
        // unless a SAS showed up first (the host asked for a comparison after all) or the mount has
        // already settled.
        void deps.bookmarks().then(
          (list) => {
            if (!settled && !sasSeen && list.some((b) => b.hostId === req.hostId && b.approved)) arm()
          },
          () => {}
        )
      }
      let outcome: HostedMountOutcome
      try {
        outcome = await deps.mount(connectionId, req, { sasConfirmed: arm })
      } catch (error) {
        outcome = { error, declined: false }
      } finally {
        settled = true
        unApproved()
        unSas()
        disarm()
      }
      if ('projectId' in outcome) {
        tabs.set(outcome.projectId, { hostId: req.hostId, code: req.code, label: req.label })
        return { projectId: outcome.projectId }
      }
      // Declined by this user, or its tab was closed meanwhile (closed for it): nothing to say.
      if (outcome.declined || !tabWanted(req)) return { retry: false }
      const retry = mountFailureRetries(outcome.error)
      // An unattended attempt that will try again says nothing; the next one may well work.
      if (retry && req.retry) return { retry: true }
      deps.notify({ kind: 'error', text: mountFailureMessage(outcome.error, req.label) })
      return { retry: false }
    },
    stopped(req, failure) {
      const text = joinStopMessage(failure, req.label)
      if (!text) return
      if (failure.code === 'E_JOIN_REVOKED') {
        deps.notify({ kind: 'error', text, action: { label: 'Remove and rejoin', run: () => void removeAndRejoin(req) } })
        return
      }
      deps.notify({ kind: 'error', text })
    },
    ended(req, projectId, reason) {
      const said = closedReasonMessage(reason)
      if (said) {
        deps.notify({ kind: 'error', text: `${team(req.label)}: ${said}` })
        return
      }
      // A drop. Come back in place, unattended — but only for a tab still open, on a team still
      // bookmarked and approved (a forgotten team, or one whose approval was withdrawn, waits for
      // the user; an approved bookmark reconnects with no SAS on this side).
      if (!deps.tabOpen(projectId)) return
      void deps.bookmarks().then(
        (list) => {
          const b = list.find((x) => x.hostId === req.hostId)
          if (!b?.approved || !deps.tabOpen(projectId)) return
          run({ hostId: b.hostId, code: b.code, label: b.label, manual: false, retry: true, reconnectProjectId: projectId, afterDrop: true, autoConfirm: true })
        },
        () => {}
      )
    }
  })
  run = (req) => attempts.run(req)

  const busyText = (hostId: string, label: string): string =>
    attempts.phase(hostId) === 'live' ? `You're already connected to ${team(label)}.` : `Already connecting to ${team(label)}…`

  async function removeAndRejoin(req: HostedAttemptRequest): Promise<void> {
    // The bookmark still holds the revoked token: offering it again would only be refused again.
    try {
      await deps.removeBookmark(req.hostId)
    } catch (err) {
      deps.notify({ kind: 'error', text: `Could not forget ${team(req.label)}: ${stripIpcPrefix(err instanceof Error ? err.message : String(err))}` })
      return
    }
    // Gone from this device now, whether or not a fresh code follows: its tab asks for one.
    markForgotten(req.hostId)
    const code = (await deps.promptForCode(req.label))?.trim()
    if (code) joiner.joinWithCode(code, req.reconnectProjectId)
  }

  const joiner: HostedJoiner = {
    joinWithCode(raw, reconnectProjectId) {
      const code = raw.trim()
      const peek = peekJoinCode(code)
      // A code pasted into a hosted tab's own reconnect prompt reconnects THAT team only. A code for
      // another team would mount that team inside this tab, under this tab's name: refuse, and say
      // where it goes instead. (An unreadable code is main's to answer, below.)
      const tab = reconnectProjectId ? tabs.get(reconnectProjectId) : undefined
      // A tab this joiner did not open is a Team Access tab: a hosted tab reconnects from its
      // bookmark and never reaches the pairing prompt. Rebinding it would mount the team there,
      // under that tab's name, with no team to check the code against. Refuse, readable or not.
      if (reconnectProjectId && !tab) {
        deps.notify({ kind: 'error', text: HOSTED_CODE_IN_TEAM_ACCESS_TAB })
        return
      }
      if (tab && peek && peek.hostId !== tab.hostId) {
        const mine = team(tab.label)
        const theirs = peek.label.trim()
        deps.notify({
          kind: 'error',
          text:
            theirs && theirs !== tab.label.trim()
              ? `That invite code is for ${theirs}, not ${mine}. To join ${theirs}, paste the code in New Remote Connection.`
              : `That invite code is for a different team than ${mine}. To join it, paste the code in New Remote Connection.`
        })
        return
      }
      // A code the renderer cannot read still goes to main, which verifies codes and answers for
      // this one; its key is the text itself, so a double paste of it is still one attempt.
      const hostId = peek?.hostId ?? `unreadable:${code}`
      const label = peek?.label ?? ''
      // The team's own tab, when it has one open (greyed or not), is the one this code is for: a
      // greyed tab reconnects in place, a live one answers "already connected" — never a second tab.
      const target = reconnectProjectId ?? tabFor(hostId)
      const req: HostedAttemptRequest = { hostId, code, label, manual: true, retry: false, ...(target ? { reconnectProjectId: target } : {}) }
      if (run(req) === 'busy') {
        deps.notify({ kind: 'info', text: busyText(hostId, label) })
      }
    },
    reconnectTab(projectId) {
      const t = tabs.get(projectId)
      if (!t) return false
      if (t.forgotten) {
        // Forgotten: no stored code to rejoin with — ask, as the forget dialog promised.
        void deps.promptForCode(t.label).then(
          (code) => {
            const c = code?.trim()
            if (c) joiner.joinWithCode(c, projectId)
          },
          () => {}
        )
        return true
      }
      if (run({ hostId: t.hostId, code: t.code, label: t.label, manual: true, retry: true, reconnectProjectId: projectId, autoConfirm: true }) === 'busy') {
        deps.notify({ kind: 'info', text: `Already reconnecting to ${team(t.label)}…` })
      }
      return true
    },
    isHostedTab(projectId) {
      return tabs.has(projectId)
    },
    tabClosed(projectId) {
      tabs.delete(projectId)
      attempts.cancelProject(projectId)
    },
    async bootReconnect() {
      const list = await deps.bookmarks().catch(() => [])
      for (const b of list) {
        if (b.approved) run({ hostId: b.hostId, code: b.code, label: b.label, manual: false, retry: true, autoConfirm: true })
      }
    },
    async forget(hostId, label) {
      if (joiner.connecting(hostId)) {
        deps.notify({ kind: 'info', text: `Still connecting to ${team(label)}; forget it once that finishes.` })
        return
      }
      attempts.cancel(hostId)
      try {
        await deps.removeBookmark(hostId)
      } catch (err) {
        deps.notify({ kind: 'error', text: `Could not forget ${team(label)}: ${stripIpcPrefix(err instanceof Error ? err.message : String(err))}` })
        return
      }
      markForgotten(hostId)
      deps.notify({ kind: 'info', text: `Forgot ${team(label)}. This device will not reconnect to it.` })
    },
    connecting(hostId) {
      const phase = attempts.phase(hostId)
      return phase === 'connecting' || phase === 'mounting'
    },
    dispose() {
      attempts.dispose()
    }
  }
  return joiner
}

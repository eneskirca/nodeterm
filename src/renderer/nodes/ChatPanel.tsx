import { TEXT_NOT_SUBMITTED, isChatPromptBlocked } from '@shared/text-delivery'
import { claudeScreenBlocksInput, readClaudeScreen } from '@shared/agents/claude-screen'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { renderMarkdown } from '../lib/markdown'
import { useAgentStatus } from '../state/agentStatus'
import { useSession } from '../session/session'
import { chipFor } from '../lib/keybindingOverrides'
import {
  canQueue,
  chatComposerPlaceholder,
  chatSendMode,
  chatSendRefusal,
  composerStandsDown,
  screenBlockedSentence,
  type ScreenBlock
} from '../lib/chatSendGate'
import type { ChatMessage } from '@shared/types'
import { chatPaneRefusal, chatPaneRefusalToast } from '../lib/chatPaneGate'
import { chatAgentLabel, isNearBottom, shouldFollowOnLoad, toolCardTitle } from '../lib/chatPanel'
import { useSettings } from '../state/settings'
import {
  CHAT_OLDER_PAGE_BYTES,
  CHAT_TAIL_PAGE_BYTES,
  anchoredScrollTop,
  applyOlder,
  applyTail,
  tailConfirmsSends,
  emptyThread,
  shouldFetchOlder,
  type ChatThread
} from '../lib/chatPaging'
import { E_UNSUPPORTED } from '@shared/rpc'
import { GROK_AMBIGUOUS_SESSION_MESSAGE, isGrokAmbiguousSessionError } from '@shared/chat-page'
import { Spinner } from '../components/Spinner'
import {
  CHAT_LIVE_RELOAD_MIN_MS,
  CHAT_OPTIMISTIC_WORKING_MS,
  CHAT_SCREEN_POLL_MS,
  TURN_END_RELOAD_DELAYS_MS,
  chatActivity,
  planLiveReload,
  shouldPollScreen,
  turnEndReloadCarries
} from '../lib/chatLive'
import { sentCommand } from '@shared/chat-command'
import { isInteractiveBuiltin } from '@shared/chat-catalog'
import { capabilityAgentId, chatReadsLocalOnly, readsScreenDialogs } from '@shared/agents/config'
import { ChatLoadingStatus } from './ChatPanelFallback'
import { answerCardState, answerRebindPending, rebindRetryDelay, type BoundAnswerCard } from '../lib/chatAnswer'
import { AnswerControlsUpdating, PlanAnswerControls, QuestionAnswerControls } from './ChatAnswerControls'
import type { PermissionAnswer } from '@shared/agents/permission-answer'
import { ChatComposer } from './ChatComposer'
import { ChatTurnActions } from './ChatTurnActions'
import { assistantTurnEnds } from '../lib/chatThread'

// Memoized bubble: marked+DOMPurify re-ran for EVERY message on each ChatPanel render (each
// turn-finish reload, each keystroke re-render). Text is stable per message, so cache per text.
// `breaks`: a single newline is a line break, as Claude Code's own TUI renders it — without it a
// multi-line prompt, or a reply quoting one line by line (`> a` / `> b`), collapsed onto one line.
export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text, { breaks: true }), [text])
  return <div className="term-chat__text" dangerouslySetInnerHTML={{ __html: html }} />
})

interface ChatPanelProps {
  nodeId: string
  sessionId?: string
  cwd?: string
  /** Managed Claude account this node runs under; resolves the transcript in the right root. */
  accountId?: string
  /** Which agent's reader to use. REQUIRED, and not cosmetic: claude's resolver falls back to the
   *  newest transcript for the cwd, so a non-claude node that arrives unlabelled is answered with
   *  another session's conversation. It was optional until 2026-09-02, defaulting to claude -- and
   *  deleting the single `agentId={agentId}` at the one mount site left the typecheck and 3767
   *  tests green while restoring that leak in full. Required makes the compiler the proof: the
   *  wiring cannot be dropped silently, with no render test needed to notice. */
  agentId: string
  /**
   * Read a transcript with no live session behind it (issue #531: a CLOSED node's conversation,
   * opened from "Recently closed"). Hides the composer — `pty.sendText` would be aimed at a node
   * id that no longer exists — and names the bar for what it is. Absent = the ⌘M panel on a live
   * node, byte-identical to before.
   */
  readOnly?: boolean
  /** Bar caption. Defaults to the ⌘M panel's own 'Chat'. */
  title?: string
  /** Rendered at the right of the bar in place of the ⌘M exit hint. */
  hint?: string
  /**
   * Resolve attached files (the composer's "+", a drop, a pasted file or screenshot) to the paths
   * the agent should read — the SAME resolution a drop onto the node's terminal uses
   * (`droppedPaths`), supplied by the mount site because only it knows the node's scope (an SSH
   * node uploads to its host over the master it runs on; a local one uses the local path, or the
   * uploads dir for clipboard bytes). Absent = no attach affordance.
   */
  pathsForFiles?: (files: File[]) => Promise<string[]>
  /**
   * Leave the ⌘M view for the node's terminal. The toolbar's model / effort labels type the
   * agent's own picker command (`/model`, `/effort`) into the pane and then call this, so the user
   * sees the picker they just opened. Absent = no labels (a label that opens a picker nobody can
   * see is worse than none).
   */
  onShowTerminal?: () => void
  /**
   * An SSH node's project scope (the same one `pathsForFiles` uploads through): the composer's `@`
   * list is the HOST's files, read over that project's master. Absent = the session's own file
   * index (this machine, or a relay peer's core).
   */
  sshProjectId?: string
}

/**
 * Why the transcript isn't on screen. Every one of these used to render as "No conversation
 * yet.": a rejected read (this surface has no transcript reader at all) left `messages` at its
 * initial `[]` because nothing caught the rejection, and a failed resolution was indistinguishable
 * from a session nobody has spoken to. They need different words — and two of them are retryable.
 */
type LoadState = 'loading' | 'ok' | 'missing' | 'unsupported' | 'remoteUnsupported' | 'ambiguous' | 'exportError' | 'error'

/**
 * An `unreadable` read of a LOCAL-ONLY reader's node (`CHAT_LOCAL_ONLY` — agents with no remote
 * leg) can only be the remote case: core's leg for those agents answers a remote node (`remoteOnly`)
 * with `unreadable` before touching anything, while their local readers never set the flag. So the
 * agent alone names it — no renderer-side remoteness guess, and no new field on the wire (the phone
 * contract keeps `unreadable`). Retry cannot heal it, so it must not read as a transient failure.
 * Grok is NOT in that list: its remote node is read on the host (`core/remote-grok-chat.ts`), so a
 * grok `unreadable` is a real, retryable failure.
 */
const remoteReaderUnsupported = (agentId: string | undefined): boolean => !!agentId && chatReadsLocalOnly(agentId)

/**
 * An `unreadable` read of an OPENCODE node has two causes and nothing on the wire tells them apart:
 * a local `opencode export` that failed (Retry heals it) and a remote node core refuses before
 * running anything (it never heals). So its copy names both instead of guessing — and never blames
 * an unreachable host for a local failure. Through the base harness, mirroring core's routing
 * (`readChatTranscript` routes `capabilityAgentId(...) === 'opencode'` to `opencode-chat.ts`).
 * That ambiguity is why opencode is NOT in `CHAT_LOCAL_ONLY` even though it has no remote leg.
 */
const opencodeUnreadable = (agentId: string | undefined): boolean =>
  !!agentId && capabilityAgentId(agentId) === 'opencode'

const isUnsupported = (e: unknown): boolean =>
  !!e && typeof e === 'object' && (e as { code?: string }).code === E_UNSUPPORTED

/** One line each, in the user's terms: what is on screen and whether waiting will fix it.
 *  `missing` is a CLEAN miss — the (local or remote) host looked and there is no file: a transcript
 *  Claude has cleaned up (30 days by default), or a session that has not written one yet (the
 *  second heals the moment it speaks). A host that could not be ASKED is `error`, which Retry can
 *  fix — a remote grok node included, whose host is read by `core/remote-grok-chat.ts`;
 *  `remoteUnsupported` is a remote node whose agent has no remote reader, which it never can. */
const EMPTY_TEXT: Record<LoadState, { title: string; detail?: string }> = {
  loading: { title: 'Loading conversation…' },
  ok: { title: 'No conversation yet.' },
  missing: {
    title: 'No transcript found for this session.',
    detail: "It may have been cleaned up, or the session hasn't written one yet."
  },
  unsupported: {
    title: "Transcripts can't be read on this surface.",
    detail: 'Open this session on the desktop app to read its conversation.'
  },
  // `{agent}` is the node's own agent label (`agentLabel` below) — the case spans several agents.
  remoteUnsupported: { title: "Reading a remote {agent} session's transcript isn't supported yet." },
  // A remote grok id that names two sessions on the host: a fixed fact, like `unsupported` — so,
  // like it, no Retry (waiting cannot change which file is this node's).
  ambiguous: {
    title: GROK_AMBIGUOUS_SESSION_MESSAGE,
    detail: 'nodeterm will not guess which one belongs to this node.'
  },
  exportError: {
    title: "Couldn't read this opencode session.",
    detail: "opencode export failed on this machine — Retry once it works. A session on a remote host can't be read here yet."
  },
  error: {
    title: "Couldn't read the transcript.",
    detail: "The agent's host may not be reachable — Retry once it is."
  }
}

/**
 * Chat view for a chat-capable agent node (Cmd+M). Renders the session transcript as
 * markdown bubbles with collapsible tool calls, and sends new prompts into the running tmux
 * session via pty.sendText. While a turn runs, a status row closes the thread and the tail is
 * re-read (throttled) on every hook event, so the answer grows as it is written; the turn's end
 * (working -> idle) takes one final reload. Replaces the markdown-of-output overlay.
 */
export function ChatPanel({
  nodeId,
  sessionId,
  cwd,
  accountId,
  agentId,
  readOnly,
  title,
  hint,
  pathsForFiles,
  onShowTerminal,
  sshProjectId
}: ChatPanelProps) {
  // This node's core api (stable for the session — the chat transcript and the tmux session
  // both live on the core this panel's project belongs to).
  const { api, source } = useSession()
  // Which transcript this panel reads. Keys are byte offsets into ONE file, so a thread is only
  // ever merged with a read of the same identity (see lib/chatPaging.ts).
  const identity = JSON.stringify([nodeId, sessionId ?? null, cwd ?? null, accountId ?? null, agentId])
  const [thread, setThread] = useState<ChatThread>(() => emptyThread(identity))
  const messages = thread.messages
  // Read by the async handlers, which must decide against the thread as it is NOW, not as it was
  // when the read was issued.
  const threadRef = useRef(thread)
  threadRef.current = thread
  const [loadState, setLoadState] = useState<LoadState>('loading')
  // Mirror for `attemptLive`, which runs from timers and settles, outside any render.
  const loadStateRef = useRef(loadState)
  loadStateRef.current = loadState
  // The older-page fetch (scroll-up paging): its own in-flight flag and token, and a failed page
  // gets a retry row instead of retrying on every scroll event.
  const [olderState, setOlderState] = useState<'idle' | 'loading' | 'error'>('idle')
  // A tail read in flight. Older paging waits for it: the tail can RESET the thread (see
  // applyTail), and an older page fetched against the pre-reload cursor would be thrown away. State,
  // not a ref, so the paging check re-runs when the tail lands.
  const [tailLoading, setTailLoading] = useState(false)
  // Mirror for `load`, which must not depend on it (its identity drives the initial-load effect).
  const olderStateRef = useRef(olderState)
  olderStateRef.current = olderState
  const [input, setInput] = useState('')
  const [readonly, setReadonly] = useState(false)
  const [optimistic, setOptimistic] = useState(false)
  const state = useAgentStatus((s) => s.byId[nodeId]?.state)
  // The shell-owned-pane flags, each as its own primitive selector (an object selector would
  // re-render on every hook event for every node). See lib/chatSendGate.ts for why they gate.
  const hibernated = useAgentStatus((s) => s.byId[nodeId]?.hibernated)
  const paused = useAgentStatus((s) => s.byId[nodeId]?.paused)
  const dropped = useAgentStatus((s) => s.byId[nodeId]?.dropped)
  const sessionEnded = useAgentStatus((s) => s.byId[nodeId]?.sessionEnded)
  // The request the node's managed hook is holding (plan / question / permission). The store keeps
  // the same object across same-ticket events, so this selector re-renders only on a new hold.
  const held = useAgentStatus((s) => s.byId[nodeId]?.held)
  const customAgents = useSettings((s) => s.settings.customAgents)
  // Not just `working`: a TUI dialog (`waiting`/`blocked`) would be ANSWERED by sendText's Enter,
  // and a pane whose CLI is gone (hibernated/paused/dropped/exited) is a SHELL that would execute it.
  const refusal = chatSendRefusal(agentId, { state, hibernated, paused, dropped, sessionEnded })
  // What Enter does now — `queue` lifts the `working` refusal for a CLI that queues mid-turn input.
  const sendMode = chatSendMode(agentId, { state, hibernated, paused, dropped, sessionEnded })
  // The agent's OWN dialog on the pane's screen (folder trust, /model, setup questions): no hook
  // reports those, so the state gate above cannot see them. Found by the poll (local panes, `live`
  // — the poll also clears it) or by a send core refused before writing (`live: false` — it then
  // stays until a send gets through or the view closes). `text`: the dialog's own lines.
  const [screenBlock, setScreenBlock] = useState<{ kind: ScreenBlock; text: string | null; live: boolean } | null>(
    null
  )
  const pollScreen = shouldPollScreen({
    readable: readsScreenDialogs(agentId),
    readOnly: readOnly === true,
    // An SSH node's tmux is on its host (`sshProjectId` is set exactly for those); a relay tab's
    // is on the peer. Either way each read is a network round trip.
    remote: sshProjectId !== undefined || source !== 'local',
    refusal
  })
  const agentLabel = chatAgentLabel(agentId, customAgents)
  // What the row closing the thread says (lib/chatLive.ts). `optimistic` covers the gap between a
  // send and the first hook event: set by `send`, retired by the next state change (the real state
  // takes over) or, for an agent whose hooks never report, after a bounded timeout.
  const activity = chatActivity({ refusal, optimistic, readOnly: !!readOnly })
  // The one Plan / Question card that gets answer controls (lib/chatAnswer.ts): only while the pane
  // holds a TUI dialog (`dialog` — the CLI is in the pane and waiting) and only on the card the held
  // ticket belongs to. A host whose hook script predates structured answers never sends `held`, so
  // its cards stay read-only — the terminal path is then the only one, exactly as before.
  //
  // …and only when the thread on screen was READ for that ticket (`threadHeldFor`, lib/chatAnswer.ts
  // `answerCardState`): while the hook moves held A → held B the thread can still show plan A's card
  // with no result, and matching by tool name alone would approve B from A's card. Until a tail read
  // that started under B lands, the latest card says "Updating…" instead. Keyed by the transcript
  // identity, so a session change never carries the previous thread's binding over.
  const [heldRead, setHeldRead] = useState<{ identity: string; pendingId: string | null } | null>(null)
  const threadHeldFor = heldRead && heldRead.identity === identity ? heldRead.pendingId : undefined
  const threadHeldForRef = useRef(threadHeldFor)
  threadHeldForRef.current = threadHeldFor
  // The card the last request was bound to (per transcript identity): a NEW request must surface on
  // a card the thread shows as new, never on that one — see `answerCardState`'s `previous`.
  const [boundCard, setBoundCard] = useState<(BoundAnswerCard & { identity: string }) | null>(null)
  const previousBound = boundCard && boundCard.identity === identity ? boundCard : null
  const cardState = useMemo(
    () => (!readOnly && refusal === 'dialog' ? answerCardState(messages, held, threadHeldFor, previousBound) : null),
    [readOnly, refusal, messages, held, threadHeldFor, previousBound]
  )
  const answerCard = cardState?.kind === 'active' ? cardState : null
  const updatingCard = cardState?.kind === 'updating' ? cardState.card : null
  // The request a rebind reload is owed for (null = none): drives the forced reload and its retry.
  const rebindFor = cardState?.kind === 'updating' ? (held?.pendingId ?? null) : null
  const rebindForRef = useRef(rebindFor)
  rebindForRef.current = rebindFor
  const activePendingId = cardState?.kind === 'active' ? cardState.pendingId : null
  const activeCardKey = cardState?.kind === 'active' ? cardState.cardKey : null
  useEffect(() => {
    if (activePendingId === null || activeCardKey === null) return
    setBoundCard((b) =>
      b && b.identity === identity && b.pendingId === activePendingId && b.cardKey === activeCardKey
        ? b
        : { identity, pendingId: activePendingId, cardKey: activeCardKey }
    )
  }, [identity, activePendingId, activeCardKey])
  const msgsRef = useRef<HTMLDivElement>(null)
  const prevState = useRef(state)
  // Request token: only the NEWEST readTranscript may land. An older read resolving late (the
  // sessionId changed underneath it, or a ↻ raced the turn-finish reload) would otherwise paint
  // another session's thread over the current one. Bumped on unmount too, so a read that resolves
  // after the panel closed is dropped rather than applied to a dead component.
  const reqRef = useRef(0)
  // Scroll-follow inputs, captured BEFORE a load changes the content: was the user following the
  // bottom (updated on every scroll), and did they just send (they expect to see it land).
  const nearBottomRef = useRef(true)
  const justSentRef = useRef(false)
  // Token for the older-page fetch. A TAIL load bumps it too: a tail read can reset the thread
  // (see applyTail), and an older page computed against the previous cursor must not land on it.
  const olderReqRef = useRef(0)
  const olderInFlightRef = useRef(false)
  // Geometry captured just BEFORE content is inserted above the viewport (an older page, or the
  // "Loading earlier messages…" row appearing); the layout effect shifts scrollTop by the height
  // that was added, so what the user is reading stays put.
  const anchorRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null)
  // Never on a panel with no layout box (collapsed node, `display:none`): every metric is 0 there,
  // and an "anchor" at 0 would pin the view to the top of whatever loads while hidden.
  const captureAnchor = () => {
    const el = msgsRef.current
    if (el && el.clientHeight > 0) anchorRef.current = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight }
  }
  // Live refresh bookkeeping (lib/chatLive.ts `planLiveReload`). Refs, not state: none of it is
  // rendered, and a hook event must not re-render the panel just to note that it arrived.
  // - a TAIL read is in flight (any: initial, ↻, turn-end or live) — live reads never overlap one
  //   (nor an older-page fetch, `olderInFlightRef`);
  // - when the last tail read started — the throttle's clock;
  // - a hook event not yet served by a read — the trailing call, retried on settle / timer /
  //   reveal / visibilitychange;
  // - the trailing timer.
  const tailInFlightRef = useRef(false)
  const lastTailStartRef = useRef<number | null>(null)
  const livePendingRef = useRef(false)
  const liveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attemptLiveRef = useRef<() => void>(() => {})
  // A held-request reload asked for while a tail read was in flight: run when that read settles
  // (single-flight, like the live reads) — never dropped, since the read in flight started under the
  // PREVIOUS request and cannot bind the new one. Any read that STARTS later satisfies it.
  const heldReloadQueuedRef = useRef(false)
  // The ONE tail read a sent local command schedules (see `send`): `/model` or `!ls` fires no hook,
  // so neither a state change nor a live read would ever confirm it.
  const commandReadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadRef = useRef<(live?: boolean, rebind?: boolean, carry?: boolean) => void>(() => {})
  // The turn-end settle reloads (TURN_END_RELOAD_DELAYS_MS) still to fire; cleared on unmount.
  const settleTimersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const requestHeldReloadRef = useRef<() => void>(() => {})

  // `live` = a read driven by a hook event while the agent works (see `attemptLive`), as opposed to
  // the first open, the turn-end reload and ↻. A live read is background refresh: it keeps
  // unconfirmed sends on screen (`carryUnconfirmed`), leaves a failed older page's retry row alone
  // (clearing it would re-arm a failing fetch every interval) and never flips the empty state to
  // "Loading…" (which would strobe on every hook event).
  //
  // `rebind` = the held-request reload (see `requestHeldReload`): QUIET like a live read (no
  // "Loading…", the older-page row left alone, unconfirmed sends kept), and it never cancels an
  // older-page fetch — it is only ever started with none in flight.
  //
  // `carry` = keep unconfirmed sends (`carryUnconfirmed`). Every live and rebind read does; so do the
  // turn-end settle reloads but the last (`turnEndReloadCarries`).
  const load = useCallback((live = false, rebind = false, carry = live || rebind) => {
    const token = ++reqRef.current
    if (!rebind) olderReqRef.current++
    // The held request this read starts under: once it is applied, the thread is known to show the
    // transcript as of (at least) that request. Read from the store, not the render: a hold that
    // landed since the last render is exactly what this must see.
    const heldAtStart = useAgentStatus.getState().byId[nodeId]?.held?.pendingId ?? null
    heldReloadQueuedRef.current = false
    // After this read settles: a queued held-request reload runs if the thread is still not read
    // for the request held NOW (`bound` = what the thread is read for after this read).
    const settleHeldReload = (bound: string | null | undefined) => {
      if (!heldReloadQueuedRef.current) return
      heldReloadQueuedRef.current = false
      if (answerRebindPending(useAgentStatus.getState().byId[nodeId]?.held, bound)) loadRef.current(false, true)
    }
    if (!rebind) olderInFlightRef.current = false
    if (!live && !rebind) {
      // Cancelling an older fetch (or clearing its error) removes a row ABOVE the viewport: anchor
      // it like any other change up there, or the view jumps by the row's height.
      if (olderStateRef.current !== 'idle') captureAnchor()
      setOlderState('idle')
    }
    setTailLoading(true)
    tailInFlightRef.current = true
    lastTailStartRef.current = Date.now()
    if (!live && !rebind) setLoadState((s) => (s === 'ok' ? s : 'loading')) // a reload never blanks a rendered thread
    // `nodeId` is what lets an SSH-project node resolve on its host; the rejection branch is what
    // keeps a surface that cannot read transcripts (Server Edition, relay tab) from silently
    // presenting itself as an empty conversation. Only the newest TAIL window is read — older
    // history pages in on scroll-up, and a reload merges by key instead of discarding it.
    void api.chat.readTranscript(sessionId, cwd, accountId, nodeId, agentId, {
      maxBytes: CHAT_TAIL_PAGE_BYTES,
      // A hook-driven refresh the user did not ask for: an expensive reader (opencode's export) may
      // space these out. An open, ↻, Retry or a held-request rebind is never marked.
      ...(live && !rebind ? { background: true } : {})
    }).then(
      (res) => {
        if (token !== reqRef.current) return
        setTailLoading(false)
        tailInFlightRef.current = false
        // A hook event held while this read was in flight gets its (trailing) read now.
        queueMicrotask(() => attemptLiveRef.current())
        if (!res.found) {
          // `missing` only when there is nothing of THIS transcript on screen. A reload that
          // failed to resolve (an SSH master blip) must not blank a thread the user is reading.
          const t = threadRef.current
          if (t.identity === identity && t.messages.length > 0) {
            // The thread on screen is still this transcript's: back to `ok`, or the `loading` this
            // reload set would stick and silently disable older paging (it waits for `ok`).
            setLoadState('ok')
            // Nothing was applied: the thread is still read for what it was read for before.
            settleHeldReload(threadHeldForRef.current)
            return
          }
          setThread(emptyThread(identity))
          // A read that FAILED (the host did not answer, a remote node with no reachable master)
          // is not "no transcript": it gets the error copy, and ↻ is the way out.
          setLoadState(
            !res.unreadable
              ? 'missing'
              : remoteReaderUnsupported(agentId)
                ? 'remoteUnsupported'
                : opencodeUnreadable(agentId)
                  ? 'exportError'
                  : 'error'
          )
          setHeldRead({ identity, pendingId: heldAtStart })
          settleHeldReload(heldAtStart)
          return
        }
        // A read that confirms every optimistic send retires the working row: for a local
        // command it is the ONLY signal (no hook fires). A command that starts a real turn is
        // still covered — its `working` state keeps the row (and the send refusal) on its own.
        if (tailConfirmsSends(threadRef.current, identity, res)) setOptimistic(false)
        setThread((t) => applyTail(t, identity, res, { carryUnconfirmed: carry }))
        setLoadState('ok')
        setHeldRead({ identity, pendingId: heldAtStart })
        settleHeldReload(heldAtStart)
      },
      (e: unknown) => {
        if (token !== reqRef.current) return
        setTailLoading(false)
        tailInFlightRef.current = false
        queueMicrotask(() => attemptLiveRef.current())
        // Same rule as a failed resolution: a rendered thread of this transcript stays usable.
        const t = threadRef.current
        if (t.identity === identity && t.messages.length > 0) {
          setLoadState('ok')
          settleHeldReload(threadHeldForRef.current)
          return
        }
        // …and, as there, a thread of ANOTHER transcript (the session changed under the panel) is
        // cleared: the error message must not sit under the previous session's conversation.
        if (t.identity !== identity) setThread(emptyThread(identity))
        setLoadState(isUnsupported(e) ? 'unsupported' : isGrokAmbiguousSessionError(e) ? 'ambiguous' : 'error')
        settleHeldReload(threadHeldForRef.current)
      }
    )
  }, [api, sessionId, cwd, accountId, nodeId, agentId, identity])
  loadRef.current = load

  // Fetch the next OLDER page and prepend it. One in flight at a time; a result that arrives
  // after a newer tail load (or unmount) is dropped by its token. A `found:false` here is a failed
  // older-page load, NOT a missing transcript: the rendered thread stays, and a retry row appears.
  const loadOlder = useCallback(() => {
    const before = thread.olderCursor
    if (before === null || olderInFlightRef.current || thread.identity !== identity) return
    const token = ++olderReqRef.current
    olderInFlightRef.current = true
    captureAnchor()
    setOlderState('loading')
    const settle = () => {
      olderInFlightRef.current = false
      // A hook event held behind this page gets its (trailing) tail read now.
      queueMicrotask(() => attemptLiveRef.current())
      // …and so does a held-request reload queued behind it (`requestHeldReload`), once the page
      // has landed (microtask: after its setThread below).
      if (heldReloadQueuedRef.current) {
        heldReloadQueuedRef.current = false
        // Through the one entry point: a tail read that started meanwhile (and so already captured
        // the new request) is queued behind, never superseded.
        queueMicrotask(() => {
          if (rebindForRef.current !== null) requestHeldReloadRef.current()
        })
      }
    }
    void api.chat.readTranscript(sessionId, cwd, accountId, nodeId, agentId, {
      before,
      maxBytes: CHAT_OLDER_PAGE_BYTES
    }).then(
      (res) => {
        if (token !== olderReqRef.current) return
        settle()
        captureAnchor()
        if (!res.found) {
          setOlderState('error')
          return
        }
        setThread((t) => (t.identity === identity && t.olderCursor === before ? applyOlder(t, res) : t))
        setOlderState('idle')
      },
      () => {
        if (token !== olderReqRef.current) return
        settle()
        captureAnchor()
        setOlderState('error')
      }
    )
  }, [api, sessionId, cwd, accountId, nodeId, agentId, identity, thread.olderCursor, thread.identity])

  // Initial load.
  useEffect(() => {
    load()
  }, [load])

  // A newly held plan / question the thread was not read for: re-read the tail now (declared after
  // the initial load, so on mount this QUEUES behind that read rather than superseding it) — or, with a
  // read in flight (it started under the previous request), queue it for that read's settle. Not
  // for a surface that cannot read transcripts at all (every read would be refused).
  // An older-page fetch in flight is waited for too, never cancelled: the user's scroll-up paging
  // must not restart because a plan was revised.
  const requestHeldReload = useCallback(() => {
    if (loadStateRef.current === 'unsupported') return
    if (tailInFlightRef.current || olderInFlightRef.current) heldReloadQueuedRef.current = true
    else loadRef.current(false, true)
  }, [])
  requestHeldReloadRef.current = requestHeldReload
  // Retries back off (`rebindRetryDelay`), counted per held request: a new one starts over.
  const rebindAttemptRef = useRef(0)
  useEffect(() => {
    rebindAttemptRef.current = 0
    // working → blocked with a new held id in the same render: the turn-end reload below (a full
    // read that starts NOW, under the new request) owns it — one read, not two.
    if (rebindFor !== null && !(prevState.current === 'working' && state !== 'working')) requestHeldReload()
  }, [rebindFor, requestHeldReload]) // eslint-disable-line react-hooks/exhaustive-deps -- `state` is read, not a trigger
  // …and while a card stays on "Updating…" with no read in flight (the reload failed, or the
  // transcript has not caught up), try again: nothing else reads the tail while the agent is
  // blocked. Also with no card on screen (A answered, B's card not read yet): the reload is quiet,
  // backs off, and stops by itself once a read under the new request lands.
  useEffect(() => {
    if (rebindFor === null || tailLoading) return
    const t = setTimeout(() => {
      rebindAttemptRef.current++
      requestHeldReload()
    }, rebindRetryDelay(rebindAttemptRef.current))
    return () => clearTimeout(t)
  }, [rebindFor, tailLoading, requestHeldReload])

  // Invalidate any in-flight read when the panel goes away.
  useEffect(
    () => () => {
      reqRef.current++
      olderReqRef.current++
      livePendingRef.current = false
      attemptLiveRef.current = () => {}
      if (liveTimerRef.current !== null) clearTimeout(liveTimerRef.current)
      liveTimerRef.current = null
      for (const t of settleTimersRef.current) clearTimeout(t)
      settleTimersRef.current = []
    },
    []
  )

  // Serve a pending hook event if the plan allows it now; otherwise leave it pending for whichever
  // retry the plan waits on. Everything is read at call time (store, geometry, visibility): it
  // runs from timers and settles, long after the render that defined it.
  attemptLiveRef.current = () => {
    if (!livePendingRef.current) return
    // This surface cannot read transcripts at all (relay tab): every live read would be refused.
    if (loadStateRef.current === 'unsupported' || loadStateRef.current === 'remoteUnsupported') {
      livePendingRef.current = false
      return
    }
    const el = msgsRef.current
    const plan = planLiveReload({
      working: useAgentStatus.getState().byId[nodeId]?.state === 'working',
      // No layout box (collapsed node, display:none) = the paging gate; a hidden document too.
      visible: !!el && el.clientHeight > 0 && !document.hidden,
      // An older page in flight counts too: `load` cancels it, and a live read every interval
      // would keep restarting the user's scroll-up paging for the whole turn.
      inFlight: tailInFlightRef.current || olderInFlightRef.current,
      now: Date.now(),
      lastStartAt: lastTailStartRef.current
    })
    switch (plan.kind) {
      case 'skip':
        livePendingRef.current = false
        return
      case 'hold':
        return
      case 'wait':
        if (liveTimerRef.current === null) {
          liveTimerRef.current = setTimeout(() => {
            liveTimerRef.current = null
            attemptLiveRef.current()
          }, plan.ms)
        }
        return
      case 'run':
        livePendingRef.current = false
        load(true)
    }
  }

  // Every hook event for this node — same-state ones included, which no zustand selector sees (the
  // store refreshes `stateAt` in place without notifying; see `onHookEvent`). While the agent is
  // working each one may have written to the transcript, so each asks for a tail refresh.
  useEffect(
    () =>
      useAgentStatus.getState().onHookEvent(nodeId, () => {
        livePendingRef.current = true
        attemptLiveRef.current()
      }),
    [nodeId]
  )

  // A tab that comes back into view serves what was held while it was hidden.
  useEffect(() => {
    const onVisibility = () => attemptLiveRef.current()
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  // Reload when a turn completes (working -> not working), then again on the settle schedule
  // (TURN_END_RELOAD_DELAYS_MS): the Stop hook lands before the final reply is written, so the read
  // at the edge usually misses it. A new turn does NOT cancel the schedule: a prompt sent the moment
  // the turn ended starts one at once, and cancelling there would hide the finished turn's reply
  // until the next one ended. Sessions whose hooks never report `working` never take this path —
  // the bar's ↻ is their reload.
  useEffect(() => {
    if (prevState.current === 'working' && state !== 'working') {
      load(false, false, true)
      for (const t of settleTimersRef.current) clearTimeout(t)
      const last = TURN_END_RELOAD_DELAYS_MS.length - 1
      settleTimersRef.current = TURN_END_RELOAD_DELAYS_MS.map((ms, i) =>
        setTimeout(() => {
          const working = useAgentStatus.getState().byId[nodeId]?.state === 'working'
          loadRef.current(false, false, turnEndReloadCarries({ final: i === last, working }))
        }, ms)
      )
    }
    prevState.current = state
  }, [state, load, nodeId])

  // Any state change retires the optimistic working row: from here the real state speaks.
  useEffect(() => {
    setOptimistic(false)
  }, [state])
  useEffect(() => {
    if (!optimistic) return
    const t = setTimeout(() => setOptimistic(false), CHAT_OPTIMISTIC_WORKING_MS)
    return () => clearTimeout(t)
  }, [optimistic])

  // Re-read the pane's screen while the view is visible (see `screenBlock`). A read that fails or
  // finds a blank screen changes nothing: unknown is not evidence either way.
  useEffect(() => {
    if (!pollScreen) {
      setScreenBlock((b) => (b?.live === true ? null : b))
      return
    }
    let cancelled = false
    const tick = async (): Promise<void> => {
      const el = msgsRef.current
      if (el === null || el.clientHeight === 0 || document.hidden) return
      let screen: string
      try {
        screen = await api.pty.capture(nodeId)
      } catch {
        return
      }
      if (cancelled) return
      const read = readClaudeScreen(screen)
      if (read.kind === 'unknown') return
      if (!claudeScreenBlocksInput(read)) setScreenBlock(null)
      else if (read.kind === 'dialog') setScreenBlock({ kind: 'dialog', text: read.text, live: true })
      else setScreenBlock({ kind: 'no-prompt', text: null, live: true })
    }
    void tick()
    const t = setInterval(() => void tick(), CHAT_SCREEN_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [pollScreen, api, nodeId])

  // Follow the newest message only when the user was already at the bottom or just sent; a user
  // scrolled up reading an earlier answer keeps their place. Layout effect: the jump lands before
  // paint, so a followed thread never flashes one frame short.
  //
  // Content inserted ABOVE the viewport (an older page, the loading row) is the other case: there
  // the anchor captured before the change wins, and the view is shifted by exactly the added
  // height — no jump, and no follow (the user is at the top, reading history).
  useLayoutEffect(() => {
    const el = msgsRef.current
    if (!el) return
    const anchor = anchorRef.current
    if (anchor) {
      anchorRef.current = null
      el.scrollTop = anchoredScrollTop(anchor, el.scrollHeight)
      return
    }
    if (shouldFollowOnLoad({ wasNearBottom: nearBottomRef.current, justSent: justSentRef.current })) {
      el.scrollTop = el.scrollHeight
      nearBottomRef.current = true
    }
    justSentRef.current = false
    // `activity` / `screenBlock`: a row appearing at the end grows the thread like a message does.
  }, [messages, olderState, activity, screenBlock])

  const maybeLoadOlder = useCallback(() => {
    const el = msgsRef.current
    if (!el) return
    if (
      shouldFetchOlder({
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        olderCursor: thread.identity === identity ? thread.olderCursor : null,
        inFlight: olderInFlightRef.current || tailLoading,
        failed: olderState === 'error',
        loaded: loadState === 'ok'
      })
    ) {
      loadOlder()
    }
  }, [thread.identity, thread.olderCursor, identity, olderState, loadState, tailLoading, loadOlder])

  // After every thread change too, not only on scroll: a thread shorter than the viewport cannot
  // scroll, so without this its older history would be unreachable.
  useEffect(() => {
    maybeLoadOlder()
  }, [maybeLoadOlder])

  // The panel's box changing size — above all a collapsed node being EXPANDED (display:none → a
  // real box). Nothing else re-runs the checks then: while hidden, follow and anchor had zero
  // geometry to work with and paging was refused. So: a user who was following lands at the
  // bottom, and paging resumes (a short thread fetches older right away). Guarded: jsdom and old
  // engines have no ResizeObserver, and the panel works without it.
  const maybeLoadOlderRef = useRef(maybeLoadOlder)
  maybeLoadOlderRef.current = maybeLoadOlder
  useEffect(() => {
    const el = msgsRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let hadBox = el.clientHeight > 0
    const ro = new ResizeObserver(() => {
      const hasBox = el.clientHeight > 0
      if (hasBox && !hadBox && nearBottomRef.current) el.scrollTop = el.scrollHeight
      hadBox = hasBox
      maybeLoadOlderRef.current()
      attemptLiveRef.current() // a hook event held while the panel was hidden
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const onScroll = () => {
    const el = msgsRef.current
    if (el) nearBottomRef.current = isNearBottom(el)
    maybeLoadOlder()
  }

  // The optimistic bubbles sent into the CLI's queue mid-turn, drawn as "Queued" until the transcript
  // has them. Object identity is enough: `applyTail` carries an unconfirmed send as the same object.
  const queuedRef = useRef(new WeakSet<ChatMessage>())

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text) return
    // Read the store at SEND time, not the render-time values: a PermissionRequest (or an Eco
    // hibernation) that landed between the last render and this keypress must still block.
    const mode = chatSendMode(agentId, useAgentStatus.getState().byId[nodeId] ?? {})
    if (mode === null) return
    if (mode === 'queue' && !canQueue(text)) {
      const message = `${chatAgentLabel(agentId, useSettings.getState().settings.customAgents)} is working — send commands once the reply finishes.`
      window.dispatchEvent(new CustomEvent('nodeterm:toast', { detail: { kind: 'error', message } }))
      return
    }
    // The kernel's say (chatPaneGate.ts): an agent that announces no quit (codex) may have left a
    // SHELL in the pane while the store still reads `done` — typed there, the message would run.
    const pane = await chatPaneRefusal(agentId, nodeId, {
      paneOwner: (n) => api.pty.paneOwner(n),
      customAgents: useSettings.getState().settings.customAgents
    })
    if (pane) {
      const message = chatPaneRefusalToast(pane, chatAgentLabel(agentId, useSettings.getState().settings.customAgents))
      window.dispatchEvent(new CustomEvent('nodeterm:toast', { detail: { kind: 'error', message } }))
      return
    }
    // Through core's chat-prompt path: where it can read the agent's screen, it refuses before
    // writing anything when the agent's own dialog owns the keyboard (such dialogs fire no hook).
    const ok = await api.pty.sendChatPrompt(nodeId, text, agentId)
    if (isChatPromptBlocked(ok)) {
      // Nothing reached the pane: the draft stays for a resend once the dialog is answered.
      setScreenBlock({ kind: ok.dialog === null ? 'no-prompt' : 'dialog', text: ok.dialog, live: pollScreen })
      return
    }
    if (ok === 'pasted-not-submitted') {
      window.dispatchEvent(new CustomEvent('nodeterm:toast', { detail: { kind: 'error', message: TEXT_NOT_SUBMITTED } }))
      setInput('')
      return
    }
    if (!ok) {
      setReadonly(true)
      return
    }
    // Optimistic: show the prompt immediately. A live read keeps it until the transcript carries it
    // (`carryUnconfirmed`); the turn-end reload / ↻ reconcile from the transcript outright.
    setScreenBlock(null)
    justSentRef.current = true
    const sent: ChatMessage = { role: 'user', parts: [{ kind: 'text', text }] }
    if (mode === 'queue') queuedRef.current.add(sent)
    setThread((t) => ({ ...t, messages: [...t.messages, sent] }))
    setOptimistic(true)
    setInput('')
    // A built-in that opens a dialog in the TUI (`/rewind`, `/resume`, `/model`, …) is now on screen
    // THERE, invisible from here, and the state still reads `done`: the next message's Enter would
    // answer it. Go to the terminal — the same hand-off the toolbar's model/effort labels make.
    // Only after the send was confirmed (`ok === true` above): nothing opened otherwise.
    if (onShowTerminal && isInteractiveBuiltin(agentId, text)) {
      onShowTerminal()
      return
    }
    // A local command (`/model`, `!ls`) fires no hook: schedule ONE live tail read, one throttle
    // interval out (claude writes the command record once the command ran), so its confirmation
    // retires the working row instead of the 15 s timeout. A read already in flight defers it.
    if (sentCommand(text)) {
      if (commandReadTimerRef.current !== null) clearTimeout(commandReadTimerRef.current)
      const fire = () => {
        if (tailInFlightRef.current || olderInFlightRef.current) {
          commandReadTimerRef.current = setTimeout(fire, CHAT_LIVE_RELOAD_MIN_MS)
          return
        }
        commandReadTimerRef.current = null
        loadRef.current(true)
      }
      commandReadTimerRef.current = setTimeout(fire, CHAT_LIVE_RELOAD_MIN_MS)
    }
  }, [api, input, nodeId, agentId, onShowTerminal, pollScreen])

  // The scheduled command read belongs to THIS transcript and this mount.
  useEffect(
    () => () => {
      if (commandReadTimerRef.current !== null) clearTimeout(commandReadTimerRef.current)
      commandReadTimerRef.current = null
    },
    [identity]
  )

  const onWriteRefused = useCallback(() => setReadonly(true), [])

  // Answer the held request through core, which validates the answer against the pending request
  // file and builds what the hook prints. `pendingId` is the request the CARD was bound to
  // (`answerCardState`), re-checked at SEND time against both the store and the thread's binding:
  // a hold that ended (answered in the TUI, timed out, replaced) while the user was choosing must
  // not receive an answer meant for it — that reads as a refusal, and the card says to use the
  // terminal. `false` from core is the same (see ChatAnswerControls).
  const answerHeld = useCallback(
    async (pendingId: string, answer: PermissionAnswer): Promise<boolean> => {
      if (useAgentStatus.getState().byId[nodeId]?.held?.pendingId !== pendingId) return false
      if (threadHeldForRef.current !== pendingId) return false
      return api.answerPermission({ nodeId, pendingId, answer })
    },
    [api, nodeId]
  )

  // Whatever the markdown/chat toggle is bound to; '' when unbound, in which case the bar names
  // the action instead of promising a chord that never fires.
  const mdChip = chipFor('node.toggleMarkdown')

  // The thread's claude.ai look (lib/chatThread.ts): one action row per assistant TURN, keyed by
  // the turn's last message. `now` is ONE clock for every row's relative time, ticked once a minute
  // (a per-row timer would be a timer per turn for a label that changes once a minute).
  const turnEnds = useMemo(() => assistantTurnEnds(messages), [messages])
  // The last key IS the latest turn end: `assistantTurnEnds` inserts in thread order.
  const latestTurnEnd = useMemo(() => {
    let last = -1
    for (const k of turnEnds.keys()) last = k
    return last
  }, [turnEnds])
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  // A tail that yielded no message but has history behind it (all-metadata records, or a window a
  // single huge record filled) is STILL LOADING — the panel pages back by itself from here. Saying
  // "No conversation yet." there, until the older page landed, told the user a session with a
  // whole conversation had none. A failed older page gets the retry row instead (below).
  const historyPending = thread.identity === identity && thread.olderCursor !== null
  const initialLoading =
    messages.length === 0 &&
    (loadState === 'loading' || (loadState === 'ok' && historyPending && olderState !== 'error'))
  const showEmpty = messages.length === 0 && loadState !== 'loading' && !(loadState === 'ok' && historyPending)

  return (
    // `data-chat-node-id`: which node's chat view this is — the mics that name only a node ask it
    // (lib/chatComposerDictation.ts `dictationTargetForNode`) so a take never reaches the hidden pane.
    <div className="term-chat nodrag nowheel" data-chat-node-id={nodeId}>
      <div className="term-chat__bar">
        <span>{title ?? 'Chat'}</span>
        <span className="term-chat__bar-end">
          <button
            className="term-chat__refresh"
            onClick={() => load()}
            title="Reload conversation"
            aria-label="Reload conversation"
          >
            ↻
          </button>
          <span className="term-chat__hint">{hint ?? (mdChip ? `${mdChip} to exit` : 'Exit')}</span>
        </span>
      </div>
      <div className="term-chat__msgs" ref={msgsRef} onScroll={onScroll}>
        {initialLoading && (
          <ChatLoadingStatus text={EMPTY_TEXT.loading.title} />
        )}
        {messages.length > 0 && olderState === 'loading' && (
          <div className="term-chat__older" role="status">
            <Spinner />
            <span>Loading earlier messages…</span>
          </div>
        )}
        {olderState === 'error' && (
          <div className="term-chat__older term-chat__older--error">
            <span>Couldn't load earlier messages.</span>
            <button className="term-chat__retry" onClick={loadOlder}>
              Retry
            </button>
          </div>
        )}
        {/* Only a PAGED thread (keyed messages) can know it reached the start; grok's capped
            whole-file read says nothing about what lies before it. */}
        {olderState === 'idle' && thread.olderCursor === null && messages.some((m) => m.key !== undefined) && (
          <div className="term-chat__older term-chat__older--start">Beginning of conversation</div>
        )}
        {showEmpty && (
          <div className="term-chat__empty">
            <div>{EMPTY_TEXT[loadState].title.replace('{agent}', agentLabel)}</div>
            {EMPTY_TEXT[loadState].detail && (
              <div className="term-chat__empty-detail">{EMPTY_TEXT[loadState].detail}</div>
            )}
            {loadState !== 'unsupported' && loadState !== 'remoteUnsupported' && loadState !== 'ambiguous' && loadState !== 'ok' && (
              <button className="term-chat__retry" onClick={() => load()}>
                Retry
              </button>
            )}
          </div>
        )}
        {messages.map((m, i) => (
          // Keyed by the source line's byte offset: a prepended page does not re-key (and so does
          // not re-render) a single existing bubble. Unkeyed ones (grok, the optimistic sent
          // bubble) fall back to their position.
          <div
            key={m.key !== undefined ? `k${m.key}` : `i${i}`}
            className={`term-chat__msg term-chat__msg--${m.role}${m.role === 'user' ? ' term-chat__bubble' : ''}${
              queuedRef.current.has(m) ? ' term-chat__msg--queued' : ''
            }`}
          >
            {m.parts.map((p, j) =>
              p.kind === 'text' ? (
                <MarkdownText key={j} text={p.text} />
              ) : p.kind === 'thinking' ? (
                // Reasoning, not the answer: collapsed by default so it cannot be mistaken for it.
                <details key={j} className="term-chat__thinking">
                  <summary>Thinking</summary>
                  <MarkdownText text={p.text} />
                </details>
              ) : p.body ? (
                // A plan / question is the content itself, not plumbing: shown expanded, in full,
                // flowing with the thread (no inner scroll box). The answer stays under it.
                <div key={j} className="term-chat__tool-card">
                  <div className="term-chat__tool-card-title">{toolCardTitle(p.name)}</div>
                  <MarkdownText text={p.body} />
                  {p.result && <pre className="term-chat__tool-result">{p.result}</pre>}
                  {answerCard && answerCard.card.message === i && answerCard.card.part === j && (
                    // Keyed by the BOUND ticket: a new hold on the same card starts from a clean
                    // state, and every answer names the request this card was drawn for.
                    p.name === 'AskUserQuestion' && p.questions ? (
                      <QuestionAnswerControls
                        key={answerCard.pendingId}
                        questions={p.questions}
                        agentLabel={agentLabel}
                        chip={mdChip}
                        onSubmit={(a) => answerHeld(answerCard.pendingId, a)}
                      />
                    ) : (
                      <PlanAnswerControls
                        key={answerCard.pendingId}
                        agentLabel={agentLabel}
                        chip={mdChip}
                        onSubmit={(a) => answerHeld(answerCard.pendingId, a)}
                      />
                    )
                  )}
                  {updatingCard && updatingCard.message === i && updatingCard.part === j && (
                    <AnswerControlsUpdating chip={mdChip} />
                  )}
                </div>
              ) : (
                <details key={j} className="term-chat__tool">
                  <summary>
                    <span className="term-chat__tool-name">{p.name}</span>
                    {p.arg && <span className="term-chat__tool-arg">{p.arg}</span>}
                  </summary>
                  {p.result && <pre className="term-chat__tool-result">{p.result}</pre>}
                </details>
              )
            )}
            {queuedRef.current.has(m) && <div className="term-chat__queued-label">Queued</div>}
            {turnEnds.has(i) && (
              <ChatTurnActions
                copyText={turnEnds.get(i)!.copyText}
                at={turnEnds.get(i)!.at}
                now={now}
                latest={i === latestTurnEnd}
              />
            )}
          </div>
        ))}
        {screenBlock && (
          <div className="term-chat__screen-block" role="status" aria-live="polite">
            <div className="term-chat__screen-block-title">
              {screenBlockedSentence(screenBlock.kind, agentLabel, mdChip)}
            </div>
            {screenBlock.text !== null && <pre className="term-chat__screen-block-text">{screenBlock.text}</pre>}
          </div>
        )}
        {activity && (
          // One live region for both sentences, so working → waiting changes its text instead of
          // remounting it (a remounted role=status is announced again). The words are the
          // composer placeholder's own (`chatComposerPlaceholder`), so the two never disagree.
          <div className="term-chat__activity" role="status" aria-live="polite">
            {activity === 'working' && <Spinner />}
            {chatComposerPlaceholder({
              readonly: false,
              refusal: activity,
              agentLabel,
              chip: mdChip,
              answerOnCard: answerCard !== null
            })}
          </div>
        )}
      </div>
      {!readOnly && (
        <ChatComposer
          nodeId={nodeId}
          sessionId={sessionId}
          agentId={agentId}
          agentLabel={agentLabel}
          value={input}
          onChange={setInput}
          onSend={() => void send()}
          placeholder={chatComposerPlaceholder({
            readonly,
            refusal,
            agentLabel,
            chip: mdChip,
            answerOnCard: answerCard !== null,
            sendMode,
            screen: screenBlock?.live === true ? screenBlock.kind : null
          })}
          // A dialog the POLL found is also cleared by it; one a refused send found is not (a remote
          // pane is never polled), so that one leaves the draft editable for the resend.
          disabled={readonly || composerStandsDown(refusal) || screenBlock?.live === true}
          agentBusy={refusal === 'working'}
          onWriteRefused={onWriteRefused}
          sendUnconfirmed={optimistic}
          pathsForFiles={pathsForFiles}
          onShowTerminal={onShowTerminal}
          cwd={cwd}
          accountId={accountId}
          sshProjectId={sshProjectId}
        />
      )}
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { quantizeCharSize } from '../../terminal/char-size-quantize'
import { reportsOwnCopy } from '@shared/agents/config'
import type { AgentId } from '@shared/agents/config'
import { effectiveAccountId } from '../../lib/accountChip'
import { readsClaudeTranscript } from '../../lib/transcriptGates'
import { liveProjectJumpTarget } from '../../lib/projectJump'
import { terminalChordBubbles, terminalShortcutPolicy } from '../../lib/keybindingOverrides'
import { FindBar } from '../FindBar'
import { useAgentStatus } from '../../state/agentStatus'
import { useProjects } from '../../state/projects'
import { useSession } from '../../session/session'
import { useSettings } from '../../state/settings'
import { useTerminalSearch } from '../../terminal/useTerminalSearch'
import { LocalTransport } from '../../terminal/local-transport'
import { clipboardImages, droppedPaths, pasteHasText, pastedFiles } from '../../terminal/file-drop'
import { guardMiddleClickPaste } from '../../terminal/middle-click'
import {
  createOsc8LinkHandler,
  createUrlLinkProvider,
  installLinkClickFallback
} from '../../terminal/file-links'
import { parseOsc52 } from '../../terminal/osc52'
import { activateUnicode11 } from '../../terminal/unicode-width'
import { useCopyFeedback } from '../../terminal/useCopyFeedback'
import {
  attachReplay,
  cursorPlacementSeq,
  seedPaint,
  stripTrailingNewline,
  terminalKeyAction,
  toXtermText,
  applyLiveOptions,
  xtermOptionsFromSettings,
  SHIFT_ENTER_SEQ,
  CO_ATTACH_MOUSE_SEQ
} from '../../terminal/terminal-config'
import { installImeGuard } from '../../terminal/ime-guard'
import { useXtermVisualSettings } from '../../terminal/useXtermVisualSettings'
import {
  owningProjectId,
  resolveSshRemote,
  reportSshDrop,
  sshConnectionScope
} from '../../nodes/TerminalNode'
import { buildSshArgs, type SshConnection } from '@shared/ssh'

/** The subset of a node's `data` a SECOND client needs to attach to its session the same way the
 *  canvas TerminalNode does. Canvas fills it from the node's data; sticky/chat cards pass `{}`. */
export interface ModalSpawn {
  shell?: string
  cwd?: string
  agentId?: string
  accountId?: string
  /** The node's `data.ssh` — a local `ssh <host>` node runs ssh as its pty program. */
  ssh?: SshConnection
  /** SSH-project node: tmux runs on the REMOTE host (over the project's ControlMaster). */
  sshRemoteTmux?: boolean
  /** One-shot launch command for a fresh session (agent CLIs). */
  initialCommand?: string
}

/**
 * A SECOND live client on the node's tmux session, living only while the card modal is open.
 *
 * It rides the viewer-identity seam (Task 2a): a per-mount `viewerId` makes this a distinct
 * subscriber of the SAME session as the canvas node — its create/resize/kill co-attach and detach
 * independently, so opening or closing the modal never disturbs the canvas node's client (live or
 * parked). Deliberately minimal vs. TerminalNode: NO park, NO WebGL budget, NO hover-guard — a modal
 * is short-lived and always on top. Closing kills ONLY this viewer (the last-view release stays with
 * the canvas node). The MIRROR-tagged blocks below are copied byte-for-byte from TerminalNode.
 */
interface ModalTerminalProps {
  nodeId: string
  spawn: ModalSpawn
  /** The modal header's 🔍 toggle — the FindBar renders inside this pane. */
  searchOpen: boolean
  onCloseSearch: () => void
}

export function ModalTerminal({ nodeId, spawn, searchOpen, onCloseSearch }: ModalTerminalProps) {
  const { api } = useSession()
  const hostRef = useRef<HTMLDivElement>(null)
  const middleClickPaste = useSettings((st) => st.settings.terminalMiddleClickPaste)
  // Chromium pastes the X PRIMARY selection into xterm's hidden textarea on middle click — a path
  // this app never built and the user could not switch off (issue #84). Its own effect, keyed on
  // the setting alone, so it applies to a PARKED terminal being re-adopted just as much as to a
  // fresh one: the guard belongs to the host ELEMENT, not to the pty lifecycle.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    return guardMiddleClickPaste(host, () => middleClickPaste)
  }, [middleClickPaste])

  const termRef = useRef<Terminal | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  // The live pty session + its fit addon, reachable from OUTSIDE the lifecycle effect's closure —
  // the appearance effect below has to re-fit and re-REPORT this viewer's grid, and under co-attach
  // a report that never happens leaves the shared pty clamped to the pre-change size.
  const sessionIdRef = useRef<string | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const transportRef = useRef<LocalTransport | null>(null)
  const agentSessionId = useAgentStatus((s) => s.byId[nodeId]?.sessionId)
  // MIRROR TerminalNode: transcript READS go to the account the session is actually running as,
  // which for a plain terminal is only ever the observed one. The spawn below keeps
  // `spawn.accountId` — launch identity stays creation-time.
  const observedAccount = useAgentStatus((s) => s.byId[nodeId]?.account)
  // …resolved against the live account list, so linking the dir repoints the reader at once.
  const claudeAccounts = useSettings((s) => s.settings.claudeAccounts)
  // One shallow-compared subscription for the whole appearance slice — see useXtermVisualSettings.
  // MIRROR TerminalNode: scoped to the OWNING project (`owningProjectId`, the active one — a modal
  // only ever opens over it), deliberately NOT this card's connection scope. `sshConnectionScope`
  // answers a project×host attachment id for a session on a foreign host, which names no project at
  // all — the per-project appearance would silently vanish for exactly those cards.
  const visual = useXtermVisualSettings(owningProjectId())
  const [dropping, setDropping] = useState(false)
  const [uploading, setUploading] = useState(false)
  // Same copy feedback as the canvas node — a copy here is the same act as a copy there, including
  // the agent gate: a claude card stays silent because claude prints its own copy line.
  const copy = useCopyFeedback({
    hostRef,
    hasSelection: () => !!termRef.current?.hasSelection(),
    enabled: !reportsOwnCopy(spawn.agentId as AgentId | undefined)
  })

  // Same search machinery as the canvas node: capture-indexed matches + xterm highlight.
  const readBuffer = useCallback((): string => {
    const b = termRef.current?.buffer.active
    if (!b) return ''
    const lines: string[] = []
    for (let i = 0; i < b.length; i++) lines[i] = b.getLine(i)?.translateToString() ?? ''
    return lines.join('\n')
  }, [])
  const search = useTerminalSearch({
    nodeId,
    sessionId: agentSessionId,
    cwd: spawn.cwd,
    accountId: effectiveAccountId(spawn.accountId, observedAccount, claudeAccounts),
    // MIRROR TerminalNode: the transcript index reads claude's JSONL through claude's resolver, so
    // it is gated on the claude-transcript fact, NOT on the context meter's `hasUsage` (which now
    // spans codex and gemini too) — see lib/transcriptGates.ts.
    searchTranscript: readsClaudeTranscript(spawn.agentId),
    open: searchOpen,
    readBuffer
  })
  // MIRROR TerminalNode's findOpts — one source for the highlight colors.
  const findOpts = {
    decorations: {
      matchBackground: '#ffd54f55',
      activeMatchBackground: '#ffb300',
      matchOverviewRuler: '#ffd54f',
      activeMatchColorOverviewRuler: '#ffb300'
    }
  }
  const handleNext = useCallback(() => {
    search.next()
    if (search.query.trim()) searchAddonRef.current?.findNext(search.query, findOpts)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])
  const handlePrev = useCallback(() => {
    search.prev()
    if (search.query.trim()) searchAddonRef.current?.findPrevious(search.query, findOpts)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  useEffect(() => {
    // A unique viewerId per mount: the core namespaces it per connection, so uniqueness only has to
    // hold within THIS window. It makes the modal a second subscriber of the node's shared session.
    const viewerId = `modal-${nodeId}-${Math.random().toString(36).slice(2, 8)}`
    const transport = new LocalTransport(api, viewerId)
    const s = useSettings.getState().settings
    // Appearance comes from the SAME source as the canvas node's terminal — this modal is a second
    // view of one session, and a card that renders it in different colours reads as a different
    // terminal. (It used to hardcode its own background, which is exactly what happened.)
    const term = new Terminal(xtermOptionsFromSettings(s))
    installImeGuard(term)
    // Without a handler xterm answers an OSC 8 click with a window.confirm — the one surface
    // where this session's links would prompt instead of opening like the canvas node's.
    term.options.linkHandler = createOsc8LinkHandler((uri) =>
      window.nodeTerminal.shell.openExternal(uri)
    )
    // The modal is a second view of the SAME tmux session, so it has to measure characters the way
    // the canvas node does. Two views on two width tables would disagree about where the columns
    // are — and the pty runs at the SMALLEST subscriber's grid, so the disagreement would be live.
    activateUnicode11(term)
    const fit = new FitAddon()
    term.loadAddon(fit)
    const searchAddon = new SearchAddon()
    term.loadAddon(searchAddon)
    termRef.current = term
    searchAddonRef.current = searchAddon
    fitRef.current = fit
    transportRef.current = transport
    term.open(hostRef.current!)
    // Renderer-parity with the canvas terminals (see char-size-quantize): the modal co-views
    // the same session, so its column math must match what the canvas draws.
    quantizeCharSize(term)
    fit.fit()

    let sessionId: string | null = null
    let dead = false
    const cleanups: Array<() => void> = []

    // MIRROR TerminalNode's link wiring, minus file links. The provider handles Cmd/Ctrl+click on
    // URL text when mouse-reporting is off (plain-shell sessions); the capture-phase fallback is
    // what works under tmux/agent mouse-reporting — the norm, and the only path on which the OSC 8
    // linkHandler above can ever fire in a tmux-backed session (xterm's own link activation is
    // swallowed by the mouse report, see installLinkClickFallback). File links stay a canvas-node
    // affordance: the modal has no project-fs/dialect routing, and resolving a path against the
    // wrong machine is worse than not linking it — hence fileEnabled: false, not stub deps that
    // pretend to resolve.
    const openUrl = (uri: string): void => window.nodeTerminal.shell.openExternal(uri)
    term.registerLinkProvider(createUrlLinkProvider(term, openUrl))
    if (term.element) {
      cleanups.push(
        installLinkClickFallback(term, term.element, {
          getCwd: () => undefined,
          lookup: () => Promise.resolve({ exists: false, dir: false }),
          activateFile: () => {},
          openUrl,
          fileEnabled: () => false
        }).dispose
      )
    }

    // MIRROR TerminalNode "WRITE-ONLY — `parseOsc52` returns null" — the OSC 52 clipboard-write path.
    // tmux's mouse is ON, so a drag-select in copy-mode emits OSC 52 to this client; this handler
    // writes the system clipboard. `parseOsc52` returns null for a `?` read query so a remote program
    // can never read the local clipboard. Returning true swallows the sequence (also the read query).
    term.parser.registerOscHandler(52, (data) => {
      const text = parseOsc52(data)
      if (text !== null) {
        window.nodeTerminal.clipboard.writeText(text)
        copy.notifyCopy(text)
      }
      return true
    })

    // MIRROR TerminalNode "const action = terminalKeyAction" — Cmd+C / Ctrl+Shift+C / Ctrl+Insert copy
    // the xterm selection (a canvas can't be DOM-copied), and Shift+Enter → ESC+CR (`SHIFT_ENTER_SEQ`)
    // so agent CLIs insert a newline instead of submitting. A copy chord is always swallowed (else
    // Ctrl+Shift+C would fall through to the pty as \x03/SIGINT); plain Ctrl+C is left alone.
    // MIRROR TerminalNode: Cmd/Ctrl+1-9 (jump to the Nth project) is swallowed here, before xterm
    // turns Ctrl+2..Ctrl+8 into control bytes — but only when the app owns the key (desktop shell,
    // digit addressing an open project, AND app-first: under terminal-first the digit belongs to
    // the PTY), which `liveProjectJumpTarget` + the policy decide for both surfaces.
    term.attachCustomKeyEventHandler((e) => {
      const ownsProjectJump =
        terminalShortcutPolicy() !== 'terminal-first' && liveProjectJumpTarget(e) !== null
      // MIRROR TerminalNode's registryOwns — but with `kanbanOpen: true` ALWAYS: the modal only
      // exists over the board, where the resolver refuses canvas-scope commands (directional
      // focus etc. mean nothing here), so those chords keep reaching the pty; app-scope
      // allowInTerminal commands still bubble, matching what the dispatcher would claim.
      const registryOwns = terminalChordBubbles(e, true)
      const action = terminalKeyAction(e, term.hasSelection(), ownsProjectJump, registryOwns)
      if (action === 'pass') return true
      // 'bubble': hand the chord to the window dispatcher — no preventDefault (it bails on
      // defaultPrevented), no xterm processing. 'native' leaves the event uncancelled for the
      // PLATFORM's own paste (Windows Ctrl+V). See TerminalNode's twin comment.
      if (action === 'bubble' || action === 'native') return false
      e.preventDefault()
      if (action === 'copy') window.nodeTerminal.clipboard.writeText(term.getSelection())
      else if (action === 'shift-enter' && sessionId) transport.write(sessionId, SHIFT_ENTER_SEQ)
      return false
    })

    void (async () => {
      // Read here, not at click time: a modal only ever opens over the ACTIVE project, and the
      // reconnect coordinator is keyed by CONNECTION SCOPE (same choice resolveSshRemote makes) —
      // the project's own id, or the host attachment when this card's session is on a machine the
      // project isn't.
      const projectId =
        spawn.sshRemoteTmux && spawn.ssh
          ? sshConnectionScope(spawn.ssh)
          : useProjects.getState().activeProjectId
      // SSH-project node: resolve the live ControlMaster (may not be up yet on a cold load).
      const sshRemote =
        spawn.sshRemoteTmux && spawn.ssh
          ? await resolveSshRemote(spawn.ssh, spawn.cwd)
          : undefined
      if (dead) return
      // The host is unreachable: spawn NOTHING. A create with no `sshRemote` falls through to
      // core's LOCAL tmux branch, and opening a card for a remote session would silently start a
      // local shell under that node's id — see PtyCreateOptions.requireRemote. The card says so
      // and the node is queued for the reconnect coordinator, exactly like the canvas node.
      if (spawn.sshRemoteTmux && !sshRemote) {
        term.write(
          `\r\n\x1b[90m[not connected — this session lives on ${spawn.ssh ? `${spawn.ssh.user}@${spawn.ssh.host}` : 'the remote host'}; nothing was started locally]\x1b[0m\r\n`
        )
        if (projectId) reportSshDrop(projectId, nodeId)
        return
      }
      // A local `ssh <host>` node runs ssh as its own pty program (shell:'ssh' + buildSshArgs); an
      // SSH-PROJECT node uses tmux on the remote host instead (sshRemote), so it is NOT localSsh.
      const localSsh = !!spawn.ssh && !spawn.sshRemoteTmux
      const res = await transport.create({
        cols: term.cols,
        rows: term.rows,
        shell: localSsh ? 'ssh' : spawn.shell,
        shellArgs: localSsh ? buildSshArgs(spawn.ssh!) : undefined,
        cwd: spawn.cwd,
        persistKey: nodeId,
        // Pane-ownership ledger parity with TerminalNode (agent messaging, PR #237 fix round 2):
        // if this modal is ever the FIRST/sole fresh spawner of the node (a card for a node whose
        // project is not the active canvas), the pane must still record its true owner. Use the
        // CARD's project resolved above, NOT the active canvas id — the modal may be for a
        // non-active project. Recorded main-side only on a genuine fresh spawn.
        ownerProjectId: projectId,
        agentId: spawn.agentId,
        accountId: spawn.accountId,
        sshRemote,
        requireRemote: spawn.sshRemoteTmux
      })
      // Refused core-side (the master died inside our round-trip, or `ssh` is missing).
      if (res.unavailable) {
        term.write('\r\n\x1b[90m[not connected — nothing was started locally]\x1b[0m\r\n')
        if (projectId) reportSshDrop(projectId, nodeId)
        return
      }
      // Another client permanently deleted this node's session — never resurrect it (no live session
      // to join, and the tombstone refused a fresh spawn). Show the state and stop.
      if (res.closed) {
        term.write('\r\n\x1b[90m[session closed by another user]\x1b[0m\r\n')
        return
      }
      // Unmounted while the create was in flight: detach the viewer we just registered so it doesn't
      // linger as a phantom subscriber constraining the shared pty's size.
      if (dead) {
        transport.kill(res.sessionId)
        return
      }
      sessionId = res.sessionId
      sessionIdRef.current = res.sessionId
      cleanups.push(transport.onData(res.sessionId, (d) => term.write(d)))
      cleanups.push(
        transport.onExit(res.sessionId, () =>
          term.write('\r\n\x1b[90m[session ended]\x1b[0m\r\n')
        )
      )
      // The pty runs at the SMALLEST subscriber's grid; render exactly what it tells us and letterbox
      // the rest (the canvas node votes independently — the modal's smaller pane may shrink it).
      if (transport.onSize)
        cleanups.push(
          transport.onSize(res.sessionId, (size) => term.resize(size.cols, size.rows))
        )
      term.onData((d) => sessionId && transport.write(sessionId, d))
      // DELIBERATELY omitted vs. TerminalNode: no flow-control pause (transport.setFlow) and no
      // onResync handler. The pty's pacing/backpressure comes from the canvas node's client — the
      // modal is a transient, always-on-top second view and never drives the shared session's flow.

      // A fresh (cold-restart / first-open) session's tmux pane is gone, so replay the persisted
      // scrollback. A warm join is painted from the server-captured screen inside create(). Agent
      // auto-resume is deliberately canvas-only — the modal never re-launches a CLI. Both the
      // snapshot and `res.screen` come from `capture-pane -p` (LF-separated, no CR bytes) and this
      // xterm runs with convertEol:false, so they MUST go through toXtermText or they staircase.
      const snapshot = res.fresh ? await api.pty.readScrollback(nodeId) : null
      // The read above is a suspension point: bail if the modal closed while it was in flight, so we
      // never write into a disposed xterm or observe a null host ref (mirrors TerminalNode's
      // post-await onDisposed check).
      if (dead) return
      const paint = seedPaint({
        replay: attachReplay({ parked: false, fresh: res.fresh, hasInitialCommand: false }),
        superseded: false,
        snapshot,
        screen: res.screen
      })
      if (paint === 'snapshot') {
        if (snapshot) term.write(toXtermText(snapshot))
        term.write('\r\n\x1b[90m— cold start · agent auto-resume happens on canvas —\x1b[0m\r\n')
      } else if (paint === 'create-screen' && res.screen) {
        // Start from a known-clean SGR state, then convert the capture's LFs to CRLFs.
        term.write('\x1b[0m' + toXtermText(stripTrailingNewline(res.screen)))
        // The capture is TEXT, so the paint above left the cursor after its last character rather
        // than where the pane has it. The modal is a co-attach joiner by definition — it is the
        // path this affects most, not an edge case (see `cursorPlacementSeq`).
        term.write(cursorPlacementSeq(res.cursor))
      }

      // Co-attach joiners miss the mouse-tracking mode tmux only sends at its own attach, so the
      // wheel can't scroll tmux history until a keystroke wakes it. Enable it here (see
      // CO_ATTACH_MOUSE_SEQ). Painting content first, then the modes, keeps the seed untouched.
      if (res.coAttachMouse) term.write(CO_ATTACH_MOUSE_SEQ)

      const ro = new ResizeObserver(() => {
        fit.fit()
        if (sessionId) transport.resize(sessionId, term.cols, term.rows)
      })
      ro.observe(hostRef.current!)
      cleanups.push(() => ro.disconnect())
      transport.resize(res.sessionId, term.cols, term.rows)
      term.focus()
    })()

    return () => {
      dead = true
      cleanups.forEach((fn) => fn())
      // Kill ONLY this modal's viewer — the instance appends its viewerId. The canvas node's PRIMARY
      // (or parked) client is a different composite subscriber and is untouched; the shared pty lives
      // on until its last view goes.
      if (sessionId) transport.kill(sessionId)
      term.dispose()
      sessionIdRef.current = null
      fitRef.current = null
      transportRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId])

  // Live-apply the appearance settings, mirroring the canvas node's effect (see TerminalNode) —
  // without this the modal kept whatever it was built with, so changing the font or the theme with
  // a card open changed the canvas terminal and left its own second view of the SAME session
  // looking different until the modal was reopened.
  //
  // Re-fitting here is not cosmetic: this viewer is a co-attach subscriber, and the pty runs at the
  // smallest subscriber's grid. A viewer that changes its cell geometry without re-reporting keeps
  // clamping the shared pty to its pre-change size — i.e. shrinks the canvas terminal too.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    const { metricsChanged } = applyLiveOptions(term, visual)
    if (!metricsChanged) return
    fitRef.current?.fit()
    const sid = sessionIdRef.current
    if (sid) transportRef.current?.resize(sid, term.cols, term.rows)
  }, [visual])

  // File drop → paste the path(s) into the co-attached session, just like the canvas node.
  const onDragOver = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (!dropping) setDropping(true)
  }
  const onDragLeave = (e: React.DragEvent) => {
    const rt = e.relatedTarget as Node | null
    if (!rt || !(e.currentTarget as HTMLElement).contains(rt)) setDropping(false)
  }
  /** Drop and paste share one path — same rule as the canvas node (see TerminalNode.insertFiles):
   *  files become paths in the terminal, and only the window-raise differs. */
  const insertFiles = async (files: File[], opts: { raiseWindow: boolean }) => {
    const term = termRef.current
    if (!term || !files.length) return
    // Clipboard bytes must be written before they have a path, which is not instant either.
    const needsWrite = files.some((f) => !window.nodeTerminal.getPathForFile(f))
    let paths: string[]
    if (spawn.sshRemoteTmux) {
      // Uploads go over the master this card's PTY runs on — its scope, not the project's.
      const projectId = spawn.ssh
        ? sshConnectionScope(spawn.ssh)
        : useProjects.getState().activeProjectId
      setUploading(true)
      try {
        paths = await droppedPaths(files, { sshRemoteTmux: true, projectId })
      } finally {
        setUploading(false)
      }
    } else if (needsWrite) {
      setUploading(true)
      try {
        paths = await droppedPaths(files, { sshRemoteTmux: false, projectId: '' })
      } finally {
        setUploading(false)
      }
    } else {
      paths = await droppedPaths(files, { sshRemoteTmux: false, projectId: '' })
    }
    if (!paths.length) return
    // A drag-drop from another OS app doesn't bring our window forward (esp. macOS), so the
    // drag-source keeps keyboard focus — the user's next keystrokes would land in the wrong app.
    // Raise our window FIRST, then focus the terminal, so typing after the drop reaches it.
    // A paste came from this window, which already has focus.
    if (opts.raiseWindow) window.nodeTerminal.focusWindow()
    term.focus()
    term.paste(paths.join(' ') + ' ')
  }

  const onDrop = async (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer.files)
    setDropping(false)
    if (!files.length) return
    e.preventDefault()
    e.stopPropagation()
    await insertFiles(files, { raiseWindow: true })
  }

  // Cmd/Ctrl+V of a file or of raw image bytes; a text paste falls through to xterm untouched.
  // Capture phase, because xterm's own paste listener sits on the textarea below this wrapper.
  const onPaste = (e: React.ClipboardEvent) => {
    const files = pastedFiles(e.clipboardData)
    if (files.length) {
      e.preventDefault()
      e.stopPropagation()
      void insertFiles(files, { raiseWindow: false })
      return
    }
    // Files nor text — the filtered image-only clipboard. Same fallback as the canvas node.
    if (pasteHasText(e.clipboardData)) return
    void clipboardImages().then((images) => {
      if (images.length) void insertFiles(images, { raiseWindow: false })
    })
  }

  return (
    <div
      className={`kanban-modal__termwrap${dropping ? ' kanban-modal__termwrap--drop' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onPasteCapture={onPaste}
    >
      {uploading && <div className="kanban-modal__upload">Uploading…</div>}
      {/* Same pill, same class, same corner as the canvas node — one session seen twice should
          not speak in two different voices. */}
      {copy.feedback && (
        <div className={`term-copy-pill term-copy-pill--${copy.feedback.kind}`}>
          {copy.feedback.label}
        </div>
      )}
      {searchOpen && (
        <FindBar
          query={search.query}
          onQueryChange={search.setQuery}
          matchIndex={search.matchIndex}
          matchCount={search.matchCount}
          current={search.current}
          onNext={handleNext}
          onPrev={handlePrev}
          onClose={onCloseSearch}
        />
      )}
      <div ref={hostRef} className="kanban-modal__term" />
    </div>
  )
}

import { TEXT_NOT_SUBMITTED } from '@shared/text-delivery'
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type Dispatch,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction
} from 'react'
import { useAgentStatus } from '../state/agentStatus'
import { useSession } from '../session/session'
import { useContextUsage } from '../state/contextWindow'
import { chatSendRefusal } from '../lib/chatSendGate'
import { chatKeyAction } from '../lib/chatPanel'
import { appendToComposer, composerLabels, composerPickerCommand, type ComposerPicker } from '../lib/chatComposer'
import { requestComposerDictation, subscribeComposerDictation } from '../lib/chatComposerDictation'
import { clipboardImages, pasteHasText, pastedFiles } from '../terminal/file-drop'
import { takeComposerFocusRequest } from '../terminal/useMdModeFocus'
import { IconMic, IconPlus } from '../components/icons'
import { Spinner } from '../components/Spinner'
import { builtinSlashCommands, sanitizeChatCatalog, type ChatCatalogEntry } from '@shared/chat-catalog'
import { prepareQuickOpenFiles, type QuickOpenIndexedFile } from '../lib/quickOpenSearch'
import { commandSegments, mentionsSlashToken } from '../lib/chatComposerHighlight'
import { SHELL_MODE_HINT, draftFromDisplay, isShellDraft, shellDisplayText, showsShellMode } from '../lib/chatShellMode'
import {
  KEYBOARD_STEP_PX,
  completeMenuMax,
  composerHeight,
  readComposerHeight,
  writeComposerHeight
} from '../lib/chatComposerHeight'
import { useChatDraft } from '../state/chatDraft'

/** How long the composer shows why a terminal draft was not carried over. */
const CARRY_NOTE_MS = 12_000
import {
  CATALOG_REUSE_MS,
  applyCompletion,
  catalogEntryTag,
  completionItems,
  completionTriggerAt,
  type CompletionItem,
  type CompletionTrigger
} from '../lib/chatComposerComplete'

export interface ChatComposerProps {
  nodeId: string
  sessionId?: string
  agentId: string
  /** The node's agent, as the placeholder and tooltips name it. */
  agentLabel: string
  /** The draft. Owned by ChatPanel, whose `send` reads it and whose optimistic bubble clears it. */
  value: string
  onChange: Dispatch<SetStateAction<string>>
  /** Enter (not Shift+Enter, not an IME commit). ChatPanel's send re-checks the gate itself. */
  onSend: () => void
  placeholder: string
  /**
   * The prompt the agent suggests next (`readClaudeSuggestion`), already shown as the placeholder by
   * ChatPanel. With an empty draft, → fills the draft with it and puts the caret at the end, as →
   * does in Claude Code's own TUI. It is never sent: Enter stays the user's.
   */
  suggestion?: string | null
  /** Read-only session or a send-gate refusal: the whole composer stands down with the textarea.
   *  Not while the agent merely works — see `agentBusy`. */
  disabled: boolean
  /**
   * The agent is mid-turn. The draft stays editable (a disabled textarea drops focus, and the user
   * could not type their next message while a reply was being written) and Enter is ChatPanel's to
   * gate (it may queue). The picker labels stand down: a `/model` typed now would land in the turn.
   */
  agentBusy?: boolean
  /** A picker command the pane refused outright (`sendText` → false): the session is not writable. */
  onWriteRefused: () => void
  /**
   * A message was just sent and no hook event has confirmed the turn yet (ChatPanel's `optimistic`,
   * #953). The gate still reads `done` in that window, but the agent is about to be working — a
   * `/model` typed now would land in (or queue behind) the turn being started. The picker labels
   * stand down until the real state speaks.
   */
  sendUnconfirmed?: boolean
  /** See ChatPanelProps. */
  pathsForFiles?: (files: File[]) => Promise<string[]>
  /** See ChatPanelProps. */
  onShowTerminal?: () => void
  /** The node's working directory — the root `@` completes under (never above it), and the project
   *  whose custom commands and skills the `/` menu lists. Absent = no `@` list. */
  cwd?: string
  /** The account the session runs as: whose config dir holds its commands and skills. */
  accountId?: string
  /** An SSH node's project scope (the one its attach uploads to): `@` lists the HOST's files over
   *  that project's master. Absent = the session's own `files.quickOpen` (local, or a relay peer's). */
  sshProjectId?: string
}

/**
 * The ⌘M chat composer, claude.ai-style: one rounded box, the textarea on top and a toolbar under
 * it — "+" attach on the left; model label, muted effort label and the mic on the right. The pure
 * decisions are lib/chatComposer.ts; this is the glue. Split out of ChatPanel so the thread and the
 * composer can be restyled independently.
 */
export function ChatComposer({
  nodeId,
  sessionId,
  agentId,
  agentLabel,
  value,
  onChange,
  onSend,
  placeholder,
  suggestion = null,
  disabled,
  agentBusy = false,
  onWriteRefused,
  sendUnconfirmed = false,
  pathsForFiles,
  onShowTerminal,
  cwd,
  accountId,
  sshProjectId
}: ChatComposerProps) {
  const { api } = useSession()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Per-MOUNT id, not the node id: the canvas node and the kanban card modal can both have this
  // session's composer mounted, and a dictated take must land in the one whose mic was clicked.
  const composerId = useId()
  // The model / effort the header ContextMeter shows, from the SAME reader (no second transcript
  // read). Never node-scoped: that is for remote Codex, which never mounts this panel.
  const usage = useContextUsage({ sessionId, nodeId, scoped: false })
  const [composerWidth, setComposerWidth] = useState<number | null>(null)
  const [attachNote, setAttachNote] = useState<{ text: string; failed?: boolean } | null>(null)
  // Why a terminal draft was not carried over on the last ⌘M flip (lib/chatDraftCarry.ts). Editing
  // the draft clears it (the store does); otherwise it goes after CARRY_NOTE_MS.
  const carryNote = useChatDraft((s) => s.notes[nodeId] ?? null)
  useEffect(() => {
    if (carryNote === null) return
    const t = setTimeout(() => useChatDraft.getState().setNote(nodeId, null), CARRY_NOTE_MS)
    return () => clearTimeout(t)
  }, [carryNote, nodeId])
  const [dropping, setDropping] = useState(false)
  // A picker command on its way into the pane. `/model` and `/effort` are local pickers that fire
  // NO hook, so the agent state stays `done` and the send gate stays open: a second click (or an
  // Enter) while the first `sendText` is still in flight — easy over SSH — would paste the command
  // plus Enter INTO the picker the first one just opened, and Enter confirms its highlighted
  // option. The ref is the guard (read synchronously); the state only renders it.
  const pickerBusyRef = useRef(false)
  const sendUnconfirmedRef = useRef(sendUnconfirmed)
  sendUnconfirmedRef.current = sendUnconfirmed
  const [pickerBusy, setPickerBusy] = useState(false)
  const labels = composerLabels({ agentId, model: usage?.model, effort: usage?.effort, width: composerWidth })

  // ── Completion (`/` and `@`) ─────────────────────────────────────────────────────────────────
  // The trigger is DERIVED at render from the draft and the caret — and the caret is only known for
  // the exact draft it was read with (`caretSnap.value`). Any change to the draft that did not come
  // through this textarea (the send clearing it after its async pane check, dictation, an attach,
  // an accept) leaves the snapshot describing another text, so the menu is closed until the user
  // types or moves the caret again; an accept can therefore never replace a range of a draft it did
  // not see. A disabled composer derives nothing. The lists are fetched on the first `/` or `@` of
  // this mount and reused for CATALOG_REUSE_MS (nothing is fetched while nobody types a trigger).
  // Until the core catalog answers — and for good on a surface that has none (a relay tab) — the `/`
  // menu shows the shared built-in table for this agent.
  const listboxId = useId()
  // Shell mode (lib/chatShellMode.ts): a draft starting with `!` shows its `!` beside the textarea,
  // not in it. The completion below then stands down by itself: the caret snapshot holds the TEXT
  // the textarea shows, which is not the draft, so no trigger is derived (Claude's TUI offers no
  // `/` menu in shell mode either).
  const shell = showsShellMode(agentId) && isShellDraft(value)
  const display = shellDisplayText(value, shell)
  const shellHintId = useId()
  // Where to put the caret after the textarea's text shifted by the `!` (entering or leaving shell
  // mode): a controlled value change moves it to the end.
  const pendingCaretRef = useRef<number | null>(null)
  useLayoutEffect(() => {
    const at = pendingCaretRef.current
    const el = inputRef.current
    if (at === null || el === null) return
    pendingCaretRef.current = null
    el.setSelectionRange(at, at)
    // Keyed on the DRAFT: typing `!` into an empty box changes the draft but not what is shown.
  }, [value])
  const [caretSnap, setCaretSnap] = useState<{ value: string; start: number; end: number } | null>(null)
  const trigger: CompletionTrigger | null =
    !disabled && caretSnap && caretSnap.value === value ? completionTriggerAt(value, caretSnap.start, caretSnap.end) : null
  const lastTokenRef = useRef<string | null>(null)
  const closeMenu = useCallback(() => setCaretSnap(null), [])
  const [activeIdx, setActiveIdx] = useState(0)
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  const [catalog, setCatalog] = useState<ChatCatalogEntry[]>(() => builtinSlashCommands(agentId))
  const [fileIndex, setFileIndex] = useState<QuickOpenIndexedFile[] | null>(null)
  const catalogAtRef = useRef(0)
  const scopeKeyRef = useRef('')
  const filesAtRef = useRef(0)
  const scopeKey = `${agentId}\u0000${accountId ?? ''}\u0000${cwd ?? ''}\u0000${sshProjectId ?? ''}`
  scopeKeyRef.current = scopeKey
  useEffect(() => {
    // A different node scope (the card modal reuses a mount across sessions only via `key`, but be
    // exact): forget what was fetched for the old one.
    catalogAtRef.current = 0
    filesAtRef.current = 0
    setCatalog(builtinSlashCommands(agentId))
    setFileIndex(null)
  }, [scopeKey, agentId])

  const ensureLists = useCallback(
    (kind: CompletionTrigger['kind']) => {
      const now = Date.now()
      if (kind === 'slash' && now - catalogAtRef.current > CATALOG_REUSE_MS) {
        catalogAtRef.current = now
        const key = scopeKey
        Promise.resolve()
          .then(() => api.chat.catalog(nodeId, agentId, accountId, cwd))
          .then((c) => sanitizeChatCatalog(c).entries)
          .catch(() => builtinSlashCommands(agentId))
          .then((entries) => {
            if (key === scopeKeyRef.current) setCatalog(entries)
          })
      }
      if (kind === 'file' && cwd && now - filesAtRef.current > CATALOG_REUSE_MS) {
        filesAtRef.current = now
        const key = scopeKey
        Promise.resolve()
          .then(() => (sshProjectId ? window.nodeTerminal.sshFs.quickOpen(sshProjectId, cwd) : api.files.quickOpen(cwd)))
          .catch(() => [] as string[])
          .then((files) => {
            if (key === scopeKeyRef.current) setFileIndex(prepareQuickOpenFiles(Array.isArray(files) ? files : []))
          })
      }
    },
    [api, nodeId, agentId, accountId, cwd, sshProjectId, scopeKey]
  )
  const syncTrigger = useCallback(
    (text: string, caret: number, selEnd: number) => {
      setCaretSnap({ value: text, start: caret, end: selEnd })
      const t = disabled ? null : completionTriggerAt(text, caret, selEnd)
      // A new token starts at the top of its list; typing within the same token keeps the place.
      const token = t ? `${t.kind}:${t.start}` : null
      if (token !== lastTokenRef.current) setActiveIdx(0)
      lastTokenRef.current = token
      if (t) ensureLists(t.kind)
      // A `/name` anywhere in the draft is colored once the catalog knows it (below), so a draft that
      // holds one asks for the catalog even with no menu open.
      else if (mentionsSlashToken(text)) ensureLists('slash')
    },
    [disabled, ensureLists]
  )
  // Known `/commands` in the draft, drawn colored in a layer behind the textarea
  // (lib/chatComposerHighlight.ts). Null = none: the textarea renders exactly as it always did. While
  // there is one, spell checking is off for the whole draft — a textarea can only check all of its
  // text or none, and a command name is not a word. A half-typed `/tid` keeps its underline: until it
  // names a command, it is a misspelling.
  const knownNames = useMemo(() => new Set(catalog.map((e) => e.name)), [catalog])
  // None in shell mode: the line is a shell command, not a prompt.
  const segments = useMemo(() => (shell ? null : commandSegments(value, knownNames)), [shell, value, knownNames])
  const highlightRef = useRef<HTMLDivElement>(null)
  const syncHighlightScroll = useCallback(() => {
    const ta = inputRef.current
    const hl = highlightRef.current
    if (ta === null || hl === null) return
    // A visible scrollbar narrows the textarea's text; the layer must wrap at the same width.
    hl.style.paddingRight = `${6 + Math.max(0, ta.offsetWidth - ta.clientWidth)}px`
    hl.scrollTop = ta.scrollTop
  }, [])
  useLayoutEffect(syncHighlightScroll, [segments, syncHighlightScroll])

  // The textarea's height (lib/chatComposerHeight.ts): it grows with the draft, or keeps the height
  // the user dragged the grip to. Set by hand, never through a style prop: the auto-grow has to
  // measure the draft at the textarea's natural height first.
  const composeRef = useRef<HTMLDivElement>(null)
  const [setHeight, setSetHeight] = useState<number | null>(readComposerHeight)
  /** The `/` and `@` menu's max-height follows the room above the composer (a custom property on
   *  the composer root, read by `.term-chat__complete`), so it never runs under the panel header. */
  const sizeCompleteMenu = useCallback((inner: number, composer: number) => {
    const max = completeMenuMax({ inner, composer })
    const el = composeRef.current
    if (el === null) return
    if (max === null) el.style.removeProperty('--chat-complete-max')
    else el.style.setProperty('--chat-complete-max', `${max}px`)
  }, [])
  /** The bounds to size against, measured with the textarea at its natural (two-row) height. Null
   *  while it has no box (a collapsed node): there is nothing to measure. */
  const measureInput = useCallback(() => {
    const ta = inputRef.current
    if (ta === null) return null
    const top = ta.scrollTop
    ta.style.height = 'auto'
    const min = ta.offsetHeight
    if (min === 0) {
      ta.style.height = ''
      return null
    }
    // Inner space: from the top of the thread to the bottom of the composer (both children of the
    // panel). The thread flexes, so this does not change with the textarea's height.
    const compose = composeRef.current
    const thread = ta.closest('.term-chat')?.querySelector<HTMLElement>(':scope > .term-chat__thread')
    const inner =
      compose === null || thread === null || thread === undefined
        ? 0
        : compose.offsetTop + compose.offsetHeight - thread.offsetTop
    const chrome = (compose?.offsetHeight ?? min) - min
    return { ta, top, min, content: ta.scrollHeight, inner, chrome }
  }, [])
  const fitInput = useCallback(() => {
    const m = measureInput()
    if (m === null) return
    const height = composerHeight({ ...m, set: setHeight })
    m.ta.style.height = `${height}px`
    sizeCompleteMenu(m.inner, height + m.chrome)
    // Collapsing to the natural height for the measurement moved the scroll; put it back.
    m.ta.scrollTop = m.top
    syncHighlightScroll()
  }, [measureInput, setHeight, sizeCompleteMenu, syncHighlightScroll])
  useLayoutEffect(fitInput, [value, fitInput])
  // A resized panel (node resize, a collapsed node expanded) changes the bounds.
  useEffect(() => {
    const panel = inputRef.current?.closest('.term-chat')
    if (panel === null || panel === undefined || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => fitInput())
    ro.observe(panel)
    return () => ro.disconnect()
  }, [fitInput])
  /** Sets the height to `target` (clamped as it will be drawn) and, when `save`, remembers it. */
  const resizeInput = (target: number | null, save: boolean) => {
    if (target === null) {
      setSetHeight(null)
      if (save) writeComposerHeight(null)
      return
    }
    const m = measureInput()
    const next = m === null ? Math.round(target) : composerHeight({ ...m, set: target })
    if (m !== null) {
      m.ta.style.height = `${next}px`
      sizeCompleteMenu(m.inner, next + m.chrome)
    }
    setSetHeight(next)
    if (save) writeComposerHeight(next)
  }
  const dragRef = useRef<{ pointerId: number; startY: number; startHeight: number; scale: number } | null>(null)
  const onGripPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const ta = inputRef.current
    if (e.button !== 0 || ta === null) return
    // The canvas zoom scales the node: a screen pixel of pointer travel is not a layout pixel.
    const scale = ta.offsetHeight > 0 ? ta.getBoundingClientRect().height / ta.offsetHeight : 1
    dragRef.current = {
      pointerId: e.pointerId,
      startY: e.clientY,
      startHeight: ta.offsetHeight,
      scale: scale > 0 ? scale : 1
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onGripPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (d === null || d.pointerId !== e.pointerId) return
    // The grip is on the TOP edge: dragging up makes the box taller.
    resizeInput(d.startHeight + (d.startY - e.clientY) / d.scale, false)
  }
  const onGripPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (d === null || d.pointerId !== e.pointerId) return
    dragRef.current = null
    resizeInput(d.startHeight + (d.startY - e.clientY) / d.scale, true)
  }
  // A cancelled drag (the system took the pointer) keeps the height it reached: a cancel event's
  // coordinates are not a position the user chose.
  const onGripPointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (d === null || d.pointerId !== e.pointerId) return
    dragRef.current = null
    const ta = inputRef.current
    if (ta !== null && ta.offsetHeight > 0) resizeInput(ta.offsetHeight, true)
  }
  const onGripKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const ta = inputRef.current
    if (ta === null) return
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      e.stopPropagation()
      const step = e.key === 'ArrowUp' ? KEYBOARD_STEP_PX : -KEYBOARD_STEP_PX
      resizeInput(ta.offsetHeight + step, true)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      e.stopPropagation()
      resizeInput(null, true)
    }
  }
  // A composer that cannot flip to the terminal (no `onShowTerminal`) does not offer a built-in that
  // opens a dialog there: the dialog would be invisible and the next Enter would answer it.
  const offered = onShowTerminal ? catalog : catalog.filter((e) => !e.interactive)
  const items: CompletionItem[] =
    trigger && dismissedAt !== trigger.start ? completionItems(trigger, offered, fileIndex) : []
  const menuOpen = items.length > 0
  const active = Math.min(activeIdx, Math.max(0, items.length - 1))
  // Keep the active row in view as the arrows move it. The menu's own scroll only, by hand:
  // `scrollIntoView` also scrolls every scrollable ancestor, and an `overflow: hidden` one inside
  // the canvas would shift the node under the user.
  const menuRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const menu = menuRef.current
    const row = menuOpen ? (menu?.children[active] as HTMLElement | undefined) : undefined
    if (menu === null || row === undefined) return
    if (row.offsetTop < menu.scrollTop) menu.scrollTop = active === 0 ? 0 : row.offsetTop
    else if (row.offsetTop + row.offsetHeight > menu.scrollTop + menu.clientHeight) {
      menu.scrollTop = row.offsetTop + row.offsetHeight - menu.clientHeight
    }
  }, [menuOpen, active])

  const accept = (item: CompletionItem) => {
    if (!trigger || disabled) return
    const next = applyCompletion(value, trigger, item.value)
    onChange(next.text)
    closeMenu()
    // After React commits the new value, put the caret right after the inserted token.
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(next.caret, next.caret)
    })
  }

  // The labels drop by the composer's OWN width (a narrow node, a split card modal), not the
  // window's. Guarded like the thread's observer: jsdom and old engines have none, and then every
  // label shows (`composerToolbarLayout(null)`).
  useEffect(() => {
    const el = composerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries?: ResizeObserverEntry[]) => {
      // No box (collapsed node, display:none) reports 0: keep the last real width rather than
      // collapsing the toolbar to its narrowest form while nobody can see it.
      const w = entries?.[entries.length - 1]?.contentRect?.width ?? el.clientWidth
      if (typeof w === 'number' && w > 0) setComposerWidth(Math.round(w))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const insertIntoComposer = useCallback(
    (text: string) => {
      onChange((cur) => appendToComposer(cur, text))
      inputRef.current?.focus()
    },
    [onChange]
  )

  // Opening the ⌘M view hands the keyboard to the composer. On the first open the ChatPanel chunk
  // is still loading when the view's entry runs, so the request waits for this mount — or, when
  // the composer mounts disabled (a dialog on screen), for the moment it is enabled.
  useEffect(() => {
    if (!disabled) takeComposerFocusRequest(nodeId, inputRef.current)
  }, [nodeId, disabled])

  // A dictated take for THIS composer lands in the draft, never in the pane.
  useEffect(() => subscribeComposerDictation(composerId, insertIntoComposer), [composerId, insertIntoComposer])

  const attachFiles = useCallback(
    async (files: File[]) => {
      if (!files.length || !pathsForFiles) return
      setAttachNote({ text: `Attaching ${files.length === 1 ? files[0].name || 'file' : `${files.length} files`}…` })
      let paths: string[] = []
      try {
        paths = await pathsForFiles(files)
      } catch {
        paths = []
      }
      if (!paths.length) {
        setAttachNote({ text: 'Could not attach', failed: true })
        return
      }
      setAttachNote(null)
      // Same shape a drop into the terminal pastes: escaped paths, space-separated, trailing space.
      insertIntoComposer(paths.join(' ') + ' ')
    },
    [pathsForFiles, insertIntoComposer]
  )
  useEffect(() => {
    if (!attachNote?.failed) return
    const t = setTimeout(() => setAttachNote(null), 2500)
    return () => clearTimeout(t)
  }, [attachNote])

  // A drag cancelled with Esc, dropped outside the window or ended by an app switch never sends
  // the composer a dragleave, which would leave the drop highlight stuck on.
  useEffect(() => {
    if (!dropping) return
    const clear = () => setDropping(false)
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
      window.removeEventListener('blur', clear)
    }
  }, [dropping])

  // Files arriving by drop or paste become paths in the DRAFT (the terminal's own drop handlers
  // stand aside while the ⌘M view covers it — `terminalOwnsFileInput`). Stopped here so the
  // canvas's window-level drop (image nodes) never sees a drop aimed at the composer.
  const onDragOver = (e: ReactDragEvent) => {
    if (!pathsForFiles || disabled || !Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    if (!dropping) setDropping(true)
  }
  const onDragLeave = (e: ReactDragEvent) => {
    const rt = e.relatedTarget as Node | null
    if (!rt || !(e.currentTarget as HTMLElement).contains(rt)) setDropping(false)
  }
  const onDrop = (e: ReactDragEvent) => {
    setDropping(false)
    if (!pathsForFiles || disabled) return
    const files = Array.from(e.dataTransfer.files)
    if (!files.length) return
    e.preventDefault()
    e.stopPropagation()
    void attachFiles(files)
  }
  const onPaste = (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
    if (!pathsForFiles) return
    const files = pastedFiles(e.clipboardData)
    if (files.length) {
      e.preventDefault()
      e.stopPropagation()
      void attachFiles(files)
      return
    }
    // Ordinary text is the textarea's; only an image-only clipboard Chromium filtered to nothing
    // on its way to a text target asks the async Clipboard API (see `clipboardImages`).
    if (pasteHasText(e.clipboardData)) return
    void clipboardImages().then((images) => {
      if (images.length) void attachFiles(images)
    })
  }

  // The model / effort label: type the agent's own picker command into the pane — through the
  // SAME send gate as a message, re-read at click time (a picker command typed into a dialog would
  // answer it; into a shell it would run) — then flip to the terminal so the picker is in view.
  const openPicker = useCallback(
    async (picker: ComposerPicker) => {
      if (pickerBusyRef.current || sendUnconfirmedRef.current) return
      const command = composerPickerCommand(agentId, picker)
      if (!command || !onShowTerminal) return
      if (chatSendRefusal(agentId, useAgentStatus.getState().byId[nodeId] ?? {}) !== null) return
      pickerBusyRef.current = true
      setPickerBusy(true)
      try {
        const ok = await api.pty.sendText(nodeId, command)
        if (ok === 'pasted-not-submitted') {
          window.dispatchEvent(
            new CustomEvent('nodeterm:toast', { detail: { kind: 'error', message: TEXT_NOT_SUBMITTED } })
          )
          return
        }
        if (ok !== true) {
          onWriteRefused()
          return
        }
        onShowTerminal()
      } finally {
        pickerBusyRef.current = false
        setPickerBusy(false)
      }
    },
    [api, agentId, nodeId, onShowTerminal, onWriteRefused]
  )

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const composing = e.nativeEvent.isComposing || e.keyCode === 229
    // The completion menu owns the navigation keys while it is open. Enter / Tab ACCEPT (insert the
    // text) and never send; Escape closes the menu only — the draft, the ⌘M view and a card modal
    // around it all stay (CardModal's capture-phase Esc already stands aside inside the composer).
    if (menuOpen && !composing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const d = e.key === 'ArrowDown' ? 1 : -1
        setActiveIdx((i) => (Math.min(i, items.length - 1) + d + items.length) % items.length)
        return
      }
      // Enter accepts only when accepting CHANGES the draft: a fully typed `/model` (the highlighted
      // item is exactly what is already there) is a message, and Enter sends it as before.
      // A bare `@` (no query yet) is not a choice either: "hello @" + Enter sends. Tab still accepts.
      const typedExactly =
        !!trigger && value.slice(trigger.start, trigger.end) === (trigger.kind === 'slash' ? '/' : '@') + items[active].value
      const bareAt = trigger?.kind === 'file' && !trigger.query
      if ((e.key === 'Enter' && !e.shiftKey && !typedExactly && !bareAt) || e.key === 'Tab') {
        e.preventDefault()
        accept(items[active])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        if (trigger) setDismissedAt(trigger.start)
        return
      }
    }
    if (
      e.key === 'ArrowRight' &&
      !composing &&
      !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey &&
      value === '' &&
      suggestion !== null &&
      suggestion !== '' &&
      !disabled
    ) {
      e.preventDefault()
      onChange(suggestion)
      requestAnimationFrame(() => {
        const el = inputRef.current
        if (!el) return
        el.setSelectionRange(suggestion.length, suggestion.length)
      })
      return
    }
    // Backspace at the very start of a shell-mode line leaves shell mode, as in Claude's TUI: the `!`
    // goes and the text stays.
    if (shell && e.key === 'Backspace' && !composing && e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0) {
      e.preventDefault()
      pendingCaretRef.current = 0
      onChange(display)
      return
    }
    if (menuOpen && e.key === 'Enter') closeMenu()
    // Shift+Enter falls through to the textarea's own newline; an IME commit is not a send.
    const action = chatKeyAction({
      key: e.key,
      shiftKey: e.shiftKey,
      isComposing: composing
    })
    if (action !== 'send') return
    e.preventDefault()
    // A picker command still in flight: this Enter would land in the picker it is opening.
    if (pickerBusyRef.current) return
    onSend()
  }

  const labelDisabled = disabled || agentBusy || pickerBusy || sendUnconfirmed

  return (
    <div ref={composeRef} className="term-chat__compose">
      {menuOpen && (
        <div
          ref={menuRef}
          className="term-chat__complete"
          id={listboxId}
          role="listbox"
          aria-label={trigger?.kind === 'file' ? 'Files' : 'Commands and skills'}
          // Keep the textarea's focus (its blur would close the menu before the click lands).
          onMouseDown={(e) => e.preventDefault()}
        >
          {items.map((item, i) => (
            <div
              key={`${item.kind}:${item.value}`}
              id={`${listboxId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`term-chat__complete-item${i === active ? ' is-active' : ''}`}
              onMouseEnter={() => setActiveIdx(i)}
              onClick={() => accept(item)}
            >
              {item.kind === 'slash' ? (
                <>
                  {/* Plain text nodes only: a name or description from a repository file is data. */}
                  <span className="term-chat__complete-name">/{item.value}</span>
                  {item.entry.description && (
                    <span className="term-chat__complete-desc">{item.entry.description}</span>
                  )}
                  {catalogEntryTag(item.entry) && (
                    <span className="term-chat__complete-tag">{catalogEntryTag(item.entry)}</span>
                  )}
                </>
              ) : (
                <span className="term-chat__complete-name">@{item.value}</span>
              )}
            </div>
          ))}
        </div>
      )}
      <div
        ref={composerRef}
        className={`term-chat__composer${dropping ? ' term-chat__composer--drop' : ''}${
          disabled ? ' term-chat__composer--disabled' : ''
        }${shell ? ' term-chat__composer--shell' : ''}`}
        // Read by the shortcut dictation paths (lib/chatComposerDictation.ts
        // `composerFromElement`) so ⌘⇧D / hold-to-talk with the caret here fills THIS draft.
        data-chat-composer-id={composerId}
        data-chat-node-id={nodeId}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <div
          className="term-chat__composer-grip"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the message box"
          title={
            setHeight === null
              ? 'Drag to resize the message box'
              : 'Drag to resize the message box. Double-click to let it grow with your text again.'
          }
          tabIndex={0}
          // Keep the caret in the textarea, and start no text selection.
          onMouseDown={(e) => e.preventDefault()}
          onPointerDown={onGripPointerDown}
          onPointerMove={onGripPointerMove}
          onPointerUp={onGripPointerEnd}
          onPointerCancel={onGripPointerCancel}
          onDoubleClick={() => resizeInput(null, true)}
          onKeyDown={onGripKeyDown}
        />
        <div className="term-chat__composer-row">
          {/* Always this slot, so the field after it keeps its position and the textarea is never
              remounted (which would drop the keyboard) when shell mode starts or ends. */}
          {shell && (
            <span className="term-chat__shell-mark" aria-hidden="true">
              !
            </span>
          )}
        <div className="term-chat__composer-field">
          {segments !== null && (
            <div ref={highlightRef} className="term-chat__composer-highlight" aria-hidden="true">
              {segments.map((seg, i) =>
                seg.command ? (
                  <span key={i} className="term-chat__composer-command">
                    {seg.text}
                  </span>
                ) : (
                  seg.text
                )
              )}
              {/* A trailing newline needs a character after it to take up its line, as in the textarea. */}
              {'\u200b'}
            </div>
          )}
          <textarea
            ref={inputRef}
            className={`term-chat__composer-input${segments !== null ? ' term-chat__composer-input--over' : ''}`}
            spellCheck={segments === null}
            onScroll={syncHighlightScroll}
            value={display}
            aria-describedby={shell ? shellHintId : undefined}
            onChange={(e) => {
              const next = draftFromDisplay(e.target.value, shell)
              // A `!` typed at the very start enters shell mode: it leaves the text, so the caret
              // moves back one.
              const entering = !shell && showsShellMode(agentId) && isShellDraft(next)
              if (entering) pendingCaretRef.current = Math.max(0, (e.target.selectionStart ?? 1) - 1)
              onChange(next)
              const caret = e.target.selectionStart ?? e.target.value.length
              // A new token (or none) forgets an Esc on the previous one.
              if (dismissedAt !== null && completionTriggerAt(e.target.value, caret)?.start !== dismissedAt) setDismissedAt(null)
              syncTrigger(e.target.value, caret, e.target.selectionEnd ?? caret)
            }}
            onKeyUp={(e) => {
              // Caret moves (arrows, Home/End) — keys that edit already went through onChange. The menu's
              // own navigation keys are not caret moves while it is open.
              if (e.nativeEvent.isComposing || (menuOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp'))) return
              const el = e.currentTarget
              syncTrigger(el.value, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length)
            }}
            onClick={(e) => {
              const el = e.currentTarget
              syncTrigger(el.value, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length)
            }}
            onBlur={closeMenu}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? listboxId : undefined}
            aria-activedescendant={menuOpen ? `${listboxId}-${active}` : undefined}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={placeholder}
            disabled={disabled}
            rows={2}
          />
        </div>
        </div>
        {carryNote !== null && (
          <div className="term-chat__carry-note" role="status">
            {carryNote}
          </div>
        )}
        <div className="term-chat__toolbar">
          {pathsForFiles && (
            <>
              <button
                type="button"
                className="term-chat__tool-btn"
                title="Attach files — their paths go into the message"
                aria-label="Attach files"
                disabled={disabled}
                onClick={() => fileInputRef.current?.click()}
              >
                <IconPlus />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                tabIndex={-1}
                aria-hidden="true"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? [])
                  // Reset so picking the same file again still fires `change`.
                  e.target.value = ''
                  void attachFiles(files)
                }}
              />
            </>
          )}
          {attachNote && (
            <span
              className={`term-chat__attach-note${attachNote.failed ? ' term-chat__attach-note--failed' : ''}`}
              role="status"
            >
              {!attachNote.failed && <Spinner />}
              {attachNote.text}
            </span>
          )}
          <span className="term-chat__toolbar-spacer" />
          {onShowTerminal && labels.model && (
            <button
              type="button"
              className="term-chat__model"
              title={`Change model — opens ${agentLabel}'s /model picker in the terminal`}
              disabled={labelDisabled}
              aria-disabled={labelDisabled}
              onClick={() => void openPicker('model')}
            >
              {labels.model}
            </button>
          )}
          {onShowTerminal && labels.effort && (
            <button
              type="button"
              className="term-chat__effort"
              title={`Change effort — opens ${agentLabel}'s /effort picker in the terminal`}
              disabled={labelDisabled}
              aria-disabled={labelDisabled}
              onClick={() => void openPicker('effort')}
            >
              {labels.effort}
            </button>
          )}
          <button
            type="button"
            className="term-chat__tool-btn"
            title="Dictate into the message"
            aria-label="Dictate into the message"
            disabled={disabled}
            onClick={() => requestComposerDictation(nodeId, composerId)}
          >
            <IconMic />
          </button>
        </div>
      </div>
      {shell && (
        <div id={shellHintId} className="term-chat__shell-hint">
          {SHELL_MODE_HINT}
        </div>
      )}
    </div>
  )
}

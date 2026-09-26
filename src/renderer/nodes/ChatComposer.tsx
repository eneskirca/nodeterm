import { TEXT_NOT_SUBMITTED } from '@shared/text-delivery'
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type Dispatch,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent,
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
import { IconMic, IconPlus } from '../components/icons'
import { Spinner } from '../components/Spinner'

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
  disabled,
  agentBusy = false,
  onWriteRefused,
  sendUnconfirmed = false,
  pathsForFiles,
  onShowTerminal
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
    // Shift+Enter falls through to the textarea's own newline; an IME commit is not a send.
    const action = chatKeyAction({
      key: e.key,
      shiftKey: e.shiftKey,
      isComposing: e.nativeEvent.isComposing || e.keyCode === 229
    })
    if (action !== 'send') return
    e.preventDefault()
    // A picker command still in flight: this Enter would land in the picker it is opening.
    if (pickerBusyRef.current) return
    onSend()
  }

  const labelDisabled = disabled || agentBusy || pickerBusy || sendUnconfirmed

  return (
    <div className="term-chat__compose">
      <div
        ref={composerRef}
        className={`term-chat__composer${dropping ? ' term-chat__composer--drop' : ''}${
          disabled ? ' term-chat__composer--disabled' : ''
        }`}
        // Read by the shortcut dictation paths (lib/chatComposerDictation.ts
        // `composerFromElement`) so ⌘⇧D / hold-to-talk with the caret here fills THIS draft.
        data-chat-composer-id={composerId}
        data-chat-node-id={nodeId}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <textarea
          ref={inputRef}
          className="term-chat__composer-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={placeholder}
          disabled={disabled}
          rows={2}
        />
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
    </div>
  )
}

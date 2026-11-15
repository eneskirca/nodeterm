import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { WatchChatMessage, WatchLinkView } from '@shared/watch-link-types'
import { stripBidiControls } from '@shared/watch-link-types'
import { CHAT_TEXT_MAX } from '@shared/watch-link/protocol'
import { isTopDialog, nextDialogId, popDialog, pushDialog } from './dialog-stack'
import { ControlHold, ControlSection, hasChat, kickViewer, type ControlHoldKind } from './LiveLinkControls'
import { IconClose, IconPin } from './icons'
import { CHAT_NOT_SENT_MESSAGE, kickNote, ROLE_NAME, statusLine, viewerName, waitingViewers } from '../lib/liveLink'
import { chatClock, chatNameColor, nearBottom } from '../lib/liveChatLook'
import { newMessagesLabel } from '../lib/chatLabels'
import { chatLinkOptionLabels, inLiveChatDrawer, LIVE_CHAT_DRAWER_ATTR, pickChatLink } from '../lib/liveChatPin'
import { useLinkThread, useWatchLinks } from '../state/watchLinks'

const EMPTY_CHAT: WatchChatMessage[] = []

export interface LiveChatDrawerProps {
  /** The link the owner picked last; the drawer shows it while it is live, else the most recent. */
  linkId: string | null
  /** Docked (no scrim, the canvas stays usable) — the Explorer's pin. */
  pinned: boolean
  /** A kanban card modal is open (z 55): sit above it, whatever the pin. */
  raised: boolean
  /** The pinned Explorer is open too: dock to its left. Only meaningful while this drawer is pinned. */
  beside?: boolean
  onPickLink(id: string): void
  onClose(): void
  onTogglePin(): void
  onGoToNode(nodeId: string): void
}

/** "build" for the head: the node title as viewers see it, never empty. */
function linkTitle(l: Pick<WatchLinkView, 'title'>): string {
  return stripBidiControls(l.title).trim() || 'Terminal'
}

/**
 * The Live chat drawer (spec §4): follow and answer a live link's chat, and manage who can type —
 * the Explorer drawer's shape and pin, on the right. A Commenter or Control link shows its thread in
 * the viewer page's live-chat look (lib/liveChatLook) with a composer that posts as the sharer, plus
 * People; a Viewer link has no chat, so People only.
 *
 * Every string someone else wrote — a name, a message, a title — is React TEXT, bidi-stripped. A
 * name is a claim; the People list shows it as a label, the way the popover does. Nothing here ever
 * raises an OS notification: chat raises the chip's unread count, and only `control-taken` notifies.
 *
 * Unpinned it is a modal in the dialog stack (Escape and the scrim close it while it is the top
 * dialog); pinned it is docked chrome and takes no place in the stack, so the board and the card
 * modal keep their keys.
 */
export function LiveChatDrawer(p: LiveChatDrawerProps): React.JSX.Element {
  const { pinned, raised, onClose, onPickLink } = p
  const links = useWatchLinks((s) => s.links)

  // A new Control password holds the drawer (`ControlHold`) — its plaintext exists nowhere else once
  // core takes it. `saves` counts the saves in flight: they keep the drawer from closing AND on its
  // link. `pins` counts every hold (a save, or a new password on screen until Done): they keep the
  // drawer on its link, whatever an Open chat for another link or the fallback says meanwhile. The
  // counters are refs (read in handlers); the held link is state, because it decides what renders.
  const saves = useRef(0)
  const pins = useRef(0)
  const [heldLink, setHeldLink] = useState<string | null>(null)
  const wanted = pickChatLink(links, p.linkId)
  const shownId = heldLink !== null && links.some((l) => l.linkId === heldLink) ? heldLink : wanted
  const link = shownId === null ? null : (links.find((l) => l.linkId === shownId) ?? null)
  const shownRef = useRef(shownId)
  shownRef.current = shownId
  const hold = useCallback((kind: ControlHoldKind = 'save'): (() => void) => {
    if (kind === 'save') saves.current++
    if (++pins.current === 1) setHeldLink(shownRef.current)
    let released = false
    return () => {
      if (released) return
      released = true
      if (kind === 'save') saves.current--
      if (--pins.current === 0) setHeldLink(null)
    }
  }, [])
  // The remembered link is gone (or none was remembered): the drawer shows the most recent one, and
  // ADOPTS it, so Canvas's state and the remembered pick say what is on screen. Never while held:
  // there the difference is an open on another link waiting for the hold to end.
  useEffect(() => {
    if (heldLink !== null || shownId === null || shownId === p.linkId) return
    onPickLink(shownId)
  }, [heldLink, shownId, p.linkId, onPickLink])
  /** Close unless something is held. Every close gesture of the owner comes here. */
  const requestClose = useCallback((): void => {
    if (saves.current > 0) return
    onClose()
  }, [onClose])

  // A modal only while unpinned: docked, it must not take the keyboard from the board or a dialog.
  const dialogIdRef = useRef<string>()
  if (!dialogIdRef.current) dialogIdRef.current = nextDialogId()
  const dialogId = dialogIdRef.current
  useEffect(() => {
    if (pinned) return
    pushDialog(dialogId)
    return () => popDialog(dialogId)
  }, [pinned, dialogId])
  useEffect(() => {
    if (pinned) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !isTopDialog(dialogId)) return
      // Only an Escape that is the drawer's: typed inside it, or with nothing focused. The palette and
      // Settings are not on the dialog stack — an Escape typed there is theirs, and closing the drawer
      // underneath would also pull the keyboard out of them (the drawer gives focus back on close).
      if (!inLiveChatDrawer(e.target) && e.target !== document.body) return
      e.preventDefault()
      e.stopPropagation()
      requestClose()
    }
    // Capture phase: beat the canvas's own keydown listeners (and xterm) to the Escape.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [pinned, dialogId, requestClose])

  // Opened as a modal, keyboard users land in it (a body portal: Tab from the chip would never reach
  // it) and go back where they were when it closes. Docked, it takes nothing.
  const asideRef = useRef<HTMLElement>(null)
  const pinnedAtMount = useRef(pinned)
  useEffect(() => {
    if (pinnedAtMount.current) return
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    asideRef.current?.focus({ preventScroll: true })
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true })
    }
  }, [])

  const overlayClass = [
    'drawer-overlay',
    'live-chat-overlay',
    pinned && 'drawer-overlay--pinned',
    pinned && p.beside && 'drawer-overlay--beside',
    raised && 'drawer-overlay--raised'
  ]
    .filter(Boolean)
    .join(' ')

  return createPortal(
    <div
      className={overlayClass}
      // Pinned: no handler, and the overlay is pointer-events:none (styles.css) — both halves are
      // what keep a docked drawer from stealing or dismissing on canvas clicks (the Explorer's rule).
      onClick={pinned ? undefined : requestClose}
    >
      <aside
        ref={asideRef}
        className={pinned ? 'drawer drawer--pinned live-chat' : 'drawer live-chat'}
        role={pinned ? undefined : 'dialog'}
        aria-label="Live chat"
        tabIndex={-1}
        // The kanban card modal leaves an Escape typed in here alone (it may be the top dialog while
        // this drawer is docked over it).
        {...{ [LIVE_CHAT_DRAWER_ATTR]: '' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer__head">
          <h2>Live chat</h2>
          <div className="ex-head-actions">
            <button
              type="button"
              className={pinned ? 'is-on' : ''}
              title={pinned ? 'Unpin' : 'Pin'}
              aria-label={pinned ? 'Unpin' : 'Pin'}
              aria-pressed={pinned}
              onClick={p.onTogglePin}
            >
              <IconPin />
            </button>
            <button type="button" className="drawer__close" title="Close" aria-label="Close" onClick={requestClose}>
              <IconClose />
            </button>
          </div>
        </div>
        {link === null ? (
          <div className="drawer__body">
            <p className="set-note">No live links.</p>
          </div>
        ) : (
          <ControlHold.Provider value={hold}>
            <div className="live-chat__body">
              <div className="live-chat__link">
                {links.length > 1 && (
                  <select
                    className="confirm__input live-chat__select"
                    aria-label="Live link"
                    value={link.linkId}
                    // Switching links unmounts the controls: not while a new password is on its way or
                    // on screen.
                    disabled={heldLink !== null}
                    title={heldLink !== null ? 'Finish the password change first.' : undefined}
                    onChange={(e) => {
                      if (pins.current > 0) return
                      onPickLink(e.target.value)
                    }}
                  >
                    {chatLinkOptionLabels(links).map((text, i) => (
                      <option key={links[i].linkId} value={links[i].linkId}>
                        {text}
                      </option>
                    ))}
                  </select>
                )}
                <div className="live-chat__linkhead">
                  <span>
                    <span className="live-pop__who">{linkTitle(link)}</span>{' '}
                    <span className="live-pop__muted">{ROLE_NAME[link.role]}</span>
                  </span>
                  <button
                    type="button"
                    className="live-chat__goto"
                    onClick={() => {
                      // A modal drawer gives way to the canvas — unless a new password is still on
                      // its way to being shown here.
                      if (!pinned && saves.current > 0) return
                      p.onGoToNode(link.nodeId)
                    }}
                  >
                    Go to terminal
                  </button>
                </div>
                <LinkStatus link={link} />
              </div>
              <People key={`people-${link.linkId}`} link={link} only={!hasChat(link.role)} />
              {hasChat(link.role) && <Thread key={link.linkId} linkId={link.linkId} />}
            </div>
          </ControlHold.Provider>
        )}
      </aside>
    </div>,
    document.body
  )
}

function LinkStatus({ link }: { link: WatchLinkView }): React.JSX.Element | null {
  const status = statusLine(link)
  if (!status) return null
  const tone = link.status === 'live' && waitingViewers([link]) > 0 ? 'waiting' : link.status
  return (
    <p className={`live-pop__status live-pop__status--${tone}`} role="status">
      {status}
    </p>
  )
}

/** Who is connected: each viewer watching or able to type, a typing dot, Kick — and, for a Control
 *  link, the owner controls the popover has (one `ControlSection`). */
function People({ link, only }: { link: WatchLinkView; only: boolean }): React.JSX.Element {
  const api = window.nodeTerminal.watchLink
  const [error, setError] = useState<string | null>(null)
  return (
    <section className={only ? 'live-chat__people live-chat__people--only' : 'live-chat__people'} aria-label="People">
      <h3 className="live-chat__heading">People</h3>
      {link.control && <ControlSection linkId={link.linkId} control={link.control} />}
      {link.viewers.length === 0 ? (
        <p className="live-pop__muted">Nobody is watching right now.</p>
      ) : (
        <ul className="live-chat__viewers">
          {link.viewers.map((v, i) => (
            <li key={v.viewerId}>
              {v.typing && <span className="live-pop__typing" role="img" aria-label="Typing now" title="Typing now" />}
              <span className="live-pop__who">{viewerName(v, i)}</span>
              <span className="live-pop__muted">
                {v.controlling ? 'can type' : 'watching'}
                {v.waiting ? ' · waiting for the terminal' : ''}
              </span>
              <button
                type="button"
                className="confirm__btn live-pop__btn live-pop__kick"
                title={kickNote(v)}
                onClick={() => kickViewer(api, link.linkId, v.viewerId, setError)}
              >
                Kick
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="live-pop__error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

/** "14:02" with the full date in the tooltip; nothing for a time no Date can hold. */
function MessageTime({ at }: { at: number }): React.JSX.Element | null {
  const date = new Date(at)
  if (!Number.isFinite(date.getTime())) return null
  const clock = chatClock(at)
  if (!clock) return null
  return (
    <time className="live-chat__time" dateTime={date.toISOString()} title={date.toLocaleString()}>
      {clock}
    </time>
  )
}

/**
 * The thread, the viewer page's live chat: one dense line per message, a Sharer badge on the owner's
 * own lines (the HOST's word, `from === 'sharer'` — never a name), and a list that stays at the newest
 * message unless the owner scrolled up, then says how many arrived ("N new messages ↓").
 *
 * `memo`: its only prop is the link id, and it reads the thread from the store itself — so a push
 * about the link's viewers (a typing dot, every few seconds while someone types) does not re-render
 * the whole message list.
 */
const Thread = memo(function Thread({ linkId }: { linkId: string }): React.JSX.Element {
  const api = window.nodeTerminal.watchLink
  const chat = useWatchLinks((s) => s.chats[linkId] ?? EMPTY_CHAT)
  const [draft, setDraft] = useState('')
  const [sendError, setSendError] = useState(false)
  const [unseen, setUnseen] = useState(0)
  const listRef = useRef<HTMLOListElement>(null)
  /** Reading the newest message (within NEAR_BOTTOM_PX of the end), as of the last scroll. */
  const stick = useRef(true)
  // On screen = read (the chip's count clears), and core's history asked once — the popover's rule.
  useLinkThread(linkId, api)

  const toBottom = (): void => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
    stick.current = true
    setUnseen(0)
  }
  // Keyed on the LAST message's id, not the length: at the store's cap the length stops changing.
  const lastId = chat.length > 0 ? chat[chat.length - 1].id : ''
  const prevLast = useRef('')
  useLayoutEffect(() => {
    const before = prevLast.current
    prevLast.current = lastId
    if (lastId === '') return
    if (stick.current || before === '') {
      toBottom()
      return
    }
    const at = chat.findIndex((m) => m.id === before)
    const added = at === -1 ? 1 : chat.length - 1 - at
    if (added > 0) setUnseen((n) => n + added)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs per new last message, reads the list then
  }, [lastId])

  return (
    <div className="live-chat__chat">
      <div className="live-chat__listwrap">
        {chat.length === 0 && <p className="live-pop__muted live-chat__empty">No messages yet. Viewers of this link can chat with you here.</p>}
        <ol
          className="live-chat__list"
          ref={listRef}
          onScroll={(e) => {
            stick.current = nearBottom(e.currentTarget)
            if (stick.current && unseen > 0) toBottom()
          }}
        >
          {chat.map((m) => {
            const sharer = m.from === 'sharer'
            return (
              <li key={m.id} className={sharer ? 'live-chat__msg live-chat__msg--sharer' : 'live-chat__msg'}>
                <MessageTime at={m.at} />
                {sharer && <span className="live-chat__badge">Sharer</span>}
                <span
                  className="live-chat__name"
                  // The page's colour for this name, hashed from the name as the viewer sent it.
                  style={sharer ? undefined : ({ '--live-name': chatNameColor(m.name) } as CSSProperties)}
                >
                  {stripBidiControls(m.name)}
                </span>
                <span className="live-chat__colon">: </span>
                <span className="live-chat__text">{stripBidiControls(m.text)}</span>
              </li>
            )
          })}
        </ol>
        {unseen > 0 && (
          <button type="button" className="confirm__btn primary live-chat__more" onClick={toBottom}>
            {`${newMessagesLabel(unseen)} ↓`}
          </button>
        )}
      </div>
      {sendError && (
        <p className="live-pop__error" role="alert">
          {CHAT_NOT_SENT_MESSAGE}
        </p>
      )}
      <form
        className="live-chat__reply"
        onSubmit={(e) => {
          e.preventDefault()
          const text = draft.trim()
          if (!text) return
          setSendError(false)
          // The reply comes back through the chat push (core echoes the owner's own message): be at
          // the end for it. The box is cleared only once core took it (unless the owner typed on);
          // a null answer or a rejection keeps the draft and says so — the popover's rule.
          toBottom()
          api.sendChat(linkId, text).then(
            (sent) => {
              if (sent) setDraft((d) => (d.trim() === text ? '' : d))
              else setSendError(true)
            },
            () => setSendError(true)
          )
        }}
      >
        <input
          className="confirm__input live-chat__input"
          value={draft}
          maxLength={CHAT_TEXT_MAX}
          placeholder="Reply to viewers…"
          aria-label="Reply to viewers"
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="confirm__btn live-pop__btn" disabled={!draft.trim()}>
          Send
        </button>
      </form>
    </div>
  )
})

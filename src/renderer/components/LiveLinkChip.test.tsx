// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WatchChatMessage, WatchLinkView } from '@shared/watch-link-types'
import { LiveLinkChip, projectSessionSource, showsLiveLinks } from './LiveLinkChip'
import { useWatchLinks } from '../state/watchLinks'
import { useBoardLog } from '../state/boardLog'
import { useProjects } from '../state/projects'
import { popDialog, pushDialog, resetDialogStack } from './dialog-stack'
import {
  CHAT_NOT_SENT_MESSAGE,
  KICK_FAILED_MESSAGE,
  KICK_NOT_DONE_MESSAGE,
  KICK_NOTE,
  STOP_FAILED_MESSAGE
} from '../lib/liveLink'

const boardApi = { tag: 'local-api' }
vi.mock('../session/session', () => ({
  sessionForProject: (id: string) => ({ source: id === 'p-relay' ? 'relay' : 'local', api: boardApi })
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const link = (over: Partial<WatchLinkView> = {}): WatchLinkView => ({
  linkId: 'L',
  nodeId: 'n1',
  role: 'viewer',
  label: 'Ada',
  title: 'build',
  createdAt: 0,
  expiresAt: Date.now() + 42 * 60_000 + 30_000,
  url: 'https://nodeterm.dev/s/L#1.secret',
  status: 'live',
  viewers: [],
  ...over
})
const msg = (id: string, over: Partial<WatchChatMessage> = {}): WatchChatMessage => ({
  id,
  name: 'Bob',
  text: 'hello',
  at: Number(id),
  from: 'viewer',
  ...over
})

const api = {
  revoke: vi.fn(async (_id: string) => {}),
  kick: vi.fn(async (_l: string, _v: string) => true),
  sendChat: vi.fn(async (_l: string, t: string): Promise<WatchChatMessage | null> => ({
    id: 's',
    name: 'Ada',
    text: t,
    at: 0,
    from: 'sharer'
  })),
  chatHistory: vi.fn(async (_l: string): Promise<WatchChatMessage[]> => [])
}
const writeText = vi.fn()

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  resetDialogStack()
  useWatchLinks.setState({ links: [], byNode: {}, chats: {}, unread: {}, hydrated: false })
  useProjects.setState({ projects: [] } as never)
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} })
  for (const f of Object.values(api)) f.mockClear()
  api.revoke.mockImplementation(async () => {})
  writeText.mockClear()
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = { watchLink: api, clipboard: { writeText } }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  resetDialogStack()
  vi.unstubAllGlobals()
})

const render = (ui: React.ReactElement): void => act(() => root.render(ui))
const chip = (): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>('.live-chip')
const pop = (): HTMLElement | null => document.querySelector<HTMLElement>('.live-pop')
const click = (el: Element): void => act(() => void el.dispatchEvent(new MouseEvent('click', { bubbles: true })))
const setLinks = (links: WatchLinkView[]): void => act(() => useWatchLinks.getState().setLinks(links))
const button = (label: string): HTMLButtonElement =>
  [...document.querySelectorAll<HTMLButtonElement>('.live-pop button')].find((b) => b.textContent === label)!
const flush = (): Promise<void> => act(async () => {})

describe('LiveLinkChip', () => {
  it('renders nothing for a node with no link', () => {
    expect(renderToStaticMarkup(<LiveLinkChip nodeId="n1" source="local" />)).toBe('')
    render(<LiveLinkChip nodeId="n1" source="local" />)
    setLinks([link({ nodeId: 'other' })])
    expect(host.innerHTML).toBe('')
  })

  // R57: the store lists THIS machine's links by node id. A relay tab shows another machine's
  // canvas, and a git-shared project opened both locally and over the relay carries the SAME node
  // ids — so a surface viewed through anything but the local session shows no chip at all.
  it('shows nothing for a node viewed through a relay (or unresolved) session, even with a link on that id', () => {
    render(
      <>
        <LiveLinkChip nodeId="n1" source="relay" />
        <LiveLinkChip nodeId="n1" source={null} />
      </>
    )
    setLinks([link()])
    expect(host.querySelector('.live-chip')).toBeNull()
    render(<LiveLinkChip nodeId="n1" source="local" />)
    expect(chip()).not.toBeNull()
  })

  it('the shared rule: only a LOCAL session shows this machine\'s links; a project resolves through its session', () => {
    expect(showsLiveLinks('local')).toBe(true)
    expect(showsLiveLinks('relay')).toBe(false)
    expect(showsLiveLinks('server')).toBe(false)
    expect(showsLiveLinks(null)).toBe(false)
    expect(projectSessionSource('p-local')).toBe('local')
    expect(projectSessionSource('p-relay')).toBe('relay')
  })

  // Rendered in the DOM, not to a string: zustand answers a server render from the store's INITIAL
  // state (empty), so `renderToStaticMarkup` can never show a link.
  it('shows LIVE with the viewer count, as a no-drag button', () => {
    render(<LiveLinkChip nodeId="n1" source="local" className="extra" />)
    setLinks([link({ viewers: [{ viewerId: 'v', name: null, joinedAt: 0, waiting: false }] })])
    const c = chip()!
    expect(c.tagName).toBe('BUTTON')
    expect(c.textContent).toBe('LIVE · 1')
    expect(c.className).toContain('nodrag')
    expect(c.className).toContain('live-chip--live')
    expect(c.className).toContain('extra')
    expect(c.title).toBe('This terminal is shared by a live link — 1 watching.')
  })

  it('follows the store: offline, refused, the unread dot, and gone again', () => {
    render(<LiveLinkChip nodeId="n1" source="local" />)
    setLinks([link()])
    expect(host.querySelector('.live-chip__dot')).not.toBeNull()
    setLinks([link({ status: 'reconnecting' })])
    expect(chip()!.className).toContain('live-chip--offline')
    expect(chip()!.textContent).toBe('LIVE · offline')
    // The broadcast dot is LIVE's alone (N6).
    expect(host.querySelector('.live-chip__dot')).toBeNull()
    setLinks([link({ status: 'refused' })])
    expect(chip()!.className).toContain('live-chip--refused')
    expect(host.querySelector('.live-chip__dot')).toBeNull()
    expect(host.querySelector('.live-chip__unread')).toBeNull()
    act(() => useWatchLinks.getState().addChat('L', msg('1')))
    expect(host.querySelector('.live-chip__unread')).not.toBeNull()
    expect(chip()!.getAttribute('aria-label')).toBe('LIVE · refused, 1 unread chat message')
    setLinks([])
    expect(chip()).toBeNull()
  })
})

describe('LiveLinkPopover', () => {
  it('opens on click with role, time, the controls and the kick note', () => {
    render(<LiveLinkChip nodeId="n1" source="local" />)
    setLinks([link({ viewers: [{ viewerId: 'v1', name: null, joinedAt: 0, waiting: false }, { viewerId: 'v2', name: 'Cy', joinedAt: 0, waiting: false }] })])
    click(chip()!)
    const p = pop()!
    expect(p.textContent).toContain('Can watch')
    expect(p.textContent).toContain('ends in 42 min')
    expect(p.textContent).toContain('Shown to viewers as Ada')
    expect([...p.querySelectorAll('.live-pop__who')].map((e) => e.textContent)).toEqual(['Viewer 1', 'Cy'])
    expect(p.textContent).toContain(KICK_NOTE)
    // A live link needs no status line; a viewer link has no chat.
    expect(p.querySelector('.live-pop__status')).toBeNull()
    expect(p.querySelector('.live-pop__chat')).toBeNull()
    click(button('Copy link'))
    expect(writeText).toHaveBeenCalledWith('https://nodeterm.dev/s/L#1.secret')
    click(p.querySelectorAll<HTMLButtonElement>('.live-pop__kick')[1])
    expect(api.kick).toHaveBeenCalledWith('L', 'v2')
  })

  it('takes the keyboard focus while open and gives it back to the chip', () => {
    render(<LiveLinkChip nodeId="n1" source="local" />)
    setLinks([link()])
    act(() => chip()!.focus())
    click(chip()!)
    expect(document.activeElement).toBe(pop())
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(document.activeElement).toBe(chip())
  })

  it('explains a link that is not live (H9)', () => {
    render(<LiveLinkChip nodeId="n1" source="local" />)
    setLinks([link({ status: 'refused' })])
    click(chip()!)
    expect(pop()!.querySelector('.live-pop__status')!.textContent).toContain("won't host this link")
  })

  // R63: a viewer with no session to join is the owner's to fix — the chip and the popover say how.
  it('viewers waiting for the terminal: an amber chip, a status line and the viewer marked', () => {
    render(<LiveLinkChip nodeId="n1" source="local" />)
    setLinks([
      link({
        viewers: [
          { viewerId: 'v1', name: null, joinedAt: 0, waiting: true },
          { viewerId: 'v2', name: null, joinedAt: 0, waiting: false }
        ]
      })
    ])
    const c = chip()!
    expect(c.textContent).toBe('LIVE · 1 waiting')
    expect(c.className).toContain('live-chip--waiting')
    expect(c.title).toBe('Viewers are waiting — open this terminal in nodeterm to let them watch.')
    click(c)
    const p = pop()!
    expect(p.querySelector('.live-pop__status')!.textContent).toBe(
      'Viewers are waiting — open this terminal in nodeterm to let them watch.'
    )
    expect(p.querySelector('.live-pop__status')!.className).toContain('live-pop__status--waiting')
    const rows = [...p.querySelectorAll('.live-pop__viewers li')].map((e) => e.textContent)
    expect(rows[0]).toContain('waiting for the terminal')
    expect(rows[1]).not.toContain('waiting')
  })

  it('Stop sharing revokes; a stop that did not reach nodeterm says so (H23)', async () => {
    render(<LiveLinkChip nodeId="n1" source="local" />)
    setLinks([link()])
    click(chip()!)
    api.revoke.mockImplementationOnce(async () => {
      throw new Error('socket down')
    })
    click(button('Stop sharing'))
    await flush()
    expect(api.revoke).toHaveBeenCalledWith('L')
    expect(pop()!.querySelector('[role="alert"]')!.textContent).toBe(STOP_FAILED_MESSAGE)
    // The state push that removes the link closes the popover, and it stays closed.
    setLinks([])
    expect(pop()).toBeNull()
    setLinks([link({ linkId: 'M' })])
    expect(chip()).not.toBeNull()
    expect(pop()).toBeNull()
  })

  it('Escape closes it, and only when it is the top dialog', () => {
    render(<LiveLinkChip nodeId="n1" source="local" />)
    setLinks([link()])
    click(chip()!)
    // A dialog raised above it owns the key.
    pushDialog('above')
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(pop()).not.toBeNull()
    popDialog('above')
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(pop()).toBeNull()
  })

  it('takes the Escape before the canvas\'s own window listeners see it', () => {
    const globalKeys = vi.fn()
    window.addEventListener('keydown', globalKeys)
    try {
      render(<LiveLinkChip nodeId="n1" source="local" />)
      setLinks([link()])
      click(chip()!)
      act(() => void document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
      expect(pop()).toBeNull()
      expect(globalKeys).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', globalKeys)
    }
  })

  it('keys pressed on the chip reach the window — also after the popover hands focus back (I1)', () => {
    const globalKeys = vi.fn()
    window.addEventListener('keydown', globalKeys)
    try {
      render(<LiveLinkChip nodeId="n1" source="local" />)
      setLinks([link()])
      act(() => chip()!.focus())
      click(chip()!)
      act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
      expect(pop()).toBeNull()
      expect(document.activeElement).toBe(chip())
      globalKeys.mockClear()
      act(() => void chip()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })))
      expect(globalKeys).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', globalKeys)
    }
  })

  it('a drag over the chip reaches the surface under it (I1)', () => {
    const onDragOver = vi.fn()
    const onDrop = vi.fn()
    render(
      <div onDragOver={onDragOver} onDrop={onDrop}>
        <LiveLinkChip nodeId="n1" source="local" />
      </div>
    )
    setLinks([link()])
    act(() => void chip()!.dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true })))
    act(() => void chip()!.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true })))
    expect(onDragOver).toHaveBeenCalledTimes(1)
    expect(onDrop).toHaveBeenCalledTimes(1)
  })

  it('keys typed inside the popover reach neither the surface nor the window', () => {
    const globalKeys = vi.fn()
    const onKeyDown = vi.fn()
    window.addEventListener('keydown', globalKeys)
    try {
      render(
        <div onKeyDown={onKeyDown}>
          <LiveLinkChip nodeId="n1" source="local" />
        </div>
      )
      setLinks([link({ role: 'commenter' })])
      click(chip()!)
      const input = pop()!.querySelector<HTMLInputElement>('.live-pop__input')!
      act(() => void input.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true })))
      act(() => void input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })))
      expect(onKeyDown).not.toHaveBeenCalled()
      expect(globalKeys).not.toHaveBeenCalled()
      expect(pop()).not.toBeNull()
    } finally {
      window.removeEventListener('keydown', globalKeys)
    }
  })

  it('a failed Kick says so: not reached, or nobody to kick (M3)', async () => {
    render(<LiveLinkChip nodeId="n1" source="local" />)
    setLinks([link({ viewers: [{ viewerId: 'v1', name: null, joinedAt: 0, waiting: false }] })])
    click(chip()!)
    api.kick.mockImplementationOnce(async () => {
      throw new Error('socket down')
    })
    click(pop()!.querySelector('.live-pop__kick')!)
    await flush()
    expect(pop()!.querySelector('[role="alert"]')!.textContent).toBe(KICK_FAILED_MESSAGE)
    api.kick.mockImplementationOnce(async () => false)
    click(pop()!.querySelector('.live-pop__kick')!)
    await flush()
    expect(pop()!.querySelector('[role="alert"]')!.textContent).toBe(KICK_NOT_DONE_MESSAGE)
    click(pop()!.querySelector('.live-pop__kick')!)
    await flush()
    expect(pop()!.querySelector('[role="alert"]')).toBeNull()
  })

  it('a click or middle press on the chip or inside the popover never reaches the surface it sits in', () => {
    const onClick = vi.fn()
    const onMouseDown = vi.fn()
    render(
      <div onClick={onClick} onMouseDown={onMouseDown}>
        <LiveLinkChip nodeId="n1" source="local" />
      </div>
    )
    setLinks([link()])
    // The chip's own press and click stop too (a sessions row ends the session on a middle press).
    act(() => void chip()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 1 })))
    click(chip()!)
    act(() => void pop()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 1 })))
    click(pop()!)
    click(document.querySelector('.live-pop__scrim')!)
    expect(onClick).not.toHaveBeenCalled()
    expect(onMouseDown).not.toHaveBeenCalled()
    expect(pop()).toBeNull()
  })
})

describe('LiveLinkPopover — Commenter chat', () => {
  it('renders every viewer string as text, never as markup', () => {
    render(<LiveLinkChip nodeId="n1" source="local" />)
    setLinks([link({ role: 'commenter', label: '<b>Ada</b>', viewers: [{ viewerId: 'v', name: '<i>Eve</i>', joinedAt: 0, waiting: false }] })])
    act(() => useWatchLinks.getState().addChat('L', msg('1', { name: '<u>Eve</u>', text: '<img src=x onerror=alert(1)>' })))
    click(chip()!)
    const p = pop()!
    expect(p.querySelector('img, b, i, u')).toBeNull()
    expect(p.querySelector('.live-pop__text')!.textContent).toBe('<img src=x onerror=alert(1)>')
    expect(p.querySelector('.live-pop__msg .live-pop__who')!.textContent).toBe('<u>Eve</u>')
    expect(p.querySelector('.live-pop__viewers .live-pop__who')!.textContent).toBe('<i>Eve</i>')
    expect(p.textContent).toContain('Shown to viewers as <b>Ada</b>')
    expect(p.textContent).toContain('(link viewer)')
  })

  it('strips bidi controls from what viewers wrote', () => {
    render(<LiveLinkChip nodeId="n1" source="local" />)
    setLinks([link({ role: 'commenter' })])
    act(() => useWatchLinks.getState().addChat('L', msg('1', { name: 'Ev\u202ee', text: 'a\u2067b' })))
    click(chip()!)
    expect(pop()!.querySelector('.live-pop__who')!.textContent).toBe('Eve')
    expect(pop()!.querySelector('.live-pop__text')!.textContent).toBe('ab')
  })

  it('opening marks the link read, and so does every message that lands while it is open (H21)', async () => {
    render(<LiveLinkChip nodeId="n1" source="local" />)
    setLinks([link({ role: 'commenter' })])
    act(() => useWatchLinks.getState().addChat('L', msg('1')))
    expect(useWatchLinks.getState().unread.L).toBe(1)
    click(chip()!)
    await flush()
    expect(useWatchLinks.getState().unread.L).toBe(0)
    expect(api.chatHistory).toHaveBeenCalledWith('L')
    act(() => useWatchLinks.getState().addChat('L', msg('2')))
    expect(useWatchLinks.getState().unread.L).toBe(0)
    expect(host.querySelector('.live-chip__unread')).toBeNull()
  })

  it('stays read at the 200-message cap, where the thread length stops changing', async () => {
    render(<LiveLinkChip nodeId="n1" source="local" />)
    setLinks([link({ role: 'commenter' })])
    act(() => {
      for (let i = 1; i <= 200; i++) useWatchLinks.getState().addChat('L', msg(String(i)))
    })
    click(chip()!)
    await flush()
    act(() => useWatchLinks.getState().addChat('L', msg('201')))
    expect(useWatchLinks.getState().chats.L).toHaveLength(200)
    expect(useWatchLinks.getState().unread.L).toBe(0)
  })

  it('sends a reply and clears the box; the echo comes back through the push', async () => {
    render(<LiveLinkChip nodeId="n1" source="local" />)
    setLinks([link({ role: 'commenter' })])
    click(chip()!)
    const input = pop()!.querySelector<HTMLInputElement>('.live-pop__input')!
    expect(input.maxLength).toBe(500)
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      set.call(input, '  on it  ')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => void pop()!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await flush()
    expect(api.sendChat).toHaveBeenCalledWith('L', 'on it')
    expect(input.value).toBe('')
    expect(useWatchLinks.getState().chats.L ?? []).toHaveLength(0)
    expect(pop()!.querySelector('[role="alert"]')).toBeNull()
  })

  it('a reply core did not take keeps the draft and says so (M3)', async () => {
    render(<LiveLinkChip nodeId="n1" source="local" />)
    setLinks([link({ role: 'commenter' })])
    click(chip()!)
    const input = pop()!.querySelector<HTMLInputElement>('.live-pop__input')!
    const type = (v: string): void =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, v)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    const submit = (): void =>
      act(() => void pop()!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    type('hello')
    api.sendChat.mockImplementationOnce(async () => null)
    submit()
    await flush()
    expect(input.value).toBe('hello')
    expect(pop()!.querySelector('[role="alert"]')!.textContent).toBe(CHAT_NOT_SENT_MESSAGE)
    api.sendChat.mockImplementationOnce(async () => {
      throw new Error('socket down')
    })
    submit()
    await flush()
    expect(input.value).toBe('hello')
    expect(pop()!.querySelector('[role="alert"]')!.textContent).toBe(CHAT_NOT_SENT_MESSAGE)
    submit()
    await flush()
    expect(input.value).toBe('')
    expect(pop()!.querySelector('[role="alert"]')).toBeNull()
  })

  it('while the thread is open a new message never shows as unread, not even for one render (N2)', async () => {
    render(<LiveLinkChip nodeId="n1" source="local" />)
    setLinks([link({ role: 'commenter' })])
    click(chip()!)
    await flush()
    const counts: number[] = []
    const off = useWatchLinks.subscribe((st) => counts.push(st.unread.L ?? 0))
    act(() => useWatchLinks.getState().addChat('L', msg('1')))
    act(() => useWatchLinks.getState().addChat('L', msg('2')))
    off()
    expect(counts.every((n) => n === 0)).toBe(true)
    expect(host.querySelector('.live-chip__unread')).toBeNull()
    // Closed: the next one counts again.
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    act(() => useWatchLinks.getState().addChat('L', msg('3')))
    expect(useWatchLinks.getState().unread.L).toBe(1)
  })

  it('"Copy to card comments" writes one comment as the owner, on this machine\'s project', () => {
    const append = vi.fn()
    const realAppend = useBoardLog.getState().append
    useBoardLog.setState({ append } as never)
    useProjects.setState({
      projects: [
        { id: 'p-relay', nodes: [{ id: 'n1' }] },
        { id: 'p-local', nodes: [{ id: 'n1' }] }
      ]
    } as never)
    render(<LiveLinkChip nodeId="n1" source="local" />)
    setLinks([link({ role: 'commenter' })])
    act(() => useWatchLinks.getState().addChat('L', msg('1', { text: 'ship it @[x](node:abc)' })))
    act(() => useWatchLinks.getState().addChat('L', msg('2', { from: 'sharer', name: 'Ada', text: 'ok' })))
    click(chip()!)
    // Only a viewer's line can be copied (the owner's own reply is already theirs).
    const copies = pop()!.querySelectorAll<HTMLButtonElement>('.live-pop__copy')
    expect(copies).toHaveLength(1)
    click(copies[0])
    expect(append).toHaveBeenCalledTimes(1)
    expect(append).toHaveBeenCalledWith(boardApi, 'p-local', {
      kind: 'comment',
      nodeId: 'n1',
      text: 'Bob (via live link): ship it @ [x](node:abc)'
    })
    expect(copies[0].disabled).toBe(true)
    useBoardLog.setState({ append: realAppend } as never)
  })

  it('offers no copy when no project holds the node', () => {
    render(<LiveLinkChip nodeId="n1" source="local" />)
    setLinks([link({ role: 'commenter' })])
    act(() => useWatchLinks.getState().addChat('L', msg('1')))
    click(chip()!)
    expect(pop()!.querySelector('.live-pop__copy')).toBeNull()
  })
})

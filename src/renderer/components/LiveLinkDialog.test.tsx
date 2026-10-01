// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreateWatchLinkRequest, CreateWatchLinkResult } from '@shared/watch-link-types'
import { LiveLinkDialog, LiveLinkDialogBody } from './LiveLinkDialog'
import { formatClock, LIVE_LINK_WARNING, SAVE_FIRST_MESSAGE, STOP_FAILED_MESSAGE } from '../lib/liveLink'
import { resetDialogStack } from './dialog-stack'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const noop = (): void => {}
const body = (state: Parameters<typeof LiveLinkDialogBody>[0]['state'], extra: Partial<Parameters<typeof LiveLinkDialogBody>[0]> = {}) =>
  renderToStaticMarkup(
    <LiveLinkDialogBody title="build" state={state} onChange={noop} onSubmit={noop} onClose={noop} onStop={noop} {...extra} />
  )
const FORM = { phase: 'form', role: 'viewer', ttl: 3600, label: 'Ada', busy: false, error: null } as const

describe('LiveLinkDialogBody', () => {
  it('shows the role and expiry choices with the defaults, and the warning always', () => {
    const html = body(FORM)
    expect(html).toContain('Share a live link to build')
    expect(html).toContain('Can watch')
    expect(html).toContain('Can watch and chat')
    for (const t of ['15 min', '1 hour', '8 hours', '24 hours']) expect(html).toContain(t)
    expect(html).toContain(LIVE_LINK_WARNING.replace(/'/g, '&#x27;'))
    expect(html).toContain('Create live link')
  })

  it('shows the URL with Copy and Stop, and until when anyone with it can watch (H25)', () => {
    const expiresAt = new Date(2026, 9, 1, 15, 42, 0).getTime()
    const now = new Date(2026, 9, 1, 14, 42, 0).getTime()
    const html = body({ phase: 'done', url: 'https://nodeterm.dev/s/x#1.y', linkId: 'x', expiresAt }, { now })
    expect(html).toContain('https://nodeterm.dev/s/x#1.y')
    expect(html).toContain('Copy')
    expect(html).toContain('Stop sharing')
    expect(html).toContain(`Anyone with this link can watch until ${formatClock(expiresAt)}.`)
  })

  // R64/M1: a 24 h link made at 15:43 read "until 15:43" — it looks like it ends now.
  it('names the day when the link ends on another day', () => {
    const now = new Date(2026, 9, 1, 15, 43, 0).getTime()
    const expiresAt = now + 24 * 3_600_000
    const html = body({ phase: 'done', url: 'https://nodeterm.dev/s/x#1.y', linkId: 'x', expiresAt }, { now })
    expect(html).toContain(`Anyone with this link can watch until tomorrow ${formatClock(expiresAt)}.`)
  })

  it('R63: the "only while open" note shows in the form when the caller has one', () => {
    expect(body(FORM, { whileOpenNote: 'NOTE-X' })).toContain('NOTE-X')
    expect(body(FORM)).not.toContain('live-dialog__note')
  })

  it('the header title loses its bidi controls (H26)', () => {
    const html = renderToStaticMarkup(
      <LiveLinkDialogBody title={'bu\u202eild'} state={FORM} onChange={noop} onSubmit={noop} onClose={noop} onStop={noop} />
    )
    expect(html).toContain('Share a live link to build')
  })

  it('offers Upgrade only for a not-entitled error AND only when the caller can upgrade (H12, R43)', () => {
    const err = { ...FORM, error: 'Live links need an active Pro plan.', offerUpgrade: true }
    expect(body(err, { onUpgrade: noop })).toContain('Upgrade to Pro')
    // The Server Edition passes no onUpgrade: never an Upgrade button there.
    expect(body(err)).not.toContain('Upgrade to Pro')
    expect(body({ ...err, offerUpgrade: false }, { onUpgrade: noop })).not.toContain('Upgrade to Pro')
  })

  it('while busy, Cancel cannot close and Create says so (H24)', () => {
    const html = body({ ...FORM, busy: true })
    expect(html).toMatch(/<button class="confirm__btn" disabled="">Cancel<\/button>/)
    expect(html).toContain('Creating…')
  })
})

// ---- the mounted dialog ----------------------------------------------------------------------

const created = (url = 'https://nodeterm.dev/s/abc#1.k'): CreateWatchLinkResult => ({
  ok: true,
  link: {
    linkId: 'abc',
    nodeId: 'n1',
    role: 'viewer',
    label: 'Ada',
    title: 'build',
    createdAt: 0,
    expiresAt: Date.now() + 3_600_000,
    url,
    status: 'live',
    viewers: []
  }
})

let api: {
  create: ReturnType<typeof vi.fn<(r: CreateWatchLinkRequest) => Promise<CreateWatchLinkResult>>>
  revoke: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>
}
/** What the local core's `tmuxStatus` reports (R63); `undefined` = the read rejects. */
let persistence: { enabled: boolean; backend: string | null } | undefined
const readPersistence = async () => {
  if (!persistence) throw new Error('no core')
  return { persistence }
}
let host: HTMLDivElement
let root: Root
beforeEach(() => {
  resetDialogStack()
  api = { create: vi.fn(async () => created()), revoke: vi.fn(async () => {}) }
  persistence = { enabled: true, backend: 'tmux' }
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    watchLink: api,
    clipboard: { writeText: vi.fn() }
  }
  localStorage.clear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  resetDialogStack()
})

const flush = (): Promise<void> => act(async () => {})
const btn = (label: string): HTMLButtonElement =>
  [...document.querySelectorAll<HTMLButtonElement>('.live-dialog button')].find((b) => b.textContent === label)!
const click = (el: Element): void => act(() => void el.dispatchEvent(new MouseEvent('click', { bubbles: true })))
const escape = (): void => act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
const setLabel = (v: string): void => {
  const input = document.querySelector<HTMLInputElement>('.live-dialog__label input')!
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    set.call(input, v)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function mount(o: {
  prepare?: () => Promise<string | null>
  onUpgrade?: () => void
  onClose?: () => void
  surface?: 'desktop' | 'server' | 'relay'
  remoteNode?: boolean
} = {}): { onClose: ReturnType<typeof vi.fn> } {
  const onClose = vi.fn(o.onClose ?? (() => {}))
  act(() =>
    root.render(
      <LiveLinkDialog
        nodeId="n1"
        title="build"
        surface={o.surface ?? 'desktop'}
        remoteNode={o.remoteNode}
        readPersistence={readPersistence}
        prepare={o.prepare ?? (async () => null)}
        onUpgrade={o.onUpgrade}
        onClose={onClose}
      />
    )
  )
  return { onClose }
}

describe('LiveLinkDialog', () => {
  it('prefills "Shown to viewers as" with the presence name, capped to the label limit', () => {
    localStorage.setItem('nodeterm.presence.me', JSON.stringify({ name: 'Ada Lovelace', color: '#fff' }))
    mount()
    const input = document.querySelector<HTMLInputElement>('.live-dialog__label input')!
    expect(input.value).toBe('Ada Lovelace')
    expect(input.maxLength).toBe(40)
    act(() => root.unmount())
    root = createRoot(host)
    localStorage.setItem('nodeterm.presence.me', JSON.stringify({ name: 'x'.repeat(60), color: '#fff' }))
    mount()
    expect(document.querySelector<HTMLInputElement>('.live-dialog__label input')!.value).toBe('x'.repeat(40))
  })

  it('D2/M3: the prefill never splits an emoji at the label limit', () => {
    localStorage.setItem('nodeterm.presence.me', JSON.stringify({ name: 'x'.repeat(39) + '\u{1F600}', color: '#fff' }))
    mount()
    expect(document.querySelector<HTMLInputElement>('.live-dialog__label input')!.value).toBe('x'.repeat(39))
  })

  it('D2/M3: focus lands in the dialog — the label on open, Copy once created', async () => {
    mount()
    expect(document.activeElement).toBe(document.querySelector('.live-dialog__label input'))
    setLabel('Ada')
    click(btn('Create live link'))
    await flush()
    expect(document.activeElement).toBe(btn('Copy'))
  })

  // R63: on a machine with no watcher client for a local node (Windows' session host, tmux off or
  // missing, Zellij), a link works only while the terminal is open here — said before it is created.
  it('R63: says "only while open" where this machine has no watcher client, and nowhere else', async () => {
    const note = (): string | null =>
      [...document.querySelectorAll('.live-dialog__note')].map((e) => e.textContent).join('|') || null
    for (const [p, remote, shown] of [
      [{ enabled: true, backend: 'session-host' }, false, true],
      [{ enabled: true, backend: 'zellij' }, false, true],
      [{ enabled: false, backend: 'tmux' }, false, true],
      [{ enabled: true, backend: null }, false, true],
      [{ enabled: true, backend: 'tmux' }, false, false],
      [{ enabled: true, backend: 'session-host' }, true, false], // an SSH node: the host's tmux
      [undefined, false, false] // unknown claims nothing
    ] as const) {
      persistence = p
      act(() => root.unmount())
      root = createRoot(host)
      mount({ remoteNode: remote })
      await flush()
      if (shown) expect(note(), JSON.stringify(p)).toMatch(/only while it is open in nodeterm/)
      else expect(note(), JSON.stringify(p)).toBeNull()
    }
  })

  it('R47: prepares BEFORE create, then creates this node with the chosen options', async () => {
    const order: string[] = []
    const prepare = vi.fn(async () => {
      order.push('prepare')
      return null
    })
    api.create.mockImplementation(async (r) => {
      order.push('create')
      return created()
    })
    mount({ prepare })
    setLabel('  Ada  ')
    click(btn('Create live link'))
    await flush()
    expect(order).toEqual(['prepare', 'create'])
    expect(api.create).toHaveBeenCalledWith({ nodeId: 'n1', role: 'viewer', ttlSeconds: 3600, label: 'Ada', title: 'build' })
    // The URL appears in the dialog, and only once created.
    expect(document.querySelector<HTMLInputElement>('.live-dialog__url input')!.value).toBe('https://nodeterm.dev/s/abc#1.k')
  })

  it('R47: a refused prepare (unsaved canvas, or a conflict) shows the sentence and NEVER calls create', async () => {
    mount({ prepare: async () => SAVE_FIRST_MESSAGE })
    setLabel('Ada')
    click(btn('Create live link'))
    await flush()
    expect(api.create).not.toHaveBeenCalled()
    expect(document.querySelector('.live-dialog__error')!.textContent).toBe(SAVE_FIRST_MESSAGE)
    // Not stuck busy: Create works again.
    expect(btn('Create live link').disabled).toBe(false)
  })

  it('H24: cannot be dismissed while busy — not by Escape, the scrim or Cancel — and can once it is done', async () => {
    let release!: (v: string | null) => void
    const { onClose } = mount({ prepare: () => new Promise((r) => (release = r)) })
    setLabel('Ada')
    click(btn('Create live link'))
    escape()
    click(document.querySelector('.confirm-overlay')!)
    click(btn('Cancel'))
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => release(null))
    await flush()
    // Done now: Escape closes.
    escape()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows the error for a refused create, with Upgrade for not-entitled when offered', async () => {
    const onUpgrade = vi.fn()
    api.create.mockResolvedValue({ ok: false, error: 'not-entitled' })
    mount({ onUpgrade })
    setLabel('Ada')
    click(btn('Create live link'))
    await flush()
    expect(document.querySelector('.live-dialog__error')!.textContent).toBe('Live links need an active Pro plan.')
    click(btn('Upgrade to Pro'))
    expect(onUpgrade).toHaveBeenCalledTimes(1)
  })

  it('words `unsupported` for the surface it was opened on, and a rejected create as the network sentence', async () => {
    api.create.mockResolvedValue({ ok: false, error: 'unsupported' })
    mount({ surface: 'relay' })
    setLabel('Ada')
    click(btn('Create live link'))
    await flush()
    expect(document.querySelector('.live-dialog__error')!.textContent).toBe(
      'Live links are created on the machine that runs this terminal.'
    )
    api.create.mockRejectedValue(new Error('socket'))
    click(btn('Create live link'))
    await flush()
    expect(document.querySelector('.live-dialog__error')!.textContent).toBe(
      "Couldn't reach nodeterm's service. Nothing was shared."
    )
  })

  it('Stop sharing revokes this link and closes; a rejected stop says so and stays open (H23)', async () => {
    const { onClose } = mount()
    setLabel('Ada')
    click(btn('Create live link'))
    await flush()
    api.revoke.mockRejectedValueOnce(new Error('down'))
    click(btn('Stop sharing'))
    await flush()
    expect(api.revoke).toHaveBeenCalledWith('abc')
    expect(onClose).not.toHaveBeenCalled()
    expect(document.querySelector('.live-dialog__error')!.textContent).toBe(STOP_FAILED_MESSAGE)
    click(btn('Stop sharing'))
    await flush()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Copy puts the URL on the clipboard', async () => {
    mount()
    setLabel('Ada')
    click(btn('Create live link'))
    await flush()
    click(btn('Copy'))
    expect(window.nodeTerminal.clipboard.writeText).toHaveBeenCalledWith('https://nodeterm.dev/s/abc#1.k')
  })
})

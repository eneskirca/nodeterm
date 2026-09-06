import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import {
  guestContextMenuTemplate,
  SPELLING_SUGGESTION_MAX,
  type GuestMenuContext,
  type GuestMenuHandlers
} from './webview-context-menu'

const handlers = (): GuestMenuHandlers => ({
  back: vi.fn(),
  forward: vi.fn(),
  reload: vi.fn(),
  openLinkInNode: vi.fn(),
  copyText: vi.fn(),
  copyImage: vi.fn(),
  replaceMisspelling: vi.fn(),
  inspect: vi.fn()
})

const ctx = (over: Partial<GuestMenuContext> = {}): GuestMenuContext => ({
  linkURL: '',
  srcURL: '',
  mediaType: 'none',
  hasImageContents: false,
  isEditable: false,
  selectionText: '',
  misspelledWord: '',
  dictionarySuggestions: [],
  editFlags: {
    canUndo: true,
    canRedo: true,
    canCut: true,
    canCopy: true,
    canPaste: true,
    canDelete: true,
    canSelectAll: true
  },
  canGoBack: false,
  canGoForward: false,
  ...over
})

const labels = (items: MenuItemConstructorOptions[]): string[] =>
  items.map((item) => item.label ?? item.role ?? item.type ?? '')

describe('guestContextMenuTemplate', () => {
  it('offers the editing roles on an editable field', () => {
    const items = guestContextMenuTemplate(ctx({ isEditable: true }), handlers())
    expect(labels(items)).toEqual([
      'undo',
      'redo',
      'separator',
      'cut',
      'copy',
      'paste',
      'delete',
      'separator',
      'selectAll',
      'separator',
      'Back',
      'Forward',
      'Reload',
      'separator',
      'Inspect Element'
    ])
  })

  it('disables an editing role the renderer says is impossible', () => {
    const flags = { ...ctx().editFlags, canPaste: false, canUndo: false }
    const items = guestContextMenuTemplate(ctx({ isEditable: true, editFlags: flags }), handlers())
    expect(items.find((i) => i.role === 'paste')?.enabled).toBe(false)
    expect(items.find((i) => i.role === 'undo')?.enabled).toBe(false)
    expect(items.find((i) => i.role === 'copy')?.enabled).toBe(true)
  })

  it('offers copy for a selection outside an editable field, and nothing else from that block', () => {
    const items = guestContextMenuTemplate(ctx({ selectionText: 'hello' }), handlers())
    expect(labels(items)).toEqual([
      'copy',
      'separator',
      'Back',
      'Forward',
      'Reload',
      'separator',
      'Inspect Element'
    ])
  })

  it('leaves no leading or doubled separator when every optional block is empty', () => {
    const items = guestContextMenuTemplate(ctx(), handlers())
    expect(labels(items)).toEqual(['Back', 'Forward', 'Reload', 'separator', 'Inspect Element'])
  })

  it('routes a link to a new browser node rather than a popup', () => {
    const h = handlers()
    const items = guestContextMenuTemplate(ctx({ linkURL: 'https://example.com/a' }), h)
    const open = items.find((i) => i.label === 'Open Link in New Browser Node')
    open?.click?.(undefined as never, undefined, undefined as never)
    expect(h.openLinkInNode).toHaveBeenCalledWith('https://example.com/a')
    items.find((i) => i.label === 'Copy Link Address')?.click?.(
      undefined as never,
      undefined,
      undefined as never
    )
    expect(h.copyText).toHaveBeenCalledWith('https://example.com/a')
  })

  it('refuses a non-http link, the same schemes setWindowOpenHandler drops', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x']) {
      const items = guestContextMenuTemplate(ctx({ linkURL: url }), handlers())
      expect(labels(items)).not.toContain('Open Link in New Browser Node')
    }
  })

  it('offers the image rows only for an image that has contents', () => {
    const withImage = guestContextMenuTemplate(
      ctx({ mediaType: 'image', hasImageContents: true, srcURL: 'https://x/y.png' }),
      handlers()
    )
    expect(labels(withImage)).toContain('Copy Image')
    expect(labels(withImage)).toContain('Copy Image Address')

    const empty = guestContextMenuTemplate(
      ctx({ mediaType: 'image', hasImageContents: false, srcURL: 'https://x/y.png' }),
      handlers()
    )
    expect(labels(empty)).not.toContain('Copy Image')
  })

  it('omits the image address row when the element has no source url', () => {
    const items = guestContextMenuTemplate(
      ctx({ mediaType: 'image', hasImageContents: true, srcURL: '' }),
      handlers()
    )
    expect(labels(items)).toContain('Copy Image')
    expect(labels(items)).not.toContain('Copy Image Address')
  })

  it('caps the spelling suggestions and replaces the word it was built from', () => {
    const h = handlers()
    const suggestions = ['aa', 'bb', 'cc', 'dd', 'ee', 'ff', 'gg']
    const items = guestContextMenuTemplate(
      ctx({ isEditable: true, misspelledWord: 'aaa', dictionarySuggestions: suggestions }),
      h
    )
    const shown = suggestions.filter((word) => labels(items).includes(word))
    expect(shown).toEqual(suggestions.slice(0, SPELLING_SUGGESTION_MAX))
    items.find((i) => i.label === 'bb')?.click?.(undefined as never, undefined, undefined as never)
    expect(h.replaceMisspelling).toHaveBeenCalledWith('bb')
  })

  it('shows no suggestions when there is no misspelled word under the cursor', () => {
    const items = guestContextMenuTemplate(
      ctx({ isEditable: true, dictionarySuggestions: ['aa'] }),
      handlers()
    )
    expect(labels(items)).not.toContain('aa')
  })

  it('gates back and forward on the guest history', () => {
    const items = guestContextMenuTemplate(ctx({ canGoBack: true }), handlers())
    expect(items.find((i) => i.label === 'Back')?.enabled).toBe(true)
    expect(items.find((i) => i.label === 'Forward')?.enabled).toBe(false)
  })
})

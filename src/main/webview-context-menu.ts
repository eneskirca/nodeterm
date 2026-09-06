import type { MenuItemConstructorOptions } from 'electron'

/**
 * The context menu for a <webview> guest (browser and web nodes).
 *
 * Electron ships no menu for web content (Chromium's own is a Chrome-browser feature), so a
 * right-click inside a guest page did nothing at all. Nothing disabled it; it was never built.
 *
 * The reason it matters beyond cut/copy/paste: on macOS the AutoFill, Writing Tools and Services
 * submenus are contributed by AppKit and are **off by default** in Electron. They are enabled by
 * handing the invoking frame to `menu.popup({ frame })`, which the caller in `index.ts` does.
 * That is what puts "AutoFill > Passwords..." on a password field. Note that macOS routes that
 * item to Apple's own Passwords app and ignores third-party managers; there is no API to change
 * it.
 *
 * The template is built here without importing Electron at runtime (the type import is erased),
 * so the shape of the menu is unit-testable: `src/main` has no Electron available under vitest.
 */

/** What the menu can ask of the guest. The caller binds each to its webContents. */
export interface GuestMenuHandlers {
  back(): void
  forward(): void
  reload(): void
  /** Open a link in a NEW browser node, mirroring `setWindowOpenHandler`, never a real popup. */
  openLinkInNode(url: string): void
  copyText(text: string): void
  copyImage(): void
  replaceMisspelling(word: string): void
  inspect(): void
}

/** The subset of Electron's `ContextMenuParams` the template reads. */
export interface GuestMenuContext {
  linkURL: string
  srcURL: string
  mediaType: string
  hasImageContents: boolean
  isEditable: boolean
  selectionText: string
  misspelledWord: string
  dictionarySuggestions: string[]
  editFlags: {
    canUndo: boolean
    canRedo: boolean
    canCut: boolean
    canCopy: boolean
    canPaste: boolean
    canDelete: boolean
    canSelectAll: boolean
  }
  canGoBack: boolean
  canGoForward: boolean
}

/** How many of the spellchecker's suggestions get a row. */
export const SPELLING_SUGGESTION_MAX = 5

const SEPARATOR: MenuItemConstructorOptions = { type: 'separator' }

const isHttpUrl = (url: string): boolean => /^https?:\/\//i.test(url)

/**
 * Drop leading, trailing and doubled separators, so a section that contributed nothing leaves no
 * rule behind. Same rule as the renderer's own menus (`tidySeparators` in lib/ui-visibility.ts),
 * duplicated rather than shared because the renderer may not import `src/main`.
 */
function tidy(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = []
  for (const item of items) {
    if (item.type === 'separator' && out.length === 0) continue
    if (item.type === 'separator' && out[out.length - 1]?.type === 'separator') continue
    out.push(item)
  }
  while (out.length > 0 && out[out.length - 1]?.type === 'separator') out.pop()
  return out
}

/**
 * Build the guest's context menu.
 *
 * The editing block uses Electron **roles** rather than explicit `webContents.cut()` calls: the
 * roles carry the OS's own localized labels and accelerators, which is what makes our menu look
 * like the native one the AutoFill and Services items are appended to. Enablement comes from
 * `editFlags`, because a role does not disable itself.
 */
export function guestContextMenuTemplate(
  ctx: GuestMenuContext,
  handlers: GuestMenuHandlers
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = []

  if (ctx.misspelledWord && ctx.dictionarySuggestions.length > 0) {
    for (const word of ctx.dictionarySuggestions.slice(0, SPELLING_SUGGESTION_MAX)) {
      items.push({ label: word, click: () => handlers.replaceMisspelling(word) })
    }
    items.push(SEPARATOR)
  }

  if (isHttpUrl(ctx.linkURL)) {
    items.push(
      { label: 'Open Link in New Browser Node', click: () => handlers.openLinkInNode(ctx.linkURL) },
      { label: 'Copy Link Address', click: () => handlers.copyText(ctx.linkURL) },
      SEPARATOR
    )
  }

  if (ctx.mediaType === 'image' && ctx.hasImageContents) {
    items.push({ label: 'Copy Image', click: () => handlers.copyImage() })
    if (ctx.srcURL) {
      items.push({ label: 'Copy Image Address', click: () => handlers.copyText(ctx.srcURL) })
    }
    items.push(SEPARATOR)
  }

  if (ctx.isEditable) {
    items.push(
      { role: 'undo', enabled: ctx.editFlags.canUndo },
      { role: 'redo', enabled: ctx.editFlags.canRedo },
      SEPARATOR,
      { role: 'cut', enabled: ctx.editFlags.canCut },
      { role: 'copy', enabled: ctx.editFlags.canCopy },
      { role: 'paste', enabled: ctx.editFlags.canPaste },
      { role: 'delete', enabled: ctx.editFlags.canDelete },
      SEPARATOR,
      { role: 'selectAll', enabled: ctx.editFlags.canSelectAll },
      SEPARATOR
    )
  } else if (ctx.selectionText) {
    items.push({ role: 'copy', enabled: ctx.editFlags.canCopy }, SEPARATOR)
  }

  items.push(
    { label: 'Back', enabled: ctx.canGoBack, click: () => handlers.back() },
    { label: 'Forward', enabled: ctx.canGoForward, click: () => handlers.forward() },
    { label: 'Reload', click: () => handlers.reload() },
    SEPARATOR,
    { label: 'Inspect Element', click: () => handlers.inspect() }
  )

  return tidy(items)
}

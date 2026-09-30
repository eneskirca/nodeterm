// Right-click on a link in terminal output → a menu of what can be done with it: open, reveal,
// download, copy. The Cmd/Ctrl+click opener (file-links.ts) does exactly ONE thing per link; this is
// the rest of what the Explorer offers for the same path, one right-click away, without first
// finding the file in a tree.
//
// Pure: the host (TerminalNode, the kanban card's ModalTerminal) supplies the context and the
// actions, so every gate below is a unit-testable decision rather than a branch in a component.
//
// The gates are the Explorer's, reused rather than restated:
//  - Download rows come from `downloadMenuEntries` — an SSH project's file comes down over scp, the
//    Server Edition's over an HTTP ticket, and a desktop LOCAL project offers none (the file is
//    already on this machine; Reveal in Finder is the honest action).
//  - The OS reveal follows `canUseLocalShell` (the host passes it in as `localShell`).
import type { MenuItem } from '../components/ContextMenu'
import type { DownloadRoute } from '../lib/download'
import { downloadMenuEntries } from '../lib/filesNode'
import { tidySeparators } from '../lib/tidySeparators'
import { findExistingForHit, type LinkHit, type PathResolution } from './file-links'

/** What a right-click resolved to, once a path's existence is known. */
export type LinkMenuTarget =
  | { kind: 'url'; url: string }
  | { kind: 'file'; abs: string; dir: boolean }
  /** Path-shaped text with nothing behind it — a VERIFIED absence. The right-click was already
   *  swallowed, so it still gets a menu — a click that shows nothing reads as broken. */
  | { kind: 'missing'; abs: string }
  /** Path-shaped text whose existence could not be checked (a dead ControlMaster, a refused IPC, a
   *  timeout). Distinct from `missing` so the menu never tells the user a file is gone when all we
   *  know is that we could not look. */
  | { kind: 'unverified'; abs: string; reason: string }

export interface LinkMenuContext {
  /** `downloadRoute` for the filesystem the path lives on. */
  route: DownloadRoute
  /** `canUseLocalShell` — this machine's file manager can act on the path. */
  localShell: boolean
  /** The Explorer drawer's root. Its reveal only works INSIDE that root (anything else opens the
   *  drawer onto nothing), so the row is withheld outside it. */
  explorerRoot?: string
  /** "New terminal here" can open on the machine that owns the path (not a relay tab). */
  terminals: boolean
  /** True while `path` is already downloading — a second start would land a duplicate `name (2)`. */
  downloading: (path: string) => boolean
}

/** The actions a URL's menu needs — all a host without file links (the kanban card modal) has. */
export interface UrlLinkActions {
  openUrl(url: string): void
  /** Open the page in a canvas browser node. Omitted where that node could not render (a
   *  `<webview>` is Electron-only) or would not be seen (the card modal covers the canvas) — the
   *  row is not offered then, rather than offered as a click that shows nothing. */
  openUrlInNode?: (url: string) => void
  copy(text: string): void
}

export interface LinkMenuActions extends UrlLinkActions {
  /** What Cmd/Ctrl+click does for a file: an editor/media node. */
  openFile(abs: string): void
  revealInExplorer(abs: string): void
  revealInOs(abs: string): void
  openTerminal(dir: string): void
  download(abs: string, dir: boolean, pickFolder: boolean): void
}

/** `abs` relative to `root`, or null when it is not strictly below it. Separator-agnostic, so a
 *  Windows project root (`C:\…`) compares against the `/`-separated paths the link resolver emits. */
export function relativeInside(root: string | undefined, abs: string): string | null {
  if (!root) return null
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const base = norm(root)
  const path = norm(abs)
  return path.startsWith(base + '/') && path.length > base.length + 1 ? path.slice(base.length + 1) : null
}

/** A hit-test result → a menu target. A lookup that throws, or a resolution with an unchecked
 *  candidate, is `unverified` (never `missing`): the menu still opens, says it could not check, and
 *  offers the one thing it honestly can — the text. */
export async function resolveLinkTarget(
  hit: LinkHit,
  find: (token: string) => Promise<PathResolution>
): Promise<LinkMenuTarget> {
  if (hit.kind === 'url') return { kind: 'url', url: hit.url }
  const missing: LinkMenuTarget = { kind: 'missing', abs: hit.abs ?? hit.token }
  try {
    const r = await findExistingForHit([hit.token, ...(hit.alternatives ?? [])], find)
    if (r.found) return { kind: 'file', abs: r.abs, dir: r.dir }
    const u = r.unverified?.[0]
    return u ? { kind: 'unverified', abs: u.abs, reason: u.reason } : missing
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err ?? '')).trim() || 'the lookup failed'
    return { kind: 'unverified', abs: hit.abs ?? hit.token, reason }
  }
}

export function urlLinkMenuItems(url: string, act: UrlLinkActions): MenuItem[] {
  const inNode = act.openUrlInNode
  return [
    { label: 'Open in browser', onClick: () => act.openUrl(url) },
    ...(inNode ? [{ label: 'Open in canvas browser', onClick: () => inNode(url) }] : []),
    { type: 'separator' },
    { label: 'Copy link', onClick: () => act.copy(url) }
  ]
}

export function linkMenuItems(
  target: LinkMenuTarget,
  ctx: LinkMenuContext,
  act: LinkMenuActions
): MenuItem[] {
  if (target.kind === 'url') return urlLinkMenuItems(target.url, act)

  const { abs } = target
  if (target.kind === 'missing' || target.kind === 'unverified') {
    return [
      {
        type: 'label',
        label: target.kind === 'missing' ? 'Not found' : `Couldn't check: ${target.reason}`
      },
      { label: 'Copy path', onClick: () => act.copy(abs) }
    ]
  }

  const { dir } = target
  const rel = relativeInside(ctx.explorerRoot, abs)
  const busy = ctx.downloading(abs)
  const items: MenuItem[] = []
  if (!dir) items.push({ label: 'Open', onClick: () => act.openFile(abs) })
  if (rel !== null) items.push({ label: 'Reveal in Explorer', onClick: () => act.revealInExplorer(abs) })
  if (dir && ctx.terminals) items.push({ label: 'New terminal here', onClick: () => act.openTerminal(abs) })
  items.push({ type: 'separator' })
  for (const d of downloadMenuEntries(ctx.route, abs, { dir, here: false })) {
    items.push({
      label: d.label,
      disabled: busy,
      hint: busy ? 'Already downloading' : undefined,
      onClick: () => act.download(abs, dir, d.pickFolder)
    })
  }
  items.push({ type: 'separator' })
  items.push({ label: 'Copy path', onClick: () => act.copy(abs) })
  if (rel !== null) items.push({ label: 'Copy relative path', onClick: () => act.copy(rel) })
  if (ctx.localShell) items.push({ label: 'Reveal in Finder', onClick: () => act.revealInOs(abs) })
  return tidySeparators(items)
}

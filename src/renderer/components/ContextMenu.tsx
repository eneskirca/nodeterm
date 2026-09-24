import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { NodeColorSwatches } from './NodeColorSwatches'
import { useMenuFlip } from '../ui/useMenuFlip'
import { SUBMENU_TOP_PX, useSubmenuFlip } from '../ui/useSubmenuFlip'

export type MenuItem =
  | {
      type?: 'item'
      label: string
      onClick: () => void
      icon?: ReactNode
      danger?: boolean
      /** Renders the row muted and inert (`onClick` never fires). Pair it with `hint`: a row that
       *  is off for a reason the user cannot see teaches nothing — worse than not showing it. */
      disabled?: boolean
      /** Why the row is disabled (or what it does). Surfaced as the row's native `title` tooltip —
       *  deliberately not a tooltip system of our own. */
      hint?: string
    }
  | { type: 'separator' }
  | { type: 'label'; label: string }
  | { type: 'colors'; onPick: (color: string) => void }
  | { type: 'submenu'; label: string; icon?: ReactNode; children: MenuItem[] }

interface ContextMenuProps {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
  /**
   * Override the base stacking order. The default CSS z-index (46) sits BELOW drawer
   * overlays (z-index 55), so a ContextMenu opened from inside a drawer (e.g. the Source
   * Control panel) would render hidden behind it. Pass a value above the host overlay.
   */
  zIndex?: number
  /**
   * Cap the menu height and scroll overflow — for data-driven flat lists that can grow
   * unbounded (e.g. the branch pickers: repos easily hold 30+ branches, and a fixed-position
   * menu otherwise runs past the viewport with no way to reach the tail). Only for menus
   * with NO submenu items: `overflow-y: auto` would clip a hover flyout.
   */
  scroll?: boolean
}

/**
 * A right-click menu rendered in a body portal at fixed coordinates, so it is never
 * clipped or hidden behind the canvas. Closes on backdrop click.
 */
export function ContextMenu({ x, y, items, onClose, zIndex, scroll }: ContextMenuProps) {
  // Keep the menu one above its backdrop (matches the default 46/45 CSS ordering).
  const backdropStyle = zIndex != null ? { zIndex } : undefined
  // Flip away from the viewport edges: a right-click near the bottom (or right) edge used to
  // open the menu DOWNWARD off-screen, cutting the tail rows off. See useMenuFlip.
  const flip = useMenuFlip(y, x)
  const menuRef = flip.ref
  const menuStyle =
    zIndex != null
      ? { top: flip.top, left: flip.left, zIndex: zIndex + 1 }
      : { top: flip.top, left: flip.left }
  return createPortal(
    <>
      <div
        className="ctx-backdrop"
        style={backdropStyle}
        onContextMenu={(e) => e.preventDefault()}
        onClick={onClose}
      />
      <div
        ref={menuRef}
        className={`ctx-menu${scroll ? ' ctx-menu--scroll' : ''}`}
        style={menuStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <MenuRows items={items} onClose={onClose} />
      </div>
    </>,
    document.body
  )
}

/**
 * The rows of one menu level — the root menu or any flyout. Recursive: a submenu row's flyout
 * renders its children through this same component, so nesting has no depth cap (the node menu's
 * "Transfer conversation ▸ Codex ▸ <model>" is three levels deep). Each level owns its own
 * open-flyout index, so hovering inside a flyout never closes its parent's.
 *
 * `colors` renders only at the root: the swatch strip is a menu-wide row, not a flyout entry.
 */
function MenuRows({
  items,
  onClose,
  nested = false
}: {
  items: MenuItem[]
  onClose: () => void
  nested?: boolean
}): JSX.Element {
  // Index of the row whose submenu flyout is currently open (hover-driven).
  const [openSub, setOpenSub] = useState<number | null>(null)
  return (
    <>
      {items.map((item, i) => {
        if (item.type === 'separator') return <div key={i} className="ctx-sep" />
        if (item.type === 'label') return <div key={i} className="ctx-label">{item.label}</div>
        if (item.type === 'colors') {
          if (nested) return null
          return (
            <NodeColorSwatches
              key={i}
              className="ctx-colors"
              onPick={(c) => {
                item.onPick(c)
                onClose()
              }}
            />
          )
        }
        if (item.type === 'submenu') {
          return (
            <div
              key={i}
              className="ctx-item ctx-item--submenu"
              onMouseEnter={() => setOpenSub(i)}
              onMouseLeave={() => setOpenSub((cur) => (cur === i ? null : cur))}
            >
              <span className="ctx-icon">{item.icon}</span>
              {item.label}
              {openSub === i && (
                <SubmenuFlyout hostsSubmenus={item.children.some((c) => c.type === 'submenu')}>
                  <MenuRows items={item.children} onClose={onClose} nested />
                </SubmenuFlyout>
              )}
            </div>
          )
        }
        return (
          <button
            key={i}
            className={`ctx-item${item.danger ? ' danger' : ''}`}
            disabled={item.disabled}
            title={item.hint}
            onClick={() => {
              item.onClick()
              onClose()
            }}
          >
            <span className="ctx-icon">{item.icon}</span>
            {item.label}
          </button>
        )
      })}
    </>
  )
}

/**
 * One submenu flyout, measured so it opens AWAY from the viewport edge.
 *
 * Its own component because the measurement is per-flyout state (a ref plus a side) and only the
 * open one exists at a time: mounting it with the row keeps the hook's lifetime exactly the
 * flyout's, so a menu re-opened near the other edge measures afresh instead of inheriting the
 * last decision. `data-side` is what the stylesheet anchors on; the default stays `right`, so a
 * flyout with room renders exactly as it always did.
 */
function SubmenuFlyout({
  children,
  hostsSubmenus
}: {
  children: ReactNode
  /** The flyout holds submenu rows of its own. It must not scroll then: `overflow-y: auto` clips
   *  every absolutely-positioned descendant, i.e. the nested flyout would open invisible. Such
   *  flyouts are short action lists; long data lists (models, accounts) are leaves and keep
   *  scrolling. */
  hostsSubmenus: boolean
}): JSX.Element {
  const { ref, side, lift } = useSubmenuFlip()
  return (
    <div
      ref={ref}
      className={`ctx-menu ctx-submenu${hostsSubmenus ? ' ctx-submenu--host' : ''}`}
      data-side={side}
      style={lift ? { top: SUBMENU_TOP_PX - lift } : undefined}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  )
}

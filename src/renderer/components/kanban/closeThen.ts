import type { MenuItem } from '../ContextMenu'

/**
 * Wrap every runnable row so the card modal closes BEFORE the action runs. Restarting the shell,
 * switching model, ending a paused session or moving to another account recycles the tmux
 * session the modal's terminal is co-attached to; closing first (the order the modal's Delete
 * already uses) means the viewer is gone before the session it watches is. A disabled row is
 * returned unchanged: clicking it must neither close the modal nor act.
 */
export function closeThen(items: MenuItem[], close: () => void): MenuItem[] {
  return items.map((it): MenuItem => {
    if (it.type === 'separator' || it.type === 'colors' || it.type === 'label') return it
    if (it.type === 'submenu') return { ...it, children: closeThen(it.children, close) }
    if (it.disabled || !it.onClick) return it
    const run = it.onClick
    return {
      ...it,
      onClick: () => {
        close()
        run()
      }
    }
  })
}

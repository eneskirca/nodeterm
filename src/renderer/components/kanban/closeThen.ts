import type { MenuItem } from '../ContextMenu'

/**
 * Wrap every runnable row so the card modal's `close()` is called BEFORE the action runs.
 * Restarting the shell, switching model, ending a paused session or moving to another account
 * recycles the tmux session the modal's terminal is co-attached to, so the modal is asked to go
 * first (the call order the modal's Delete already uses). This guarantees only call order, not
 * when React actually unmounts the modal. A disabled row is returned unchanged: clicking it must
 * neither close the modal nor act.
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

// Windows/Linux background-mode tray (docs: CLAUDE.md, "Window close off macOS = background mode"). Created only when
// background mode resolves on (`resolveBackgroundOnClose`), never on macOS — the Dock is the
// analogue there. All decisions live in the pure ./tray-model; this file is the Electron glue.

import { Menu, Tray, nativeImage } from 'electron'
import { trayMenuModel, trayStateKey, trayTooltip, type TrayAction, type TrayState } from './tray-model'

export interface BackgroundTray {
  /** Re-render if (and only if) the state's identity changed. */
  update(state: TrayState): void
  destroy(): void
}

export function createBackgroundTray(opts: {
  iconPath: string
  initial: TrayState
  onAction: (action: TrayAction) => void
}): BackgroundTray {
  // 16 logical px with a 2x representation for HiDPI notification areas. A missing dev icon
  // (make-icon not run) yields an empty image: the tray still exists and its menu still works.
  const src = nativeImage.createFromPath(opts.iconPath)
  let image = src
  if (!src.isEmpty()) {
    image = src.resize({ width: 16, height: 16, quality: 'best' })
    const x2 = src.resize({ width: 32, height: 32, quality: 'best' })
    image.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: x2.toPNG() })
  }
  const tray = new Tray(image)
  let lastKey = ''
  const render = (state: TrayState): void => {
    const key = trayStateKey(state)
    if (key === lastKey || tray.isDestroyed()) return
    lastKey = key
    tray.setToolTip(trayTooltip(state))
    tray.setContextMenu(
      Menu.buildFromTemplate(
        trayMenuModel(state).map((item) =>
          item.type === 'separator'
            ? { type: 'separator' as const }
            : {
                label: item.label,
                enabled: item.enabled,
                click: item.action ? () => opts.onAction(item.action as TrayAction) : undefined
              }
        )
      )
    )
  }
  render(opts.initial)
  // Windows: a left click restores the window (right click opens the menu). On Linux most
  // StatusNotifier hosts open the menu on any click, where "Open nodeterm" does the same job.
  tray.on('click', () => opts.onAction('open'))
  tray.on('double-click', () => opts.onAction('open'))
  return {
    update: render,
    destroy: () => {
      if (!tray.isDestroyed()) tray.destroy()
    }
  }
}

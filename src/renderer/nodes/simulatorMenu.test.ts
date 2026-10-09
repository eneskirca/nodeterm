import { describe, expect, it, vi } from 'vitest'
import type { MenuItem } from '../components/ContextMenu'
import { buildSimulatorMenu, type SimulatorMenuHandlers } from './simulatorMenu'

function handlers(): SimulatorMenuHandlers {
  return {
    button: vi.fn(), rotate: vi.fn(), action: vi.fn(), screenshot: vi.fn(), toggleRecording: vi.fn(),
    shutDown: vi.fn(), confirmErase: vi.fn(), promptCustomLocation: vi.fn(), promptOpenUrl: vi.fn(),
    promptPush: vi.fn(), promptPrivacy: vi.fn(), pickInstall: vi.fn(), pickMedia: vi.fn(),
    actualSize: vi.fn(), fitToScreen: vi.fn()
  }
}

/** Every clickable leaf, with its path ("Device › Home"). */
function leaves(items: MenuItem[], prefix = ''): Array<{ path: string; item: Extract<MenuItem, { onClick: () => void }> }> {
  const out: Array<{ path: string; item: Extract<MenuItem, { onClick: () => void }> }> = []
  for (const it of items) {
    if (it.type === 'submenu') out.push(...leaves(it.children, `${prefix}${it.label} › `))
    else if ('onClick' in it) out.push({ path: prefix + it.label, item: it })
  }
  return out
}

describe('the Simulator ⋯ menu', () => {
  const menu = buildSimulatorMenu(handlers(), { device: { appearance: 'dark', increaseContrast: true, locationScenarios: ['City Run', 'Freeway Drive'] }, recording: false })
  const all = leaves(menu)

  it('lists DeviceHub’s groups', () => {
    const groups = menu.filter((m): m is Extract<MenuItem, { type: 'submenu' }> => m.type === 'submenu').map((m) => m.label)
    expect(groups).toEqual(['Device', 'Capture', 'Appearance', 'Location', 'Status Bar', 'Biometrics', 'Clipboard', 'Apps', 'View', 'Device Management'])
  })

  it('greys out every "(Not Supported)" item, each with a reason — and nothing else', () => {
    for (const { path, item } of all) {
      const ns = item.label.endsWith('(Not Supported)')
      expect(!!item.disabled, path).toBe(ns)
      if (ns) expect(item.hint, path).toBeTruthy()
    }
    expect(all.filter((l) => l.item.disabled).map((l) => l.path)).toEqual([
      'Device › App Switcher (Not Supported)',
      'Device › Action Button (Not Supported)',
      'Device › Directional Pad (Not Supported)',
      'Device › Simulate Trackpad (Not Supported)',
      'Device › Back (Not Supported)',
      'Appearance › Grayscale (Not Supported)',
      'Appearance › Reduce Motion (Not Supported)',
      'Appearance › Reduce Transparency (Not Supported)',
      'Appearance › Liquid Glass Look (Not Supported)',
      'Biometrics › Optic ID (Not Supported)',
      'Apps › Provisioning Profiles (Not Supported)',
      'Apps › Crash Reports (Not Supported)',
      'Device Management › New Device… (Not Supported)',
      'Device Management › Rename… (Not Supported)',
      'Device Management › Pair Apple Watch… (Not Supported)',
      'Device Management › Pair Nearby Device… (Not Supported)'
    ])
  })

  it('marks the current settings and lists the location scenarios', () => {
    const labels = all.map((l) => l.path)
    expect(labels).toContain('Appearance › ✓ Dark')
    expect(labels).toContain('Appearance › Light')
    expect(labels).toContain('Appearance › ✓ Increase Contrast')
    expect(labels).toContain('Location › City Run')
    expect(labels).toContain('Location › Freeway Drive')
  })

  it('wires every supported item to a handler', () => {
    const h = handlers()
    const m = buildSimulatorMenu(h, { device: {}, recording: false })
    for (const { item } of leaves(m)) if (!item.disabled) item.onClick()
    for (const [name, fn] of Object.entries(h)) expect(fn, name).toHaveBeenCalled()
  })

  it('offers Stop while recording', () => {
    const m = buildSimulatorMenu(handlers(), { device: {}, recording: true })
    expect(leaves(m).map((l) => l.path)).toContain('Capture › ■ Stop Recording')
  })
})

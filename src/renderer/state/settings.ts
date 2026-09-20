import { create } from 'zustand'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'
import { sameModelGatewayDiscoveryConfig, useModelGateway } from './modelGateway'

interface SettingsState {
  settings: Settings
  /** True once settings have been loaded from disk (so first-run logic can wait). */
  hydrated: boolean
  hydrate(): Promise<void>
  update(patch: Partial<Settings>): void
}

// Coalesce disk writes: the settings inputs fire update() per keystroke/step-click, and each
// save is a full temp-file write + rename in main. The in-memory store stays synchronous (UI
// and xterm/Monaco react immediately); only the persistence trails, at most one write per
// window, always with the latest snapshot.
const SAVE_COALESCE_MS = 300
let saveTimer: ReturnType<typeof setTimeout> | null = null
let pendingSave: Settings | null = null
function scheduleSave(next: Settings): void {
  // Same guard as the beforeunload flush below: this module is transitively imported by
  // node-environment unit tests, where `window` doesn't exist and the timer would throw.
  if (typeof window === 'undefined') return
  pendingSave = next
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (pendingSave) void window.nodeTerminal.settings.save(pendingSave)
    pendingSave = null
  }, SAVE_COALESCE_MS)
}
// Reload/quit inside the coalesce window must not lose the last edit. (Guarded: this module
// is transitively imported by node-environment unit tests, where `window` doesn't exist.)
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    if (pendingSave) void window.nodeTerminal.settings.save(pendingSave)
    pendingSave = null
  })
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  hydrated: false,

  async hydrate() {
    const s = await window.nodeTerminal.settings.load()
    const next = { ...DEFAULT_SETTINGS, ...s }
    if (!sameModelGatewayDiscoveryConfig(get().settings.modelGateway, next.modelGateway)) {
      useModelGateway.getState().clear()
    }
    set({ settings: next, hydrated: true })
  },

  update(patch) {
    const next = { ...get().settings, ...patch }
    // `vanillaLaunchDefault` is the one-release downgrade mirror for `agentLaunchMode`: an older
    // build reads the boolean, so when the user picks a mode here the mirror must follow. (The
    // read path in core settings-store keeps them in lockstep on load; this keeps them in lockstep
    // on write.) `'subscription'` ⇒ true (strip env), anything else ⇒ false.
    if ('agentLaunchMode' in patch) {
      next.vanillaLaunchDefault = patch.agentLaunchMode === 'subscription'
    }
    if (!sameModelGatewayDiscoveryConfig(get().settings.modelGateway, next.modelGateway)) {
      // Invalidate now, before Canvas's debounced discovery starts. Otherwise an older response can
      // land in that interval and feed a launch or recovery pass for the new settings.
      useModelGateway.getState().clear()
    }
    set({ settings: next })
    scheduleSave(next)
  }
}))

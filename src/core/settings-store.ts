import { promises as fs, readFileSync } from 'fs'
import path from 'path'
import { IPC } from '../shared/ipc'
import { platform } from './platform'
import { DEFAULT_SETTINGS, type Settings } from '../shared/types'

/**
 * Merge a possibly-partial/legacy `Settings` object over `DEFAULT_SETTINGS`. A plain
 * `{ ...DEFAULT_SETTINGS, ...saved }` shallow merge is right for top-level keys (a missing key
 * picks up the default), but WRONG for nested objects: an old `settings.json` that has a
 * `speech` object without a newly-added key (e.g. `shortcut`) would have its whole `speech`
 * object override the default one-for-one, silently dropping the new key. `speech` is merged
 * one level deeper so old files still pick up new nested defaults.
 */
function mergeSettings(saved: Partial<Settings> | null | undefined): Settings {
  const merged = { ...DEFAULT_SETTINGS, ...saved }
  merged.speech = { ...DEFAULT_SETTINGS.speech, ...saved?.speech }
  // `shortcuts` is a nested map seeded from DEFAULT_SHORTCUTS. Merge one level deep so an old
  // settings.json that predates a newly-added action still picks up its shipped default, exactly
  // like `speech`. A missing map on old files falls back to the full default map.
  merged.shortcuts = { ...DEFAULT_SETTINGS.shortcuts, ...saved?.shortcuts }
  // Legacy `terminalGpuRendering` was a boolean whose default (true) was merged into every saved
  // file — so a stored `true` is indistinguishable from "never touched" and maps to the new
  // 'auto' (platform-aware) default, while a stored `false` was always an explicit escape-hatch
  // choice and stays 'off'. See the field's doc in shared/types.ts.
  //
  // Every value that is not one of the four known modes ('auto' | 'on' | 'off' | 'shared')
  // normalizes to the DEFAULT: settings.json is hand-editable, and an unrecognised mode must not
  // be handed to the renderer's resolver to interpret.
  const gpu = (saved as { terminalGpuRendering?: unknown } | null | undefined)
    ?.terminalGpuRendering
  if (gpu === false) merged.terminalGpuRendering = 'off'
  else if (gpu !== 'on' && gpu !== 'off' && gpu !== 'auto' && gpu !== 'shared')
    merged.terminalGpuRendering = 'auto'
  return merged
}

/** Paired with `process.pid` in the temp name below: the counter makes a name unique WITHIN this
 *  process, the pid makes it unique ACROSS processes (it restarts at 0 in every new one). Same
 *  scheme as agent-status-mirror's local write. */
let writeSeq = 0

/**
 * Stores user settings in settings.json. Keeps a synchronous cache so the PtyManager
 * can read shell/tmux preferences immediately at terminal creation.
 */
export class SettingsStore {
  private cache: Settings = DEFAULT_SETTINGS
  private listeners = new Set<(s: Settings) => void>()

  private get filePath(): string {
    return path.join(platform().userDataDir, 'settings.json')
  }

  /** Subscribe to saves (fires after each successful `settings:save`). Additive; used by the
   *  desktop shell to create/destroy runtime-toggled subsystems (e.g. the Notch HUD). Returns an
   *  unsubscribe. Never throws into a save. */
  onChange(cb: (s: Settings) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** Load synchronously into cache (call after app is ready). */
  init(): void {
    try {
      const raw = readFileSync(this.filePath, 'utf-8')
      this.cache = mergeSettings(JSON.parse(raw))
    } catch {
      this.cache = DEFAULT_SETTINGS
    }
  }

  get(): Settings {
    return this.cache
  }

  registerIpc(): void {
    platform().handle(IPC.settingsLoad, () => this.cache)
    platform().handle(IPC.settingsSave, async (settings: Settings) => {
      this.cache = mergeSettings(settings)
      // Atomic write (temp + rename) so a mid-write crash can't corrupt settings.json. The temp
      // name is unique per call because nothing serializes this handler and its callers overlap:
      // on the desktop the renderer's coalesced timer save, the `beforeunload` flush that fires
      // outside that window, and any still-in-flight earlier save are all fire-and-forget
      // (src/renderer/state/settings.ts); on the Server Edition every WS frame is dispatched
      // concurrently (src/server/ws.ts), so even one browser tab can have two saves in the air.
      // With a shared name, one writer's rename publishes the other's half-written bytes, or moves
      // the file out from under it entirely. The pid covers the other direction: two
      // `nodeterm-server --data-dir X` processes share the dir with no lock, and their counters
      // both start at 0.
      const tmp = `${this.filePath}.${process.pid}.${++writeSeq}.tmp`
      try {
        // 0600 at open(2), before any bytes land, and the rename carries it onto settings.json.
        // Two reasons: the temp name is predictable (`<file>.<pid>.<seq>.tmp`), so a same-uid
        // process could pre-create it as a symlink for this write to follow; and every other
        // writer in this family already creates owner-only — this one was the outlier, which is
        // exactly what CodeQL's js/insecure-temporary-file was pointing at.
        await fs.writeFile(tmp, JSON.stringify(this.cache, null, 2), { encoding: 'utf-8', mode: 0o600 })
        await fs.rename(tmp, this.filePath)
      } catch (e) {
        // A unique name never self-heals the way the fixed one did (the next save just reused it),
        // so a failed write has to remove its own temp. The error still propagates, so a failed
        // save stays a failed save — and the listeners below still only run on success. There is
        // deliberately no sweep of orphans from killed processes as provider-cookie does: an
        // orphaned settings temp is config litter, not a live credential.
        await fs.rm(tmp, { force: true }).catch(() => {})
        throw e
      }
      for (const cb of this.listeners) {
        try {
          cb(this.cache)
        } catch {
          // A listener must never break a settings save (or its siblings).
        }
      }
    })
  }
}

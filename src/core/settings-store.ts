import { readFileSync } from "fs";
import path from "path";
import { writeFileAtomic } from "./fs-atomic";
import { IPC } from "../shared/ipc";
import { platform } from "./platform";
import { DEFAULT_SETTINGS, type Settings } from "../shared/types";

/**
 * Merge a possibly-partial/legacy `Settings` object over `DEFAULT_SETTINGS`. A plain
 * `{ ...DEFAULT_SETTINGS, ...saved }` shallow merge is right for top-level keys (a missing key
 * picks up the default), but WRONG for nested objects: an old `settings.json` that has a
 * `speech` object without a newly-added key (e.g. `shortcut`) would have its whole `speech`
 * object override the default one-for-one, silently dropping the new key. Nested settings are
 * merged one level deeper so old files still pick up new defaults.
 */
function mergeSettings(saved: Partial<Settings> | null | undefined): Settings {
  const merged = { ...DEFAULT_SETTINGS, ...saved };
  merged.speech = { ...DEFAULT_SETTINGS.speech, ...saved?.speech };
  merged.modelGateway = {
    ...DEFAULT_SETTINGS.modelGateway,
    ...saved?.modelGateway,
  };
  // One-shot dictation migration: a customized legacy `speech.shortcut` becomes the
  // `speech.dictation` override that every consumer now reads (renderer lib `dictationBinding()`).
  // Once the key exists — user-set, seeded, or explicitly disabled (`[]`) — it is the truth and
  // this never runs again; the legacy field lives on only as a downgrade mirror (the renderer
  // write path keeps it in sync so an older build still finds the user's chord).
  // A shortcut EQUAL to the default seeds nothing: the override would only restate what the
  // registry already says, and would then pin that chord against any future default change.
  // **The seeded value survives the read path.** `speech.dictation` has its OWN conflict bucket
  // (`conflictBucket` in shared/keybindings.ts), so it can never be a participant in a
  // cross-command collision, and the READ path's sanitizer (`sanitizeKeybindingOverrides`) has
  // nothing to strip — neither the seed nor the user's own override on the same chord. (It used
  // not to: both were deleted on load, and dictation silently fell back to the registry default.)
  // What a shared chord costs is PRECEDENCE, not the binding: dictation's own keyed listener
  // claims it first in plain app focus, and the other command still gets it everywhere dictation
  // does not listen — terminal focus, say. That is exactly the pre-migration behavior of a legacy
  // `speech.shortcut` that happened to match an app chord, which is what this seed must preserve.
  if (
    merged.speech.shortcut !== DEFAULT_SETTINGS.speech.shortcut &&
    !(merged.keybindings && "speech.dictation" in merged.keybindings)
  ) {
    merged.keybindings = {
      ...(merged.keybindings ?? {}),
      "speech.dictation": [merged.speech.shortcut],
    };
  }
  // One-shot markdown-preview default flip (#495, maintainer decision): every file written
  // before the flip gets `openMarkdownPreview: true` exactly once — INCLUDING one saved by
  // v0.3.3, the sole release that defaulted off, whose full-snapshot saves materialized `false`
  // for users who never touched the toggle (indistinguishable from an explicit off, so the
  // absent-key merge alone could not reach them). The stamped `openMarkdownPreviewMigrated`
  // is what makes it one-shot: once present, the stored value is the user's own and an opt-out
  // is permanent. Same shape as the dictation seed above — keyed on the marker's absence in
  // the SAVED file, never on the merged value.
  if (!saved?.openMarkdownPreviewMigrated) {
    merged.openMarkdownPreview = true;
    merged.openMarkdownPreviewMigrated = true;
  }
  // Legacy `terminalGpuRendering` was a boolean whose default (true) was merged into every saved
  // file — so a stored `true` is indistinguishable from "never touched" and maps to the new
  // 'auto' (platform-aware) default, while a stored `false` was always an explicit escape-hatch
  // choice and stays 'off'. See the field's doc in shared/types.ts.
  //
  // Every value that is not one of the four known modes ('auto' | 'on' | 'off' | 'shared')
  // normalizes to the DEFAULT: settings.json is hand-editable, and an unrecognised mode must not
  // be handed to the renderer's resolver to interpret.
  const gpu = (saved as { terminalGpuRendering?: unknown } | null | undefined)
    ?.terminalGpuRendering;
  if (gpu === false) merged.terminalGpuRendering = "off";
  else if (gpu !== "on" && gpu !== "off" && gpu !== "auto" && gpu !== "shared")
    merged.terminalGpuRendering = "auto";
  // `agentLaunchMode` is the three-way successor to the `vanillaLaunchDefault` boolean. A saved
  // file from before this field existed carries only the boolean: `true` was an explicit opt into
  // subscription/vanilla, so it migrates to `'subscription'`; `false` (or absent) is the default
  // and maps to `'gateway'`. Once `agentLaunchMode` is present it is the truth and the boolean is
  // only a downgrade mirror (the renderer write path keeps it in sync for an older build).
  // Validate to the default for an unrecognized value — settings.json is hand-editable.
  const savedLaunchMode = (saved as { agentLaunchMode?: unknown } | null | undefined)
    ?.agentLaunchMode;
  if (
    savedLaunchMode === "gateway" ||
    savedLaunchMode === "gateway-model" ||
    savedLaunchMode === "subscription"
  ) {
    merged.agentLaunchMode = savedLaunchMode;
  } else if (merged.vanillaLaunchDefault === true) {
    merged.agentLaunchMode = "subscription";
  } else {
    merged.agentLaunchMode = DEFAULT_SETTINGS.agentLaunchMode;
  }
  // Keep the mirror in lockstep with the resolved mode so an older build still honors the choice.
  merged.vanillaLaunchDefault = merged.agentLaunchMode === "subscription";
  return merged;
}

/**
 * Stores user settings in settings.json. Keeps a synchronous cache so the PtyManager
 * can read shell/tmux preferences immediately at terminal creation.
 */
export class SettingsStore {
  private cache: Settings = DEFAULT_SETTINGS;
  private listeners = new Set<(s: Settings) => void>();
  /** In-flight save chain: saves run FIFO (same idiom as WorkspaceStore.saveChain). The handler
   *  has overlapping callers in both builds (the renderer's coalesced timer save, the
   *  `beforeunload` flush, concurrent WS frames on the Server Edition); unordered, the last RENAME
   *  wins the disk while the last CALL wins the cache — and they can disagree until next boot.
   *  Each caller still sees only ITS OWN save's failure. */
  private saveChain: Promise<unknown> = Promise.resolve();

  private get filePath(): string {
    return path.join(platform().userDataDir, "settings.json");
  }

  /** Subscribe to saves (fires after each successful `settings:save`). Additive; used by the
   *  desktop shell to create/destroy runtime-toggled subsystems (e.g. the Notch HUD). Returns an
   *  unsubscribe. Never throws into a save. */
  onChange(cb: (s: Settings) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Load synchronously into cache (call after app is ready). */
  init(): void {
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      this.cache = mergeSettings(JSON.parse(raw));
    } catch {
      this.cache = DEFAULT_SETTINGS;
    }
  }

  get(): Settings {
    return this.cache;
  }

  /** Persist a full settings snapshot. Public so startup migrations can use the exact same atomic
   *  FIFO writer as renderer IPC instead of reaching into the cache or duplicating disk semantics. */
  save(settings: Settings): Promise<void> {
    const run = this.saveChain.then(() => this.saveNow(settings));
    this.saveChain = run.catch(() => {});
    return run;
  }

  registerIpc(): void {
    platform().handle(IPC.settingsLoad, () => this.cache);
    platform().handle(IPC.settingsSave, (settings: Settings) =>
      this.save(settings),
    );
  }

  private async saveNow(settings: Settings): Promise<void> {
    this.cache = mergeSettings(settings);
    // Atomic write (temp + rename) so a mid-write crash can't corrupt settings.json. The temp
    // name is unique per call because nothing serializes this handler and its callers overlap:
    // on the desktop the renderer's coalesced timer save, the `beforeunload` flush that fires
    // outside that window, and any still-in-flight earlier save are all fire-and-forget
    // (src/renderer/state/settings.ts); on the Server Edition every WS frame is dispatched
    // concurrently (src/server/ws.ts), so even one browser tab can have two saves in the air.
    // With a shared name, one writer's rename publishes the other's half-written bytes, or moves
    // the file out from under it entirely. writeFileAtomic covers all of it: a per-call unique
    // temp, 0600 at open(2) before any bytes land (the rename carries it onto settings.json —
    // CodeQL's js/insecure-temporary-file flagged the old default-mode outlier here), a rename
    // that retries Windows sharing violations, and temp cleanup on failure. The error still
    // propagates, so a failed save stays a failed save — and the listeners below still only run
    // on success. There is deliberately no sweep of orphans from killed processes as
    // provider-cookie does: an orphaned settings temp is config litter, not a live credential.
    await writeFileAtomic(this.filePath, JSON.stringify(this.cache, null, 2), {
      mode: 0o600,
    });
    for (const cb of this.listeners) {
      try {
        cb(this.cache);
      } catch {
        // A listener must never break a settings save (or its siblings).
      }
    }
  }
}

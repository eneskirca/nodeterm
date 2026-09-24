// Ensure Claude Code's fullscreen rendering (`"tui": "fullscreen"` in settings.json). That setting
// is what makes a Claude session take the alternate screen + mouse, so it behaves natively inside
// nodeterm's tmux instead of dropping drags into tmux's copy-mode (yellow selection + counter).
//
// Two hard guardrails, both enforced here:
//   - WRITE-IF-ABSENT: if the `tui` key already exists with ANY value, leave it untouched — a user
//     who ran `/tui default` has spoken, and `/tui` always has the last word (no nodeterm toggle).
//   - VERSION-GATED at the CALL SITE: only run this when the CLI is known to be >= 2.1.89
//     (FULLSCREEN_TUI_MIN_VERSION). This pure helper does not know the version; callers gate it.
//
// Merge semantics mirror install-helper.ts: pure transform on a parsed object (`ensureFullscreenTui`)
// plus a guarded file transaction. Only a missing file defaults to {}; malformed or unreadable
// settings are preserved, and an existing tui value never causes a write.
import { updateSettingsFile } from './settings-file'

/** The settings.json value that turns on Claude's fullscreen rendering. */
export const TUI_FULLSCREEN = 'fullscreen'

/** A subset of Claude's settings.json — we only reason about the `tui` key; everything else rides. */
export type TuiSettings = { tui?: unknown; [k: string]: unknown }

/**
 * Pure: ensure `"tui": "fullscreen"` ONLY when the `tui` key is absent. When it already exists
 * (any value — `"default"`, `"fullscreen"`, or garbage), the object is returned untouched and
 * `changed` is false so the caller skips the write. Every other key is preserved.
 */
export function ensureFullscreenTui(config: TuiSettings): { config: TuiSettings; changed: boolean } {
  if ('tui' in config) return { config, changed: false }
  return { config: { ...config, tui: TUI_FULLSCREEN }, changed: true }
}

/**
 * Fail-open file wrapper for the local surfaces (system `~/.claude` + managed account dirs). Reads
 * `configPath`, applies `ensureFullscreenTui`, and writes back ONLY if the key was added. Returns
 * whether it wrote. Errors skip the update without preventing a session from starting.
 * Uses the same lock, validation and stale-snapshot protection as hook installation/removal.
 */
export function ensureFullscreenTuiInFile(configPath: string): boolean {
  return updateSettingsFile(configPath, (config) => ensureFullscreenTui(config).config)
}

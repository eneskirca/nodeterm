import { useRef, useState } from 'react'
import { useSettings } from '../../../state/settings'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Switch } from '@renderer/ui/Switch'
import { Button } from '@renderer/ui/Button'
import { isMacPlatform, isWindowsPlatform } from '@shared/platform-utils'
import { notificationsBlockedCopy } from '@renderer/lib/notificationsBlockedCopy'
import { checkCustomSfx, playSfx } from '@renderer/lib/sfx'
import { readAsBase64 } from '@renderer/terminal/file-drop'
import {
  ALERT_SOUND_ACCEPT,
  ALERT_SOUND_KINDS,
  ALERT_SOUND_MAX_BYTES,
  customAlertSoundFor,
  type AlertSoundKind,
  type CustomAlertSound,
  type CustomAlertSounds
} from '@shared/alert-sound'

const ROWS = {
  notify: {
    title: 'Notify when a turn finishes in the background',
    keywords: ['notify', 'notification', 'claude', 'background', 'turn', 'done']
  },
  sound: {
    title: 'Play a sound when a turn finishes or needs you',
    keywords: ['sound', 'audio', 'sfx', 'effect', 'chime', 'beep', 'retro', '8-bit', 'chiptune', 'volume', 'mute', 'finished', 'needs you', 'custom', 'file', 'mp3', 'wav', 'own sound']
  },
  mobilePush: {
    title: 'Send push notifications to your paired phone',
    keywords: ['push', 'phone', 'mobile', 'apns', 'fcm', 'ios', 'android', 'notification', 'approval', 'question', 'done', 'completed', 'needs you', 'live update', 'live updates', 'live activity', 'live activities', 'ongoing notification', 'dynamic island', 'lock screen', 'presence', 'idle', 'hold', 'defer', 'at this computer']
  }
}
const ENTRIES = Object.values(ROWS)

const SOUND_LABELS: Record<AlertSoundKind, string> = { done: 'Finished sound', needsYou: 'Needs-you sound' }

/**
 * One alert kind's sound (issue #289): the built-in chime or the user's own file. The picked file's
 * BYTES go to the core, which validates them and stores a fixed per-kind copy in its data dir —
 * the original path is never sent or kept, so this works the same in the Server Edition, where
 * the file is on the browser's machine. Settings keep only the display name + a stamp.
 */
function CustomSoundRow({ kind, volume }: { kind: AlertSoundKind; volume: number }): React.JSX.Element {
  const customAlertSounds = useSettings((s) => s.settings.customAlertSounds)
  const update = useSettings((s) => s.update)
  const current = customAlertSoundFor(customAlertSounds, kind)
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | undefined>()

  // Rebuilt from the validated entries (never spread from the raw, hand-editable value), so a
  // malformed entry for the other kind is dropped rather than carried forward.
  const withEntry = (entry: CustomAlertSound | undefined): CustomAlertSounds => {
    const base = useSettings.getState().settings.customAlertSounds
    const next: CustomAlertSounds = {}
    for (const k of ALERT_SOUND_KINDS) {
      const e = k === kind ? entry : customAlertSoundFor(base, k)
      if (e) next[k] = e
    }
    return next
  }

  const onPick = async (file: File | undefined): Promise<void> => {
    if (!file) return
    setNote(undefined)
    // A fast answer for the obvious case; the core re-checks everything (size, type, magic bytes).
    if (file.size > ALERT_SOUND_MAX_BYTES) {
      setNote(`That file is too large — the limit is ${ALERT_SOUND_MAX_BYTES / (1024 * 1024)} MB.`)
      return
    }
    setBusy(true)
    try {
      const b64 = await readAsBase64(file)
      if (!b64) {
        setNote('That file could not be read.')
        return
      }
      const res = await window.nodeTerminal.files.saveAlertSound(kind, file.name, b64)
      if (!res.ok) {
        setNote(res.error)
        return
      }
      const stamp = Date.now()
      update({ customAlertSounds: withEntry({ name: res.name, stamp }) })
      if (await checkCustomSfx(kind, stamp)) {
        playSfx(kind, volume, useSettings.getState().settings.customAlertSounds)
      } else {
        setNote('Saved, but this file could not be decoded — the built-in chime will play instead.')
      }
    } catch {
      setNote('Could not save the sound.')
    } finally {
      setBusy(false)
    }
  }

  const onReset = async (): Promise<void> => {
    setNote(undefined)
    setBusy(true)
    try {
      await window.nodeTerminal.files.clearAlertSound(kind)
    } catch {
      // The entry is dropped below regardless: a stale file on disk is never played without it.
    } finally {
      update({ customAlertSounds: withEntry(undefined) })
      setBusy(false)
    }
  }

  return (
    <FieldRow
      label={SOUND_LABELS[kind]}
      description={current ? current.name : 'Built-in chime'}
      note={note}
      control={
        <div className="flex items-center gap-2">
          <Button
            onClick={() => playSfx(kind, volume, useSettings.getState().settings.customAlertSounds)}
            aria-label={`Preview ${SOUND_LABELS[kind].toLowerCase()}`}
          >
            Preview
          </Button>
          <Button disabled={busy} onClick={() => inputRef.current?.click()}>
            {busy ? 'Saving…' : 'Choose file…'}
          </Button>
          <Button variant="ghost" disabled={busy || !current} onClick={() => void onReset()}>
            Reset
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept={ALERT_SOUND_ACCEPT}
            hidden
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              const f = e.target.files?.[0]
              // Reset so picking the same file again still fires `change`.
              e.target.value = ''
              void onPick(f)
            }}
          />
        </div>
      }
    />
  )
}

// The OS-refusal repair row's wording follows the OS whose notification center refused us.
const blockedCopy = notificationsBlockedCopy(isMacPlatform() ? 'mac' : isWindowsPlatform() ? 'windows' : 'other')

export function NotificationsSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const notifyOnClaudeDone = useSettings((s) => s.settings.notifyOnClaudeDone)
  const soundEffects = useSettings((s) => s.settings.soundEffects)
  const soundVolume = useSettings((s) => s.settings.soundVolume)
  const customAlertSounds = useSettings((s) => s.settings.customAlertSounds)
  const mobilePushEnabled = useSettings((s) => s.settings.mobilePushEnabled)
  const mobilePushNeedsYou = useSettings((s) => s.settings.mobilePushNeedsYou)
  const mobilePushDone = useSettings((s) => s.settings.mobilePushDone)
  const mobileLiveActivities = useSettings((s) => s.settings.mobileLiveActivities)
  const mobilePushPresenceAware = useSettings((s) => s.settings.mobilePushPresenceAware)
  const update = useSettings((s) => s.update)
  // The OS refused our test notification (macOS permission denied). macOS never re-prompts
  // once the app's record exists, so the only way back is the System Settings pane.
  const [osBlocked, setOsBlocked] = useState(false)
  return (
    <SettingsSection
      id="notifications"
      title="Notifications"
      description="Get notified when an agent finishes while the app is in the background."
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.notify}>
        <FieldRow
          label="Notify when a turn finishes in the background"
          control={
            <Switch
              checked={notifyOnClaudeDone}
              ariaLabel="Background notifications"
              onChange={(on) => {
                update({ notifyOnClaudeDone: on, notifyConsentAsked: true })
                setOsBlocked(false)
                // Enabling fires a real test notification: on a fresh install this is what
                // triggers the macOS permission prompt; on a denied/stale record the OS
                // rejects it and we surface the repair path below.
                if (on)
                  void window.nodeTerminal
                    .notify({
                      title: 'Notifications enabled',
                      body: "You'll be told when Claude Code finishes in the background.",
                      nodeId: '',
                      force: true
                    })
                    .then((result) => setOsBlocked(result === 'failed'))
              }}
            />
          }
        />
        {osBlocked && (
          <div className="mt-2 flex items-center gap-3 text-[13px] text-[color:var(--caution)]">
            {blockedCopy.message}
            {blockedCopy.button && (
              <Button onClick={() => void window.nodeTerminal.openNotificationSettings()}>
                {blockedCopy.button}
              </Button>
            )}
          </div>
        )}
      </SearchableRow>
      <SearchableRow {...ROWS.sound}>
        <FieldRow
          label="Play a sound when a turn finishes or needs you"
          description="A short retro chirp for a finished turn and a crackly one when a session needs you — or your own sound file for either. Plays whether or not the window is focused, so you catch a finish while looking at another node."
          control={
            <Switch
              checked={soundEffects}
              ariaLabel="Sound effects"
              onChange={(on) => {
                update({ soundEffects: on })
                // Enabling plays the finish chirp — it doubles as the volume preview AND as the
                // user gesture a browser needs before it will let us make noise at all.
                if (on) playSfx('done', soundVolume, customAlertSounds)
              }}
            />
          }
        />
        <div
          className={
            'mt-3 space-y-3 border-l border-border pl-4' +
            (soundEffects ? '' : ' pointer-events-none opacity-40')
          }
          aria-disabled={!soundEffects}
        >
          <FieldRow
            label="Volume"
            control={
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={Math.round(soundVolume * 100)}
                  aria-label="Sound effect volume"
                  onChange={(e) => update({ soundVolume: Number(e.target.value) / 100 })}
                  onMouseUp={() => playSfx('done', soundVolume, customAlertSounds)}
                  className="w-40 accent-[var(--accent)]"
                />
                <span className="w-9 text-right text-[12px] text-muted tabular-nums">
                  {Math.round(soundVolume * 100)}%
                </span>
              </div>
            }
          />
          <CustomSoundRow kind="done" volume={soundVolume} />
          <CustomSoundRow kind="needsYou" volume={soundVolume} />
        </div>
      </SearchableRow>
      <SearchableRow {...ROWS.mobilePush}>
        <FieldRow
          label="Send push notifications to your paired phone"
          description="Fires when an agent needs approval, asks a question, or finishes — only if you've paired a phone."
          control={
            <Switch
              checked={mobilePushEnabled}
              ariaLabel="Mobile push notifications"
              onChange={(on) => update({ mobilePushEnabled: on })}
            />
          }
        />
        {/* Per-kind sub-gates. Inert (dimmed, non-interactive) while the master toggle is off. */}
        <div
          className={
            'mt-3 space-y-3 border-l border-border pl-4' +
            (mobilePushEnabled ? '' : ' pointer-events-none opacity-40')
          }
          aria-disabled={!mobilePushEnabled}
        >
          <FieldRow
            label="Needs you (approvals & questions)"
            control={
              <Switch
                checked={mobilePushNeedsYou}
                ariaLabel="Push when an agent needs you"
                onChange={(on) => update({ mobilePushNeedsYou: on })}
              />
            }
          />
          <FieldRow
            label="Task completed"
            control={
              <Switch
                checked={mobilePushDone}
                ariaLabel="Push when a task completes"
                onChange={(on) => update({ mobilePushDone: on })}
              />
            }
          />
          <FieldRow
            label="Live updates on phone"
            description="Keep a live status on your phone's lock screen updated as a session works, needs you, or finishes."
            control={
              <Switch
                checked={mobileLiveActivities}
                ariaLabel="Live updates on your phone"
                onChange={(on) => update({ mobileLiveActivities: on })}
              />
            }
          />
          <FieldRow
            label="Hold phone alerts while you're at this computer"
            description="Defer approval, question, and completed alerts while you're active here, then send them the moment you go idle or lock the screen. Live updates are never held."
            control={
              <Switch
                checked={mobilePushPresenceAware}
                ariaLabel="Hold phone alerts while you're at this computer"
                onChange={(on) => update({ mobilePushPresenceAware: on })}
              />
            }
          />
        </div>
      </SearchableRow>
    </SettingsSection>
  )
}

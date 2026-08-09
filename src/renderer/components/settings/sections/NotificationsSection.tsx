import { useState } from 'react'
import { useSettings } from '../../../state/settings'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Switch } from '@renderer/ui/Switch'
import { Button } from '@renderer/ui/Button'
import { playSfx } from '@renderer/lib/sfx'

const ROWS = {
  notify: {
    title: 'Notify when a turn finishes in the background',
    keywords: ['notify', 'notification', 'claude', 'background', 'turn', 'done']
  },
  agentInbox: {
    title: 'Allow linked agents to signal inbox updates',
    keywords: ['agent', 'linked', 'inbox', 'coordination', 'notify', 'automation']
  },
  sound: {
    title: 'Play a sound when a turn finishes or needs you',
    keywords: ['sound', 'audio', 'sfx', 'effect', 'chime', 'beep', 'retro', '8-bit', 'chiptune', 'volume', 'mute', 'finished', 'needs you']
  },
  mobilePush: {
    title: 'Send push notifications to your paired phone',
    keywords: ['push', 'phone', 'mobile', 'apns', 'ios', 'notification', 'approval', 'question', 'done', 'completed', 'needs you', 'live activity', 'live activities', 'dynamic island', 'lock screen', 'presence', 'idle', 'hold', 'defer', 'at this computer']
  }
}
const ENTRIES = Object.values(ROWS)

export function NotificationsSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const notifyOnClaudeDone = useSettings((s) => s.settings.notifyOnClaudeDone)
  const agentInboxNotifications = useSettings((s) => s.settings.agentInboxNotifications)
  const soundEffects = useSettings((s) => s.settings.soundEffects)
  const soundVolume = useSettings((s) => s.settings.soundVolume)
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
            macOS is blocking notifications for this app.
            <Button onClick={() => void window.nodeTerminal.openNotificationSettings()}>
              Open System Settings
            </Button>
          </div>
        )}
      </SearchableRow>
      <SearchableRow {...ROWS.agentInbox}>
        <FieldRow
          label="Allow linked agents to signal inbox updates"
          description="Lets a context-linked agent send a fixed, rate-limited prompt to check your configured coordination inbox. Arbitrary terminal writes still require approval."
          control={
            <Switch
              checked={agentInboxNotifications}
              ariaLabel="Linked agent inbox notifications"
              onChange={(on) => update({ agentInboxNotifications: on })}
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.sound}>
        <FieldRow
          label="Play a sound when a turn finishes or needs you"
          description="A short retro chirp for a finished turn and a crackly one when a session needs you. Plays whether or not the window is focused, so you catch a finish while looking at another node."
          control={
            <Switch
              checked={soundEffects}
              ariaLabel="Sound effects"
              onChange={(on) => {
                update({ soundEffects: on })
                // Enabling plays the finish chirp — it doubles as the volume preview AND as the
                // user gesture a browser needs before it will let us make noise at all.
                if (on) playSfx('done', soundVolume)
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
                  onMouseUp={() => playSfx('done', soundVolume)}
                  className="w-40 accent-[var(--accent)]"
                />
                <span className="w-9 text-right text-[12px] text-muted tabular-nums">
                  {Math.round(soundVolume * 100)}%
                </span>
              </div>
            }
          />
          <FieldRow
            label="Preview"
            control={
              <div className="flex items-center gap-2">
                <Button onClick={() => playSfx('done', soundVolume)}>Finished</Button>
                <Button onClick={() => playSfx('needsYou', soundVolume)}>Needs you</Button>
              </div>
            }
          />
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
            label="Live Activities"
            description="Keep a Lock Screen / Dynamic Island activity updated as a session works, needs you, or finishes."
            control={
              <Switch
                checked={mobileLiveActivities}
                ariaLabel="Live Activities on your phone"
                onChange={(on) => update({ mobileLiveActivities: on })}
              />
            }
          />
          <FieldRow
            label="Hold phone alerts while you're at this computer"
            description="Defer approval, question, and completed alerts while you're active here, then send them the moment you go idle or lock the screen. Live Activities are never held."
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

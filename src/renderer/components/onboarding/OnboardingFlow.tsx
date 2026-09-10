import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { DEFAULT_SETTINGS, type SpeechModelInfo } from '@shared/types'
import { AGENT_CONFIG, BUILTIN_AGENT_IDS, type BuiltinAgentId } from '@shared/agents/config'
import { isHoldChord, matchesShortcut, shortcutKeyParts } from '@shared/shortcut'
import { hasSpeechModel, SPEECH_MODEL_NONE } from '@shared/speech'
import { keyLabel } from '@shared/platform-utils'
import {
  chipFor,
  commandKeys,
  dictationBinding,
  effectiveBindings
} from '../../lib/keybindingOverrides'
import { IOS_APP_STORE_URL } from '../../lib/links'
import { useSettings } from '../../state/settings'
import { useEntitlement } from '../../state/entitlement'
import { Switch } from '@renderer/ui/Switch'
import { AgentIcon } from '../../lib/agentIcons'
import {
  OnbBrandMark,
  OnbCheck,
  OnbGhostCanvas,
  SceneAgents,
  SceneDictation,
  SceneKanban,
  SceneKeepAwake,
  SceneNotch,
  SceneNotify,
  ScenePhone
} from './scenes'

const isMac = /Mac/i.test(navigator.platform || navigator.userAgent)

/** `large-v3-turbo` -> `"Large V3 Turbo"` (same rendering as Settings → Speech). */
function modelLabel(id: string): string {
  return id
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function formatSize(mb: number): string {
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

/** Info step + the setting it configures, one per screen. Step 0 is the welcome cover; the last
 *  step is the mobile-app announcement (info-only). Steps are addressed by ID, not index, because
 *  the notch step only exists on macOS — an index-keyed tour would shift under it. */
const STEPS = [
  'cover',
  'agents',
  'dictation',
  'kanban',
  'notify',
  'keepawake',
  ...(isMac ? (['notch'] as const) : []),
  'phone'
] as const
type StepId = (typeof STEPS)[number]
const STEP_COUNT = STEPS.length

/**
 * First-run setup tour: welcome → agents → dictation → kanban → notifications. Each step
 * pairs an animated scene with ONE decision, and every choice writes settings immediately
 * (there is no final "save" — closing mid-way keeps what was chosen so far). Replaces both
 * the auto-opened ShortcutsPanel and the standalone notification-consent dialog on first
 * launch; rerunnable via the ⌘K "Setup tour" command.
 */
export function OnboardingFlow({ onClose }: { onClose: () => void }) {
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)
  const isPremium = useEntitlement((s) => s.isPremium)
  const [step, setStep] = useState(0)

  // ---- dictation models (loaded once; selection + download mirror Settings → Speech) ----
  const [models, setModels] = useState<SpeechModelInfo[]>([])
  const [progress, setProgress] = useState<Record<string, number>>({})
  const [modelHint, setModelHint] = useState('')
  const refreshModels = useCallback(async () => {
    try {
      setModels(await window.nodeTerminal.speech.models())
    } catch {
      // transient read error — the list just stays empty and the step degrades to info-only
    }
  }, [])
  useEffect(() => {
    void refreshModels()
    const unsub = window.nodeTerminal.speech.onProgress(({ id, pct }) => {
      setProgress((p) => ({ ...p, [id]: pct }))
      if (pct >= 100) {
        setProgress((p) => {
          const next = { ...p }
          delete next[id]
          return next
        })
        void refreshModels()
      }
    })
    return unsub
  }, [refreshModels])

  const pickModel = (m: SpeechModelInfo): void => {
    if (m.pro && !isPremium) {
      setModelHint('Pro model — unlock later in Settings → License. Tiny is free and works offline.')
      return
    }
    setModelHint('')
    update({ speech: { ...settings.speech, model: m.id } })
    if (!m.downloaded && progress[m.id] === undefined) {
      setProgress((p) => ({ ...p, [m.id]: 0 }))
      window.nodeTerminal.speech.downloadModel(m.id).catch(() => {
        setProgress((p) => {
          const next = { ...p }
          delete next[m.id]
          return next
        })
        setModelHint('Download failed — you can retry any time in Settings → Speech.')
      })
    }
  }

  // ---- kanban try-it: catch the REAL kanban-toggle chord while the step is up (capture phase,
  // so the canvas's own toggle handler never fires under the tour). Matched through the registry
  // rather than by hand, so a remapped chord is what the tour accepts — and so the acceptance is
  // exactly as strict as dispatch. The old test was LAX in two directions: `metaKey || ctrlKey`
  // accepted Ctrl+Shift+B on a mac (where the command is ⌘⇧B) and Cmd+Shift+B on Linux, and it
  // ignored `altKey` entirely, so ⌘⌥⇧B — a different chord — also lit the checkmark. Narrowing
  // it means the tour can only be satisfied by the key that actually toggles the board. ----
  const [kanbanTried, setKanbanTried] = useState(false)
  const [kanbanPulse, setKanbanPulse] = useState(0)
  useEffect(() => {
    if (STEPS[step] !== 'kanban') return
    const onKey = (e: KeyboardEvent) => {
      // Read at event time, not at effect setup: a remap mid-tour takes effect immediately.
      if (effectiveBindings('view.kanbanToggle').some((s) => matchesShortcut(e, s, isMac))) {
        e.preventDefault()
        e.stopPropagation()
        setKanbanTried(true)
        setKanbanPulse((n) => n + 1)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [step])

  // Esc skips the tour (settings chosen so far are already saved).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // ---- notifications (either choice records the consent and moves on) ----
  const chooseNotifications = (enable: boolean): void => {
    update({ notifyOnClaudeDone: enable, notifyConsentAsked: true })
    if (enable) {
      void window.nodeTerminal.notify({
        title: 'Notifications enabled',
        body: "You'll be told when an agent finishes in the background.",
        nodeId: '',
        force: true
      })
    }
    setStep((s) => Math.min(s + 1, STEP_COUNT - 1))
  }

  // `defaultAgent` is always a launchable builtin per its doc, but the type is open — guard.
  const agentId: BuiltinAgentId = (BUILTIN_AGENT_IDS as readonly string[]).includes(settings.defaultAgent)
    ? (settings.defaultAgent as BuiltinAgentId)
    : 'claude'
  const agent = AGENT_CONFIG[agentId]
  // The registry's dictation chord. `''` (the user unbound it) falls back to the DEFAULT chord
  // with the copy unchanged: the tour TEACHES the feature, and a fresh install — the only place
  // this flow runs on its own — cannot have it disabled. Telling a first-run user "dictation is
  // off" on a screen whose whole job is to introduce dictation would be a worse lie than the
  // chord being stale for the one user who re-opened the tour after unbinding it.
  const dictationChord = useSettings(() => dictationBinding()) || DEFAULT_SETTINGS.speech.shortcut
  const dictKeys = shortcutKeyParts(dictationChord, isMac)
  const dictHold = isHoldChord(dictationChord)
  // Both read through the SAME `settings` subscription above (`useSettings((s) => s.settings)`
  // re-renders this component on every settings write, a remap included), so these plain calls
  // are live. `''` / `[]` mean the command is unbound — each site below says what it does then.
  const newAgentChip = chipFor('node.newAgent')
  const kanbanKeys = commandKeys('view.kanbanToggle')

  const stepId: StepId = STEPS[step] ?? 'cover'
  const next = () => setStep((s) => Math.min(s + 1, STEP_COUNT - 1))
  const back = () => setStep((s) => Math.max(s - 1, 0))

  return createPortal(
    <div className="onb">
      {stepId === 'cover' && <OnbGhostCanvas />}
      <button className="onb-skip" onClick={onClose}>
        Skip setup
      </button>

      {stepId === 'cover' ? (
        <div className="onb-cover">
          <div className="onb-cover__brand">
            <OnbBrandMark />
            <span className="onb-cover__name">nodeterm</span>
          </div>
          <p className="onb-cover__tagline">A canvas of terminals — spatial, not stacked.</p>
          <div className="onb-cover__props">
            <div className="onb-prop">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="14" rx="2" />
                <path d="M7 9l3 2.5L7 14M12.5 14H17" />
              </svg>
              <span>Terminals never die — tmux keeps them running across restarts</span>
            </div>
            <div className="onb-prop">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
              </svg>
              <span>
                AI agents are first-class nodes —{' '}
                {BUILTIN_AGENT_IDS.map((id) => AGENT_CONFIG[id].label).join(', ')}
              </span>
            </div>
            <div className="onb-prop">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1.5" />
                <rect x="14" y="8" width="7" height="7" rx="1.5" />
                <rect x="6" y="14" width="7" height="7" rx="1.5" />
              </svg>
              <span>Lay your work out in space — pan, zoom, group, connect</span>
            </div>
          </div>
          <button className="onb-btn onb-btn--primary onb-cover__cta" autoFocus onClick={next}>
            Set up in a minute →
          </button>
        </div>
      ) : (
        <div className="onb-card">
          <div className="onb-scene">
            {stepId === 'agents' && <SceneAgents agentId={agentId} label={agent.label} color={agent.color} />}
            {stepId === 'dictation' && <SceneDictation keys={dictKeys.map((k) => keyLabel(k, isMac))} hold={dictHold} />}
            {stepId === 'kanban' && <SceneKanban pulseKey={kanbanPulse} />}
            {stepId === 'notify' && <SceneNotify />}
            {stepId === 'keepawake' && (
              <SceneKeepAwake agentId={agentId} label={agent.label} color={agent.color} />
            )}
            {stepId === 'notch' && <SceneNotch />}
            {stepId === 'phone' && <ScenePhone />}
          </div>
          <div className="onb-pane">
            <div className="onb-step-no">Step {step} of {STEP_COUNT - 1}</div>

            {stepId === 'agents' && (
              <>
                <h2>Everything is a node</h2>
                <p>
                  Right-click the canvas to open a terminal — or an AI agent. Each one runs in
                  its own persistent tmux session.
                </p>
                <div className="onb-label">
                  {/* Follows a remap of `node.newAgent`. When the user unbound it there is no
                      key to name, so the label drops the parenthetical instead of promising a
                      chord that no longer fires — the setting itself still matters (the pane
                      menu, the dock and ⌘K all open the default agent). */}
                  {newAgentChip ? `Default agent (what ${newAgentChip} opens)` : 'Default agent'}
                </div>
                <div className="onb-agent-grid">
                  {BUILTIN_AGENT_IDS.map((id) => (
                    <button
                      key={id}
                      className={`onb-agent ${settings.defaultAgent === id ? 'is-selected' : ''}`}
                      onClick={() => update({ defaultAgent: id })}
                    >
                      <AgentIcon agentId={id} />
                      {AGENT_CONFIG[id].label}
                    </button>
                  ))}
                </div>
                <div className="onb-fineprint">
                  Bring your own CLI too — add custom agents in Settings → Agents.
                </div>
              </>
            )}

            {stepId === 'dictation' && (
              <>
                <h2>Talk to your terminal</h2>
                <p>
                  {dictHold ? 'Hold' : 'Press'}{' '}
                  {dictKeys.map((k, i) => (
                    <kbd key={i} className="kbd">
                      {keyLabel(k, isMac)}
                    </kbd>
                  ))}{' '}
                  anywhere to dictate — on-device Whisper turns speech into text. Nothing is
                  sent to the cloud, and nothing auto-submits.
                </p>
                <div className="onb-label">Whisper model — optional</div>
                <div className="onb-models">
                  {/* A real "I don't use dictation" choice (issue #143), not just the generic Next:
                      selects None, downloads nothing. It is also the DEFAULT, so doing nothing on
                      this step is the same honest opt-out. */}
                  <button
                    className={`onb-model ${!hasSpeechModel(settings.speech.model) ? 'is-selected' : ''}`}
                    onClick={() => {
                      setModelHint('')
                      update({ speech: { ...settings.speech, model: SPEECH_MODEL_NONE } })
                    }}
                  >
                    <span className="onb-model__radio" />
                    <span className="onb-model__name">No dictation</span>
                    <span className="onb-model__size">nothing downloads</span>
                  </button>
                  {models.map((m) => {
                    const selected = settings.speech.model === m.id
                    const pct = progress[m.id]
                    return (
                      <button
                        key={m.id}
                        className={`onb-model ${selected ? 'is-selected' : ''} ${m.pro && !isPremium ? 'is-locked' : ''}`}
                        onClick={() => pickModel(m)}
                      >
                        <span className="onb-model__radio" />
                        <span className="onb-model__name">{modelLabel(m.id)}</span>
                        <span className="onb-model__size">{formatSize(m.sizeMB ?? m.approxMB)}</span>
                        {m.pro && <span className="onb-pro">PRO</span>}
                        {m.downloaded && (
                          <span className="onb-model__ok">
                            <OnbCheck />
                          </span>
                        )}
                        {pct !== undefined && (
                          <span className="onb-model__bar">
                            <span style={{ width: `${pct}%` }} />
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
                {modelHint && <div className="onb-fineprint">{modelHint}</div>}
              </>
            )}

            {stepId === 'kanban' && (
              <>
                <h2>One project, two views</h2>
                <p>
                  Every project is a canvas — and also a kanban board. Cards are your live
                  sessions: drag them across columns, open them, comment on them.
                </p>
                {/* No chord to press when the user unbound the toggle, so the try-it PROMPT is
                    dropped — the scene, the copy and the default-view choice all stay. (Kept
                    while `kanbanTried` so an unbind mid-tour doesn't retract a checkmark the
                    user already earned; nothing can set it once unbound.) The chips are
                    `commandKeys`, which already renders platform-correct parts — no keyLabel
                    rewrite on top. */}
                {(kanbanKeys.length > 0 || kanbanTried) && (
                  <div className={`onb-tryit ${kanbanTried ? 'is-done' : ''}`}>
                    {kanbanTried ? (
                      <>
                        <OnbCheck /> That's the toggle — it works in any project.
                      </>
                    ) : (
                      <>
                        Try it now — press{' '}
                        {kanbanKeys.map((k, i) => (
                          <kbd key={i} className="kbd">
                            {k}
                          </kbd>
                        ))}
                      </>
                    )}
                  </div>
                )}
                <div className="onb-defaultview">
                  <span className="onb-defaultview__label">Open new projects as</span>
                  <div className="onb-seg" role="group" aria-label="Default view">
                    <button
                      className={`onb-seg__btn${settings.defaultProjectView === 'table' ? ' is-on' : ''}`}
                      onClick={() => update({ defaultProjectView: 'table' })}
                    >
                      Mesa
                    </button>
                    <button
                      className={`onb-seg__btn${settings.defaultProjectView === 'canvas' ? ' is-on' : ''}`}
                      onClick={() => update({ defaultProjectView: 'canvas' })}
                    >
                      Canvas
                    </button>
                    <button
                      className={`onb-seg__btn${settings.defaultProjectView === 'kanban' ? ' is-on' : ''}`}
                      onClick={() => update({ defaultProjectView: 'kanban' })}
                    >
                      Kanban
                    </button>
                  </div>
                </div>
              </>
            )}

            {stepId === 'notify' && (
              <>
                <h2>Know when an agent needs you</h2>
                <p>
                  nodeterm can notify you when an agent finishes — or gets stuck waiting on an
                  approval — while you're somewhere else. Change any time in Settings →
                  Notifications.
                </p>
                <div className="onb-notify-actions">
                  <button className="onb-btn onb-btn--primary" autoFocus onClick={() => chooseNotifications(true)}>
                    Enable notifications
                  </button>
                  <div className="onb-fineprint">…or just hit Next to leave them off.</div>
                </div>
              </>
            )}

            {stepId === 'keepawake' && (
              <>
                <h2>Long runs survive your lunch break</h2>
                <p>
                  While an agent is working, nodeterm keeps this machine from idle-sleeping —
                  and lets go the moment it finishes.
                </p>
                <p>
                  Closing the lid still sleeps the machine — keep it open and plugged in for
                  overnight runs.
                </p>
                <div className="onb-toggle-row">
                  <Switch
                    checked={settings.keepAwakeWhileAgentsWork}
                    ariaLabel="Keep awake while agents work"
                    onChange={(on) => update({ keepAwakeWhileAgentsWork: on })}
                  />
                  <span>Keep awake while agents work</span>
                </div>
                <div className="onb-fineprint">Change any time in Settings → Behavior.</div>
              </>
            )}

            {stepId === 'notch' && (
              <>
                <h2>Your agents, inside the notch</h2>
                <p>
                  On a MacBook, nodeterm can grow the notch into a small black capsule: a walking
                  mascot for every agent that's working, a red dot when one needs you, and a green
                  blob when one has finished and you haven't looked yet.
                </p>
                <p>
                  Point at it and it opens a mini panel of your live sessions — hit <strong>Go</strong>{' '}
                  and nodeterm comes forward with that node centred.
                </p>
                <div className="onb-toggle-row">
                  <Switch
                    checked={settings.notchHud}
                    ariaLabel="Notch HUD"
                    onChange={(on) => update({ notchHud: on })}
                  />
                  <span>Show the notch HUD</span>
                </div>
                <div className="onb-fineprint">
                  Fine-tune it any time in Settings → Interface → Notch — including the notch width,
                  which is what makes the capsule sit flush on your Mac.
                </div>
              </>
            )}

            {stepId === 'phone' && (
              <>
                <h2>Your sessions, in your pocket</h2>
                <p>
                  <strong>nodeterm mobile</strong> attaches to these same live tmux sessions from
                  your phone — watch an agent work, answer a "needs you", or type into any
                  terminal from anywhere.
                </p>
                <p>
                  Grab it from the App Store, then pair in seconds: Settings → Phone (or the
                  phone button top-right) shows a QR — scan it and you're in.
                </p>
                <div className="onb-notify-actions">
                  <button
                    className="onb-btn onb-btn--primary"
                    onClick={() => window.nodeTerminal.shell.openExternal(IOS_APP_STORE_URL)}
                  >
                    Get the iOS app
                  </button>
                </div>
              </>
            )}

            <div className="onb-nav">
              <div className="onb-dots">
                {Array.from({ length: STEP_COUNT }, (_, i) => (
                  <span key={i} className={i === step ? 'is-active' : ''} />
                ))}
              </div>
              <div className="onb-nav__btns">
                <button className="onb-btn" onClick={back}>
                  Back
                </button>
                {/* One consistent footer on every step (a lone Back read as the primary action).
                    Next past the notifications step without choosing = leave them off — the
                    close handler records the unanswered consent as asked+off. */}
                <button
                  className="onb-btn onb-btn--primary"
                  onClick={step === STEP_COUNT - 1 ? onClose : next}
                >
                  {step === STEP_COUNT - 1 ? 'Finish' : 'Next'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body
  )
}

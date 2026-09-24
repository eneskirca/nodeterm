import { useEffect, useRef, useState } from 'react'
import type { AgentId } from '@shared/agents/config'
import { AgentIcon } from '../../lib/agentIcons'
import { IconTerminal, IconNote, IconEditor } from '../icons'
import { AgentMascot } from '../../nodes/AgentMascot'

/**
 * Animated scenes for the first-run setup tour (OnboardingFlow). All motion is CSS-only
 * (keyframes in styles.css, `.onb-*`) so there are no new dependencies; every scene loops
 * and respects `prefers-reduced-motion` (styles.css freezes them to their final frame).
 * Where a scene depicts real UI (context menu, terminal node, kanban columns) it reuses
 * the app's OWN classes (`ctx-menu`/`ctx-item`, `term-node__status`, kanban column look)
 * so the tour never drifts from what the user actually gets.
 */

/** Inline check icon — a literal "✓" is tofu on Linux's default font stack. */
export function OnbCheck({ size = 13 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12.5l5.5 5.5L20 6.5" />
    </svg>
  )
}

/** The nodeterm mark (same path as WelcomeScreen's, sized for the tour). */
export function OnbBrandMark({ size = 56 }: { size?: number }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
      <defs>
        <linearGradient id="onbg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#a38dff" />
          <stop offset="1" stopColor="#622994" />
        </linearGradient>
      </defs>
      <path
        d="M13 12 L31 24 L13 36"
        fill="none"
        stroke="url(#onbg)"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="13" cy="12" r="3.6" fill="#a38dff" />
      <circle cx="13" cy="36" r="3.6" fill="#a38dff" />
      <circle cx="31" cy="24" r="3.6" fill="#fff" />
      <rect x="33.5" y="32.5" width="10.5" height="5" rx="2.5" fill="#a38dff" />
    </svg>
  )
}

/** Floating ghost nodes + edges behind the welcome step — the canvas metaphor, sensed
 *  before it's explained. Pure decoration (aria-hidden). */
export function OnbGhostCanvas() {
  return (
    <div className="onb-ghosts" aria-hidden="true">
      <div className="onb-ghost onb-ghost--a" />
      <div className="onb-ghost onb-ghost--b" />
      <div className="onb-ghost onb-ghost--c" />
      <div className="onb-ghost onb-ghost--d" />
      <svg className="onb-ghost-edges" viewBox="0 0 800 500" preserveAspectRatio="none">
        <path d="M180 140 C 300 120, 380 220, 520 200" />
        <path d="M540 230 C 480 320, 340 340, 240 380" />
      </svg>
    </div>
  )
}

/** Right-click → context menu → an agent node pops onto the canvas. The menu is the app's
 *  real `.ctx-menu`/`.ctx-item` (with the real brand icons) and the node mirrors
 *  `.term-node`'s look (3px color top border, panel header, real RUNNING badge classes) —
 *  both follow the currently selected default agent. */
export function SceneAgents({ agentId, label, color }: { agentId: AgentId; label: string; color: string }) {
  return (
    <div className="onb-scene-canvas" aria-hidden="true">
      {/* click ripple where the cursor right-clicks */}
      <div className="onb-ripple" />
      {/* the real context menu, replayed (pointer-events off; positioned by the scene) */}
      <div className="ctx-menu onb-menu">
        <button className="ctx-item" tabIndex={-1}>
          <span className="ctx-icon"><IconTerminal /></span>
          New terminal
        </button>
        <button className="ctx-item onb-menu__hl" tabIndex={-1}>
          <span className="ctx-icon"><AgentIcon agentId={agentId} /></span>
          New {label}
        </button>
        <button className="ctx-item" tabIndex={-1}>
          <span className="ctx-icon"><IconNote /></span>
          New sticky note
        </button>
        <button className="ctx-item" tabIndex={-1}>
          <span className="ctx-icon"><IconEditor /></span>
          Open file…
        </button>
      </div>
      {/* the spawned agent node (term-node look: 3px color top border + panel header) */}
      <div className="onb-node" style={{ borderTopColor: color }}>
        <div className="onb-node__head">
          <span className="onb-node__color" style={{ background: color }} />
          <AgentIcon agentId={agentId} size={13} />
          <span className="onb-node__title">{label}</span>
          <span className="term-node__status term-node__status--busy" style={{ marginLeft: 'auto' }}>
            <span className="term-node__status-dot" />
            RUNNING
          </span>
        </div>
        <div className="onb-node__body">
          <div className="onb-line onb-line--w70" />
          <div className="onb-line onb-line--w50" />
          <div className="onb-line onb-line--w60" />
        </div>
      </div>
      {/* animated cursor */}
      <svg className="onb-cursor" viewBox="0 0 24 24" width="18" height="18">
        <path
          d="M5 3l14 8-6 1.5L16 19l-2.5 1-3-6.5L6 17z"
          fill="#fff"
          stroke="rgba(0,0,0,0.55)"
          strokeWidth="1.2"
        />
      </svg>
    </div>
  )
}

/** Dictation, as a SEQUENCE (one shared 8s timeline): the shortcut is held → the mic +
 *  waveform appear while holding → on release the transcribed text types into the
 *  terminal line. Mirrors the real flow: nothing is written until you let go. */
export function SceneDictation({ keys, hold }: { keys: string[]; hold: boolean }) {
  return (
    <div className="onb-scene-canvas onb-scene--dictation" aria-hidden="true">
      <div className="onb-kbd-row">
        {keys.map((k, i) => (
          <kbd key={i} className={`onb-kbd ${hold ? 'onb-kbd--hold' : ''}`} style={{ animationDelay: `${i * 0.1}s` }}>
            {k}
          </kbd>
        ))}
        {hold && <span className="onb-kbd-hint">hold…</span>}
      </div>
      {/* visible only during the hold window (wrapper opacity gates the loop inside) */}
      <div className="onb-mic-wrap">
        <div className="onb-mic">
          <div className="onb-mic__ring" />
          <div className="onb-mic__ring onb-mic__ring--late" />
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
          </svg>
          <div className="onb-wave">
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i} style={{ animationDelay: `${i * 0.15}s` }} />
            ))}
          </div>
        </div>
      </div>
      <div className="onb-term-line">
        <span className="onb-term-prompt">❯</span>
        <span className="onb-term-typed">run the tests and fix what breaks</span>
        <span className="onb-caret" />
      </div>
    </div>
  )
}

// Stage is 312×210 (3 real-looking columns of 96px + 12px gaps), centered by the scene.
const KCOL_W = 96
const KCOL_X = [0, 108, 216]
const KCOL_LABELS = ['To Do', 'In Progress', 'Done']
const KANBAN_CARDS = [
  // canvas-scatter [x, y, rotate] → board [column, row]
  { id: 0, c: [18, 22, -3], col: 0, row: 0 },
  { id: 1, c: [180, 12, 2], col: 0, row: 1 },
  { id: 2, c: [232, 74, -2], col: 1, row: 0 },
  { id: 3, c: [64, 120, 3], col: 1, row: 1 },
  { id: 4, c: [190, 158, -1], col: 2, row: 0 }
]

/** Canvas ↔ kanban morph: scattered session cards fly into three labelled columns and back,
 *  on a timer (transition-driven, so a JS toggle is enough — no per-card keyframes). The
 *  stage is centered in the scene and the columns mirror the real board's column panels. */
export function SceneKanban({ pulseKey }: { pulseKey?: number }) {
  const [board, setBoard] = useState(false)
  const reduced = useRef(
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
  )
  useEffect(() => {
    if (reduced.current) {
      setBoard(true) // static: show the board form
      return
    }
    const t = setInterval(() => setBoard((b) => !b), 2600)
    return () => clearInterval(t)
  }, [])
  // an external pulse (the user pressing ⌘⇧B for real) flips the scene too — the animation
  // answers their keystroke, which is the whole point of the try-it interaction
  const lastPulse = useRef(pulseKey)
  useEffect(() => {
    if (pulseKey !== undefined && pulseKey !== lastPulse.current) {
      lastPulse.current = pulseKey
      setBoard((b) => !b)
    }
  }, [pulseKey])

  return (
    <div className="onb-scene-canvas onb-scene--kanban" aria-hidden="true">
      <div className={`onb-kstage ${board ? 'is-board' : ''}`}>
        {KCOL_LABELS.map((l, i) => (
          <div key={l} className="onb-kcol" style={{ left: KCOL_X[i] }}>
            <div className="onb-kcol__h">{l}</div>
          </div>
        ))}
        {KANBAN_CARDS.map((k) => (
          <div
            key={k.id}
            className="onb-mini"
            style={
              board
                ? { left: KCOL_X[k.col] + 6, top: 36 + k.row * 34, transform: 'rotate(0deg)', width: KCOL_W - 12 }
                : { left: k.c[0], top: k.c[1], transform: `rotate(${k.c[2]}deg)`, width: 64 }
            }
          >
            <span className="onb-mini__dot" />
            <span className="onb-mini__bar" />
          </div>
        ))}
      </div>
    </div>
  )
}

/** A mock OS notification sliding in — what enabling notifications buys you. */
/**
 * The macOS notch capsule: a laptop lid whose notch grows sideways into a black capsule with a
 * walking mascot + a green "finished" blob, then drops the mini session panel out of it. Same
 * geometry story as the real HUD (fused to the notch, extends left/right, never taller).
 */
export function SceneNotch() {
  return (
    <div className="onb-scene-canvas onb-scene--notch" aria-hidden="true">
      <div className="onb-lid">
        <div className="onb-lid__bar">
          <div className="onb-capsule">
            <span className="onb-capsule__left">
              <AgentMascot agentId="claude" />
              <span className="onb-capsule__blob" />
            </span>
            <span className="onb-capsule__notch" />
          </div>
          <div className="onb-notchpanel">
            <div className="onb-notchpanel__row">
              <span className="onb-mini__dot" style={{ background: '#d97757' }} />
              <span className="onb-mini__bar" />
              <span className="onb-notchpanel__go">Go</span>
            </div>
            <div className="onb-notchpanel__row">
              <span className="onb-mini__dot" style={{ background: '#30d158' }} />
              <span className="onb-mini__bar onb-mini__bar--short" />
              <span className="onb-notchpanel__go">Go</span>
            </div>
          </div>
        </div>
        <div className="onb-lid__screen" />
      </div>
    </div>
  )
}

export function SceneNotify() {
  return (
    <div className="onb-scene-canvas onb-scene--notify" aria-hidden="true">
      <svg className="onb-bell" viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.7 21a2 2 0 0 1-3.4 0" />
      </svg>
      <div className="onb-notif">
        <div className="onb-notif__icon">
          <OnbBrandMark size={22} />
        </div>
        <div className="onb-notif__text">
          <div className="onb-notif__title">Claude Code finished</div>
          <div className="onb-notif__body">fix-auth · tests passing</div>
        </div>
        <div className="onb-notif__time">now</div>
      </div>
    </div>
  )
}

/** Keep-awake: a crossed-out moon drifts above a term-node that stays RUNNING — while an
 *  agent works, idle sleep doesn't happen, and the slash shares the RUNNING clay so the
 *  badge reads as the thing cancelling sleep. Built entirely from existing vocabulary:
 *  the node is the agents scene's `.onb-node` (held on screen via static inline overrides)
 *  with the app's real RUNNING badge classes, and the moon borrows `.onb-ghost`'s float
 *  loop — so every animation here is one styles.css already freezes under
 *  `prefers-reduced-motion`, and no new keyframes were needed. */
export function SceneKeepAwake({ agentId, label, color }: { agentId: AgentId; label: string; color: string }) {
  return (
    <div
      className="onb-scene-canvas"
      aria-hidden="true"
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 30 }}
    >
      {/* the sleep that doesn't happen: onb-ghost supplies the gentle float (and its
          reduced-motion freeze); the ghost's box look is neutralized inline */}
      <div
        className="onb-ghost"
        style={{ position: 'relative', width: 'auto', height: 'auto', border: 'none', background: 'none' }}
      >
        <svg
          viewBox="0 0 34 28"
          width="72"
          height="60"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ color: 'var(--muted)' }}
        >
          <path d="M13 6a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" stroke="currentColor" strokeWidth="1.8" />
          <path d="M25 3h4.5l-4.5 4.5h4.5" stroke="currentColor" strokeWidth="1.5" opacity="0.75" />
          <path d="M29 11h3l-3 3h3" stroke="currentColor" strokeWidth="1.3" opacity="0.5" />
          <line x1="4" y1="26" x2="31" y2="2" stroke="#d97757" strokeWidth="2.6" />
        </svg>
      </div>
      {/* the agent that outlasts it: the agents scene's node, pop loop off, with the real
          RUNNING badge — the pulsing status dot is the live part */}
      <div
        className="onb-node"
        style={{ position: 'relative', left: 'auto', top: 'auto', opacity: 1, animation: 'none', width: 200, borderTopColor: color }}
      >
        <div className="onb-node__head">
          <span className="onb-node__color" style={{ background: color }} />
          <AgentIcon agentId={agentId} size={13} />
          <span className="onb-node__title">{label}</span>
          <span className="term-node__status term-node__status--busy" style={{ marginLeft: 'auto' }}>
            <span className="term-node__status-dot" />
            RUNNING
          </span>
        </div>
        <div className="onb-node__body">
          <div className="onb-line onb-line--w70" />
          <div className="onb-line onb-line--w50" />
          <div className="onb-line onb-line--w60" />
        </div>
      </div>
    </div>
  )
}

/** Shortcuts: the palette chord goes down and a command palette drops open under it, a query
 *  typing into it. The palette is the step's one key to remember, so it is the one acted out;
 *  the user's own press of that chord (`pulseKey`) replays the drop. */
export function SceneShortcuts({ keys, query, pulseKey }: { keys: string[]; query: string; pulseKey?: number }) {
  return (
    <div className="onb-scene-canvas onb-scene--dictation" aria-hidden="true">
      {keys.length > 0 && (
        <div className="onb-kbd-row">
          {keys.map((k, i) => (
            <kbd key={i} className="onb-kbd" style={{ animationDelay: `${i * 0.1}s` }}>
              {k}
            </kbd>
          ))}
        </div>
      )}
      {/* keyed on the pulse so a real press restarts the drop animation */}
      <div key={pulseKey ?? 0} className="onb-palette">
        <div className="onb-palette__input">
          <span className="onb-term-typed">{query}</span>
          <span className="onb-caret" />
        </div>
        <div className="onb-palette__row is-hl">
          <span className="onb-mini__dot" style={{ background: '#d97757' }} />
          <span className="onb-mini__bar" />
        </div>
        <div className="onb-palette__row">
          <span className="onb-mini__dot" />
          <span className="onb-mini__bar onb-mini__bar--short" />
        </div>
        <div className="onb-palette__row">
          <span className="onb-mini__dot" />
          <span className="onb-mini__bar" />
        </div>
      </div>
    </div>
  )
}

/** The mobile companion as a floating phone mockup: live session rows with real status
 *  badges + a terminal line — live on the App Store (the step links to it). */
export function ScenePhone() {
  return (
    <div className="onb-scene-canvas onb-scene--phone" aria-hidden="true">
      <div className="onb-phone">
        <div className="onb-phone__notch" />
        <div className="onb-phone__rows">
          <div className="onb-phone__row">
            <span className="onb-mini__dot" style={{ background: '#d97757' }} />
            <span className="onb-mini__bar" />
            <span className="term-node__status term-node__status--busy onb-phone__badge">
              <span className="term-node__status-dot" />
              RUNNING
            </span>
          </div>
          <div className="onb-phone__row">
            <span className="onb-mini__dot" style={{ background: '#10a37f' }} />
            <span className="onb-mini__bar" />
            <span className="term-node__status term-node__status--attention onb-phone__badge">
              <span className="term-node__status-dot" />
              NEEDS YOU
            </span>
          </div>
          <div className="onb-phone__row">
            <span className="onb-mini__dot" />
            <span className="onb-mini__bar" />
          </div>
          <div className="onb-phone__term">
            <span className="onb-term-prompt">❯</span>
            <span className="onb-caret" />
          </div>
        </div>
      </div>
      <span className="onb-soon">ON THE APP STORE</span>
    </div>
  )
}

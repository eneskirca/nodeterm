// Notch HUD renderer (docs/notch-hud.md). Plain TS/DOM — no React. Draws the collapsed indicator
// (walking mascots beside the notch) and the expanded mini session panel, reusing lib/mascot.ts art
// + the walk-cycle CSS. Reports pointer enter/leave of the hotspot to main to toggle click-through,
// and row clicks to focus the node in nodeterm.

import './hud.css'
import { CLAUDE_MASCOT, CODEX_MASCOT, DONE_BLOB } from '../lib/mascot'
import { HUD_BRAND_PULSE_CLASS, brandPulseBackground, brandPulsePlan } from '../lib/brandPulse'
import { createGrokMarkSvg } from '../lib/grokMark'
import { createCopilotMarkSvg } from '../lib/copilotMark'
import { buildIndicator, orderIndicatorAgents } from './indicator'
import { HUD_ROW_CAP, overflowLabel, splitPanelRows } from './panel-rows'
import { percentText } from '../lib/usageFormat'
import codexPet from '../assets/pet-codex.webp'

// Local mirror of the preload's HUD contract (src/preload/hud.ts) — kept self-contained so this
// renderer entry has no cross-project (main/preload) type dependency.
interface HudSubagentRow {
  id: string
  label?: string
  state: 'working' | 'done'
}
interface HudRow {
  nodeId: string
  agentId?: string
  title: string
  model?: string
  state: 'working' | 'needsYou' | 'done' | 'idle'
  prompt?: string
  activity?: string
  contextPercent?: number
  subagents: HudSubagentRow[]
  /** Finished and not yet looked at — the sidebar's `unread` mark, ranked + labelled here. */
  unread: boolean
  updatedAt: number
}
interface HudPush {
  rows: HudRow[]
  bar: number
  width: number
  notchWidth: number
  notchCenterX: number
  hasNotch: boolean
  hoverExpand: boolean
  percentMode?: 'used' | 'remaining' | 'tokens'
}
interface HudApi {
  onRows(cb: (push: HudPush) => void): () => void
  setIgnoreMouse(ignore: boolean): void
  focusNode(nodeId: string): void
  setExpanded(expanded: boolean): void
  dismiss(nodeId: string): void
}

declare global {
  interface Window {
    hud: HudApi
  }
}

const root = document.getElementById('hud') as HTMLDivElement

// One black rounded-bottom surface — the DynamicNotch capsule — fused to the physical notch. It IS
// the interactive hotspot: the walking mascots live INSIDE it (collapsed), and clicking it grows
// the SAME surface downward into the session panel (expanded).
const capsule = document.createElement('div')
// Start hidden so there is no flash of an empty black pill before the first rows push.
capsule.className = 'hud-capsule hud-capsule--hidden'
const indicator = document.createElement('div')
indicator.className = 'hud-indicator'
const panel = document.createElement('div')
panel.className = 'hud-panel'
capsule.append(indicator, panel)
root.append(capsule)

let expanded = false
let latestRows: HudRow[] = []
// Notch width from main's geometry push — drives the symmetric right-hand padding.
let notchWidthPx = 168
// Hover-to-expand (settings.notchHoverExpand). Off = the capsule only expands on click.
let hoverExpand = true
// settings.usagePercentMode — the same number/label the other context surfaces render (issue #78).
let percentMode: 'used' | 'remaining' | 'tokens' = 'remaining'
// Which subagent disclosures the user has opened (by nodeId), preserved across re-renders.
const openSubs = new Set<string>()
// The user clicked "+N more" — draw every pushed row instead of the first HUD_ROW_CAP. Reset when
// the panel closes: the cap is the glance default, and an expansion is about the panel in front of
// you, not a preference.
let showAllRows = false

// ---- Interaction: click-through hotspot + expand/collapse ----------------------------------

// The capsule IS the hotspot. While the window is click-through (setIgnoreMouse(true,{forward:true})),
// the OS still forwards MOVE events, so pointerenter fires and we flip click-through OFF to accept
// clicks. Leaving the capsule re-enables click-through and collapses the panel (the click-away). The
// transparent rest of the window stays click-through throughout.
// HOVER OPENS IT (owner: "üzerine gelince genişleme yok"). A short dwell keeps a pointer merely
// crossing the top edge from popping the panel; leaving collapses immediately. Clicking still
// toggles, so the panel can also be dismissed without moving away.
const HOVER_OPEN_MS = 180
let hoverTimer: number | undefined

capsule.addEventListener('pointerenter', () => {
  window.hud.setIgnoreMouse(false)
  window.clearTimeout(hoverTimer)
  if (hoverExpand) hoverTimer = window.setTimeout(() => setExpanded(true), HOVER_OPEN_MS)
})
capsule.addEventListener('pointerleave', () => {
  window.clearTimeout(hoverTimer)
  window.hud.setIgnoreMouse(true)
  if (expanded) setExpanded(false)
})
indicator.addEventListener('click', () => {
  window.clearTimeout(hoverTimer)
  setExpanded(!expanded)
})

function setExpanded(next: boolean): void {
  if (expanded === next) return
  expanded = next
  if (!expanded && showAllRows) {
    showAllRows = false
    renderPanel(latestRows)
  }
  capsule.classList.toggle('expanded', expanded)
  syncCapsuleOverhang() // expanded: drop the padding so the panel gets the full width
  window.hud.setExpanded(expanded)
}

// ---- Relative time -------------------------------------------------------------------------

function reltime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 5) return 'now'
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  return `${h}h`
}

// ---- Mascot / icon builders ----------------------------------------------------------------

// Indicator mascot heights in the menu-bar strip (px). agent-notch draws Claude ~ the bar height
// and the Codex pet at 26px; these are the sensible defaults — NAIL EXACTLY ON A MAC (the notch
// bar height varies by model, and 26px overflows a short bar). Aspect ratios are preserved from
// the sprite geometry, so only the height matters.
/** Height of the quadrant-block sprite (claude), and of the pulsing brand marks — one number so the
 *  working indicators all sit on the same baseline in the strip. */
const HUD_QUADRANT_H = 13
const HUD_CODEX_H = 17

/** A quadrant-block sprite mascot (claude today) — the sizing math is shared so the notch strip
 *  and the canvas badge can never disagree about the geometry in lib/mascot.ts. */
function quadrantMascot(
  mascot: { src: string; frameWidth: number; frameHeight: number },
  variant: 'claude'
): HTMLElement {
  const el = document.createElement('span')
  el.className = `mascot mascot--${variant}`
  const h = HUD_QUADRANT_H
  const w = Math.round((h * mascot.frameWidth) / mascot.frameHeight)
  el.style.setProperty('--mascot-w', `${w}px`)
  el.style.setProperty('--mascot-h', `${h}px`)
  el.style.backgroundImage = `url(${mascot.src})`
  return el
}
function codexMascot(): HTMLElement {
  const el = document.createElement('span')
  el.className = 'mascot mascot--codex'
  const h = HUD_CODEX_H
  const w = Math.round((h * CODEX_MASCOT.frameWidth) / CODEX_MASCOT.frameHeight)
  el.style.setProperty('--cmascot-w', `${w}px`)
  el.style.setProperty('--cmascot-h', `${h}px`)
  el.style.setProperty('--cmascot-sheet-w', `${w * CODEX_MASCOT.cols}px`)
  el.style.setProperty('--cmascot-sheet-h', `${h * CODEX_MASCOT.rows}px`)
  el.style.backgroundImage = `url(${codexPet})`
  return el
}
/** An asset brand mark (gemini/opencode/copilot), breathing: a background-image span. These marks carry their
 *  own fills, so unlike grok's they cannot be drawn as an inline `currentColor` path — the bloom is
 *  the strip's label colour rather than their own ink (see lib/brandPulse.ts). */
function brandPulseMascot(src: string, size: number): HTMLElement {
  const el = document.createElement('span')
  el.className = `${HUD_BRAND_PULSE_CLASS} mascot--pulse-asset`
  el.style.width = `${size}px`
  el.style.height = `${size}px`
  // Quoted via brandPulseBackground: these marks are inlined data URIs containing `)` and `'`, and
  // an unquoted url() is rejected outright — the mark would paint NOTHING.
  el.style.backgroundImage = brandPulseBackground(src)
  return el
}
// Returns an SVGSVGElement for grok (an inline brand mark) and HTMLElement for the sprite
// mascots; every caller only appends it, so `Element` is the honest shared type.
function workingMascot(agentId?: string): Element {
  if (agentId === 'claude' && CLAUDE_MASCOT.src) return quadrantMascot(CLAUDE_MASCOT, 'claude')
  if (agentId === 'codex') return codexMascot()
  // grok, gemini, opencode, copilot and devin breathe their own brand mark instead of walking a critter — the SAME
  // decision the canvas badge makes (lib/brandPulse.ts, shared precisely so one agent is never two
  // different things on two surfaces). This renderer stays React-free, so it draws the plan itself.
  const plan = brandPulsePlan(agentId, HUD_QUADRANT_H)
  if (plan) {
    return plan.kind === 'inline'
      ? plan.mark === 'copilot'
        ? createCopilotMarkSvg(plan.size, HUD_BRAND_PULSE_CLASS)
        : createGrokMarkSvg(plan.size, HUD_BRAND_PULSE_CLASS)
      : brandPulseMascot(plan.src, plan.size)
  }
  const dot = document.createElement('span')
  dot.className = 'mascot mascot--dot'
  return dot
}
function doneBlob(): HTMLElement {
  const blob = document.createElement('span')
  blob.className = 'done-blob'
  // 7×7 crisp green pixel circle (agent-notch look); CSS drives the shimmer. Falls back to the
  // CSS-only round blob when the sprite couldn't be built (no DOM canvas).
  if (DONE_BLOB.src) blob.style.backgroundImage = `url(${DONE_BLOB.src})`
  else blob.classList.add('done-blob--fallback')
  return blob
}
function rowIcon(row: HudRow): Element {
  if (row.state === 'working') return workingMascot(row.agentId)
  if (row.state === 'done') {
    const c = document.createElement('span')
    c.className = 'check'
    c.textContent = '✓'
    return c
  }
  // needsYou / idle
  const d = document.createElement('span')
  d.className = 'needs-dot'
  return d
}

// ---- Collapsed indicator -------------------------------------------------------------------

function renderIndicator(rows: HudRow[]): void {
  indicator.replaceChildren()
  // The aggregation is the pure `buildIndicator` (./indicator) — one definition of the rule, unit
  // tested; this function only paints its result.
  const { workingAgents, doneUnseen, needsYou } = buildIndicator(rows)
  // Left→right paint order, centered inside the capsule's drop zone: a red "needs you" dot and the
  // green "done" blob sit furthest left, then the working mascots with Claude last (notch-side).
  // Surfacing needsYou here keeps the collapsed capsule meaningful (never an empty black pill) for a
  // session that is waiting on the user even when nothing is actively working.
  if (needsYou) {
    const d = document.createElement('span')
    d.className = 'needs-dot'
    indicator.append(d)
  }
  if (doneUnseen) indicator.append(doneBlob())
  for (const agentId of orderIndicatorAgents(workingAgents)) indicator.append(workingMascot(agentId))
}

// ---- Expanded panel ------------------------------------------------------------------------

function renderPanel(rows: HudRow[]): void {
  panel.replaceChildren()
  // Rows arrive in state-priority order (main's `hudRowRank`), so the cap always cuts from the
  // least urgent end — but it still cuts, and what it cut is counted below rather than dropped.
  const { shown, hidden } = splitPanelRows(rows, showAllRows ? rows.length : HUD_ROW_CAP)
  shown.forEach((row, i) => {
    // Dithered pixel separator between rows (agent-notch's DitherSeparator).
    if (i > 0) {
      const sep = document.createElement('div')
      sep.className = 'hud-sep'
      panel.append(sep)
    }
    panel.append(buildRow(row))
  })
  const label = overflowLabel(hidden)
  if (label || showAllRows) panel.append(buildMore(label))
}

/** The "+N more · 2 unread" footer — click to draw the rest (the panel scrolls), click again to
 *  return to the glance-sized list. */
function buildMore(label: string | undefined): HTMLElement {
  const el = document.createElement('div')
  el.className = 'hud-panel__more'
  el.textContent = showAllRows ? 'Show fewer' : (label ?? '')
  el.addEventListener('click', (e) => {
    e.stopPropagation()
    showAllRows = !showAllRows
    renderPanel(latestRows)
  })
  return el
}

function buildRow(row: HudRow): HTMLElement {
  const el = document.createElement('div')
  el.className = 'hud-row'
  el.addEventListener('click', (e) => {
    // Don't hijack the disclosure toggle click.
    if ((e.target as HTMLElement).closest('.hud-subs__toggle')) return
    window.hud.focusNode(row.nodeId)
    setExpanded(false)
  })

  const icon = document.createElement('div')
  icon.className = 'hud-row__icon'
  icon.append(rowIcon(row))

  const title = document.createElement('div')
  title.className = 'hud-row__title'
  const name = document.createElement('span')
  name.className = 'hud-row__name'
  name.textContent = row.title
  title.append(name)
  // Say "unread" out loud. The row's mere existence used to be the only sign that a finished
  // session was new for you — invisible next to five other rows, and indistinguishable from a
  // glitch when it vanished on a read-ack from the phone. Same word the sessions sidebar uses.
  if (row.unread) {
    const badge = document.createElement('span')
    badge.className = 'hud-row__badge'
    badge.textContent = 'Unread'
    title.append(badge)
  }

  const tag = document.createElement('div')
  tag.className = `hud-row__tag hud-row__tag--${row.state}`
  const parts: string[] = []
  if (row.model) parts.push(row.model)
  parts.push(reltime(row.updatedAt))
  // Labeled, not a bare number: "42% used" / "58% left" per the display setting — the label is
  // what keeps a context percentage from reading as provider quota.
  if (typeof row.contextPercent === 'number') parts.push(percentText(row.contextPercent, percentMode))
  tag.textContent = parts.join(' · ')

  const sub = document.createElement('div')
  sub.className = 'hud-row__sub'
  if (row.prompt) {
    const b = document.createElement('b')
    b.textContent = 'You: '
    sub.append(b, document.createTextNode(row.prompt))
  } else if (row.activity) {
    sub.textContent = row.activity
  } else {
    sub.textContent = stateLabel(row.state)
  }

  el.append(icon, title, tag, sub)

  if (row.subagents.length > 0) el.append(buildSubs(row))

  // Dismiss (hover ×, or right-click anywhere on the row): a session can hang in `working` when its
  // agent dies mid-turn, and the HUD would carry it forever. Hiding is local to the HUD — the node
  // and its terminal are untouched, and a real state change brings the row back.
  const dismiss = (e: Event): void => {
    e.preventDefault()
    e.stopPropagation()
    window.hud.dismiss(row.nodeId)
  }
  el.addEventListener('contextmenu', dismiss)

  const close = document.createElement('button')
  close.className = 'hud-row__close'
  close.title = 'Remove from HUD'
  close.setAttribute('aria-label', 'Remove from HUD')
  close.textContent = '×'
  close.addEventListener('click', dismiss)
  el.append(close)

  const go = document.createElement('button')
  go.className = 'hud-row__go'
  go.textContent = 'Go'
  go.addEventListener('click', (e) => {
    e.stopPropagation()
    window.hud.focusNode(row.nodeId)
    setExpanded(false)
  })
  el.append(go)

  return el
}

// Sub-line fallback wording, borrowed from the sessions sidebar's labels (STATE_LABEL /
// STATUS_GROUP_LABEL in renderer/lib/sessionList.ts) so one session does not have two names on two
// surfaces. `done` reads "Done" — the "new for you" half of it is the Unread badge's job.
function stateLabel(state: HudRow['state']): string {
  if (state === 'working') return 'Running'
  if (state === 'needsYou') return 'Needs you'
  if (state === 'done') return 'Done'
  return 'Idle'
}

function buildSubs(row: HudRow): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'hud-subs'
  const isOpen = openSubs.has(row.nodeId)
  const toggle = document.createElement('div')
  toggle.className = 'hud-subs__toggle'
  toggle.textContent = `${isOpen ? '▾' : '▸'} ${row.subagents.length} subagent${row.subagents.length === 1 ? '' : 's'}`
  toggle.addEventListener('click', (e) => {
    e.stopPropagation()
    if (openSubs.has(row.nodeId)) openSubs.delete(row.nodeId)
    else openSubs.add(row.nodeId)
    render(latestRows)
  })
  wrap.append(toggle)
  if (isOpen) {
    const list = document.createElement('ul')
    list.className = 'hud-subs__list'
    for (const s of row.subagents) list.append(buildSubItem(s))
    wrap.append(list)
  }
  return wrap
}

function buildSubItem(s: HudSubagentRow): HTMLElement {
  const li = document.createElement('li')
  const dot = document.createElement('span')
  dot.className = `hud-subs__dot hud-subs__dot--${s.state}`
  li.append(dot, document.createTextNode(s.label || s.state))
  return li
}

// ---- Render + geometry ---------------------------------------------------------------------

// The capsule grows LEFT-ONLY: its right edge stays flush with the notch's right edge, and the
// content (the mascots) occupies only the strip LEFT of the notch — the right padding covers
// exactly the notch itself, nothing more. This retires the earlier symmetric growth ("soldan ne
// kadar genişlettiysen sağdan da o kadar"): on a crowded menu bar the symmetric right-hand
// overhang sat ON TOP of the status items, and because the capsule is the click-through hotspot,
// hovering there also swallowed their clicks (issue #78 — grow-left approved by the owner there).
function syncCapsuleOverhang(): void {
  if (expanded) {
    capsule.style.paddingRight = ''
    return
  }
  const ext = indicator.offsetWidth
  capsule.style.paddingRight = ext > 0 ? `${notchWidthPx}px` : ''
}

function render(rows: HudRow[]): void {
  latestRows = rows
  renderIndicator(rows)
  renderPanel(rows)
  syncCapsuleOverhang()
  // Idle → hide the whole capsule (no empty black pill); active → the fused capsule shows.
  capsule.classList.toggle('hud-capsule--hidden', rows.length === 0)
  // Auto-collapse if there is nothing to show.
  if (rows.length === 0 && expanded) setExpanded(false)
}

function applyGeometry(push: HudPush): void {
  const rs = document.documentElement.style
  rs.setProperty('--bar', `${push.bar}px`)
  if (typeof push.notchWidth === 'number') {
    notchWidthPx = push.notchWidth
    rs.setProperty('--notch-width', `${push.notchWidth}px`)
  }
  if (typeof push.notchCenterX === 'number') rs.setProperty('--notch-center-x', `${push.notchCenterX}px`)
  if (typeof push.hoverExpand === 'boolean') hoverExpand = push.hoverExpand
  if (push.percentMode === 'used' || push.percentMode === 'remaining' || push.percentMode === 'tokens') percentMode = push.percentMode
  // No physical notch → draw a standalone floating pill instead of fusing to y=0.
  document.documentElement.classList.toggle('notchless', push.hasNotch === false)
}

window.hud.onRows((push: HudPush) => {
  applyGeometry(push)
  render(push.rows ?? [])
})

// Refresh reltimes every 20s even without a push.
setInterval(() => {
  if (latestRows.length > 0) renderPanel(latestRows)
}, 20_000)

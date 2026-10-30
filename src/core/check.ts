// Polls the backend /v1/check feed from the main process (so the renderer CSP stays 'self').
// Successor to the static announcements.json: returns targeted messages for the announcement
// banner AND the mandatory-update policy for the Update Card. It also carries the anonymous
// install id (deviceId + os/arch/version), which the backend upserts into `devices` as a
// passive active-install counter — so the version distribution reflects EVERY install, not only
// the (few) that also opt into the telemetry ping. It also states the plan (`pro` | `free`) so a
// message can be aimed at paid or free users; the backend matches on it and does not store it.
// While the Settings → Privacy telemetry toggle is on it also carries the open-project count
// (`openProjects`, a bare number — never names, paths or hosts); the backend keeps the per-install
// maximum, the data the project-limit allowance is computed from. See `configureCheck`.
// Nothing personal is sent and the client IP is never stored server-side; a hard opt-out is still
// DO_NOT_TRACK / NODETERM_TELEMETRY_DISABLED.
import { platform } from './platform'
import { getDeviceId } from './device-id'
import { isPremium } from './license'
import type { Announcement, UpdatePolicy } from '../shared/types'

const API_BASE = process.env.NODETERM_API_BASE || 'https://api.nodeterm.dev'
const CACHE_MS = 5 * 60 * 1000

export interface CheckResult {
  messages: Announcement[]
  update: UpdatePolicy
}

const EMPTY: CheckResult = { messages: [], update: { minSupported: null, mandatory: false } }

// Same build + DO_NOT_TRACK gate as telemetry: dev never hits the prod API unless a local
// server is targeted explicitly. Deliberately NOT gated on the in-app telemetry toggle: this
// call always runs (content delivery + the anonymous install count), so an install still counts
// even if the user never opts into the detailed telemetry ping. The env kill-switches above are
// the hard off. The one field that IS gated on the toggle is `openProjects` (`openProjectsParam`).
function allowed(): boolean {
  if (process.env.DO_NOT_TRACK || process.env.NODETERM_TELEMETRY_DISABLED) return false
  if (!platform().isPackaged && !process.env.NODETERM_API_BASE) return false
  return true
}

function sanitize(data: unknown): CheckResult {
  if (!data || typeof data !== 'object') return EMPTY
  const d = data as Record<string, unknown>
  const rawMessages = Array.isArray(d.messages) ? d.messages : []
  const messages: Announcement[] = rawMessages
    .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
    .filter((m) => typeof m.id === 'string' && typeof m.title === 'string')
    .map((m) => ({
      id: m.id as string,
      title: m.title as string,
      body: typeof m.body === 'string' ? m.body : undefined,
      url: typeof m.url === 'string' && /^https?:\/\//.test(m.url) ? m.url : undefined,
      level: m.level === 'success' || m.level === 'warning' ? m.level : 'info'
    }))
  const u = (d.update ?? {}) as Record<string, unknown>
  const update: UpdatePolicy = {
    minSupported: typeof u.minSupported === 'string' ? u.minSupported : null,
    mandatory: u.mandatory === true
  }
  // Optional release highlights for the update card. Both or neither: notes without the version
  // they describe could be pinned to the wrong card.
  if (typeof u.notes === 'string' && u.notes.trim() && typeof u.latestVersion === 'string' && u.latestVersion) {
    update.notes = u.notes.slice(0, NOTES_MAX)
    update.latestVersion = u.latestVersion.slice(0, 64)
  }
  return { messages, update }
}

const NOTES_MAX = 16 * 1024

/** Test seam: the sanitizer is the whole contract with the feed's shape. */
export const sanitizeCheckForTest = sanitize

export interface CheckDeps {
  /** Open projects in the workspace index (`WorkspaceStore.openProjectCount`); undefined = unknown
   *  (index not loaded yet, or never saved in v3 form), and an unknown count is never sent. */
  openProjects: () => number | undefined
  /** `settings.telemetryEnabled` — the count is sent only while it is exactly true. */
  telemetryEnabled: () => boolean
}

// Set once by the shell at boot; read per call, so a toggle flip or a project open/close takes
// effect on the next uncached fetch. Never configured = the count is never sent.
let deps: CheckDeps | null = null

export function configureCheck(next: CheckDeps): void {
  deps = next
}

// `openProjects=<n>` only when configured, the telemetry toggle is on and `n` is a non-negative
// integer. Nothing else is added.
function openProjectsParam(): Record<string, string> {
  if (!deps || deps.telemetryEnabled() !== true) return {}
  const n = deps.openProjects()
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? { openProjects: String(n) } : {}
}

type Plan = 'pro' | 'free'

// The plan the response was fetched for. The backend aims messages at paid or free users by the
// plan WE state (the feed is anonymous — it cannot look a device up), so an answer belongs to the
// plan it was asked with: a purchase or a lapse must not be served the other plan's messages.
let cache: { at: number; plan: Plan; data: CheckResult } | null = null

export async function fetchCheck(): Promise<CheckResult> {
  if (!allowed()) return EMPTY
  const now = Date.now()
  // Offline token verify, so it is cheap to read per call and already right at boot.
  const plan: Plan = isPremium() ? 'pro' : 'free'
  if (cache && cache.plan === plan && now - cache.at < CACHE_MS) return cache.data
  // A failed read keeps the last good answer, except the messages it fetched for another plan.
  // The update policy does not depend on the plan, so it survives.
  const fallback = (): CheckResult =>
    !cache ? EMPTY : cache.plan === plan ? cache.data : { messages: [], update: cache.data.update }
  try {
    const q = new URLSearchParams({
      deviceId: getDeviceId(),
      version: platform().appVersion,
      os: process.platform,
      arch: process.arch,
      channel: 'stable',
      plan,
      ...openProjectsParam()
    })
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 8000)
    const res = await fetch(`${API_BASE}/v1/check?${q.toString()}`, {
      signal: ctrl.signal,
      cache: 'no-cache'
    }).finally(() => clearTimeout(t))
    if (!res.ok) return fallback()
    const data = sanitize(await res.json())
    cache = { at: now, plan, data }
    return data
  } catch {
    return fallback()
  }
}

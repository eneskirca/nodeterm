/**
 * The preview panel inside a run node: a simulator for a run that targets a phone, a browser for one
 * that targets a browser (a `chrome` / `msedge` launch configuration, a Flutter web device) or serves
 * a page (a dev server: vite, next, a Flask app…). Pure decisions, shared by the run bar and tests.
 */

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

/** Persisted on a run node as `data.runBrowser`: present = the browser panel is shown. */
export interface RunBrowserConfig {
  /** The page shown. Absent until the run prints one (or the person types one). */
  url?: string
  /** The URL was picked out of the run's output, so the next run (which may serve on a different
   *  port) looks again rather than keeping a stale one. */
  auto?: boolean
}

export function isPreviewUrl(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 4096 && !CONTROL.test(v) && /^https?:\/\/[^\s]+$/i.test(v)
}

/** Re-validate a persisted panel (git-shared, hand-editable). Only http(s) pages load in it. */
export function normalizeRunBrowserConfig(raw: unknown): RunBrowserConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const out: RunBrowserConfig = {}
  if (isPreviewUrl(r.url)) {
    out.url = r.url
    if (r.auto === true) out.auto = true
  }
  return out
}

export type PreviewKind = 'simulator' | 'browser'

export interface PreviewTarget {
  /** The configuration takes a device (Flutter) and lets the person pick it. */
  picksDevice: boolean
  /** The picked device's id and kind, when there is one. */
  deviceId?: string
  deviceKind?: string
  /** The device the configuration names itself (`-d chrome`, `"deviceId": "chrome"`). */
  pinnedDeviceId?: string
  /** A `chrome` / `msedge` configuration: it opens a page rather than running a process. */
  browserConfig: boolean
}

const IOS_UDID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/

/** Flutter's browser devices. */
export function isWebDeviceId(id: string | undefined): boolean {
  return id === 'chrome' || id === 'edge' || id === 'web-server'
}

/** Whether a device id names a simulator the simulator panel can show by itself. */
export function isSimulatorDeviceId(id: string | undefined): boolean {
  return !!id && (IOS_UDID.test(id) || /^emulator-\d+$/.test(id))
}

/** Which panel the run calls for (the button offers both; this one is marked and opened on Run). */
export function previewKindFor(t: PreviewTarget): PreviewKind {
  if (t.browserConfig) return 'browser'
  if (t.pinnedDeviceId) return isWebDeviceId(t.pinnedDeviceId) ? 'browser' : 'simulator'
  if (t.picksDevice) return t.deviceKind === 'web' || isWebDeviceId(t.deviceId) ? 'browser' : 'simulator'
  // A run with no device at all is most likely a server, whose page is the thing to look at.
  return 'browser'
}

const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{2,5})?(?:\/[^\s'"<>`)\]]*)?/gi
/** A line naming where the app is served — preferred over any other URL on screen. */
const SERVED_LINE = /served at|\blocal:|listening (?:on|at)|running (?:on|at)|available (?:on|at)|ready (?:on|at)|started (?:server )?on|server running/i
/** URLs that are tools, not the app (Flutter DevTools, the Dart VM service, debugger endpoints). */
const TOOL_LINE = /devtools|debugger|dart vm|vm service|observatory|inspect|profiler/i

/**
 * The page a run serves, picked out of its terminal output: the newest local http(s) URL on a line
 * that says where the app is served, else the newest local URL that is not a tool's. `0.0.0.0` (bound
 * on every interface) is opened as `localhost`. Null when the output names none yet.
 */
export function localUrlFromOutput(text: string): string | null {
  let served: string | null = null
  let other: string | null = null
  for (const line of text.split(/\r?\n/)) {
    if (TOOL_LINE.test(line)) continue
    const urls = line.match(LOCAL_URL)
    if (!urls) continue
    const url = urls[urls.length - 1].replace(/[.,;:]+$/, '').replace('://0.0.0.0', '://localhost')
    if (SERVED_LINE.test(line)) served = url
    else other = url
  }
  return served ?? other
}

/**
 * The updater's event policy — pure, so every rule below unit-tests on Linux with no Electron.
 *
 * electron-updater keeps polling after an update is STAGED: the running binary is still the old
 * version, so every 6h re-check emits `update-available` again, re-downloads (a cached file
 * resolves at once) and emits `update-downloaded` again — which used to re-open a card the user had
 * minimized or dismissed and re-send the "Update ready" OS notification, every six hours. The gate
 * remembers what was already said and lets only NEWS through.
 *
 * It also owns the two other decisions main has to make about an updater event: whether an error
 * is worth a card (a background check failing offline is not), and how soon a failed background
 * download is retried (sooner than the next 6h tick, a bounded number of times).
 */

/**
 * Compare two version strings: true when `a` is strictly newer than `b`. Numeric `major.minor.patch`
 * (missing parts are 0); on equal cores a release beats a prerelease, and two prereleases compare by
 * their dot-separated identifiers (numeric ones numerically). Anything unparsable is never "newer" —
 * a garbled feed must not be able to talk the gate into forwarding.
 */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return false
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] > pb.core[i]
  }
  if (pa.pre.length === 0) return pb.pre.length > 0
  if (pb.pre.length === 0) return false
  const n = Math.max(pa.pre.length, pb.pre.length)
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return false
    if (y === undefined) return true
    if (x === y) continue
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) return Number(x) > Number(y)
    if (xn !== yn) return !xn // numeric identifiers sort below alphanumeric ones
    return x > y
  }
  return false
}

function parseVersion(v: string): { core: number[]; pre: string[] } | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(v).trim())
  if (!m) return null
  return {
    core: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)],
    pre: m[4] ? m[4].split('.') : []
  }
}

export interface AvailableDecision {
  /** Send `update-available` to the renderer. */
  forward: boolean
  /**
   * Start the download explicitly. Only for a version NEWER than the one already staged: once
   * something is staged main turns `autoDownload` off (a re-check must not re-download and re-stage
   * the same zip), so a newer release is fetched on purpose instead.
   */
  download: boolean
}

export interface DownloadedDecision {
  /** Send `update-downloaded` to the renderer. */
  forward: boolean
  /** Show the OS "Update ready" notification (still subject to the window being unfocused). */
  notify: boolean
}

export interface UpdateGate {
  onAvailable(version: string, opts: { userInitiated: boolean }): AvailableDecision
  onDownloaded(version: string): DownloadedDecision
  /** A user-initiated check: the staged version to echo as `update-downloaded`, if any. Without
   *  the echo a user who dismissed the ready card and asks again would be left on "Checking…". */
  onManualCheck(): { echoDownloaded: string | null }
  stagedVersion(): string | null
}

export function createUpdateGate(): UpdateGate {
  let staged: string | null = null
  let lastAvailable: string | null = null
  const notified = new Set<string>()
  return {
    onAvailable(version, { userInitiated }) {
      if (staged !== null) {
        if (!isNewerVersion(version, staged)) return { forward: false, download: false }
        lastAvailable = version
        return { forward: true, download: true }
      }
      // A repeat of the version the renderer already heard about is noise for a background check
      // (the 6h tick, a download retry); a user asking deserves the answer again.
      const forward = userInitiated || lastAvailable !== version
      lastAvailable = version
      return { forward, download: false }
    },
    onDownloaded(version) {
      if (staged !== null && !isNewerVersion(version, staged)) return { forward: false, notify: false }
      staged = version
      const notify = !notified.has(version)
      notified.add(version)
      return { forward: true, notify }
    },
    onManualCheck() {
      return { echoDownloaded: staged }
    },
    stagedVersion: () => staged
  }
}

/**
 * Where an updater error came from. Main tracks the flow it is in (who started the check, whether a
 * download began, whether an install was requested) and names it here.
 */
export type UpdateErrorOrigin =
  | 'auto-check' // the silent launch / 6h check
  | 'manual-check' // Settings → Check for updates, the required card's "Update now"
  | 'auto-download' // a download a background check started
  | 'manual-download' // a download a user-initiated check started
  | 'install' // restart-to-update was requested and preparing/installing failed

/**
 * `surface` = put it on the card; `log` = console only. A background failure — offline at launch, a
 * captive portal, a feed 5xx, a background download dropping — is not something the user asked
 * about and has nothing to do about, so it never becomes an "Update failed" card (a background
 * download is retried instead, see `nextDownloadRetryMs`). Anything the user started is answered.
 */
export function classifyUpdaterError(origin: UpdateErrorOrigin): 'surface' | 'log' {
  return origin === 'auto-check' || origin === 'auto-download' ? 'log' : 'surface'
}

const NETWORK_ERROR = /net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NETWORK_CHANGED|NETWORK_IO_SUSPENDED|CONNECTION_(REFUSED|RESET|CLOSED|TIMED_OUT|ABORTED)|ADDRESS_UNREACHABLE|TIMED_OUT|PROXY_CONNECTION_FAILED)|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH/

/**
 * The sentence the card shows for an updater error. The raw text (`net::ERR_INTERNET_DISCONNECTED`,
 * an HttpError with the feed's headers) stays in the log; the user gets what it means.
 */
export function friendlyUpdateErrorMessage(raw: string): string {
  const text = String(raw ?? '')
  if (NETWORK_ERROR.test(text)) return "Couldn't reach the update server. Check your connection and try again."
  if (/HttpError:\s*(5\d\d|404)\b|status(?:Code)?[:= ]+(5\d\d|404)\b|\b(5\d\d|404)\b.*latest[^\s]*\.yml/i.test(text))
    return 'The update server is temporarily unavailable. Try again later.'
  const first = text.split('\n')[0].trim()
  if (!first) return 'The update could not be completed.'
  return first.length > 200 ? `${first.slice(0, 197)}…` : first
}

/** Retry schedule after a failed BACKGROUND download: 15, 30, 60, 120 minutes, then back to the
 *  ordinary 6h tick (null). Every step stays below six hours, so a retry always comes first. */
export const DOWNLOAD_RETRY_MINUTES = [15, 30, 60, 120] as const

/** Delay before retry number `failures` (1-based), or null once the schedule is exhausted. */
export function nextDownloadRetryMs(failures: number): number | null {
  if (!Number.isInteger(failures) || failures < 1) return null
  const m = DOWNLOAD_RETRY_MINUTES[failures - 1]
  return m === undefined ? null : m * 60 * 1000
}

/**
 * Composing and rate-deciding an agent-filed issue report. Pure: no clock of its own, no network,
 * no disk — every decision is a function of what it is handed, so the spam rules are testable
 * without a GitHub account.
 *
 * The premise this file is built on: an automatic filer that files twice is not a minor annoyance,
 * it is the whole risk. Twenty agents across a fleet hitting the same product gap on the same
 * afternoon is the NORMAL case, not the pathological one — that is exactly what "report what you
 * could not do" produces — so the default outcome for a repeated gap must be "say nothing", and
 * filing must be the narrow path.
 *
 * Four independent brakes, deliberately redundant because each fails differently:
 *   1. FINGERPRINT + remote lookup — the same gap from any machine lands on one issue.
 *   2. A local ledger — survives an app restart, and answers before any network call is made.
 *   3. A per-run cap — bounds a loop that re-hits the same code path with varying text.
 *   4. A per-day cap — bounds the fleet case a per-run cap cannot see.
 */
import { createHash } from 'node:crypto'

/** Marker version. Bump only if the fingerprint INPUT changes, which re-keys every open report. */
const MARKER_VERSION = 'v1'

/** How many reports one app run may file into one project before it stops and says so. */
export const REPORT_CAP_PER_RUN = 5

/** How many reports one project may accumulate in a rolling day, across app runs. */
export const REPORT_CAP_PER_DAY = 20

/** After commenting "seen again" on an existing report, stay quiet on it for this long. */
export const RECOMMENT_WINDOW_MS = 24 * 60 * 60 * 1_000

/** The label every auto-filed issue carries, so a maintainer can find, filter and mute them. */
export const REPORT_LABEL = 'agent-report'
export const REPORT_LABEL_COLOR = 'b60205'
export const REPORT_LABEL_DESCRIPTION = 'Filed automatically by a nodeterm agent; not read by a human first.'

export interface ReportEnvironment {
  /** nodeterm version, e.g. `0.3.7`. */
  version: string
  /** `darwin` / `linux` / `win32`. */
  os: string
  /** Which surface filed it — desktop, server. */
  edition: string
}

export interface ReportInput {
  /**
   * The machine-readable class of what could not be done — a refusal code or verb name, NOT free
   * prose. This is the stable half of the fingerprint: prose varies per agent and per turn, and a
   * fingerprint over prose alone would file a fresh issue for every rewording of one gap.
   */
  kind: string
  /** One line, the issue title. */
  title: string
  /** The agent's own description of what it was trying to do. */
  detail: string
  /** Optional pasted machine output. Clamped and redacted by the caller before it arrives here. */
  excerpt?: string
  /** Which agent hit it (`claude`, `codex`, …), for the body only — never the fingerprint. */
  agent?: string
}

/**
 * Normalise a message so the same gap fingerprints identically on two machines and in two runs.
 * Digits, hex runs and quoted spans all carry per-run identity (a node id, a PID, a path, a
 * timestamp) and are exactly what would otherwise split one gap into a hundred issues.
 */
export function normalizeForFingerprint(message: string): string {
  return message
    .toLowerCase()
    // Long hex / base64-ish runs: ids, hashes, tokens' remnants.
    .replace(/[0-9a-f]{8,}/g, '#')
    // Any remaining digit run: ports, counts, line numbers, timestamps.
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

/**
 * The host-independent identity of a gap. Built from the KIND and the normalised title only —
 * never the body, the excerpt, the OS, the version or the agent. Two users on two platforms
 * hitting one product gap must land on one issue, and a version in the fingerprint would file a
 * fresh copy of every known gap on every release.
 */
export function fingerprintReport(input: Pick<ReportInput, 'kind' | 'title'>): string {
  const basis = `${input.kind.trim().toLowerCase()}\n${normalizeForFingerprint(input.title)}`
  return createHash('sha256').update(basis).digest('hex').slice(0, 16)
}

/** The HTML comment carrying the fingerprint. Invisible when rendered, greppable by the next run,
 *  and — because it is in the body rather than a label — it survives label edits by a maintainer. */
export function reportMarker(fingerprint: string): string {
  return `<!-- nodeterm-report:${MARKER_VERSION}:${fingerprint} -->`
}

/** Does this issue body carry this fingerprint? Substring match on the exact marker, so a body
 *  quoting the marker inside a code fence still counts — that is a report of the same gap. */
export function bodyHasMarker(body: string, fingerprint: string): boolean {
  return body.includes(reportMarker(fingerprint))
}

/**
 * The issue body. Every sentence here is doing a job:
 *  - it says a MACHINE wrote this and no human read it, first, before the reader forms an opinion
 *    about who is asking them for something;
 *  - it says which version and platform, because a gap that is already fixed must be closable at a
 *    glance;
 *  - it carries the marker, which is the only thing that keeps the next thousand runs quiet.
 *
 * It must never claim a person reported this, and must never adopt a person's voice ("I tried…").
 */
export function composeReportBody(
  input: ReportInput,
  env: ReportEnvironment,
  fingerprint: string
): string {
  const lines = [
    '> **Filed automatically by a nodeterm agent.**',
    '> A human has not read this. It was written by an agent that could not complete something and',
    '> was configured to report it. Close it without ceremony if it is wrong, already known, or not',
    '> a real gap.',
    '',
    '### What the agent could not do',
    '',
    input.detail.trim() || '_(no detail given)_',
    ''
  ]
  if (input.excerpt?.trim()) {
    lines.push('### Output', '', '```', input.excerpt.trim(), '```', '')
  }
  lines.push(
    '### Environment',
    '',
    `| | |`,
    `|---|---|`,
    `| nodeterm | ${env.version} |`,
    `| platform | ${env.os} |`,
    `| surface | ${env.edition} |`,
    `| agent | ${input.agent ?? 'unknown'} |`,
    `| kind | \`${input.kind}\` |`,
    '',
    reportMarker(fingerprint)
  )
  return lines.join('\n')
}

/** The body of the "this happened again" comment. Deliberately tiny — the issue already says
 *  everything; this only adds that it is still live on a later version. */
export function composeRecurrenceComment(env: ReportEnvironment, fingerprint: string): string {
  return [
    `Seen again by a nodeterm agent on ${env.version} (${env.os}, ${env.edition}).`,
    '',
    reportMarker(fingerprint)
  ].join('\n')
}

/** One project's machine-local report history. Persisted as-is; see `report-ledger.ts`. */
export interface ReportLedger {
  /** Per fingerprint: the issue we filed or commented on, and when we last spoke. */
  seen: Record<string, { issueNumber: number; lastSpokeAt: number }>
  /** Timestamps of reports filed, for the rolling-day cap. Pruned on write. */
  filedAt: number[]
}

export function emptyLedger(): ReportLedger {
  return { seen: {}, filedAt: [] }
}

export type ReportDecision =
  | { action: 'create'; fingerprint: string }
  | { action: 'comment'; fingerprint: string; issueNumber: number }
  | { action: 'skip'; fingerprint: string; issueNumber: number; reason: string }
  | { action: 'refuse'; fingerprint: string; reason: string }

export interface DecideInput {
  fingerprint: string
  ledger: ReportLedger
  /** Open issues already carrying this fingerprint, newest first. Empty = nothing upstream. */
  matches: Array<{ number: number }>
  /** Reports this app run has already filed into this project. */
  filedThisRun: number
  now: number
}

/**
 * The whole rate decision, in one pure function.
 *
 * Order matters and is the opposite of the obvious one: DEDUPE IS CHECKED BEFORE THE CAPS. A gap
 * that already has an issue costs nothing to recognise and must not consume a cap slot — otherwise
 * five recurrences of one known gap would exhaust the run's budget and silence the sixth, genuinely
 * new gap. Caps exist to bound how much NEW noise reaches the tracker, not how often we notice an
 * old thing.
 */
export function decideReport(input: DecideInput): ReportDecision {
  const { fingerprint, ledger, matches, filedThisRun, now } = input
  const known = ledger.seen[fingerprint]
  const upstream = matches[0]

  // Already tracked upstream → at most a quiet "seen again", and only outside the window.
  if (upstream) {
    const spokeAt = known?.issueNumber === upstream.number ? known.lastSpokeAt : undefined
    if (spokeAt !== undefined && now - spokeAt < RECOMMENT_WINDOW_MS) {
      return {
        action: 'skip',
        fingerprint,
        issueNumber: upstream.number,
        reason: 'already reported and commented recently'
      }
    }
    return { action: 'comment', fingerprint, issueNumber: upstream.number }
  }

  // Known locally but gone upstream (closed, deleted, or a repo change): treat as new, but only
  // once the recomment window has passed, so a closed-as-wontfix issue is not instantly refiled on
  // a loop. A CLOSED issue carries no marker match because the lookup asks for open ones only.
  if (known && now - known.lastSpokeAt < RECOMMENT_WINDOW_MS) {
    return {
      action: 'skip',
      fingerprint,
      issueNumber: known.issueNumber,
      reason: 'reported recently; its issue is no longer open'
    }
  }

  if (filedThisRun >= REPORT_CAP_PER_RUN) {
    return {
      action: 'refuse',
      fingerprint,
      reason:
        `report-cap-run: this nodeterm run has already filed ${REPORT_CAP_PER_RUN} reports for ` +
        'this project, which is the limit. Do not retry; tell the user what you found instead.'
    }
  }

  const dayAgo = now - 24 * 60 * 60 * 1_000
  const today = ledger.filedAt.filter((t) => t > dayAgo).length
  if (today >= REPORT_CAP_PER_DAY) {
    return {
      action: 'refuse',
      fingerprint,
      reason:
        `report-cap-day: ${REPORT_CAP_PER_DAY} reports have been filed for this project in the ` +
        'last 24 hours, which is the limit. Do not retry; tell the user what you found instead.'
    }
  }

  return { action: 'create', fingerprint }
}

/** Fold an outcome back into the ledger. Pure; the caller persists the result. Prunes the
 *  rolling-day list here so the file cannot grow without bound. */
export function recordReport(
  ledger: ReportLedger,
  fingerprint: string,
  issueNumber: number,
  now: number,
  filed: boolean
): ReportLedger {
  const dayAgo = now - 24 * 60 * 60 * 1_000
  return {
    seen: { ...ledger.seen, [fingerprint]: { issueNumber, lastSpokeAt: now } },
    filedAt: filed ? [...ledger.filedAt.filter((t) => t > dayAgo), now] : ledger.filedAt.filter((t) => t > dayAgo)
  }
}

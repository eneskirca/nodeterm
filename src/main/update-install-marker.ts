// The NSIS preflight's failure note (build/installer.nsh, U6). When an update the app handed itself
// over to (`--updated`) cannot start because nodeterm is still running after the bounded wait, the
// installer writes `%LOCALAPPDATA%\nodeterm\update-failed.json`, relaunches the installed build and
// quits. This reads that note once on the next start and deletes it, so the failure is reported
// instead of the update silently not happening. Windows only; pure apart from the injected fs.

import fs from 'fs'
import path from 'path'

export interface UpdateInstallFailure {
  reason: string
  /** The preflight's exit code: 10 = still running, 20 = could not verify. */
  code: number | null
  /** The version the installer would have installed. */
  version: string | null
}

export interface MarkerDeps {
  platform: NodeJS.Platform | string
  localAppData: string | null | undefined
  readFile?: (file: string) => string
  removeFile?: (file: string) => void
}

export function updateFailedMarkerPath(localAppData: string): string {
  return path.win32.join(localAppData, 'nodeterm', 'update-failed.json')
}

/**
 * Read and delete the marker. `null` when there is none (or not Windows). The file is read ONCE
 * and then removed — no exists-then-read — and a malformed note still counts as a failure (its
 * existence is the fact), reported with what could be parsed. Never throws.
 */
export function consumeUpdateFailedMarker(deps: MarkerDeps): UpdateInstallFailure | null {
  if (deps.platform !== 'win32' || !deps.localAppData) return null
  const file = updateFailedMarkerPath(deps.localAppData)
  const readFile = deps.readFile ?? ((f: string) => fs.readFileSync(f, 'utf8'))
  const removeFile = deps.removeFile ?? ((f: string) => fs.rmSync(f, { force: true }))
  let raw: string
  try {
    raw = readFile(file)
  } catch {
    return null
  }
  try {
    removeFile(file)
  } catch {
    /* reported anyway; a later start reports it again rather than never */
  }
  let parsed: Record<string, unknown> = {}
  try {
    const value: unknown = JSON.parse(raw)
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>
  } catch {
    /* existence is the fact */
  }
  // The installer writes `code` as a STRING (nsExec answers `error` / `timeout` instead of an
  // exit code when PowerShell could not run); a number is accepted too.
  const rawCode = parsed.code
  const code =
    Number.isInteger(rawCode)
      ? (rawCode as number)
      : typeof rawCode === 'string' && /^\d{1,9}$/.test(rawCode)
        ? Number(rawCode)
        : null
  const reason = typeof parsed.reason === 'string' ? parsed.reason : 'unknown'
  return {
    reason:
      code === null && typeof rawCode === 'string' && /^[\w-]{1,32}$/.test(rawCode)
        ? `${reason} (${rawCode})`
        : reason,
    code,
    version: typeof parsed.version === 'string' ? parsed.version : null
  }
}

/** One log line for the debug ring. */
export function describeUpdateInstallFailure(f: UpdateInstallFailure): string {
  const why =
    f.code === 10
      ? 'nodeterm was still running when the installer checked'
      : f.code === 20
        ? 'the installer could not verify that nodeterm had exited'
        : `reason ${f.reason}`
  return `the last update${f.version ? ` to ${f.version}` : ''} did not install: ${why}. The previous version was restarted.`
}

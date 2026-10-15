import path from 'path'

// Where Git for Windows puts its POSIX `sh`, as data — the ONE list both the codex hook wrapper
// (which needs it as `%VAR%`-expanded batch text, see `codex-windows-wrapper.ts`) and the in-process
// resolver below (which needs real paths) derive from, so the two cannot drift. Measured layouts:
// `bin` and `usr\bin`, the 64-bit and 32-bit program dirs, and the per-user install under
// LOCALAPPDATA that `winget install Git.Git` produces without admin. A stock Git install puts only
// `Git\cmd` on PATH, so bare `sh` is NOT found there — that is why this list exists at all.

export interface WindowsShLayout {
  envVar: 'ProgramFiles' | 'ProgramFiles(x86)' | 'LOCALAPPDATA'
  rel: string
}

export const WINDOWS_SH_LAYOUTS: readonly WindowsShLayout[] = [
  { envVar: 'ProgramFiles', rel: 'Git\\bin\\sh.exe' },
  { envVar: 'ProgramFiles', rel: 'Git\\usr\\bin\\sh.exe' },
  { envVar: 'ProgramFiles(x86)', rel: 'Git\\bin\\sh.exe' },
  { envVar: 'ProgramFiles(x86)', rel: 'Git\\usr\\bin\\sh.exe' },
  { envVar: 'LOCALAPPDATA', rel: 'Programs\\Git\\bin\\sh.exe' },
  { envVar: 'LOCALAPPDATA', rel: 'Programs\\Git\\usr\\bin\\sh.exe' }
]

/** Windows env names are case-insensitive; an injected env object (or one built by hand) is not. */
function envGet(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name]
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(env)) if (k.toLowerCase() === lower) return v
  return undefined
}

/** A `sh.exe`/`bash.exe` under the Windows dir or the Store app-alias dir is a WSL shim: it runs a
 *  LINUX shell that cannot see a `C:\…` cwd the way the script expects. Never pick one. */
function isWslShim(p: string, env: NodeJS.ProcessEnv): boolean {
  const norm = path.win32.normalize(p).toLowerCase()
  const sysRoot = envGet(env, 'SystemRoot') ?? envGet(env, 'windir') ?? 'C:\\Windows'
  const root = path.win32.normalize(sysRoot).toLowerCase().replace(/\\+$/, '')
  return norm.startsWith(`${root}\\`) || norm.includes('\\microsoft\\windowsapps\\')
}

export interface ResolveWindowsShDeps {
  env: NodeJS.ProcessEnv
  exists: (p: string) => boolean
  /** PATH to search last; defaults to the env's own PATH. */
  pathStr?: string | null
}

/**
 * Git Bash's `sh.exe` on this Windows machine, or null. Fixed Git layouts first, PATH last (the
 * least predictable, and where a WSL shim lives — refused). Pure over its deps so the order is
 * testable on any OS; paths are built with `path.win32` regardless of the host.
 */
export function resolveWindowsSh(deps: ResolveWindowsShDeps): string | null {
  for (const l of WINDOWS_SH_LAYOUTS) {
    const base = envGet(deps.env, l.envVar)
    if (!base) continue
    const p = path.win32.join(base, l.rel)
    if (deps.exists(p)) return p
  }
  const pathStr = deps.pathStr === undefined ? envGet(deps.env, 'PATH') : deps.pathStr
  for (const raw of (pathStr ?? '').split(';')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1')
    if (!dir) continue
    const p = path.win32.join(dir, 'sh.exe')
    if (isWslShim(p, deps.env)) continue
    if (deps.exists(p)) return p
  }
  return null
}

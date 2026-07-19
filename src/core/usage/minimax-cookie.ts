// Storage for the MiniMax browser cookie.
//
// This deliberately does NOT live in settings.json. That file is written with default
// permissions and is treated throughout the app as CONFIG — the `claudeAccounts` list sits
// there precisely because an account list is config, not a credential. A MiniMax session cookie
// is the opposite: it is a live bearer credential that grants access to the user's MiniMax
// account, so it gets its own file with 0600 and never appears in a config blob that is
// world-readable, copied between machines, or pasted into a bug report.
import { promises as fs } from 'fs'
import path from 'path'
import { platform } from '../platform'

const FILE = 'minimax-cookie.json'
/** Owner read/write only. The whole reason this is a separate file. */
const MODE = 0o600

function file(): string {
  return path.join(platform().userDataDir, FILE)
}

/** The stored cookie header, or null when MiniMax has not been configured. */
export async function readMinimaxCookie(): Promise<string | null> {
  try {
    const raw = await fs.readFile(file(), 'utf-8')
    const j = JSON.parse(raw) as Record<string, unknown>
    return typeof j.cookie === 'string' && j.cookie.trim() ? j.cookie : null
  } catch {
    return null
  }
}

/**
 * Store (or, with an empty value, clear) the cookie. Written to a temp file first and renamed,
 * so a crash mid-write cannot leave a half-written credential behind — and the temp file is
 * created with the restricted mode too, since a rename preserves whatever the source had.
 */
export async function writeMinimaxCookie(cookie: string): Promise<void> {
  const target = file()
  if (!cookie.trim()) {
    await fs.rm(target, { force: true })
    return
  }
  const tmp = `${target}.tmp`
  await fs.writeFile(tmp, JSON.stringify({ cookie }), { encoding: 'utf-8', mode: MODE })
  await fs.rename(tmp, target)
  // Belt and braces: an existing temp file from a previous run would keep its own mode.
  await fs.chmod(target, MODE).catch(() => undefined)
}

/** Whether a cookie is stored — for the settings UI, which must never read the value back. */
export async function hasMinimaxCookie(): Promise<boolean> {
  return (await readMinimaxCookie()) !== null
}

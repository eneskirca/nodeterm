// Storage for user-pasted browser cookies, per provider.
//
// Some providers (MiniMax, opencode) publish no CLI credential on disk — their quota lives
// behind a web console session — so the only way to read it is to replay a cookie the user
// copies out of DevTools.
//
// These deliberately do NOT live in settings.json. That file is written with default
// permissions and is treated throughout the app as CONFIG — the `claudeAccounts` list sits
// there precisely because an account list is config, not a credential. A session cookie is the
// opposite: a live bearer credential for someone's account. It gets its own file at 0600 and
// never appears in a config blob that is world-readable, copied between machines, or pasted
// into a bug report.
//
// Generalized from the MiniMax-only version once opencode needed exactly the same thing; the
// file naming is unchanged (`<provider>-cookie.json`), so an already-stored MiniMax cookie is
// still found.
import { promises as fs } from 'fs'
import path from 'path'
import { platform } from '../platform'

/** Owner read/write only. The whole reason these are separate files. */
const MODE = 0o600

/** Providers whose usage is read with a pasted browser cookie. */
export const COOKIE_PROVIDERS = ['minimax', 'opencode'] as const
export type CookieProvider = (typeof COOKIE_PROVIDERS)[number]

export function isCookieProvider(v: unknown): v is CookieProvider {
  return typeof v === 'string' && (COOKIE_PROVIDERS as readonly string[]).includes(v)
}

function file(provider: CookieProvider): string {
  return path.join(platform().userDataDir, `${provider}-cookie.json`)
}

/** The stored cookie header, or null when this provider has not been configured. */
export async function readProviderCookie(provider: CookieProvider): Promise<string | null> {
  try {
    const raw = await fs.readFile(file(provider), 'utf-8')
    const j = JSON.parse(raw) as Record<string, unknown>
    return typeof j.cookie === 'string' && j.cookie.trim() ? j.cookie : null
  } catch {
    return null
  }
}

/** Paired with `process.pid` in the temp name: the counter makes a name unique WITHIN this process,
 *  the pid makes it unique ACROSS processes (it restarts at 0 in every new one — two
 *  `nodeterm-server --data-dir X` processes share the dir with no lock). Same scheme as
 *  agent-status-mirror's local write. */
let writeSeq = 0

/**
 * Remove temp files no writer in THIS process owns: the legacy fixed `<file>.tmp` (written by
 * builds before per-call names) and any `<file>.<pid>.<seq>.tmp` whose pid is not ours. Best
 * effort — a failure here must never break a save.
 *
 * Unlike settings.json, an orphan here is a live credential at 0600 that nothing will ever
 * overwrite, so it has to be collected rather than left. Temps bearing our own pid are untouchable:
 * one may belong to a concurrent write sitting between its `writeFile` and its `rename`, and
 * deleting it would recreate the exact race the unique names fixed. A foreign pid can in theory be
 * a second LIVE process on the same data dir; that setup has no lock to begin with, and the worst
 * case is that process's rename failing cleanly (ENOENT, rethrown to its caller) instead of a
 * forgotten cookie sitting on disk forever.
 */
async function sweepStaleTmp(target: string): Promise<void> {
  try {
    const dir = path.dirname(target)
    const base = path.basename(target)
    for (const entry of await fs.readdir(dir)) {
      if (!entry.startsWith(base) || !entry.endsWith('.tmp')) continue
      const middle = entry.slice(base.length, -'.tmp'.length) // '' or '.<pid>.<seq>'
      const owner = /^\.(\d+)\.\d+$/.exec(middle)?.[1]
      if (middle === '' || (owner && owner !== String(process.pid))) {
        await fs.rm(path.join(dir, entry), { force: true }).catch(() => undefined)
      }
    }
  } catch {
    // A dir we cannot read is not a reason to fail (or skip) the write below.
  }
}

/**
 * Store (or, with an empty value, clear) a provider's cookie. Written to a temp file first and
 * renamed, so a crash mid-write cannot leave a half-written credential behind — and the temp
 * file is created with the restricted mode too, since a rename preserves the source's mode.
 *
 * The temp name is unique per call: `usage:set-provider-cookie` is reachable from the preload
 * bridge and, on the Server Edition, from any WS client's frame (src/renderer/bridge/ws-bridge.ts
 * over the concurrent dispatch in src/server/ws.ts), with nothing serializing them. A shared temp
 * name lets one writer's rename publish the other's half-written cookie — or move the file out
 * from under it, so the loser's rename fails.
 */
export function writeProviderCookie(provider: CookieProvider, cookie: string): Promise<void> {
  // FIFO per provider (the WorkspaceStore.saveChain idiom): without it a clear's rm can run while
  // an earlier set sits between tmp-write and rename — the parked rename then resurrects the
  // credential the UI just reported cleared. Unique tmp names cannot fix that; only ordering can.
  // Each caller still sees only its own write's failure.
  const prev = writeChains.get(provider) ?? Promise.resolve()
  const run = prev.then(() => writeCookieNow(provider, cookie))
  writeChains.set(provider, run.catch(() => {}))
  return run
}

const writeChains = new Map<CookieProvider, Promise<unknown>>()

async function writeCookieNow(provider: CookieProvider, cookie: string): Promise<void> {
  const target = file(provider)
  // Both paths sweep: clearing a cookie that leaves an orphan temp behind has not cleared anything.
  await sweepStaleTmp(target)
  if (!cookie.trim()) {
    await fs.rm(target, { force: true })
    return
  }
  const tmp = `${target}.${process.pid}.${++writeSeq}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify({ cookie }), { encoding: 'utf-8', mode: MODE })
    await fs.rename(tmp, target)
  } catch (e) {
    // A failed write MUST remove its own temp, because here a leaked temp IS a leaked cookie: a
    // unique name is never written again, so only this cleanup (or a later run's sweep above, once
    // the pid is dead) will ever collect it. The error still propagates.
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw e
  }
  // Defense in depth on the PUBLISHED file: the temp is created 0600 and rename preserves the
  // mode, so this is a second lock on the door — cheap, and the one thing an attacker would need.
  await fs.chmod(target, MODE).catch(() => undefined)
}

/** Whether a cookie is stored — for the settings UI, which must never read the value back. */
export async function hasProviderCookie(provider: CookieProvider): Promise<boolean> {
  return (await readProviderCookie(provider)) !== null
}

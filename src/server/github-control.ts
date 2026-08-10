import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { GitHubSecretStore } from '../core/github/credentials'
import type { CorePlatform } from '../core/platform'
import type { GitHubHostController } from '../core/github/host'
import { IPC } from '../shared/ipc'

const FILE_NAME = 'github-issues-token.json'

export class ServerGitHubSecretError extends Error {
  constructor(readonly code: 'invalid-token') {
    super(code)
  }
}

function validToken(token: string): boolean {
  return token.trim() === token && token.length > 0 && token.length <= 4096 && !/[\r\n\0]/.test(token)
}

/** Paired with `process.pid` in the temp name below: the counter makes a name unique WITHIN this
 *  process, the pid makes it unique ACROSS processes (it restarts at 0 in every new one — two
 *  `nodeterm-server --data-dir X` processes share the dir with no lock). Same scheme as
 *  agent-status-mirror's local write. */
let writeSeq = 0

/**
 * Remove temp files no writer in THIS process owns: the legacy fixed `<file>.tmp` (written by
 * builds before per-call names) and any `<file>.<pid>.<seq>.tmp` whose pid is not ours. Best
 * effort — a failure here must never break a save.
 *
 * The token file is not config: an orphan here is a live PAT at 0600 that nothing will ever
 * overwrite, because a unique name is never written twice. So it has to be collected rather than
 * left. Temps bearing our own pid are untouchable: one may belong to a concurrent write sitting
 * between its `writeFile` and its `rename`, and deleting it would recreate the exact race the
 * unique names fixed. A foreign pid can be a second LIVE server on the same data dir; that setup
 * has no lock to begin with, and the worst case is that process's rename failing cleanly (ENOENT,
 * rethrown to its caller) instead of a forgotten PAT sitting on disk forever.
 */
async function sweepStaleTmp(target: string): Promise<void> {
  try {
    const directory = path.dirname(target)
    const base = path.basename(target)
    for (const entry of await fs.readdir(directory)) {
      if (!entry.startsWith(base) || !entry.endsWith('.tmp')) continue
      const middle = entry.slice(base.length, -'.tmp'.length) // '' or '.<pid>.<seq>'
      const owner = /^\.(\d+)\.\d+$/.exec(middle)?.[1]
      if (middle === '' || (owner && owner !== String(process.pid))) {
        await fs.rm(path.join(directory, entry), { force: true }).catch(() => undefined)
      }
    }
  } catch {
    // A dir we cannot read is not a reason to fail (or skip) the write below.
  }
}

export class ServerGitHubSecretStore implements GitHubSecretStore {
  readonly availability = 'restricted-file' as const

  constructor(private readonly userDataDir: string) {}

  private get filePath(): string {
    return path.join(this.userDataDir, FILE_NAME)
  }

  async save(token: string): Promise<void> {
    if (!validToken(token)) throw new ServerGitHubSecretError('invalid-token')
    await fs.mkdir(this.userDataDir, { recursive: true })
    await sweepStaleTmp(this.filePath)
    // The temp name is unique per call because nothing serializes `IPC.githubControlSaveToken`: it
    // is registered through `platform.handle` and reached over the concurrent WS dispatch in
    // src/server/ws.ts with no queue in front of it, and GitHubHostController.saveToken awaits a
    // NETWORK validateToken before it reaches this write (src/core/github/host.ts), so two saves
    // overlap for as long as a round trip to github.com. With a shared name one writer's rename
    // publishes the other's half-written PAT, or moves the file out from under it entirely and the
    // loser's rename fails.
    const temporary = `${this.filePath}.${process.pid}.${++writeSeq}.tmp`
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, token }), {
        encoding: 'utf-8',
        mode: 0o600
      })
      await fs.chmod(temporary, 0o600)
      await fs.rename(temporary, this.filePath)
    } catch (error) {
      // A failed write MUST remove its own temp, because here a leaked temp IS a leaked PAT: a
      // unique name is never written again, so only this cleanup (or a later run's sweep above,
      // once the pid is dead) will ever collect it. The error still propagates.
      await fs.rm(temporary, { force: true }).catch(() => {})
      throw error
    }
    await fs.chmod(this.filePath, 0o600)
  }

  async clear(): Promise<void> {
    // Sweep here too: clearing a token that leaves an orphan temp behind has not cleared anything.
    await sweepStaleTmp(this.filePath)
    await fs.rm(this.filePath, { force: true })
  }

  async readForHost(): Promise<string | null> {
    try {
      const value: unknown = JSON.parse(await fs.readFile(this.filePath, 'utf-8'))
      const token = value && typeof value === 'object' &&
        (value as { version?: unknown }).version === 1
        ? (value as { token?: unknown }).token
        : null
      return typeof token === 'string' && validToken(token) ? token : null
    } catch {
      return null
    }
  }
}

type Controller = Pick<GitHubHostController,
  'status' | 'approve' | 'revoke' | 'selectProvider' | 'saveToken' | 'clearToken'>

export function registerServerGitHubControl(
  platform: CorePlatform,
  controller: Controller
): void {
  platform.handle(IPC.githubControlStatus, (projectId?: string) => controller.status(projectId))
  platform.handle(IPC.githubControlApprove, (input) => controller.approve(input))
  platform.handle(IPC.githubControlRevoke, (input) => controller.revoke(input))
  platform.handle(IPC.githubControlSelectProvider, (input) => controller.selectProvider(input))
  platform.handle(IPC.githubControlSaveToken, (token: string) => controller.saveToken(token))
  platform.handle(IPC.githubControlClearToken, () => controller.clearToken())
}

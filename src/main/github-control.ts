import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { GitHubSecretStore } from '../core/github/credentials'
import type { GitHubSecretAvailability } from '../shared/github-issues'
import { IPC } from '../shared/ipc'
import type { GitHubHostController } from '../core/github/host'

const FILE_NAME = 'github-issues-token.json'

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

type TokenDocument =
  | { version: 1; kind: 'safe-storage'; value: string }
  | { version: 1; kind: 'restricted-file'; token: string }

export class GitHubSecretError extends Error {
  constructor(readonly code: 'invalid-token' | 'keyring-locked') {
    super(code)
  }
}

function validToken(token: string): boolean {
  return token.trim() === token && token.length > 0 && token.length <= 4096 && !/[\r\n\0]/.test(token)
}

/** Paired with `process.pid` in the temp name below: the counter makes a name unique WITHIN this
 *  process, the pid makes it unique ACROSS processes (it restarts at 0 in every new one — and
 *  `NT_MULTI=1` without `NT_USER_DATA` skips the single-instance lock while keeping the default
 *  userData dir, so two instances can share this file, see src/main/index.ts). Same scheme as
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
 * unique names fixed. A foreign pid can in theory be a second LIVE process on the same dir; that
 * setup has no lock to begin with, and the worst case is that process's rename failing cleanly
 * (ENOENT, rethrown to its caller) instead of a forgotten PAT sitting on disk forever.
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

async function atomicWrite(file: string, document: TokenDocument): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await sweepStaleTmp(file)
  // The temp name is unique per call because nothing serializes `IPC.githubControlSaveToken`: the
  // handler is reachable from the preload bridge (src/preload/index.ts) AND from a remote client
  // over the ws bridge (src/renderer/bridge/ws-bridge.ts), and GitHubHostController.saveToken
  // awaits a NETWORK validateToken before it reaches this write (src/core/github/host.ts), so two
  // saves overlap for as long as a round trip to github.com. With a shared name one writer's
  // rename publishes the other's half-written PAT, or moves the file out from under it entirely
  // and the loser's rename fails.
  const temporary = `${file}.${process.pid}.${++writeSeq}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify(document), { encoding: 'utf-8', mode: 0o600 })
    await fs.chmod(temporary, 0o600)
    await fs.rename(temporary, file)
  } catch (error) {
    // A failed write MUST remove its own temp, because here a leaked temp IS a leaked PAT: a
    // unique name is never written again, so only this cleanup (or a later run's sweep above, once
    // the pid is dead) will ever collect it. The error still propagates.
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  await fs.chmod(file, 0o600)
}

export class ElectronGitHubSecretStore implements GitHubSecretStore {
  constructor(
    private readonly userDataDir: string,
    private readonly safeStorage: SafeStorageLike
  ) {}

  get availability(): GitHubSecretAvailability {
    return this.canEncrypt() ? 'encrypted' : 'restricted-file'
  }

  private get filePath(): string {
    return path.join(this.userDataDir, FILE_NAME)
  }

  async save(token: string): Promise<void> {
    if (!validToken(token)) throw new GitHubSecretError('invalid-token')
    const current = await this.readDocument()
    if (current?.kind === 'safe-storage' && !this.canEncrypt()) {
      throw new GitHubSecretError('keyring-locked')
    }
    const document: TokenDocument = this.canEncrypt()
      ? {
          version: 1,
          kind: 'safe-storage',
          value: this.safeStorage.encryptString(token).toString('base64')
        }
      : { version: 1, kind: 'restricted-file', token }
    await atomicWrite(this.filePath, document)
  }

  async clear(): Promise<void> {
    // Sweep here too: clearing a token that leaves an orphan temp behind has not cleared anything.
    await sweepStaleTmp(this.filePath)
    await fs.rm(this.filePath, { force: true })
  }

  async readForHost(): Promise<string | null> {
    const document = await this.readDocument()
    if (!document) return null
    if (document.kind === 'restricted-file') return validToken(document.token) ? document.token : null
    if (!this.canEncrypt()) return null
    try {
      const token = this.safeStorage.decryptString(Buffer.from(document.value, 'base64'))
      return validToken(token) ? token : null
    } catch {
      return null
    }
  }

  private canEncrypt(): boolean {
    if (!this.safeStorage.isEncryptionAvailable()) return false
    try {
      return this.safeStorage.getSelectedStorageBackend?.() !== 'basic_text'
    } catch {
      return false
    }
  }

  private async readDocument(): Promise<TokenDocument | null> {
    try {
      const value: unknown = JSON.parse(await fs.readFile(this.filePath, 'utf-8'))
      if (!value || typeof value !== 'object') return null
      const document = value as Partial<TokenDocument>
      if (document.version !== 1) return null
      if (document.kind === 'safe-storage' && typeof document.value === 'string') {
        return document as TokenDocument
      }
      if (document.kind === 'restricted-file' && typeof document.token === 'string') {
        return document as TokenDocument
      }
      return null
    } catch {
      return null
    }
  }
}

export class GitHubControlAccessError extends Error {
  readonly code = 'E_FORBIDDEN'

  constructor() {
    super('GitHub control is available only to the local main window')
  }
}

type IpcMainLike = {
  handle(channel: string, handler: (event: { sender: { id: number } }, ...args: any[]) => unknown): void
}

type Controller = Pick<GitHubHostController,
  'status' | 'approve' | 'revoke' | 'selectProvider' | 'saveToken' | 'clearToken'>

export function registerElectronGitHubControl(
  ipc: IpcMainLike,
  mainWindowId: () => number | undefined,
  controller: Controller
): void {
  const local = <T extends unknown[]>(action: (...args: T) => unknown) =>
    (event: { sender: { id: number } }, ...args: T): unknown => {
      if (mainWindowId() !== event.sender.id) throw new GitHubControlAccessError()
      return action(...args)
    }
  ipc.handle(IPC.githubControlStatus, local((projectId?: string) => controller.status(projectId)))
  ipc.handle(IPC.githubControlApprove, local((input) => controller.approve(input)))
  ipc.handle(IPC.githubControlRevoke, local((input) => controller.revoke(input)))
  ipc.handle(IPC.githubControlSelectProvider, local((input) => controller.selectProvider(input)))
  ipc.handle(IPC.githubControlSaveToken, local((token: string) => controller.saveToken(token)))
  ipc.handle(IPC.githubControlClearToken, local(() => controller.clearToken()))
}

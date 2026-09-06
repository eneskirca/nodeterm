import { promises as fs } from 'fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'path'
import { renameAtomic, writeFileAtomic } from './fs-atomic'
import { IPC } from '../shared/ipc'
import { platform } from './platform'
import {
  DEFAULT_PROJECT_ID, EMPTY_WORKSPACE,
  type BridgeLink, type CanvasNodeState, type Project, type Workspace, type WorkspaceV1
} from '../shared/types'
import {
  PROJECT_DIR, PROJECT_FILE, fileToProject, projectToFile, resolveNodes, sameProjectContent,
  sanitizeLoadedClosedSessions, sanitizeNodeTriggers, serializeProjectFile, splitWorkspace,
  validKanban,
  type IndexEntryV3, type ProjectFileV1, type WorkspaceIndexV3
} from './workspace-files'
import { readProjectSettingsFile, writeProjectSettingsFile } from './project-settings-files'
import {
  parseProjectSettingsFile, sameProjectSettingsContent, sanitizeProjectLocalSettings,
  sanitizeProjectSettingsDoc, serializeProjectSettingsFile,
  type ProjectLocalSettings, type ProjectSettingsDoc, type ProjectSettingsFileV1,
  type ProjectSettingsSnapshot
} from '../shared/project-settings'
import { readProjectCapabilities, type ProjectCapability } from '../shared/project-capabilities'
import type { CapabilityAckMap } from './project-capability-consent'
import { hoistLegacyNodeExec, type LocalNodeExecMap } from '../shared/node-exec'
import { collisionSeed, derivedProjectId, freshProjectId } from '../shared/project-id'
import { appendProjectNode, removeProjectNode, type RemoteNodeInput } from './project-node-append'

/** Checked remote read: `absent` (no file — safe to push our cache) is NOT `error` (connection
 *  down / ssh failure — a failed read is never evidence of absence, so nothing may be pushed). */
export type RemoteReadResult = { status: 'ok'; content: string } | { status: 'absent' } | { status: 'error' }

/** Remote file access for SSH projects (implemented in src/main over SshFs — src/core stays electron-free). */
export interface RemoteWorkspaceIO {
  read(projectId: string, ssh: NonNullable<Project['ssh']>): Promise<RemoteReadResult>
  write(projectId: string, ssh: NonNullable<Project['ssh']>, content: string): Promise<boolean>
  /** `.nodeterm/settings.json` on the same host. Optional: an IO that predates the settings leg (or
   *  a test fake that only cares about project.json) simply leaves the project on its offline cache,
   *  which is exactly the disconnected behaviour. */
  readSettings?(projectId: string, ssh: NonNullable<Project['ssh']>): Promise<RemoteReadResult>
  writeSettings?(projectId: string, ssh: NonNullable<Project['ssh']>, content: string): Promise<boolean>
}

const projectFilePath = (cwd: string): string => path.join(cwd, PROJECT_DIR, PROJECT_FILE)

/** How many recent mirror payloads a project remembers for self-write recognition (see
 *  `recentMirrorHashes`). Big enough to cover a burst of throttled writes inside one poll window;
 *  small enough that a server-side revert to genuinely old content still reads as external. */
const RECENT_MIRROR_CAP = 8

const contentHash = (content: string): string => createHash('sha256').update(content).digest('hex')

/** Alias of the shared `ProjectSettingsSnapshot` (moved to `shared/project-settings.ts` so the
 *  renderer's `ProjectSettingsApi` can name the shape without importing core) — the store's
 *  methods keep this name in their signatures. */
export type ProjectSettingsState = ProjectSettingsSnapshot

/** A parsed project file together with the exact bytes it was parsed from. `lastWritten` must
 *  record `raw` — see the field it caches. */
interface ProjectFileRead {
  file: ProjectFileV1
  raw: string
}

/** One index entry paired with the project loadV3 built from it (and, for a local ref, the file it
 *  was built from). The uniqueness pass needs all three: it re-keys the project the renderer sees,
 *  the entry that persists that identity, and the project.json the id was wrongly read from. */
interface LoadedEntry {
  entry: IndexEntryV3
  project: Project
  file?: ProjectFileV1
}

export async function writeAtomic(filePath: string, content: string): Promise<void> {
  // Unique temp per write: writers that bypass each other's queue (a second app instance, the SSH
  // poll's index write) must never share a tmp file — interleaved writes into one shared tmp
  // published spliced JSON under the atomic rename. writeFileAtomic also removes its own temp on
  // failure (project.json temps live in the USER'S repo, where litter is visible) and retries the
  // rename over Windows sharing violations. The error still propagates; per-file callers swallow
  // it by design.
  await writeFileAtomic(filePath, content)
}

/** Remove tmp litter next to `target` left by writers that died mid-write: the legacy fixed
 *  `<file>.tmp` name and any `<file>.<pid>.<seq>[.<uuid>].tmp` from another (dead) pid. Our own
 *  pid's temps are in-flight writes and stay. Same family rule as provider-cookie's sweep. */
async function sweepStaleTmp(target: string): Promise<void> {
  try {
    const dir = path.dirname(target)
    const base = path.basename(target)
    for (const entry of await fs.readdir(dir)) {
      if (!entry.startsWith(base) || !entry.endsWith('.tmp')) continue
      const middle = entry.slice(base.length, -'.tmp'.length) // '' or '.<pid>.<seq>[.<uuid>]'
      const owner = /^\.(\d+)\.\d+(?:\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?$/.exec(middle)?.[1]
      if (middle === '' || (owner && owner !== String(process.pid))) {
        await fs.rm(path.join(dir, entry), { force: true }).catch(() => undefined)
      }
    }
  } catch {
    // A dir we cannot read is not a reason to fail the load.
  }
}

/**
 * v3 persistence: workspace.json is an index (refs + inline canvases); each local
 * project's data lives in <cwd>/.nodeterm/project.json (source of truth). The
 * renderer contract is unchanged: load() returns / save() takes an assembled
 * v2-shaped Workspace.
 */
export class WorkspaceStore {
  /** file path -> exact content of the file as we last WROTE or READ it (skip-unchanged + watcher
   *  self-write suppression). Always the RAW bytes, never a re-serialization: a project.json whose
   *  on-disk formatting differs from ours (a teammate's editor, a git checkout) would otherwise
   *  never match isSelfWrite, so every fs event on it read as an external change forever — endless
   *  spurious reloads and conflict bars (field bug 2026-08-10). */
  private lastWritten = new Map<string, string>()
  /** project id -> rev of the last written/loaded file. */
  private revs = new Map<string, number>()
  /** Entries whose one-time exec migration could NOT run (their project file was unreadable at load).
   *  They stay unmarked on disk, so the hoist is retried when the folder/server comes back. */
  private execUnmigrated = new Set<string>()
  /** A hoist happened this load → show the one-time note (fired with the migration's save, exactly
   *  like the v2→v3 one: a silent change to how the user's own config is stored is not acceptable). */
  private pendingExecNote = false
  /** Raw v2 file content, kept until the first save backs it up (migration). */
  private pendingV2Backup: string | null = null
  /** The corrupt-index recovery note is a one-time-per-run banner: every later load in the same run
   *  sees the same missing index next to the same backup and must stay quiet. */
  private corruptNoteSent = false
  /** ssh project ids whose last mirror write was dropped (connection down). Retried on every
   *  save/connect until a write confirms — guarantees the server file lands regardless of node
   *  type or creation timing. Runtime-only, never persisted. */
  private unmirrored = new Set<string>()
  /** ssh project ids whose remote file has been read-compared at least once this run. Until then a
   *  save may NOT blind-write the mirror: a fresh/re-added project would clobber a populated
   *  server file it has never looked at (the ".nodeterm reset itself" bug). Runtime-only. */
  private reconciled = new Set<string>()
  /** ssh project id -> node ids a save REMOVED from that project's cache and the server has not been
   *  told about yet. The one discriminator between the two ways our cache can lack a node the server
   *  has: "the user deleted it here" (the deletion must travel — never rescue it back) and "we simply
   *  never had it" (the phone appended it while we were looking away — never delete it). Both rescue
   *  sites consult it; a confirmed write / an adopt drops the entry, because the server then already
   *  reflects our side. Runtime-only: after a restart an UNMIRRORED clear is indistinguishable from a
   *  node we never had, and the tie is broken toward rescuing (a resurrected node is visible and
   *  deletable again; a deleted session node is gone with no trace of where it went). */
  private clearedNodes = new Map<string, Set<string>>()
  /** ssh project id -> sha256 of the last few project.json payloads THIS store handed to
   *  `remoteIO.write`. The SSH twin of `lastWritten`'s watcher self-write suppression: the 15 s
   *  poll and the connect-time refresh read the very file the mirror writes, so a reconcile can
   *  read the store's OWN bytes back — either a write that just landed, or (because the real IO's
   *  5 s throttle acks a trailing write optimistically) an OLDER own write the trailing one has
   *  not yet replaced. Recognized by exact bytes, they are never an external change: without this
   *  a rev-only decision "adopted" our own mirror and broadcast it, raising the Reload/Keep-mine
   *  conflict bar over a file nobody else touched — and the older-write echo could rescue back a
   *  node the user had just deleted. Several hashes (RECENT_MIRROR_CAP), not one, precisely for
   *  that throttle window. Runtime-only: after a restart the rev comparison is the arbiter, as
   *  before. */
  private recentMirrorHashes = new Map<string, string[]>()
  /** project id -> this machine's settings overlay, already sanitized. The map — not the index
   *  entry — is the live copy: `splitWorkspace` rebuilds entries from the renderer's Workspace,
   *  which has never carried machine-local state, so every save would otherwise drop the overlay
   *  (the same reason `localExec`/`cache` are re-attached below). Absent = no overlay. */
  private localSettingsByProject = new Map<string, ProjectLocalSettings>()
  /** ssh project id -> last shared settings.json seen on that host (offline copy). Only entries that
   *  round-tripped through `parseProjectSettingsFile` are in here. */
  private settingsCacheByProject = new Map<string, ProjectSettingsFileV1>()
  /** ssh project ids whose settings.json was git-conflict-marked on the last read: `writeSshSettings`
   *  refuses while an id is in here instead of picking a side of the merge (the local leg refuses
   *  the same way, straight off the file it re-reads). Cleared as soon as a read finds the file
   *  parsing again — or gone. Runtime-only, and deliberately NOT relied on to be populated: a write
   *  that finds both settings maps cold does its own read first, because "a read established this
   *  flag before any write" is an assumption about panel order, not something this store enforces. */
  private settingsConflictByProject = new Set<string>()
  /** project id -> the shared settings file as last read/written, i.e. the rev source for the NEXT
   *  write. Runtime-only: a write that has not read first starts at rev 1, which is the same thing
   *  a fresh file means. */
  private lastSharedSettings = new Map<string, ProjectSettingsFileV1>()
  /** Last index written/loaded — lets readLocalRef/refresh resolve entries without a full load. */
  private index: WorkspaceIndexV3 | null = null
  /** Optional hook fired after every load()/save() — the watcher re-syncs its watch set (Task 5). */
  onPersist?: () => void

  constructor(private remoteIO?: RemoteWorkspaceIO) {}

  private get indexPath(): string {
    return path.join(platform().userDataDir, 'workspace.json')
  }

  registerIpc(): void {
    platform().handle(IPC.workspaceLoad, () => this.load())
    platform().handle(IPC.workspaceSave, (workspace: Workspace) => this.save(workspace))
    platform().handle(IPC.workspaceProbeFolder, (folder: string) => this.probeFolder(folder))
    platform().handle(IPC.workspaceProjectFileState, (cwd: unknown) =>
      typeof cwd === 'string' && cwd ? this.projectFileState(cwd) : 'unreadable')
    platform().handle(IPC.projectSettingsRead, (projectId: unknown) =>
      typeof projectId === 'string' ? this.readProjectSettings(projectId) : null)
    platform().handle(IPC.projectSettingsWriteShared, (projectId: unknown, doc: ProjectSettingsDoc) =>
      typeof projectId === 'string' ? this.writeProjectSettings(projectId, doc) : false)
    platform().handle(IPC.projectSettingsUpdateLocal,
      (projectId: unknown, local: ProjectLocalSettings | undefined) =>
        typeof projectId === 'string' ? this.updateLocalProjectSettings(projectId, local) : false)
  }

  /**
   * `sideline` (default true) forwards to readProjectFile: an unparsable/wrong-shape local
   * project.json is renamed to `.corrupt-<ts>` so a later save can't overwrite the only copy —
   * correct for boot/renderer loads. Read-only callers (e.g. the relay `projects.list` blob, which
   * a phone can trigger mid git-merge) pass false so a conflict-marked file is left hand-resolvable.
   */
  async load(opts?: { sideline?: boolean }): Promise<Workspace> {
    const result = await this.loadInner(opts?.sideline ?? true)
    this.onPersist?.()
    return result
  }

  private async loadInner(sideline: boolean): Promise<Workspace> {
    // Read-only loads (sideline: false — the relay blob path) must not mutate the disk, so the
    // litter sweep rides the same flag as the corrupt-file sideline.
    if (sideline) await sweepStaleTmp(this.indexPath)
    let raw: string
    try {
      raw = await fs.readFile(this.indexPath, 'utf-8')
    } catch {
      // No index. Usually a first run — but it is also what a crash BETWEEN the sideline rename
      // below and the next index write leaves behind, and that case owes the user the note. Only
      // this branch pays for the readdir, and only for a load that may touch disk anyway.
      if (sideline) this.noteCorruptIndex(await this.newestSidelined())
      return EMPTY_WORKSPACE
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // Same rule as a corrupt project.json: sideline the only copy so the boot flow's
      // unconditional save cannot replace it with an empty index. Read-only callers must not
      // mutate the disk (sideline: false).
      if (sideline) {
        const backup = `${path.basename(this.indexPath)}.corrupt-${Date.now()}`
        try {
          await renameAtomic(this.indexPath, path.join(platform().userDataDir, backup))
          // Only AFTER the rename succeeded: the note promises a backup exists.
          this.noteCorruptIndex(backup)
        } catch { /* best effort — never destroy data */ }
      }
      return EMPTY_WORKSPACE
    }
    const anyParsed = parsed as { version?: number }
    if (anyParsed?.version === 3) return this.loadV3(parsed as WorkspaceIndexV3, sideline)
    // v1/v2: assemble in memory now; the first save() performs the actual migration.
    const legacy = migrateLegacy(parsed)
    if (legacy.projects.length) this.pendingV2Backup = raw
    return legacy
  }

  /** Newest `workspace.json.corrupt-<ts>` sitting in userData, or null. */
  private async newestSidelined(): Promise<string | null> {
    const prefix = `${path.basename(this.indexPath)}.corrupt-`
    let newest: { name: string; ts: number } | null = null
    try {
      for (const name of await fs.readdir(platform().userDataDir)) {
        if (!name.startsWith(prefix)) continue
        const ts = Number(name.slice(prefix.length))
        if (!Number.isFinite(ts)) continue
        if (!newest || ts > newest.ts) newest = { name, ts }
      }
    } catch { /* userData unreadable — nothing to report */ }
    return newest?.name ?? null
  }

  /** One-time note: the index was lost but backed up, and no project data went with it. */
  private noteCorruptIndex(backup: string | null): void {
    if (!backup || this.corruptNoteSent) return
    this.corruptNoteSent = true
    platform().broadcast(IPC.workspaceCorruptRecovered, backup)
  }

  private async loadV3(index: WorkspaceIndexV3, sideline: boolean): Promise<Workspace> {
    for (const entry of index.entries) {
      entry.localApprovalId ||= randomUUID()
      // Same "workspace.json is hand-editable input too" treatment as the inline-project branch
      // below, for a REF'd project's own closed-session history: validate shape, cap, and
      // re-normalize each snapshot's trigger spec. Sanitized ONCE here so every downstream reader
      // of `e.closedSessions` (fileToProject, readLocalRef, the ssh reconcile paths) can trust it.
      entry.closedSessions = sanitizeLoadedClosedSessions(entry.closedSessions)
    }
    this.index = index
    const built: LoadedEntry[] = []
    for (const e of index.entries) {
      if (e.project) {
        // Inline projects are stored verbatim in the index (no fileToProject pass), so apply the
        // same kanban shape guard here — a v1/hand-edited board would otherwise crash the render —
        // and the same trigger shape rule (workspace.json is hand-editable input too).
        // `rest` drops BOTH guarded fields; each is added back below only if it passes its guard.
        const { kanban, closedSessions, ...rest } = e.project
        const base = validKanban(kanban) ? { ...rest, kanban } : rest
        // Same treatment for `closedSessions` as the ref'd-project entries above, and for the
        // same reason: a malformed value here reaches `mergeClosedHistory`, which iterates it (a
        // non-array throws and takes the whole sidebar render down) and hands each entry's node
        // to React Flow.
        const history = sanitizeLoadedClosedSessions(closedSessions)
        built.push({
          entry: e,
          project: {
            ...base,
            nodes: sanitizeNodeTriggers(base.nodes),
            ...(history ? { closedSessions: history } : {})
          }
        })
      } else if (e.cwd) {
        if (sideline) await sweepStaleTmp(projectFilePath(e.cwd))
        const read = await this.readProjectFile(e.cwd, sideline)
        if (read) {
          const p = read.file
          this.revs.set(e.id, p.rev)
          this.lastWritten.set(projectFilePath(e.cwd), read.raw)
          built.push({
            entry: e,
            file: p,
            project: fileToProject(p, {
              // The ENTRY's id, always. The file's own `id` is a legacy compatibility field that
              // git copies verbatim into every worktree — reading it is what let one machine's
              // project id name two folders.
              id: e.id,
              cwd: e.cwd,
              closed: e.closed,
              closedAt: e.closedAt,
              viewport: e.viewport,
              defaultAccountId: e.defaultAccountId,
              breadcrumbs: e.breadcrumbs,
              closedSessions: e.closedSessions,
              capabilityAck: e.capabilityAck,
              localExec: this.execOverlay(e, p)
            })
          })
        } else {
          this.deferExecMigration(e)
          built.push({ entry: e, project: unavailableProject(e) })
        }
      } else if (e.ssh) {
        if (e.cache) {
          this.revs.set(e.id, e.cache.rev)
          built.push({
            entry: e,
            project: fileToProject(e.cache, {
              id: e.id,
              ssh: e.ssh,
              closed: e.closed,
              closedAt: e.closedAt,
              viewport: e.viewport,
              defaultAccountId: e.defaultAccountId,
              breadcrumbs: e.breadcrumbs,
              closedSessions: e.closedSessions,
              capabilityAck: e.capabilityAck,
              localExec: this.execOverlay(e, e.cache)
            })
          })
        } else {
          this.deferExecMigration(e)
          built.push({ entry: e, project: unavailableProject(e) })
        }
      }
    }
    await this.repairDuplicateIds(built, sideline)
    // AFTER the repair: it re-keys entries in place, and the maps are keyed by project id.
    this.adoptSettingsFromIndex(index)
    const projects = built.map((b) => b.project)
    const active = projects.some((p) => p.id === index.activeProjectId && !p.unavailable)
      ? index.activeProjectId
      : (projects.find((p) => !p.closed && !p.unavailable)?.id ?? '')
    return { version: 2, activeProjectId: active, projects }
  }

  /**
   * The backstop: after every entry is loaded, no two projects may still share an id.
   *
   * The shared file no longer carries an id to copy, so nothing can corrupt a store this way any
   * more — but the stores corrupted BEFORE that are still on disk, and they cannot heal
   * themselves: once two entries were saved under one id (both folders' files carried it at the
   * last save), nothing downstream notices. `splitWorkspace` dedupes by CWD, so both entries
   * survive every save; `commitCanvas` maps by id, so the active canvas is written into BOTH
   * projects and the next save flushes it into the other folder's project.json. That is silent
   * cross-folder data loss on every autosave, so the repair cannot wait for the user to notice —
   * and it must be persisted, or every restart re-inherits the same corrupt index.
   *
   * It repairs the INDEX only. Re-keying the loser's project.json (what this did while the file
   * was the id's home) is now both pointless and wrong: the id in there is a legacy compatibility
   * field nothing reads, and writing to a git-shared file to fix a machine-local mistake is the
   * habit this whole change is removing.
   *
   * First holder keeps the id; the rest are re-keyed by `derivedProjectId`, which is DETERMINISTIC
   * in (id, folder) — a random id would give the two folders new names on every boot, whereas this
   * converges: the second load finds no collision at all.
   *
   * Loud on purpose (one line per repaired project, naming the folder): the user's tabs quietly
   * change identity, and a silent repair of someone's data is worse than a noisy one.
   */
  private async repairDuplicateIds(built: LoadedEntry[], sideline: boolean): Promise<void> {
    const seen = new Set<string>()
    let repaired = false
    for (const b of built) {
      if (!seen.has(b.project.id)) {
        seen.add(b.project.id)
        continue
      }
      const old = b.project.id
      const seed = collisionSeed({
        cwd: b.entry.cwd,
        ssh: b.entry.ssh,
        name: b.project.name
      })
      const next = derivedProjectId(old, seed, (id) => seen.has(id) || built.some((o) => o.project.id === id))
      seen.add(next)
      repaired = true
      console.warn(
        `[workspace] two projects claimed the project id "${old}" — a git-shared ` +
          `.nodeterm/project.json copied into a second folder (worktree/checkout). Re-keyed ` +
          `${b.entry.cwd ?? b.entry.ssh?.remoteCwd ?? `inline canvas "${b.project.name}"`} to "${next}".`
      )
      b.entry.id = next
      b.project = { ...b.project, id: next }
      if (b.entry.project) b.entry.project = { ...b.entry.project, id: next }
      if (b.entry.cache) {
        b.entry.cache = { ...b.entry.cache, id: next }
        this.revs.set(next, b.entry.cache.rev)
      }
      // The rev is tracked per project id, so it has to follow the re-key. The file itself is not
      // touched: it holds this project's CONTENT, and the content did not change.
      if (b.file) this.revs.set(next, b.file.rev)
    }
    // The re-keyed ENTRIES are the half that makes the repair survive a restart — without this the
    // next boot reads the old index and repairs again (harmlessly, but forever).
    if (!repaired || !sideline) return
    try {
      await writeAtomic(this.indexPath, JSON.stringify(this.index))
    } catch { /* the next save writes it anyway */ }
  }

  /**
   * The machine-local exec overlay for one ref'd entry — plus the ONE-TIME migration (see
   * `IndexEntryV3.execMigrated` / `hoistLegacyNodeExec`).
   *
   * `ssh.extraArgs` had a producer before the trust boundary existed, so an existing user's jump
   * host / corporate `ProxyCommand` is sitting in the CURRENT project file with no `localExec` to
   * match. Dropping it would break the connection and then, on the next save, erase it from disk and
   * propagate the deletion to every teammate. So for an entry that has not been migrated yet — i.e.
   * one that was ALREADY REFERENCED in this machine's workspace.json at upgrade time, which is the
   * provenance signal available — the file's own values are hoisted into the overlay once.
   * `localExec` (if any) still wins per node.
   */
  private execOverlay(e: IndexEntryV3, f: ProjectFileV1): LocalNodeExecMap | undefined {
    // This entry is readable THIS load, so any earlier deferral (its file was offline when we first
    // loaded) is now resolved. Clear it so the next save() may record execMigrated=true — otherwise
    // the entry stays unmarked forever and the hoist re-runs on every full load, which would also
    // let a project.json swapped in AFTER the deferral get its exec fields hoisted as trusted.
    this.execUnmigrated.delete(e.id)
    if (e.execMigrated) return e.localExec
    const hoisted = hoistLegacyNodeExec(f.nodes)
    if (!hoisted) return e.localExec
    this.pendingExecNote = true
    return { ...hoisted, ...e.localExec }
  }

  /** The file was unreadable, so the hoist could not run: leave the entry unmarked and retry it on
   *  a later load. Anything dropped must be visible or recoverable — never silently gone. */
  private deferExecMigration(e: IndexEntryV3): void {
    if (!e.execMigrated) this.execUnmigrated.add(e.id)
  }

  /**
   * Loads the settings halves out of a just-read index into the two runtime maps.
   *
   * workspace.json is hand-editable (and, on Server Edition, sits next to other users' reach), so
   * neither field is trusted on the way in: the overlay goes through the same sanitizer a settings
   * file gets, and a cached SHARED file is accepted only if it still parses as one — the parser is
   * reused as the validator so there is exactly one definition of "a valid settings file",
   * wherever the bytes came from.
   */
  private adoptSettingsFromIndex(index: WorkspaceIndexV3): void {
    this.localSettingsByProject.clear()
    this.settingsCacheByProject.clear()
    for (const e of index.entries) {
      const local = sanitizeProjectLocalSettings(e.localSettings)
      if (local && Object.keys(local).length) this.localSettingsByProject.set(e.id, local)
      if (!e.ssh || !e.settingsCache) continue
      const parsed = parseProjectSettingsFile(JSON.stringify(e.settingsCache))
      if (parsed.status === 'ok') this.settingsCacheByProject.set(e.id, parsed.file)
    }
  }

  /** Writes the maps back onto an index about to be persisted — the machine-local half that
   *  `splitWorkspace` cannot know about. Runs on every index write, so an entry the maps no longer
   *  cover loses the field rather than keeping a stale copy of it. */
  private applySettingsToIndex(index: WorkspaceIndexV3): void {
    for (const e of index.entries) {
      const local = this.localSettingsByProject.get(e.id)
      if (local) e.localSettings = local
      else delete e.localSettings
      // Only an ssh entry has anywhere to cache: a local ref's shared file is one disk read away,
      // and an inline canvas has no shared file at all.
      const cached = e.ssh ? this.settingsCacheByProject.get(e.id) : undefined
      if (cached) e.settingsCache = cached
      else delete e.settingsCache
    }
  }

  /**
   * The shared + local settings of one project. `null` means the id names no entry (never "no
   * settings" — an entry with neither file nor overlay answers `{shared: null, local: undefined}`).
   *
   * The shared doc is read from disk on every call rather than cached: `.nodeterm/settings.json` is
   * a git-tracked file a checkout/merge/teammate rewrites behind our back, and a settings read is
   * rare enough (a panel opening, a launch) that a stale answer would cost more than the read does.
   */
  async readProjectSettings(projectId: string): Promise<ProjectSettingsState | null> {
    const e = this.index?.entries.find((x) => x.id === projectId)
    if (!e) return null
    const local = this.localSettingsByProject.get(projectId)
    if (e.ssh) return this.readSshSettings(projectId, e.ssh, local)
    // An inline canvas has no folder, so there is no shared document to have.
    if (!e.cwd) return { shared: null, local }
    const read = await readProjectSettingsFile(e.cwd)
    if (read.status === 'ok') {
      // The rev source for the next write — a write that skipped the read would restart at rev 1
      // and lose the counter a remote/offline comparison depends on.
      this.lastSharedSettings.set(projectId, read.file)
      return { shared: read.file, local }
    }
    // conflict: the file exists but is mid-merge; it is left untouched for the user to resolve and
    // reported as such, so a caller shows "resolve this" instead of "this project has no settings".
    if (read.status === 'conflict') return { shared: null, local, conflict: true }
    return { shared: null, local } // absent / invalid (sidelined) / unreadable
  }

  /**
   * The ssh half of `readProjectSettings`: reconcile the host's settings.json against the offline
   * cache, then answer with whichever is authoritative. Same rules the project.json mirror lives by:
   *
   *  - no settings IO / read `error` → serve the cache. A failed read is never evidence of absence,
   *    so nothing is pushed and nothing is dropped; the project stays usable offline.
   *  - `absent` → the host has no file; heal it from the cache (the mirror direction) and serve the
   *    cache. Without a cache there is simply no shared document yet.
   *  - `ok` → the bytes are HOSTILE INPUT (a git-shared file on a machine we do not control) and go
   *    through `parseProjectSettingsFile` alone. The higher rev wins, ties to the host, so a
   *    teammate's push is adopted rather than fought over, while a STRICTLY newer cache (this
   *    machine edited while disconnected) is pushed back instead of being silently overwritten.
   *  - `conflict`/`invalid` → the remote copy cannot be trusted and must not be clobbered; the cache
   *    is served as the last known good, with `conflict` flagged so a caller can say "resolve this"
   *    (and, for a conflict, remembered so a WRITE refuses too — see `settingsConflictByProject`).
   *
   * The cache is read AFTER the round trip, never before: a cache-first write can land while this
   * read is in flight, and comparing the host's answer against a snapshot taken before the await
   * would adopt an older remote doc over an edit the user has already been told was saved.
   */
  private async readSshSettings(
    projectId: string,
    ssh: NonNullable<Project['ssh']>,
    local: ProjectLocalSettings | undefined
  ): Promise<ProjectSettingsState> {
    const res = await this.remoteIO?.readSettings?.(projectId, ssh)
    const cached = this.settingsCacheByProject.get(projectId) ?? null
    if (!res || res.status === 'error') return { shared: cached, local }
    if (res.status === 'absent') {
      // The host has no file to be mid-merge: whatever conflict a previous read saw is gone.
      this.settingsConflictByProject.delete(projectId)
      if (cached) await this.pushSshSettings(projectId, ssh, cached)
      return { shared: cached, local }
    }
    const parsed = parseProjectSettingsFile(res.content)
    if (parsed.status === 'conflict') {
      this.settingsConflictByProject.add(projectId)
      return { shared: cached, local, conflict: true }
    }
    // `invalid` deliberately leaves the flag alone: unparsable is not "resolved", and refusing to
    // write is the conservative side of a file we still cannot read.
    if (parsed.status === 'invalid') return { shared: cached, local }
    this.settingsConflictByProject.delete(projectId) // the host's file parses again — resolved
    const file = parsed.file
    if (cached && file.rev < cached.rev) {
      // Offline edits outrank the host's older copy — push them rather than letting the next read
      // adopt a document the user already replaced here.
      await this.pushSshSettings(projectId, ssh, cached)
      return { shared: cached, local }
    }
    this.lastSharedSettings.set(projectId, file)
    // Only persist when the cache actually moved: a read is the common case, and rewriting
    // workspace.json on every panel open would be a disk write per glance.
    if (!cached || cached.rev !== file.rev || !sameProjectSettingsContent(cached, file)) {
      this.settingsCacheByProject.set(projectId, file)
      await this.persistIndexNow().catch(() => {})
    }
    return { shared: file, local }
  }

  /** Best-effort mirror of one settings document to the host. A failure is not an error anywhere:
   *  the cache is the durable copy and the next read reconciles (heal / push again). */
  private async pushSshSettings(
    projectId: string,
    ssh: NonNullable<Project['ssh']>,
    file: ProjectSettingsFileV1
  ): Promise<boolean> {
    const io = this.remoteIO
    if (!io?.writeSettings) return false
    try {
      return await io.writeSettings(projectId, ssh, serializeProjectSettingsFile(file))
    } catch {
      return false
    }
  }

  /**
   * The ssh half of `writeProjectSettings`, CACHE-FIRST: the rev-bumped document lands in the
   * offline cache and workspace.json BEFORE it is offered to the host, so a connection that dies
   * mid-save loses a round trip, never the user's edit. The remote write is then best-effort —
   * `true` here means "this edit is safely recorded", and an unreachable host is reconciled by the
   * next read (which heals an absent file and pushes a cache that outranks the remote).
   *
   * The doc is sanitized on the way in because this cache is served straight from memory and
   * persisted into workspace.json; running it through the same sanitizer a read applies keeps one
   * definition of "a valid settings file" whichever side the bytes came from.
   *
   * REFUSES a git-conflict-marked host file, exactly like the local leg refuses a conflicted
   * settings.json: a conflicted file is the user's to resolve, and pushing over it would silently
   * pick a side of a merge nobody has looked at. Two mechanisms enforce that, because the ssh leg
   * cannot afford the local leg's read-before-every-write (a round trip per save):
   *  - WARM (this run has a cache or a last-read doc): the runtime flag a read left behind, which
   *    clears itself the moment a read finds the file parsing again — or gone.
   *  - COLD (neither map knows this project, so no read has ever compared): one read here, or the
   *    refusal would be a promise nothing checks — the first save of a session would blind-write
   *    the mirror over a merge. `absent` writes rev 1 as before; a read `error` proceeds
   *    cache-first, since being unable to reach the host is exactly what the cache exists for.
   */
  private async writeSshSettings(
    projectId: string,
    ssh: NonNullable<Project['ssh']>,
    doc: ProjectSettingsDoc
  ): Promise<boolean> {
    if (this.settingsConflictByProject.has(projectId)) return false
    let prev = this.settingsCacheByProject.get(projectId) ?? this.lastSharedSettings.get(projectId) ?? null
    if (!prev && this.remoteIO?.readSettings) {
      // A throwing IO is an unreachable host, not a verdict on the file — same fail-open shape as
      // `pushSshSettings`, and the cache-first write below is what makes that survivable.
      let cold: RemoteReadResult = { status: 'error' }
      try {
        cold = await this.remoteIO.readSettings(projectId, ssh)
      } catch { /* offline: fall through to the cache-first write */ }
      if (cold.status === 'ok') {
        const parsed = parseProjectSettingsFile(cold.content)
        if (parsed.status === 'conflict') {
          this.settingsConflictByProject.add(projectId)
          return false
        }
        // `invalid` is left as prev=null: the host's bytes are unusable as a rev source, and the
        // cache-first write is what gives the user a readable file again.
        if (parsed.status === 'ok') {
          prev = parsed.file
          this.lastSharedSettings.set(projectId, parsed.file)
          this.settingsConflictByProject.delete(projectId)
        }
      }
    }
    // Canonical shape (bookkeeping first, then the sanitized doc) — the same order
    // `parseProjectSettingsFile` produces, so a cache built here compares equal to the identical
    // document read back from the host instead of looking like a change. Sanitizing on the way in
    // keeps one definition of "a valid settings file" whichever side the bytes came from, and drops
    // the stale version/rev/savedAt of a document a caller hands straight back.
    const next: ProjectSettingsFileV1 = {
      version: 1,
      rev: (prev?.rev ?? 0) + 1,
      savedAt: new Date().toISOString(),
      ...sanitizeProjectSettingsDoc(doc)
    }
    this.settingsCacheByProject.set(projectId, next)
    this.lastSharedSettings.set(projectId, next)
    try {
      await this.persistIndexNow()
    } catch {
      return false // the edit is live in this session, but it did not durably land
    }
    await this.pushSshSettings(projectId, ssh, next)
    return true
  }

  /**
   * Whole-document write of the GIT-SHARED settings file. Whole-document on purpose: a per-field
   * patch grammar would have to merge against a file that another writer (a teammate's commit, the
   * user's editor) may have changed since the caller read it, and silently merging into a file the
   * caller never saw is how the shared half stops meaning what the repo says.
   *
   * ALWAYS READS FIRST — not just when this run has never read the file. A remembered rev is not
   * evidence of the file's current STATE: `.nodeterm/settings.json` is git-tracked, so between the
   * panel's read and the user's save a pull/merge can leave conflict markers, and a write off the
   * warm rev would overwrite them (the same file `readProjectSettings` deliberately refuses to
   * parse). Without any read a fresh process is worse still — rev restarts at 1 over a file that was
   * at rev N. Settings are cold (a panel save, not a keystroke), so one read per write is the ruled
   * cost of never writing a file this store has not just looked at.
   *
   * An ssh project takes the cache-first remote leg instead (`writeSshSettings`).
   *
   * False = there is nowhere to write it, or writing would destroy something. On BOTH legs: an
   * unknown id, an inline canvas (no folder), and a git-conflicted shared file — the user's to
   * resolve, left untouched (the local leg sees it in the read-before-write; the ssh leg sees it
   * WARM from a cache or last-read doc this run already has, or — COLD, when neither map knows this
   * project yet — from the one read `writeSshSettings` does itself before its first write, per its
   * own docstring above). Local leg only: an unreadable file (a failed read is never evidence of
   * absence, so it may not be clobbered either) or a failed write. SSH leg only: an index write that
   * did not persist — a failed REMOTE write is not false there, because the cache already holds
   * the edit.
   */
  async writeProjectSettings(projectId: string, doc: ProjectSettingsDoc): Promise<boolean> {
    const e = this.index?.entries.find((x) => x.id === projectId)
    if (!e) return false
    if (e.ssh) return this.writeSshSettings(projectId, e.ssh, doc)
    if (!e.cwd) return false
    const read = await readProjectSettingsFile(e.cwd)
    // absent → nothing to lose, start at rev 1. invalid → the read already sidelined the only
    // copy to `.corrupt-<ts>`, so this write destroys nothing either.
    if (read.status === 'conflict' || read.status === 'error') return false
    let prev: ProjectSettingsFileV1 | null = null
    if (read.status === 'ok') {
      prev = read.file
      this.lastSharedSettings.set(projectId, read.file)
    }
    try {
      const written = await writeProjectSettingsFile(
        e.cwd, doc, prev, new Date().toISOString()
      )
      this.lastSharedSettings.set(projectId, written)
      return true
    } catch {
      // Folder gone / read-only checkout: the caller is told the doc did not land, exactly like a
      // failed project.json write leaves the entry stale rather than pretending it saved.
      return false
    }
  }

  /**
   * Replaces this machine's overlay for one project (undefined = clear it) and persists the index
   * NOW, without waiting for a canvas save: a settings edit is often the only thing the user did in
   * that session, and an overlay that lives only in memory until the next node is dragged is an
   * overlay that quietly disappears when the app quits.
   */
  async updateLocalProjectSettings(
    projectId: string,
    local: ProjectLocalSettings | undefined
  ): Promise<boolean> {
    const e = this.index?.entries.find((x) => x.id === projectId)
    if (!e) return false
    const clean = local === undefined ? undefined : sanitizeProjectLocalSettings(local)
    if (clean && Object.keys(clean).length) this.localSettingsByProject.set(projectId, clean)
    else this.localSettingsByProject.delete(projectId)
    await this.persistIndexNow()
    return true
  }

  /** Rewrites the CURRENT index with the settings maps applied. On `saveChain` like every other
   *  index write, so it can neither interleave with a save's own rewrite nor invent entries: it
   *  persists exactly what `this.index` already holds (and does nothing before the first load). */
  private persistIndexNow(): Promise<void> {
    const run = this.saveChain.then(async () => {
      const index = this.index
      if (!index) return
      this.applySettingsToIndex(index)
      await writeAtomic(this.indexPath, JSON.stringify(index))
    })
    this.saveChain = run.catch(() => {})
    return run
  }

  /**
   * Reads + parses one project file. Only the authoritative loadV3 path passes `sideline: true`,
   * which renames an unparsable/wrong-shape file to `.corrupt-<ts>` so a later save can't overwrite
   * the only copy. Read-only callers (probeFolder — an RPC reachable with arbitrary paths on Server
   * Edition — and the watcher's readLocalRef*) pass false: a probe must never mutate the disk, and a
   * git-conflict-marked project.json mid-merge must be left in place so the user can hand-resolve it.
   */
  private async readProjectFile(cwd: string, sideline: boolean): Promise<ProjectFileRead | null> {
    const file = projectFilePath(cwd)
    let raw: string
    try {
      raw = await fs.readFile(file, 'utf-8')
    } catch {
      return null
    }
    try {
      const parsed = JSON.parse(raw) as ProjectFileV1
      // `raw` travels with the parse so callers can record the BYTES on disk in `lastWritten`.
      // A missing `id` is NOT a wrong shape: the file stopped carrying identity, and the version
      // that still demanded one sidelines every modern file it meets (which is precisely why we
      // keep writing the legacy field for a release — see `legacyFileId`).
      if (parsed?.version === 1 && Array.isArray(parsed.nodes)) return { file: parsed, raw }
      // parses but isn't a ProjectFileV1 — sideline it too, so a later save can't overwrite the only copy.
    } catch { /* not JSON — sideline below */ }
    if (sideline) {
      try {
        await renameAtomic(file, `${file}.corrupt-${Date.now()}`)
      } catch { /* best effort — never destroy data */ }
    }
    return null
  }

  /** True when writing an empty canvas to `file` destroys nothing: the file is absent (fresh
   *  folder) or already an empty-nodes project file. Populated AND unparsable both answer false —
   *  a corrupt file is left for readProjectFile's sideline instead of being overwritten. */
  private async emptyOrAbsentOnDisk(file: string): Promise<boolean> {
    let raw: string
    try {
      raw = await fs.readFile(file, 'utf-8')
    } catch {
      return true
    }
    try {
      const parsed = JSON.parse(raw) as ProjectFileV1
      return parsed?.version === 1 && Array.isArray(parsed.nodes) && parsed.nodes.length === 0
    } catch {
      return false
    }
  }

  /** In-flight save chain: saves run FIFO (same idiom as SpeechService.queue). Overlapping saves
   *  used to interleave their file writes and land their indexes out of call order — the "both
   *  projects went blank after tab switching" wipe. */
  private saveChain: Promise<unknown> = Promise.resolve()

  save(workspace: Workspace): Promise<void> {
    const run = this.saveChain.then(() => this.saveNow(workspace))
    this.saveChain = run.catch(() => {})
    return run
  }

  private async saveNow(workspace: Workspace): Promise<void> {
    if (!workspace.projects.length && !this.index) {
      // A store that never read the index may not replace a populated one with "no projects":
      // that is the boot-save wipe — load() failed transiently, the renderer hydrated zero
      // projects, and its unconditional boot save would atomically erase every ref. A fresh
      // install has no readable index and falls through.
      try {
        const disk = JSON.parse(await fs.readFile(this.indexPath, 'utf-8')) as
          { entries?: unknown[]; projects?: unknown[] }
        if ((disk.entries?.length ?? 0) > 0 || (disk.projects?.length ?? 0) > 0) return
      } catch { /* absent or unparsable (loadInner sidelines corruption) — an empty write is fresh */ }
    }
    const savedAt = new Date().toISOString()
    const { index, files } = splitWorkspace(workspace, (id) => this.revs.get(id) ?? 0, savedAt)

    for (const entry of index.entries) {
      const previous = this.index?.entries.find((candidate) => candidate.id === entry.id)
      entry.localApprovalId = previous?.localApprovalId || randomUUID()
    }

    // The settings overlay / ssh settings cache ride every index write, like `localExec` and
    // `cache`: `splitWorkspace` builds entries from the renderer's Workspace, which carries no
    // machine-local state, so without this each autosave would erase them from disk.
    this.applySettingsToIndex(index)

    // An unavailable placeholder carries no real data. splitWorkspace already dropped its file
    // and cache; here we restore the machine-local payload (ssh offline cache) from the previous
    // index so the index rewrite doesn't drop a good cache we still can't reach.
    // The one-time exec migration is now recorded, so it never runs again for these entries — which
    // is what keeps a project.json cloned AFTER the upgrade (the hostile case) out of the hoist. An
    // entry whose file we could not read at load stays unmarked, so it is retried.
    for (const e of index.entries) {
      if (e.project) continue // inline canvases live in this machine-local file already
      if (!this.execUnmigrated.has(e.id)) e.execMigrated = true
    }

    const unavailableIds = new Set(workspace.projects.filter((p) => p.unavailable).map((p) => p.id))
    if (unavailableIds.size) {
      for (const e of index.entries) {
        if (!unavailableIds.has(e.id)) continue
        const old = this.index?.entries.find((o) => o.id === e.id)
        if (old?.cache) e.cache = old.cache
        // Same reasoning for the machine-local exec values: the placeholder has no nodes, so
        // splitWorkspace could not carry them — restoring them keeps the user's own custom shell /
        // ssh args for when the ref becomes readable again.
        if (old?.localExec) e.localExec = old.localExec
        // …and for the rest of the machine-local half. A placeholder's viewport is the {0,0,1} of
        // an empty stand-in canvas: persisting it would forget where the user was looking the
        // moment a folder is briefly unmounted.
        if (old?.viewport) e.viewport = old.viewport
        if (old?.defaultAccountId) e.defaultAccountId = old.defaultAccountId
        if (old?.breadcrumbs) e.breadcrumbs = old.breadcrumbs
        // Same rule: a placeholder's project carries no closedSessions (it has no nodes to have
        // deleted), so without this an unavailable window would silently forget the user's trash
        // can the moment splitWorkspace rebuilds the index.
        if (old?.closedSessions) e.closedSessions = old.closedSessions
        // The clone-notice acknowledgment must also survive an unavailable window: forgetting it
        // would re-raise a notice the user already answered the moment the folder remounts.
        if (old?.capabilityAck) e.capabilityAck = old.capabilityAck
      }
    }

    // Which project each pending file belongs to. `files` is keyed by cwd and the candidate no
    // longer carries an id (that is the point), while `revs` is keyed by PROJECT id — so the two
    // are joined here, through the index entry that owns the folder. At most one ref entry exists
    // per cwd (splitWorkspace's second tab on a folder becomes an inline entry, no cwd at all).
    const projectIdForCwd = new Map(
      index.entries.filter((e) => e.cwd).map((e) => [e.cwd!, e.id] as const)
    )
    for (const [cwd, candidate] of files) {
      const projectId = projectIdForCwd.get(cwd) ?? cwd
      const file = projectFilePath(cwd)
      const prev = this.lastWritten.get(file)
      const prevParsed = prev ? (JSON.parse(prev) as ProjectFileV1) : null
      if (prevParsed && sameProjectContent(prevParsed, candidate)) continue
      if (!prevParsed && candidate.nodes.length === 0 && !(await this.emptyOrAbsentOnDisk(file))) {
        // The local twin of the SSH "never blind-write a file we have not read" rule: an empty
        // canvas from a store that never read this file (setProjectFolder, migration, a hydrate
        // race) must not overwrite the populated — or corrupt-but-recoverable — only copy. The
        // disk stays authoritative; the next load returns its truth.
        continue
      }
      const next: ProjectFileV1 = { ...candidate, rev: (this.revs.get(projectId) ?? 0) + 1 }
      const content = serializeProjectFile(next)
      try {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await writeAtomic(file, content)
        this.lastWritten.set(file, content)
        this.revs.set(projectId, next.rev)
      } catch { /* folder gone (unmounted disk): the entry simply stays stale → unavailable next load */ }
    }

    // ssh caches: bump rev on change so a later remote write can win; mirror write in Task 8.
    for (const e of index.entries) {
      if (!e.ssh || !e.cache) continue
      const prevRev = this.revs.get(e.id) ?? 0
      const previousCache = this.index?.entries.find((old) => old.id === e.id && old.cache)?.cache
      const changedSinceLoad = !(previousCache && sameProjectContent(previousCache, e.cache))
      e.cache.rev = changedSinceLoad ? prevRev + 1 : prevRev
      this.revs.set(e.id, e.cache.rev)
      if (!this.remoteIO) continue
      // Anything this save dropped is a deliberate local deletion — remember it until the server has
      // been told, so the mirror write's re-read below can tell it apart from a node we never had.
      // Without that record the re-read would hand every just-deleted node straight back on the very
      // write that was supposed to remove it, and no node on an ssh project could ever be closed.
      this.recordLocalDeletions(e.id, previousCache?.nodes, e.cache.nodes)
      if (!this.reconciled.has(e.id)) {
        // Never blind-write a remote file we have not read yet: the first mirror of a fresh or
        // re-added project must LOOK first — an existing lineage on the server may win (adopted,
        // broadcast to the renderer) instead of being clobbered by an empty newborn canvas.
        const adopted = await this.reconcileSsh(e)
        if (adopted) platform().broadcast(IPC.workspaceExternalChange, adopted)
        continue
      }
      // Mirror on change, and re-mirror while a previous write is still owed (the first save
      // often races the ControlMaster coming up — its write is dropped fail-open, and without
      // the retry nothing rewrites until the next real content change).
      //
      // The write RE-READS the server first (mirrorSshCache) — it used to be blind, which is the
      // gap that cost users a phone-started session: the phone appends its node to the server file
      // at T0, the user drags a node here at T0+2s, and that ordinary save's mirror write pushed a
      // cache that had never seen the append, deleting it from both sides for good. The ~15s poll
      // only rescued the appends that happened to land outside its own window. The re-read costs one
      // extra round-trip per CHANGED save (an unchanged, already-mirrored save still reads nothing).
      if (changedSinceLoad || this.unmirrored.has(e.id)) await this.mirrorSshCache(e)
    }

    // Back up the raw v2 file BEFORE the v3 index flip: a crash between the two must never leave a
    // migrated tree (project files already written above) without its pre-migration backup.
    const migrating = this.pendingV2Backup !== null
    if (migrating) {
      try {
        await writeAtomic(path.join(platform().userDataDir, 'workspace.v2.bak'), this.pendingV2Backup!)
      } catch { /* backup is best-effort */ }
      this.pendingV2Backup = null
    }

    // Compact index, atomic — same reasoning as the old single-file store.
    await writeAtomic(this.indexPath, JSON.stringify(index))
    this.index = index

    if (migrating) platform().broadcast(IPC.workspaceMigrated, 'v2')
    if (this.pendingExecNote) {
      this.pendingExecNote = false
      platform().broadcast(IPC.workspaceMigrated, 'exec')
    }

    this.onPersist?.()
  }

  /**
   * The ADOPTION path: a folder with no index entry (Open folder…, a fresh clone). It is the one
   * place that must MINT an id — the file used to supply one, which is exactly how a worktree's
   * copy handed a second folder the first's identity.
   *
   * Minting cannot be idempotent (two folders holding the same canvas must become two projects),
   * so re-opening a folder is kept to one project by the CALLER, which looks the folder up by cwd
   * before it probes (`projects.openFolderProject` / `addProjectFromFolder`). Once adopted, the
   * index entry owns the id for good.
   */
  async probeFolder(folder: string): Promise<Project | null> {
    const read = await this.readProjectFile(folder, false)
    // No `localExec`: this folder is being ADOPTED (its project.json may have been cloned from
    // anywhere), so its nodes come up with no custom shell and no extra ssh args — the safe
    // defaults. Only values this machine typed itself are ever restored (@shared/node-exec).
    return read ? fileToProject(read.file, { id: freshProjectId(), cwd: folder }) : null
  }

  /**
   * Is this folder's `.nodeterm/project.json` genuinely gone, merely unreadable, or fine?
   *
   * `readProjectFile` collapses all three into `null`, which is right for its callers (they only
   * need "can I use it") but wrong for recovery: clearing a project's `unavailable` placeholder
   * lets the next save WRITE its empty canvas, so doing that on a file that is present but
   * momentarily unreadable (permissions, a stalled mount) would overwrite the only copy. A failed
   * read is never evidence of absence — so the errno is the answer, and anything that is not a
   * definite ENOENT reports `unreadable`, the side that changes nothing. See issue #385.
   */
  async projectFileState(cwd: string): Promise<'present' | 'absent' | 'unreadable'> {
    try {
      await fs.stat(projectFilePath(cwd))
      return 'present'
    } catch (err) {
      return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'absent' : 'unreadable'
    }
  }

  localRefPaths(): string[] {
    return (this.index?.entries ?? []).filter((e) => e.cwd).map((e) => projectFilePath(e.cwd!))
  }

  isSelfWrite(filePath: string, content: string): boolean {
    return this.lastWritten.get(filePath) === content
  }

  async readLocalRef(projectId: string): Promise<Project | null> {
    const e = this.index?.entries.find((x) => x.id === projectId && x.cwd)
    if (!e?.cwd) return null
    const read = await this.readProjectFile(e.cwd, false)
    if (!read) return null
    // The watcher's re-read after a git checkout is exactly where a foreign file arrives; the
    // project must come back under OUR entry id or `replaceProject` (which matches by id) silently
    // drops it. Same for the camera: a teammate's committed viewport must not yank this user's.
    this.revs.set(e.id, read.file.rev)
    this.lastWritten.set(projectFilePath(e.cwd), read.raw)
    return fileToProject(read.file, {
      id: e.id,
      cwd: e.cwd,
      closed: e.closed,
      closedAt: e.closedAt,
      viewport: e.viewport,
      defaultAccountId: e.defaultAccountId,
      breadcrumbs: e.breadcrumbs,
      closedSessions: e.closedSessions,
      capabilityAck: e.capabilityAck,
      localExec: e.localExec
    })
  }

  /** Maps a watched file path back to its project and re-reads it. */
  async readLocalRefByPath(filePath: string): Promise<Project | null> {
    const e = this.index?.entries.find((x) => x.cwd && projectFilePath(x.cwd) === filePath)
    return e ? this.readLocalRef(e.id) : null
  }

  /**
   * Reconciles the server's .nodeterm/project.json with our cached copy (see reconcileSsh):
   * remote won → adopt (returned; caller broadcasts it); otherwise our cache pushed up.
   * Called on connect, and periodically while connected (the POLL — how a session the mobile
   * companion appended to the server file reaches the live canvas). The poll passes
   * `pushIfStanding: false`: when our cache simply stands, a poll must be read-only — only an
   * OWED mirror (a previously dropped write) may still push.
   *
   * Runs ON `saveChain`, like every other read-modify-write of the same state: off the chain a
   * poll could snapshot the pre-save index entry, then complete its slow ssh read AFTER the save's
   * mirror write landed — remote.rev > (stale) cacheRev, and the store "adopted" and broadcast its
   * OWN write as an external change (the spurious Reload/Keep-mine conflict bar). Queued, a
   * reconcile always compares the server file against the same generation of cache/rev state, and
   * its index write cannot interleave with a save's either.
   */
  refreshSshProject(projectId: string, opts?: { pushIfStanding?: boolean }): Promise<Project | null> {
    const run = this.saveChain.then(() => this.refreshSshProjectNow(projectId, opts))
    this.saveChain = run.catch(() => {})
    return run
  }

  private async refreshSshProjectNow(projectId: string, opts?: { pushIfStanding?: boolean }): Promise<Project | null> {
    const e = this.index?.entries.find((x) => x.id === projectId && x.ssh)
    if (!e?.ssh || !this.remoteIO) return null
    const revBefore = e.cache?.rev
    const adopted = await this.reconcileSsh(e, opts?.pushIfStanding ?? true)
    // Persist the index only when the reconcile moved something — a quiet poll must not churn
    // workspace.json every tick.
    if (adopted || e.cache?.rev !== revBefore) {
      await writeAtomic(this.indexPath, JSON.stringify(this.index))
    }
    return adopted
  }

  /** The ssh entry ids of the current index — what the connected-project poll iterates. */
  sshProjectIds(): string[] {
    return (this.index?.entries ?? []).filter((e) => e.ssh).map((e) => e.id)
  }

  /** The local folder cwd of a project by id (index lookup), or undefined for ssh/inline/unknown
   *  projects. Sync (reads the in-memory index): the board-log router's local-vs-unsupported call. */
  localCwdForProject(projectId: string): string | undefined {
    return this.index?.entries.find((e) => e.id === projectId && e.cwd)?.cwd
  }

  /** Minimal per-project target info for the setup/archive runner (project-setup-runner-local.ts's
   *  `resolveProjectSetupTarget`) — cwd/ssh/name straight off the loaded index. Sync, like
   *  `localCwdForProject`: this is what closes the Task 1 review finding that a run's rootPath/
   *  ssh/projectName must come from THIS machine's own index, never from whatever the renderer
   *  happened to send. */
  projectTargetInfo(projectId: string): { cwd?: string; ssh?: Project['ssh']; name: string } | null {
    const e = this.index?.entries.find((x) => x.id === projectId)
    return e ? { cwd: e.cwd, ssh: e.ssh, name: e.name } : null
  }

  /** Resolve the shared project together with its machine-local trust identity. The approval id
   *  never enters the shared project object or project.json. */
  async githubProject(projectId: string): Promise<{
    project: Project
    localApprovalId: string
  } | null> {
    const workspace = await this.load({ sideline: false })
    const project = workspace.projects.find((candidate) => candidate.id === projectId)
    const localApprovalId = this.index?.entries.find((entry) => entry.id === projectId)?.localApprovalId
    return project && localApprovalId ? { project, localApprovalId } : null
  }

  /** The local ref cwds of the current index — the workspace half of the phone bridge's fs/git
   *  jail. The phone browses EVERY project over `projects.list`, so jailing to only the active
   *  canvas's node cwds denied any project the desktop didn't happen to have focused. */
  localProjectCwds(): string[] {
    return (this.index?.entries ?? []).filter((e) => e.cwd).map((e) => e.cwd!)
  }

  /** Node ids of an ssh project's cached file — the slice of the agent-status mirror its host
   *  receives (see remote-status-push.ts). Empty when the project isn't an ssh entry. */
  sshProjectNodeIds(projectId: string): Set<string> {
    const e = this.index?.entries.find((x) => x.id === projectId && x.ssh)
    return new Set((e?.cache?.nodes ?? []).map((n) => n.id))
  }

  /** The SSH project id a node belongs to, or undefined for a local/inline node (deterministic
   *  approvals: a match routes the answer-file write to the REMOTE host over that project's
   *  ControlMaster; undefined ⇒ write on the LOCAL fs). Scans the ssh entries' cached node lists;
   *  a not-yet-cached remote node resolves undefined (fail-open to a local write that harmlessly
   *  never matches a remote poll). */
  sshProjectIdForNode(nodeId: string): string | undefined {
    for (const e of this.index?.entries ?? []) {
      if (!e.ssh) continue
      if ((e.cache?.nodes ?? []).some((n) => n.id === nodeId)) return e.id
    }
    return undefined
  }

  /**
   * Resolve a node's human display title (what the canvas header / sessions sidebar shows) from the
   * last-persisted workspace, across all three entry kinds: inline canvases (`e.project.nodes`), ssh
   * caches (`e.cache.nodes`), and local folder refs (the last content we wrote to their
   * `project.json`, held in `lastWritten`). Sync + in-memory (no disk read). Returns undefined when
   * the node isn't found or carries no non-empty title.
   *
   * Chosen as the mobile-push `nodeTitle` source (over the agent-status mirror) because:
   *  - the mirror's `sessionTitle` field is declared but NEVER emitted by any normalizer — recording
   *    it would record nothing;
   *  - the OS-notification title is formatted in the RENDERER and reaches main already-composed
   *    (`app:notify`), so main keeps no nodeId→title map of its own;
   *  - the persisted node title here is the exact canvas/sidebar name and is refreshed on every
   *    debounced save (which commits the ACTIVE project's live nodes first — see Canvas `persist()`),
   *    so it lags a rename only by the save debounce. Freshness caveat: a brand-new node not yet
   *    saved, or a rename inside that debounce window, resolves to undefined and the field is simply
   *    omitted — acceptable for an optional alert-title enrichment.
   */
  /**
   * The persisted node record for a node id (first project that has it), or undefined. The
   * session-name sweep needs more than the title — `accountId` (managed Claude accounts scope the
   * transcript root) and `titleAuto` (a hand-renamed node must not be overwritten). Same scan as
   * `getNodeTitle`, which now delegates here.
   */
  getNode(nodeId: string): CanvasNodeState | undefined {
    for (const e of this.index?.entries ?? []) {
      let nodes: CanvasNodeState[] | undefined
      if (e.project) nodes = e.project.nodes
      else if (e.cache) nodes = e.cache.nodes
      else if (e.cwd) {
        const raw = this.lastWritten.get(projectFilePath(e.cwd))
        if (raw) {
          try {
            nodes = (JSON.parse(raw) as ProjectFileV1).nodes
          } catch {
            // Corrupt cached content: skip this entry, keep scanning the others.
          }
        }
      }
      const node = nodes?.find((n) => n.id === nodeId)
      if (node) return node
    }
    return undefined
  }

  /**
   * Every persisted canvas as {id, nodes, bridges} — the raw material the Server Edition derives
   * its context-link map from (src/server/context-link.ts). Same three-entry-kind scan as
   * `getNode`, but whole projects rather than one node, because a link edge only means anything
   * alongside the nodes it joins.
   *
   * Sync + in-memory: it reads the loaded index and the last content written to each local ref's
   * project.json, so a project whose file has never been read this run is simply absent (it
   * appears after the next load/save, which is also what re-derives the map).
   */
  persistedCanvases(): Array<{ id: string; nodes: CanvasNodeState[]; bridges?: BridgeLink[] }> {
    const out: Array<{ id: string; nodes: CanvasNodeState[]; bridges?: BridgeLink[] }> = []
    for (const e of this.index?.entries ?? []) {
      if (e.project) {
        out.push({ id: e.project.id, nodes: e.project.nodes, bridges: e.project.bridges })
      } else if (e.cache) {
        out.push({ id: e.id, nodes: e.cache.nodes, bridges: e.cache.bridges })
      } else if (e.cwd) {
        const raw = this.lastWritten.get(projectFilePath(e.cwd))
        if (!raw) continue
        try {
          const f = JSON.parse(raw) as ProjectFileV1
          // Node cwds are stored portable ("./sub"); resolve them the way `fileToProject` does, so
          // a caller sees the same absolute paths the desktop's renderer would have handed it.
          // Keyed by the ENTRY id — the map's consumers look projects up by the id the renderer
          // knows, which is never the git-shared file's (it no longer has one).
          out.push({ id: e.id, nodes: resolveNodes(f.nodes, e.cwd), bridges: f.bridges })
        } catch {
          // Corrupt cached content: skip this entry, keep scanning the others.
        }
      }
    }
    return out
  }

  /**
   * Does this project exist on THIS machine, and is it SSH? The `--project` targeting gate
   * (issue #338, src/main/project-grants.ts) asks main's own store — never the request — before
   * any targeted open is forwarded. Same three-entry-kind scan and same id semantics as
   * `persistedCanvases` (inline keyed by `e.project.id`, ssh/local refs by `e.id`), because the
   * projectId a grant names there must resolve to the same project here. `undefined` = unknown
   * to this store (deleted, invented, another machine's) — the gate fails closed on it.
   */
  projectMetaFor(projectId: string): { ssh: boolean } | undefined {
    if (!projectId) return undefined
    for (const e of this.index?.entries ?? []) {
      if (e.project) {
        if (e.project.id === projectId) return { ssh: !!e.project.ssh }
        continue
      }
      if (e.id === projectId) return { ssh: !!e.ssh }
    }
    return undefined
  }

  /**
   * The capability view of one project, for `projectCapabilityGrantedFor`: the STRICT capability
   * flags from the shared file (`readProjectCapabilities` — literal `true`, known keys only) plus
   * this machine's recorded answers from the INDEX ENTRY. Same three-entry-kind scan and same id
   * semantics as `persistedCanvases`, because the projectId a delivery resolved there must look up
   * the same project here.
   *
   * The ack deliberately never comes from the parsed file: a repo hand-carrying `capabilityAck`
   * is a forgery attempt (workspace-files.ts says the same at the fileToProject boundary), and
   * `agent-messaging-switch.test.ts` drives that exact file through a real store. An inline entry
   * stores the Project verbatim (ack included — splitWorkspace gives it no localState), so there
   * the project object IS the entry-local record.
   */
  capabilityProjectFor(
    projectId: string
  ): (Partial<Record<ProjectCapability, true>> & { capabilityAck?: CapabilityAckMap }) | undefined {
    for (const e of this.index?.entries ?? []) {
      if (e.project) {
        if (e.project.id !== projectId) continue
        return {
          ...readProjectCapabilities(e.project),
          ...(e.project.capabilityAck ? { capabilityAck: e.project.capabilityAck } : {})
        }
      }
      if (e.id !== projectId) continue
      const ack = e.capabilityAck ? { capabilityAck: e.capabilityAck } : {}
      if (e.cache) return { ...readProjectCapabilities(e.cache), ...ack }
      if (e.cwd) {
        const raw = this.lastWritten.get(projectFilePath(e.cwd))
        if (!raw) return { ...ack } // file never read this run: no flag known, so nothing grants
        try {
          return { ...readProjectCapabilities(JSON.parse(raw)), ...ack }
        } catch {
          return { ...ack } // corrupt file: fail closed, like every other reader of this cache
        }
      }
      return undefined
    }
    return undefined
  }

  getNodeTitle(nodeId: string): string | undefined {
    for (const e of this.index?.entries ?? []) {
      let nodes: CanvasNodeState[] | undefined
      if (e.project) nodes = e.project.nodes
      else if (e.cache) nodes = e.cache.nodes
      else if (e.cwd) {
        const raw = this.lastWritten.get(projectFilePath(e.cwd))
        if (raw) {
          try {
            nodes = (JSON.parse(raw) as ProjectFileV1).nodes
          } catch {
            // Corrupt cached content: skip this entry, keep scanning the others.
          }
        }
      }
      const node = nodes?.find((n) => n.id === nodeId)
      if (node) {
        const title = node.title?.trim()
        return title ? title : undefined
      }
    }
    return undefined
  }

  /** A throttled trailing mirror write was acked but later dropped (connection died inside the
   *  throttle window): re-owe it so the next save retries. Wired from makeRemoteWorkspaceIO. */
  markUnmirrored(projectId: string): void {
    this.unmirrored.add(projectId)
  }

  /** Remembers a project.json payload handed to `remoteIO.write` (see `recentMirrorHashes`).
   *  Called only on an acked write: an ack may be optimistic (the throttle's trailing write), but
   *  a read can only ever return these bytes if they actually landed — so a dropped trailing
   *  write leaves a harmless unused hash, never a false echo. */
  private recordMirrored(projectId: string, content: string): void {
    const hashes = this.recentMirrorHashes.get(projectId) ?? []
    hashes.push(contentHash(content))
    while (hashes.length > RECENT_MIRROR_CAP) hashes.shift()
    this.recentMirrorHashes.set(projectId, hashes)
  }

  /** True when `content` is byte-identical to a payload this store recently mirrored — a
   *  self-write echo, never an external change. Exact bytes only: any other writer's edit
   *  (a phone append, another machine's save with its own savedAt) hashes differently. */
  private isOwnMirrorContent(projectId: string, content: string): boolean {
    return this.recentMirrorHashes.get(projectId)?.includes(contentHash(content)) ?? false
  }

  /**
   * Registers a PHONE-STARTED session as a node in a LOCAL ref project's file — the host side of
   * the relay `projects.registerNode` verb. v1 scope: local-cwd projects only (an ssh ref's file
   * lives on another machine; the phone reaches that one over its own SSH path).
   *
   * The renderer must adopt the node onto the live canvas, so the change IS announced — but
   * explicitly, via workspaceExternalChange, not by leaving `lastWritten` stale so the watcher
   * fires. That side channel only worked while every self-write matched byte-for-byte, and it made
   * an OUR-write indistinguishable from a teammate's; the store's own caches (getNode,
   * persistedCanvases) were left holding a file they knew was outdated. Record the write like any
   * other and send the notification ourselves.
   *
   * It runs ON `saveChain`, like save(): this is a read-modify-write of the SAME project.json a save
   * rewrites whole, and off the chain the two interleave — the phone registers its node, an autosave
   * that read the file first lands last, and the node the phone was told about ("true", card shown)
   * never existed. Queued, the append reads what the save just wrote and the save cannot un-write it.
   */
  appendRemoteNode(
    projectId: string,
    input: RemoteNodeInput,
    now = new Date(),
    accountColor?: string
  ): Promise<boolean> {
    const run = this.saveChain.then(() =>
      this.appendRemoteNodeNow(projectId, input, now, accountColor)
    )
    this.saveChain = run.catch(() => {})
    return run
  }

  private async appendRemoteNodeNow(
    projectId: string,
    input: RemoteNodeInput,
    now: Date,
    accountColor?: string
  ): Promise<boolean> {
    const e = this.index?.entries.find((x) => x.id === projectId && x.cwd)
    if (!e?.cwd) return false
    const file = projectFilePath(e.cwd)
    let raw: string
    try {
      raw = await fs.readFile(file, 'utf-8')
    } catch {
      return false
    }
    const updated = appendProjectNode(raw, input, now, accountColor)
    if (updated === null) return false
    try {
      await writeAtomic(file, updated)
    } catch {
      return false
    }
    this.lastWritten.set(file, updated)
    // appendProjectNode only returns a string it produced from a valid ProjectFileV1, so this parse
    // cannot realistically fail — but a throw here would turn a landed write into a `false`.
    try {
      const parsed = JSON.parse(updated) as ProjectFileV1
      this.revs.set(e.id, parsed.rev)
      platform().broadcast(
        IPC.workspaceExternalChange,
        fileToProject(parsed, {
          id: e.id,
          cwd: e.cwd,
          closed: e.closed,
          closedAt: e.closedAt,
          viewport: e.viewport,
          defaultAccountId: e.defaultAccountId,
          breadcrumbs: e.breadcrumbs,
          closedSessions: e.closedSessions,
          capabilityAck: e.capabilityAck,
          localExec: e.localExec
        })
      )
    } catch { /* the file is written and cached; the next load/poll surfaces the node */ }
    return true
  }

  /**
   * Takes a DESTROYED session's node off its project's canvas — the host side of the relay
   * `pty.destroy` verb ("End session" on the phone), run AFTER the tmux kill so the file only ever
   * loses a node whose session is already gone. Node ids are globally unique (they are tmux
   * session names), so the node is looked up by SCAN across the local ref projects — the phone
   * addresses sessions by streamId→nodeId and knows no projectId. Same v1 scope and the same
   * announce-and-record discipline as `appendRemoteNode` above, and queued on `saveChain` for the
   * same read-modify-write reason. A node found in NO file is an answer (an unregistered phone
   * session, an inline project), not an error: the caller treats false as "nothing to remove".
   */
  removeRemoteNode(nodeId: string, now = new Date()): Promise<boolean> {
    const run = this.saveChain.then(() => this.removeRemoteNodeNow(nodeId, now))
    this.saveChain = run.catch(() => {})
    return run
  }

  private async removeRemoteNodeNow(nodeId: string, now: Date): Promise<boolean> {
    for (const e of this.index?.entries ?? []) {
      // Local ref projects only, like appendRemoteNode: an ssh ref's file lives on another
      // machine (and a relay `pty.attach` only ever reaches THIS machine's tmux anyway).
      if (!e.cwd || e.ssh) continue
      const file = projectFilePath(e.cwd)
      let raw: string
      try {
        raw = await fs.readFile(file, 'utf-8')
      } catch {
        continue
      }
      const updated = removeProjectNode(raw, nodeId, now)
      if (updated === null) continue // not in this project (or unreadable file) — keep looking
      try {
        await writeAtomic(file, updated)
      } catch {
        return false
      }
      this.lastWritten.set(file, updated)
      try {
        const parsed = JSON.parse(updated) as ProjectFileV1
        this.revs.set(e.id, parsed.rev)
        platform().broadcast(
          IPC.workspaceExternalChange,
          fileToProject(parsed, {
            id: e.id,
            cwd: e.cwd,
            closed: e.closed,
            closedAt: e.closedAt,
            viewport: e.viewport,
            defaultAccountId: e.defaultAccountId,
            breadcrumbs: e.breadcrumbs,
            closedSessions: e.closedSessions,
            capabilityAck: e.capabilityAck,
            localExec: e.localExec
          })
        )
      } catch { /* the file is written and cached; the next load/poll drops the node */ }
      return true
    }
    return false
  }

  /**
   * The mirror write for one ssh entry, with the server's own additions rescued first.
   *
   * Never write the server file without looking at it: between two of our saves the OTHER writer of
   * this same file (the mobile companion, appending a session it just started) may have added a node
   * that exists nowhere else. Serializing our cache over it is a silent, permanent delete of a live
   * session — the canvas node is gone on both machines while the tmux session keeps running.
   */
  private async mirrorSshCache(e: IndexEntryV3): Promise<void> {
    if (!e.ssh || !e.cache || !this.remoteIO) return
    const rescued = await this.rescueRemoteNodes(e)
    // AFTER the rescue: it replaces e.cache with the merged copy, which is what must land.
    const content = serializeProjectFile(e.cache)
    const ok = await this.remoteIO.write(e.id, e.ssh, content)
    if (ok) {
      this.recordMirrored(e.id, content)
      this.unmirrored.delete(e.id)
      // The server now holds exactly our cache, deletions included — nothing left to remember.
      this.clearedNodes.delete(e.id)
    } else {
      this.unmirrored.add(e.id)
    }
    // A rescued node is live on the server and missing from the live canvas: say so now, the same
    // way the reconcile path does, instead of leaving the user to wait for the next poll.
    if (rescued) platform().broadcast(IPC.workspaceExternalChange, rescued)
  }

  /**
   * Reads the server file and unions in the session nodes it has that our cache lacks. Returns the
   * merged project to announce, or null when nothing moved — which includes every case where the
   * read could not answer (error, absent, corrupt) and the DIFFERENT-lineage case: a failed read is
   * never evidence of absence, so it changes nothing and the caller writes exactly what it would
   * have written before. Which lineage wins is `reconcileSsh`'s call alone; merging a stranger's
   * nodes into our canvas would not be a rescue.
   */
  private async rescueRemoteNodes(e: IndexEntryV3): Promise<Project | null> {
    if (!e.ssh || !e.cache || !this.remoteIO) return null
    const res = await this.remoteIO.read(e.id, e.ssh)
    if (res.status !== 'ok') return null
    let remote: ProjectFileV1 | null = null
    try {
      const parsed = JSON.parse(res.content) as ProjectFileV1
      if (parsed?.version === 1 && Array.isArray(parsed.nodes)) remote = parsed
    } catch { /* corrupt server file — our cache is the only readable copy; it is written as-is */ }
    if (!remote || remote.id !== e.cache.id) return null
    const rescued = this.rescuableNodes(e.id, e.cache.nodes, remote.nodes)
    if (!rescued.length) return null
    // The merged set must outrank both sides, or the next reconcile could rev-decide it away.
    e.cache = {
      ...e.cache,
      nodes: [...e.cache.nodes, ...rescued],
      rev: Math.max(e.cache.rev, remote.rev) + 1
    }
    this.revs.set(e.id, e.cache.rev)
    return fileToProject(e.cache, {
      id: e.id, ssh: e.ssh, closed: e.closed, closedAt: e.closedAt,
      viewport: e.viewport, defaultAccountId: e.defaultAccountId, breadcrumbs: e.breadcrumbs,
      closedSessions: e.closedSessions,
      capabilityAck: e.capabilityAck, localExec: e.localExec
    })
  }

  /** The remote-only nodes worth rescuing: on the server, absent from `ours`, and NOT among the ones
   *  we deliberately deleted (see `clearedNodes` — those must propagate, not resurrect). */
  private rescuableNodes(
    projectId: string,
    ours: CanvasNodeState[],
    theirs: CanvasNodeState[]
  ): CanvasNodeState[] {
    const cleared = this.clearedNodes.get(projectId)
    const missing = nodesMissingFrom(ours, theirs)
    return cleared ? missing.filter((n) => !cleared.has(n.id)) : missing
  }

  /** Record the nodes a save removed from an ssh cache (see `clearedNodes`). */
  private recordLocalDeletions(
    projectId: string,
    before: CanvasNodeState[] | undefined,
    after: CanvasNodeState[]
  ): void {
    if (!before?.length) return
    const kept = new Set(after.map((n) => n.id))
    const gone = before.filter((n) => !kept.has(n.id))
    if (!gone.length) return
    const cleared = this.clearedNodes.get(projectId) ?? new Set<string>()
    for (const n of gone) cleared.add(n.id)
    this.clearedNodes.set(projectId, cleared)
  }

  /**
   * The ONE place that decides who wins between an ssh entry's cache and the server's
   * .nodeterm/project.json. Rules, in order:
   * - read ERROR → decide nothing (a failed read is never evidence of absence): stay
   *   un-reconciled, mirror stays owed, no write.
   * - the server holds bytes THIS store recently mirrored (`recentMirrorHashes`) → a self-write
   *   echo, not an external change: the cache stands, nothing is adopted or merged, nothing is
   *   broadcast (no conflict bar); an owed mirror still pushes.
   * - absent/corrupt remote → push our cache up.
   * - same lineage (ids match): higher remote rev wins (rev is this file's save counter) —
   *   including an emptier remote (the user really cleared their canvas elsewhere).
   * - DIFFERENT lineage (the server file belongs to another project id — a re-added folder, a
   *   second machine, a git checkout): an empty side never beats a populated one, regardless of
   *   rev. Adoption re-keys the file to OUR entry id (node ids — tmux session names — are kept,
   *   so the terminals reattach); a push outbids the losing lineage's rev so it stays beaten.
   * Returns the adopted project (for the caller to surface) or null when our cache stood/pushed.
   */
  private async reconcileSsh(e: IndexEntryV3, pushIfStanding = true): Promise<Project | null> {
    if (!e.ssh || !this.remoteIO) return null
    const res = await this.remoteIO.read(e.id, e.ssh)
    if (res.status === 'error') {
      this.unmirrored.add(e.id)
      return null
    }
    let remote: ProjectFileV1 | null = null
    if (res.status === 'ok') {
      try {
        const parsed = JSON.parse(res.content) as ProjectFileV1
        if (parsed?.version === 1 && Array.isArray(parsed.nodes)) remote = parsed
      } catch { /* corrupt remote file → treat as absent, our cache pushes up */ }
      // Self-write echo: the server holds bytes this store itself mirrored (a poll reading right
      // behind a save's write, or an OLDER own write the 5 s throttle has not yet replaced).
      // Nothing foreign is there to adopt, merge or announce — decide exactly as if the remote
      // said nothing new: the cache stands, and an owed mirror still pushes below. Matching by
      // exact bytes keeps the genuine-external-edit path untouched (any other writer's file —
      // a phone append, another machine's save — hashes differently).
      if (remote && this.isOwnMirrorContent(e.id, res.content)) remote = null
    }
    this.reconciled.add(e.id)
    const cacheRev = e.cache?.rev ?? 0
    const cacheNodes = e.cache?.nodes.length ?? 0
    const sameLineage = !e.cache || !remote || remote.id === e.cache.id
    const remoteWins =
      remote !== null &&
      (sameLineage
        ? remote.rev > cacheRev
        : (cacheNodes === 0 && remote.nodes.length > 0) ||
          (remote.nodes.length > 0 && remote.rev > cacheRev))
    // Whichever side wins, rescue the OTHER side's session nodes it doesn't have. The two writers of a
    // same-lineage file (this desktop's throttled mirror + the mobile companion's direct append) are
    // ordered only by a single `rev` counter, and that counter DRIFTS: a dropped/forgotten final mirror
    // write or an offline edit leaves the server behind our cache, so the phone's append (rev = the
    // server file + 1) lands BELOW our cache rev and a rev-only decision silently discards it — the
    // field bug where a phone-created SSH session never reached the desktop canvas.
    //
    // The guard is same-lineage + a POPULATED REMOTE, and deliberately no longer "our cache has
    // nodes too". That half read an empty cache with a drifted rev as a deliberate clear and pushed
    // the emptiness up — but an empty desktop canvas is precisely where a phone-started session is
    // the ONLY node in the file, so it deleted the very thing this rescue exists to save. The
    // deliberate clear is now told apart by WHAT the cache is missing rather than by how much:
    // `clearedNodes` holds the ids this run removed, and `rescuableNodes` never brings those back,
    // so a real clear still travels. The remote half of the guard is untouched: an empty REMOTE with
    // a higher rev is the user clearing the canvas on another machine and still wins by rev.
    const mergeable = sameLineage && !!e.cache && !!remote && remote.nodes.length > 0
    if (remote && remoteWins) {
      let adopted = remote.id === e.id ? remote : { ...remote, id: e.id }
      let owed = false
      if (mergeable) {
        const rescued = nodesMissingFrom(adopted.nodes, e.cache!.nodes) // our local-only additions
        if (rescued.length) {
          adopted = { ...adopted, nodes: [...adopted.nodes, ...rescued], rev: Math.max(adopted.rev, cacheRev) + 1 }
          owed = true // the server file lacks the merged-in nodes → owe a mirror write
        }
      }
      e.cache = adopted
      e.name = adopted.name
      e.color = adopted.color
      this.revs.set(e.id, adopted.rev)
      // The remote won on rev, so its content — including anything we had deleted — is the truth
      // now: our pending deletions are settled (overruled) and must not haunt a later rescue.
      this.clearedNodes.delete(e.id)
      if (owed) this.unmirrored.add(e.id)
      else this.unmirrored.delete(e.id) // pure adopt: the server copy IS the truth now — nothing owed
      return fileToProject(adopted, {
        id: e.id, ssh: e.ssh, closed: e.closed, closedAt: e.closedAt,
        viewport: e.viewport, defaultAccountId: e.defaultAccountId, breadcrumbs: e.breadcrumbs,
        closedSessions: e.closedSessions,
        capabilityAck: e.capabilityAck, localExec: e.localExec
      })
    }
    // Our cache stood. Before it clobbers the server, merge in any remote-only session nodes (the
    // phone's drifted append) so the push carries them instead of erasing them.
    let merged: Project | null = null
    if (mergeable && e.cache && remote) {
      const rescued = this.rescuableNodes(e.id, e.cache.nodes, remote.nodes)
      if (rescued.length) {
        e.cache = { ...e.cache, nodes: [...e.cache.nodes, ...rescued], rev: Math.max(cacheRev, remote.rev) + 1 }
        this.revs.set(e.id, e.cache.rev)
        this.unmirrored.add(e.id) // the merged set must land on the server
        merged = fileToProject(e.cache, {
          id: e.id, ssh: e.ssh, closed: e.closed, closedAt: e.closedAt,
          viewport: e.viewport, defaultAccountId: e.defaultAccountId, breadcrumbs: e.breadcrumbs,
          closedSessions: e.closedSessions,
          capabilityAck: e.capabilityAck, localExec: e.localExec
        })
      }
    }
    if (e.cache && (pushIfStanding || this.unmirrored.has(e.id))) {
      // Our cache stood. If it just beat a FOREIGN lineage on the merits (not on rev), outbid that
      // lineage's rev so a later rev-only reconcile can't resurrect the losing side.
      if (remote && !sameLineage && remote.rev >= e.cache.rev) {
        e.cache.rev = remote.rev + 1
        this.revs.set(e.id, e.cache.rev)
      }
      // Push-up runs with the master just up, but record the outcome anyway: a failed write
      // (connection flapped) stays owed so the next save retries it.
      const content = serializeProjectFile(e.cache)
      const ok = await this.remoteIO.write(e.id, e.ssh, content)
      if (ok) {
        this.recordMirrored(e.id, content)
        this.unmirrored.delete(e.id)
        this.clearedNodes.delete(e.id) // the server holds our deletions now
      } else this.unmirrored.add(e.id)
    }
    // Surface a rescued merge to the renderer even on a read-only poll (pushIfStanding:false) — the
    // whole point is the phone's session reaching the live desktop canvas without a reconnect.
    return merged
  }
}

/** The nodes of `from` whose id is NOT present in `base` — the additions one writer has that the
 *  other lacks. Used to UNION a same-lineage divergence so neither writer's session nodes are lost
 *  when the shared `rev` counter can't order the two writes (see reconcileSsh). */
function nodesMissingFrom(base: CanvasNodeState[], from: CanvasNodeState[]): CanvasNodeState[] {
  const have = new Set(base.map((n) => n.id))
  return from.filter((n) => !have.has(n.id))
}

/** A labeled grey placeholder for a ref whose file can't be read right now. */
function unavailableProject(e: { id: string; name: string; color: string; closed?: boolean; closedAt?: number; cwd?: string; ssh?: Project['ssh'] }): Project {
  return {
    id: e.id, name: e.name, color: e.color,
    viewport: { x: 0, y: 0, zoom: 1 }, nodes: [],
    ...(e.cwd ? { cwd: e.cwd } : {}), ...(e.ssh ? { ssh: e.ssh } : {}),
    ...(e.closed ? { closed: true } : {}),
    ...(e.closedAt ? { closedAt: e.closedAt } : {}),
    unavailable: true
  }
}

/** Normalize legacy on-disk shapes (v1 single canvas, v2 projects) into a v2-shaped workspace. */
function migrateLegacy(parsed: unknown): Workspace {
  const ws = parsed as Partial<Workspace> & Partial<WorkspaceV1>
  if (ws?.version === 2 && Array.isArray(ws.projects)) {
    const active = ws.projects.some((p) => p.id === ws.activeProjectId)
      ? (ws.activeProjectId as string)
      : (ws.projects[0]?.id ?? '')
    // A pre-v3 workspace.json is hand-editable input too, same as an inline v3 entry — and this
    // path skips loadV3 entirely (the first save() is what actually migrates it), so without this
    // a malformed `closedSessions` reaches `mergeClosedHistory`'s `for...of` before that save ever
    // runs and takes the sidebar render down on the very first load.
    const projects = ws.projects.map((p) => {
      const history = sanitizeLoadedClosedSessions(p.closedSessions)
      if (history === p.closedSessions) return p
      const { closedSessions: _dropped, ...rest } = p
      return history ? { ...rest, closedSessions: history } : rest
    })
    return { version: 2, activeProjectId: active, projects }
  }
  if (ws?.version === 1 && Array.isArray(ws.nodes)) {
    return {
      version: 2,
      activeProjectId: DEFAULT_PROJECT_ID,
      projects: [{
        id: DEFAULT_PROJECT_ID, name: 'Project 1', color: '#7aa2f7',
        viewport: ws.viewport ?? { x: 0, y: 0, zoom: 1 }, nodes: ws.nodes
      }]
    }
  }
  return EMPTY_WORKSPACE
}

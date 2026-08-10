import { promises as fs } from 'fs'
import { randomUUID } from 'node:crypto'
import path from 'path'
import { IPC } from '../shared/ipc'
import { platform } from './platform'
import {
  DEFAULT_PROJECT_ID, EMPTY_WORKSPACE,
  type BridgeLink, type CanvasNodeState, type Project, type Workspace, type WorkspaceV1
} from '../shared/types'
import {
  PROJECT_DIR, PROJECT_FILE, fileToProject, projectToFile, resolveNodes, sameProjectContent,
  serializeProjectFile, splitWorkspace, validKanban,
  type IndexEntryV3, type ProjectFileV1, type WorkspaceIndexV3
} from './workspace-files'
import { hoistLegacyNodeExec, type LocalNodeExecMap } from '../shared/node-exec'
import { appendProjectNode, type RemoteNodeInput } from './project-node-append'

/** Checked remote read: `absent` (no file — safe to push our cache) is NOT `error` (connection
 *  down / ssh failure — a failed read is never evidence of absence, so nothing may be pushed). */
export type RemoteReadResult = { status: 'ok'; content: string } | { status: 'absent' } | { status: 'error' }

/** Remote file access for SSH projects (implemented in src/main over SshFs — src/core stays electron-free). */
export interface RemoteWorkspaceIO {
  read(projectId: string, ssh: NonNullable<Project['ssh']>): Promise<RemoteReadResult>
  write(projectId: string, ssh: NonNullable<Project['ssh']>, content: string): Promise<boolean>
}

const projectFilePath = (cwd: string): string => path.join(cwd, PROJECT_DIR, PROJECT_FILE)

/** A parsed project file together with the exact bytes it was parsed from. `lastWritten` must
 *  record `raw` — see the field it caches. */
interface ProjectFileRead {
  file: ProjectFileV1
  raw: string
}

let tmpSeq = 0
async function writeAtomic(filePath: string, content: string): Promise<void> {
  // Unique per write: writers that bypass each other's queue (a second app instance, the SSH
  // poll's index write) must never share a tmp file — interleaved writes into one shared tmp
  // published spliced JSON under the atomic rename.
  const tmp = `${filePath}.${process.pid}.${++tmpSeq}.tmp`
  await fs.writeFile(tmp, content, 'utf-8')
  await fs.rename(tmp, filePath)
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
          await fs.rename(this.indexPath, path.join(platform().userDataDir, backup))
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
    for (const entry of index.entries) entry.localApprovalId ||= randomUUID()
    this.index = index
    const projects: Project[] = []
    for (const e of index.entries) {
      if (e.project) {
        // Inline projects are stored verbatim in the index (no fileToProject pass), so apply the
        // same kanban shape guard here — a v1/hand-edited board would otherwise crash the render.
        const { kanban, ...rest } = e.project
        projects.push(validKanban(kanban) ? e.project : rest)
      } else if (e.cwd) {
        const read = await this.readProjectFile(e.cwd, sideline)
        if (read) {
          const p = read.file
          this.revs.set(p.id, p.rev)
          this.lastWritten.set(projectFilePath(e.cwd), read.raw)
          projects.push(
            fileToProject(p, { cwd: e.cwd, closed: e.closed, localExec: this.execOverlay(e, p) })
          )
        } else {
          this.deferExecMigration(e)
          projects.push(unavailableProject(e))
        }
      } else if (e.ssh) {
        if (e.cache) {
          this.revs.set(e.id, e.cache.rev)
          projects.push(
            fileToProject(e.cache, {
              ssh: e.ssh,
              closed: e.closed,
              localExec: this.execOverlay(e, e.cache)
            })
          )
        } else {
          this.deferExecMigration(e)
          projects.push(unavailableProject(e))
        }
      }
    }
    const active = projects.some((p) => p.id === index.activeProjectId && !p.unavailable)
      ? index.activeProjectId
      : (projects.find((p) => !p.closed && !p.unavailable)?.id ?? '')
    return { version: 2, activeProjectId: active, projects }
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
      if (parsed?.version === 1 && typeof parsed.id === 'string' && Array.isArray(parsed.nodes)) return { file: parsed, raw }
      // parses but isn't a ProjectFileV1 — sideline it too, so a later save can't overwrite the only copy.
    } catch { /* not JSON — sideline below */ }
    if (sideline) {
      try {
        await fs.rename(file, `${file}.corrupt-${Date.now()}`)
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
      }
    }

    for (const [cwd, candidate] of files) {
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
      const next: ProjectFileV1 = { ...candidate, rev: (this.revs.get(candidate.id) ?? 0) + 1 }
      const content = serializeProjectFile(next)
      try {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await writeAtomic(file, content)
        this.lastWritten.set(file, content)
        this.revs.set(next.id, next.rev)
      } catch { /* folder gone (unmounted disk): the entry simply stays stale → unavailable next load */ }
    }

    // ssh caches: bump rev on change so a later remote write can win; mirror write in Task 8.
    for (const e of index.entries) {
      if (!e.ssh || !e.cache) continue
      const prevRev = this.revs.get(e.id) ?? 0
      const changedSinceLoad = !this.index?.entries.some(
        (old) => old.id === e.id && old.cache && sameProjectContent(old.cache, e.cache!)
      )
      e.cache.rev = changedSinceLoad ? prevRev + 1 : prevRev
      this.revs.set(e.id, e.cache.rev)
      if (!this.remoteIO) continue
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
      // KNOWN GAP (concurrent write, follow-up): this is a BLIND mirror write — it does not re-read
      // the server first. While the desktop is connected, the connected-project poll
      // (refreshSshProject, ~15s) reconciles + rescues a phone-appended node (reconcileSsh above), but
      // a local edit whose 5s-throttled mirror write fires INSIDE that poll window overwrites the
      // server before the poll adopts the append — the phone's session is lost until it is re-created.
      // Closing it means routing this write through reconcileSsh (read → union → write) so it can
      // never clobber a remote-only node; deferred here because that adds an SSH round-trip to every
      // changed save (the poll was the deliberate cheaper alternative). The connect-LATER path — the
      // reported field bug — is fully fixed by the union in reconcileSsh.
      if (changedSinceLoad || this.unmirrored.has(e.id)) {
        const ok = await this.remoteIO.write(e.id, e.ssh, serializeProjectFile(e.cache))
        if (ok) this.unmirrored.delete(e.id)
        else this.unmirrored.add(e.id)
      }
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

  async probeFolder(folder: string): Promise<Project | null> {
    const read = await this.readProjectFile(folder, false)
    // No `localExec`: this folder is being ADOPTED (its project.json may have been cloned from
    // anywhere), so its nodes come up with no custom shell and no extra ssh args — the safe
    // defaults. Only values this machine typed itself are ever restored (@shared/node-exec).
    return read ? fileToProject(read.file, { cwd: folder }) : null
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
    this.revs.set(read.file.id, read.file.rev)
    this.lastWritten.set(projectFilePath(e.cwd), read.raw)
    return fileToProject(read.file, { cwd: e.cwd, closed: e.closed, localExec: e.localExec })
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
   */
  async refreshSshProject(projectId: string, opts?: { pushIfStanding?: boolean }): Promise<Project | null> {
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
        out.push({ id: e.cache.id, nodes: e.cache.nodes, bridges: e.cache.bridges })
      } else if (e.cwd) {
        const raw = this.lastWritten.get(projectFilePath(e.cwd))
        if (!raw) continue
        try {
          const f = JSON.parse(raw) as ProjectFileV1
          // Node cwds are stored portable ("./sub"); resolve them the way `fileToProject` does, so
          // a caller sees the same absolute paths the desktop's renderer would have handed it.
          out.push({ id: f.id, nodes: resolveNodes(f.nodes, e.cwd), bridges: f.bridges })
        } catch {
          // Corrupt cached content: skip this entry, keep scanning the others.
        }
      }
    }
    return out
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
   */
  async appendRemoteNode(projectId: string, input: RemoteNodeInput, now = new Date()): Promise<boolean> {
    const e = this.index?.entries.find((x) => x.id === projectId && x.cwd)
    if (!e?.cwd) return false
    const file = projectFilePath(e.cwd)
    let raw: string
    try {
      raw = await fs.readFile(file, 'utf-8')
    } catch {
      return false
    }
    const updated = appendProjectNode(raw, input, now)
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
      this.revs.set(parsed.id, parsed.rev)
      platform().broadcast(
        IPC.workspaceExternalChange,
        fileToProject(parsed, { cwd: e.cwd, closed: e.closed, localExec: e.localExec })
      )
    } catch { /* the file is written and cached; the next load/poll surfaces the node */ }
    return true
  }

  /**
   * The ONE place that decides who wins between an ssh entry's cache and the server's
   * .nodeterm/project.json. Rules, in order:
   * - read ERROR → decide nothing (a failed read is never evidence of absence): stay
   *   un-reconciled, mirror stays owed, no write.
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
    // field bug where a phone-created SSH session never reached the desktop canvas. Guarded to
    // same-lineage AND both sides populated, so a deliberate clear on either side (an empty side with a
    // higher rev = "the user cleared their canvas elsewhere") still wins by rev, unchanged.
    const mergeable = sameLineage && !!e.cache && cacheNodes > 0 && !!remote && remote.nodes.length > 0
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
      if (owed) this.unmirrored.add(e.id)
      else this.unmirrored.delete(e.id) // pure adopt: the server copy IS the truth now — nothing owed
      return fileToProject(adopted, { ssh: e.ssh, closed: e.closed, localExec: e.localExec })
    }
    // Our cache stood. Before it clobbers the server, merge in any remote-only session nodes (the
    // phone's drifted append) so the push carries them instead of erasing them.
    let merged: Project | null = null
    if (mergeable && e.cache && remote) {
      const rescued = nodesMissingFrom(e.cache.nodes, remote.nodes)
      if (rescued.length) {
        e.cache = { ...e.cache, nodes: [...e.cache.nodes, ...rescued], rev: Math.max(cacheRev, remote.rev) + 1 }
        this.revs.set(e.id, e.cache.rev)
        this.unmirrored.add(e.id) // the merged set must land on the server
        merged = fileToProject(e.cache, { ssh: e.ssh, closed: e.closed, localExec: e.localExec })
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
      const ok = await this.remoteIO.write(e.id, e.ssh, serializeProjectFile(e.cache))
      if (ok) this.unmirrored.delete(e.id)
      else this.unmirrored.add(e.id)
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
function unavailableProject(e: { id: string; name: string; color: string; closed?: boolean; cwd?: string; ssh?: Project['ssh'] }): Project {
  return {
    id: e.id, name: e.name, color: e.color,
    viewport: { x: 0, y: 0, zoom: 1 }, nodes: [],
    ...(e.cwd ? { cwd: e.cwd } : {}), ...(e.ssh ? { ssh: e.ssh } : {}),
    ...(e.closed ? { closed: true } : {}),
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
    return { version: 2, activeProjectId: active, projects: ws.projects }
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

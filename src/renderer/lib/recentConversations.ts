// "Open recent" — the pure half: where a past conversation should be resumed, and how the list is
// grouped. Canvas executes the plan; nothing here touches a store or the disk.
//
// The rules, each a refusal or a dedupe the feature would be wrong without:
//  - A conversation already held by a node (the node's live hook-fed id, else the id it persisted)
//    is FOCUSED, never resumed twice — two CLIs writing one transcript interleave it.
//  - The session id is re-validated (`canResumeWith` = SAFE_SESSION_ID) before anything is planned:
//    it came off disk, and the plan ends with it on a typed command line.
//  - Resume happens only in a LOCAL folder project whose cwd is exactly the conversation's. The
//    history is this machine's, so an SSH project (its cwd is on the host) and a relay tab (another
//    machine's project) never match. No project → offer to open the folder as one.
//  - The conversation must run under the account whose config dir holds it: a managed/linked
//    account that is gone (or pending, or pinned to a host) refuses rather than resuming under the
//    system login, where the CLI would answer "No conversation found".
import type { ClaudeAccount, Project } from '@shared/types'
import type { CodexAccount } from '@shared/codex-account'
import { canResumeWith } from '@shared/agents/config'
import type { RecentConversation } from '@shared/recent-conversations'

export type ResumePlan =
  | { kind: 'focus'; nodeId: string; projectId: string }
  /** `groupId`: a worktree-bound group frame whose worktree holds the conversation's folder — the
   *  node opens inside it, so it is where the user's branch work already is. */
  | { kind: 'resume'; projectId: string; reopen: boolean; groupId?: string }
  | { kind: 'open-folder'; folder: string }
  | { kind: 'refuse'; reason: string }

export const RESUME_REFUSALS = {
  unsafeId: 'This conversation’s id cannot be put on a command line safely.',
  noCwd: 'The history does not say which folder this conversation ran in.',
  folderGone:
    'The folder this conversation ran in no longer exists (a removed worktree?). Opening it would recreate an empty folder.',
  accountGone: 'The account this conversation belongs to is no longer set up on this machine.'
} as const

/** A node's session as the planner needs it: its id, its project, the ids it could be holding. */
export interface HeldSession {
  nodeId: string
  projectId: string
  /** The ONE session this node holds: the live hook-fed id, else the persisted `agentSessionId`.
   *  Never both — `agentSessionId` is the id minted at launch and nothing rewrites it from hooks,
   *  so after a `/clear` (live id B) the node no longer holds A, and A must stay resumable. Same
   *  rule as `closedHistory` (`live || persisted`). */
  sessionId: string | undefined
}

/** A worktree-bound group frame on a canvas: its project, its id and its worktree folder. */
export interface WorktreeGroupRef {
  projectId: string
  groupId: string
  path: string
}

export interface ResumeContext {
  projects: readonly Pick<Project, 'id' | 'cwd' | 'ssh' | 'closed' | 'unavailable' | 'remote'>[]
  activeProjectId: string
  held: readonly HeldSession[]
  /** Worktree-bound groups (live canvas + stored projects), for a conversation that ran in one. */
  worktreeGroups?: readonly WorktreeGroupRef[]
  claudeAccounts: readonly Pick<ClaudeAccount, 'id' | 'host' | 'pending'>[]
  codexAccounts: readonly Pick<CodexAccount, 'id' | 'host' | 'pending'>[]
}

/** Every node holding a session, from the live canvas (active project) and the stored projects.
 *  The live copy of the active project wins: the store lags it by an autosave. */
export function heldSessions(
  projects: readonly Pick<Project, 'id' | 'nodes'>[],
  activeProjectId: string,
  liveNodes: ReadonlyArray<{ id: string; data?: { agentSessionId?: unknown } }>,
  liveSessionId: (nodeId: string) => string | undefined
): HeldSession[] {
  const out: HeldSession[] = []
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
  for (const n of liveNodes) {
    out.push({
      nodeId: n.id,
      projectId: activeProjectId,
      sessionId: liveSessionId(n.id) || str(n.data?.agentSessionId)
    })
  }
  for (const p of projects) {
    if (p.id === activeProjectId && liveNodes.length) continue
    for (const n of p.nodes ?? []) {
      out.push({
        nodeId: n.id,
        projectId: p.id,
        sessionId: liveSessionId(n.id) || str((n as { agentSessionId?: unknown }).agentSessionId)
      })
    }
  }
  return out
}

/** Every worktree-bound group, live canvas first (the store lags it by an autosave). */
export function worktreeGroups(
  projects: readonly Pick<Project, 'id' | 'nodes'>[],
  activeProjectId: string,
  liveNodes: ReadonlyArray<{ id: string; type?: string; data?: { worktree?: unknown } }>
): WorktreeGroupRef[] {
  const out: WorktreeGroupRef[] = []
  const pathOf = (w: unknown): string | undefined =>
    w && typeof w === 'object' && typeof (w as { path?: unknown }).path === 'string'
      ? (w as { path: string }).path
      : undefined
  for (const n of liveNodes) {
    const p = n.type === 'group' ? pathOf(n.data?.worktree) : undefined
    if (p) out.push({ projectId: activeProjectId, groupId: n.id, path: p })
  }
  for (const pr of projects) {
    if (pr.id === activeProjectId && liveNodes.length) continue
    for (const n of pr.nodes ?? []) {
      const p = n.kind === 'group' ? pathOf((n as { worktree?: unknown }).worktree) : undefined
      if (p) out.push({ projectId: pr.id, groupId: n.id, path: p })
    }
  }
  return out
}

export function findHolder(conv: RecentConversation, held: readonly HeldSession[]): HeldSession | undefined {
  return held.find((h) => h.sessionId === conv.sessionId)
}

function accountUsable(conv: RecentConversation, ctx: ResumeContext): boolean {
  if (!conv.accountId) return true
  if (conv.agentId === 'claude') {
    return ctx.claudeAccounts.some((a) => a.id === conv.accountId && !a.host && !a.pending)
  }
  if (conv.agentId === 'codex') {
    return ctx.codexAccounts.some((a) => a.id === conv.accountId && !a.host && !a.pending)
  }
  // Only claude and codex have managed accounts; anything else naming one is not ours to trust.
  return false
}

const trimSep = (s: string): string => (s.length > 1 ? s.replace(/[/\\]+$/, '') : s)

/** Length of `dir` when it is `target` or an ANCESTOR of it (segment-wise: `/repo` holds
 *  `/repo/packages/app`, never `/repository`), else -1. Longer = more specific. */
export function containsDir(dir: string | undefined, target: string): number {
  if (!dir) return -1
  const d = trimSep(dir)
  const t = trimSep(target)
  if (t === d) return d.length
  const prefixes = /[/\\]$/.test(d) ? [d] : [d + '/', d + '\\']
  return prefixes.some((p) => t.startsWith(p)) ? d.length : -1
}

export function planResume(conv: RecentConversation, ctx: ResumeContext): ResumePlan {
  // A conversation that is already open is where the user is going, whatever else is true.
  const holder = findHolder(conv, ctx.held)
  if (holder) return { kind: 'focus', nodeId: holder.nodeId, projectId: holder.projectId }
  if (!canResumeWith(conv.agentId, conv.sessionId)) return { kind: 'refuse', reason: RESUME_REFUSALS.unsafeId }
  if (!accountUsable(conv, ctx)) return { kind: 'refuse', reason: RESUME_REFUSALS.accountGone }
  if (!conv.cwd) return { kind: 'refuse', reason: RESUME_REFUSALS.noCwd }
  // Only a DEFINITE absence refuses; `unknown` (a stat that failed otherwise) proceeds.
  if (conv.cwdState === 'absent') return { kind: 'refuse', reason: RESUME_REFUSALS.folderGone }
  const cwd = conv.cwd
  // The most specific owner of the folder wins: a worktree-bound group, or the local project whose
  // folder is the conversation's or an ANCESTOR of it (a subfolder like `/repo/packages/app`
  // resumes in the `/repo` project, it does not mint a second project inside the repository).
  const local = ctx.projects.filter((p) => !p.ssh && !p.remote && !p.unavailable)
  const localIds = new Set(local.map((p) => p.id))
  const rank = (p: (typeof local)[number]): number =>
    p.id === ctx.activeProjectId ? 0 : p.closed ? 2 : 1
  let best: { depth: number; projectId: string; groupId?: string; rank: number } | null = null
  const consider = (depth: number, projectId: string, groupId?: string): void => {
    if (depth < 0) return
    const p = local.find((x) => x.id === projectId)!
    const r = rank(p)
    // Deeper wins; at equal depth a group beats its project, then active > open > closed.
    if (
      !best ||
      depth > best.depth ||
      (depth === best.depth && !!groupId && !best.groupId) ||
      (depth === best.depth && !!groupId === !!best.groupId && r < best.rank)
    ) {
      best = { depth, projectId, groupId, rank: r }
    }
  }
  for (const p of local) consider(containsDir(p.cwd, cwd), p.id)
  for (const g of ctx.worktreeGroups ?? []) {
    if (localIds.has(g.projectId)) consider(containsDir(g.path, cwd), g.projectId, g.groupId)
  }
  const pick = best as { depth: number; projectId: string; groupId?: string; rank: number } | null
  if (pick) {
    const project = local.find((p) => p.id === pick.projectId)!
    return {
      kind: 'resume',
      projectId: pick.projectId,
      reopen: !!project.closed,
      ...(pick.groupId ? { groupId: pick.groupId } : {})
    }
  }
  return { kind: 'open-folder', folder: cwd }
}

/** The action a row offers, in words. */
export function resumeActionLabel(plan: ResumePlan, projectName: (id: string) => string): string {
  switch (plan.kind) {
    case 'focus':
      return 'Go to node'
    case 'resume':
      return `Resume in ${projectName(plan.projectId)}`
    case 'open-folder':
      return 'Open folder & resume'
    case 'refuse':
      return 'Cannot resume'
  }
}

export interface RecentFolderGroup {
  /** null = the conversations whose history does not name a folder. */
  cwd: string | null
  items: RecentConversation[]
}

/** Group by folder, groups ordered by their newest conversation, rows newest-first within. */
export function groupRecentByFolder(items: readonly RecentConversation[]): RecentFolderGroup[] {
  const groups = new Map<string, RecentFolderGroup>()
  const sorted = [...items].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  for (const it of sorted) {
    const key = it.cwd ?? '\0'
    let g = groups.get(key)
    if (!g) groups.set(key, (g = { cwd: it.cwd, items: [] }))
    g.items.push(it)
  }
  return [...groups.values()]
}

/** The last path segment, for a compact folder label. */
export function folderLabel(cwd: string | null): string {
  if (!cwd) return 'Unknown folder'
  const segs = cwd.split(/[/\\]+/).filter(Boolean)
  return segs[segs.length - 1] ?? cwd
}

/** The display title, never empty. */
export function recentTitle(conv: RecentConversation): string {
  return conv.title || `Untitled ${conv.agentId} conversation`
}

/** The managed Codex homes this machine may read: local, settled accounts only (a host-pinned
 *  account's home is on that host; a pending one has never logged in). */
export function localCodexAccountIds(accounts: readonly Pick<CodexAccount, 'id' | 'host' | 'pending'>[]): string[] {
  return accounts.filter((a) => a && typeof a.id === 'string' && !a.host && !a.pending).map((a) => a.id)
}

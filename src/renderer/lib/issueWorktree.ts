import type { ReactNode } from 'react'
import type {
  IssueWorktreeBoundGroup,
  IssueWorktreeExisting,
  IssueWorktreeTarget
} from '@shared/issue-worktree'
import { boundGroups, type ScmScopeNode } from '@shared/scm-scope'
import { normWorktreePath } from '@shared/worktree-reconcile'
import type { MenuItem } from '../components/ContextMenu'
import { WORKTREE_NO_CWD_HINT, WORKTREE_SSH_HINT } from './addMenuSpec'
import { groupSizeFor, groupSlot } from './coldOpen'

// The renderer half of "Start with agent in a new worktree" on a GitHub issue card: when the
// action is unavailable (and why), and what the reuse-or-new choice says. The branch/plan rules
// themselves live in `@shared/issue-worktree`.

/** The label every surface uses, so the card menu and the summary modal cannot drift apart. */
export const ISSUE_WORKTREE_LABEL = 'Start with agent in a new worktree'
/** The summary modal's button, beside its "Start with agent ▾" — the shorter form of the same
 *  action (the modal's action row has room for one long label, not two). */
export const ISSUE_WORKTREE_BUTTON_LABEL = 'Start in a new worktree'

/** Worktrees are made on THIS machine's filesystem; a relay tab's canvas belongs to another one. */
export const ISSUE_WORKTREE_RELAY_HINT = 'Not available in a shared tab — worktrees are local to this machine in this version'

/** `repoRoot` is null both for a folder that is not a repository and while (or after) the store's
 *  read failed — so the reason names both, rather than claiming absence on a read that did not
 *  happen. */
export const ISSUE_WORKTREE_NO_REPO_HINT =
  'No git repository was found for this project’s folder (or git could not be read)'

/**
 * Why the action cannot run on this project, or `null` when it can. The rows are shown DISABLED
 * with this reason rather than hidden — the rule every worktree affordance follows: a row that
 * silently vanishes takes its reason with it. Worktrees are local-only in v1, so a relay tab and
 * an SSH project are refused before a cwd-less project or a folder that is not a repository.
 */
export function issueWorktreeRefusal(p: {
  relay: boolean
  ssh: boolean
  cwd: string | undefined
  repoRoot: string | null
}): string | null {
  if (p.relay) return ISSUE_WORKTREE_RELAY_HINT
  if (p.ssh) return WORKTREE_SSH_HINT
  if (!p.cwd?.trim()) return WORKTREE_NO_CWD_HINT
  if (!p.repoRoot?.trim()) return ISSUE_WORKTREE_NO_REPO_HINT
  return null
}

/** The two answers the reuse-or-new dialog can give. */
export type IssueWorktreeChoice = 'reuse' | 'new'

/**
 * The dialog shown when the issue already has a worktree (or the branch it would create already
 * exists): what is there, and the two ways forward. Nothing is ever overwritten, so "new" is always
 * a DIFFERENT branch and folder. Reuse is preselected — the common reason to start a second agent
 * on an issue is to continue in the checkout the first one used.
 */
export function issueWorktreeChoiceCopy(
  issueNumber: number,
  existing: IssueWorktreeExisting,
  alternative: IssueWorktreeTarget | null,
  baseRef: string
): {
  message: string
  options: { value: IssueWorktreeChoice; label: string }[]
  value: IssueWorktreeChoice
} {
  const what =
    existing.kind === 'bound'
      ? `Issue #${issueNumber} already has a worktree on this canvas: ⎇ ${existing.branch} (${existing.path}).`
      : existing.kind === 'orphan'
        ? `Issue #${issueNumber} already has a worktree that no group is bound to: ⎇ ${existing.branch} (${existing.path}).`
        : `The branch ${existing.branch} already exists, but it is not checked out anywhere.`
  const reuse =
    existing.kind === 'bound'
      ? 'Reuse it — open the agent in that group'
      : existing.kind === 'orphan'
        ? 'Reuse it — bind a new group to that worktree (Remove will not delete a worktree the app did not create)'
        : `Check out ${existing.branch} in a new worktree at ${existing.path}`
  const options: { value: IssueWorktreeChoice; label: string }[] = [{ value: 'reuse', label: reuse }]
  if (alternative) {
    options.push({
      value: 'new',
      label: `Create ⎇ ${alternative.branch} off ${baseRef} at ${alternative.path}`
    })
  }
  const message = alternative
    ? `${what} Nothing will be overwritten.`
    : `${what} No free branch name was found for a new one, so only reuse is offered.`
  return { message, options, value: 'reuse' }
}

/** The notice after a start that created a worktree under a different name than the usual one. */
export function issueWorktreeRenamedNotice(wanted: string, created: string): string {
  return `${wanted} was already taken (a local or remote branch, or a folder, of that name exists), so the new worktree is ${created}.`
}

/** What the canvas answers for one issue card: the agent rows, or why there are none. */
export type IssueWorktreeMenuAnswer = { items: MenuItem[] } | { refusal: string }

/**
 * The issue card's menu row: a submenu of agents, or the same label DISABLED with its reason (a
 * submenu row cannot be disabled, and a row that vanishes takes its reason with it).
 */
export function issueWorktreeMenuRow(answer: IssueWorktreeMenuAnswer, icon?: ReactNode): MenuItem {
  if ('refusal' in answer) {
    return { label: ISSUE_WORKTREE_LABEL, icon, disabled: true, hint: answer.refusal, onClick: () => {} }
  }
  return { type: 'submenu', label: ISSUE_WORKTREE_LABEL, icon, children: answer.items }
}

/**
 * Where the next agent opened INTO a worktree frame goes, in root space, and how big the frame must
 * then be. The same grid the control opens use (`groupSlot` / `groupSizeFor`). Returns a CENTER,
 * because that is what `addAgentNode` takes — the node factories centre a node on the point they
 * are given (`placeAt`) — while `groupSlot` is a TOP-LEFT offset inside the frame. Handing the slot
 * over as-is put the agent half a node up and left: over the frame's label, its only drag handle.
 */
export function frameAgentPlacement(
  frameOrigin: { x: number; y: number },
  children: number,
  size: { width: number; height: number }
): { center: { x: number; y: number }; frame: { width: number; height: number } } {
  const slot = groupSlot(children, size.width, size.height)
  return {
    center: {
      x: frameOrigin.x + slot.x + size.width / 2,
      y: frameOrigin.y + slot.y + size.height / 2
    },
    frame: groupSizeFor(children + 1, size.width, size.height)
  }
}

/**
 * Run `task` unless one is already running under `key`; `false` = refused (a start for this issue is
 * in flight). Held across EVERYTHING the start awaits — the planning reads AND a create confirmed
 * from the reuse-or-new dialog — so a second click while git works cannot plan against the store as
 * it was before the first worktree existed and race it for the same name.
 */
export async function runExclusive(
  inFlight: Set<string>,
  key: string,
  task: () => Promise<void>
): Promise<boolean> {
  if (inFlight.has(key)) return false
  inFlight.add(key)
  try {
    await task()
  } finally {
    inFlight.delete(key)
  }
  return true
}

/** The reuse-or-new dialog's state. */
export interface IssueWorktreeAsk {
  message: string
  options: { value: IssueWorktreeChoice; label: string }[]
  value: IssueWorktreeChoice
  run: (choice: IssueWorktreeChoice) => void
}

/**
 * The worktree frames on this canvas that may be REUSED for an issue: bound to a worktree of THIS
 * repository and not stale. A frame bound to another repository's worktree (the worktree store
 * skips those too) is never offered — a hostile or foreign frame whose branch happens to read
 * `issue-<N>-…` would otherwise be the preselected "Reuse".
 */
export function issueWorktreeFrames(
  nodes: readonly ScmScopeNode[],
  repoRoot: string,
  staleGroupIds: readonly string[]
): IssueWorktreeBoundGroup[] {
  const repo = normWorktreePath(repoRoot)
  return boundGroups(nodes as ScmScopeNode[])
    .filter((b) => normWorktreePath(b.worktree.repoPath ?? '') === repo && !staleGroupIds.includes(b.groupId))
    .map((b) => ({ groupId: b.groupId, branch: b.worktree.branch, path: b.worktree.path }))
}

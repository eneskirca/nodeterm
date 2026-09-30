// The CLIENT side of a hosted team's role policy: which relay calls a Viewer or Commenter may send.
//
// The host decides (src/core/relay/access-policy.ts `VIEW` / `COMMENT`, argument checks included);
// this is only its mirror, so a read-only teammate's tab does not send the host calls it will refuse
// anyway — the autosave, the canvas edits, the typing, the mount-time probes. A refusal the host
// would have sent comes back from here instead, in the host's words and with its code, so every
// caller behaves exactly as it would have. The access-policy guard test pins these two lists to the
// host's tables: a channel the host opens to viewers and this file does not name would silently
// disappear from a viewer's tab. See docs/hosted-team-relay.md.
import { IPC } from './ipc'
import type { HostedRole } from './types'

/** Every channel the host serves a Viewer (its `VIEW` table's keys). */
export const HOSTED_VIEW_METHODS: readonly string[] = Object.freeze([
  IPC.workspaceLoad,
  IPC.ptyCreate,
  IPC.ptyResize,
  IPC.ptyFlow,
  IPC.ptyKill,
  IPC.ptyCapture,
  IPC.ptyReadScrollback,
  IPC.ptyPaneCommand,
  IPC.ptyTmuxStatus,
  IPC.fsList,
  IPC.fsRead,
  IPC.fsReadBinary,
  IPC.fsExists,
  IPC.gitStatus,
  IPC.gitRepoRoot,
  IPC.gitDiff,
  IPC.gitShowFile,
  IPC.gitHistory,
  IPC.agentSubagentSnapshot,
  IPC.presenceHello,
  IPC.presenceCursor,
  IPC.presenceFocus,
  IPC.presenceProject,
  IPC.boardLogRead,
  IPC.boardLogSubscribe,
  IPC.boardLogUnsubscribe
])

/** What a Commenter may call on top of a Viewer's (its `COMMENT` table's keys). */
export const HOSTED_COMMENT_METHODS: readonly string[] = Object.freeze([IPC.presenceChat, IPC.boardLogAppend])

const VIEW = new Set(HOSTED_VIEW_METHODS)
const COMMENT = new Set(HOSTED_COMMENT_METHODS)

/** The hosted team verbs: intercepted and judged by the host itself (owner-only ones included). */
const HOSTED_PREFIX = 'relay:hosted:'

/** May a teammate with `role` send `method`? `null` (not known yet) is the lowest role. */
export function hostedMayCall(role: HostedRole | null, method: string): boolean {
  if (typeof method !== 'string') return false
  if (method.startsWith(HOSTED_PREFIX)) return true
  if (role === 'owner' || role === 'editor') return true
  if (VIEW.has(method)) return true
  return role === 'commenter' && COMMENT.has(method)
}

const ROLE_NAME: Readonly<Record<string, string>> = { owner: 'Owners', editor: 'Editors', commenter: 'Commenters', viewer: 'Viewers' }

/** The refusal the host would have answered with (relay-host's `E_ROLE` + access-policy's words). */
export function hostedRoleRefusal(role: HostedRole | null): Error & { code: string } {
  const name = role && Object.hasOwn(ROLE_NAME, role) ? ROLE_NAME[role] : ROLE_NAME.viewer
  return Object.assign(new Error(`${name} can't do that here. Ask an owner for Editor access.`), { code: 'E_ROLE' })
}

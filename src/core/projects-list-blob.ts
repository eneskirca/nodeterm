import { promises as fs } from 'fs'
import path from 'path'
import type { Workspace } from '../shared/types'
import { AGENT_STATUS_FILE } from './agent-status-mirror'

/**
 * The `projects.list` blob the standing phone host serves over the relay (host-service.ts), and the
 * ONE definition of how it is assembled: the desktop's `listProjectsOutput` (src/main/index.ts) and
 * the Android interop fixture (android/protocol/src/test/interop/host-fixture.ts) both call
 * `buildProjectsListBlob`, so the Kotlin client is tested against the bytes the desktop serves, not
 * against a hand-written copy of them (audit A64).
 *
 * Layout: `<workspace json>\n--NT-PROJECTS-SPLIT--\n<tmux session names, one per line>\n
 * --NT-STATUS-SPLIT--\n<agent-status.json>` — the same three sections, in the same order, that a phone
 * on direct SSH reads off the host itself (`workspace.json`, `tmux ls`, `agent-status.json`). Both
 * phone clients split on the markers: keep them in sync with NodetermProjects.swift (iOS,
 * nodeterm-ios) and android/protocol/src/main/kotlin/dev/nodeterm/protocol/model/ProjectsParser.kt.
 */
export const PROJECTS_SPLIT_MARK = '--NT-PROJECTS-SPLIT--'
export const STATUS_SPLIT_MARK = '--NT-STATUS-SPLIT--'

export interface ProjectsListSources {
  /** The machine's workspace store (`WorkspaceStore`). Loaded read-only; see `buildProjectsListBlob`. */
  workspace: { load(opts: { sideline: boolean }): Promise<Workspace> }
  /** userData: where the agent-status mirror writes `AGENT_STATUS_FILE`. */
  userDataDir: string
  /** The live nodeterm tmux session names (`nt-<nodeId>`). */
  listSessions(): Promise<string[]>
}

/**
 * Build the blob. Reads the same things the SSH browse path reads on the host, without SSH. Every
 * read is best-effort (a failed one degrades to an empty section), so this never rejects.
 *
 * The workspace section is the ASSEMBLED v2-shaped workspace, never the raw workspace.json: since the
 * v3 migration that file is an index whose folder refs hold no node data at all, and the phones decode
 * `{ projects: [Project] }`, so a raw v3 file would list zero projects. `load()` re-reads each ref's
 * `.nodeterm/project.json` and returns `{version: 2, projects: […]}`; it is idempotent, so calling it
 * per request is safe. It runs with `sideline: false`: a phone listing projects in the middle of a git
 * merge must not move a conflict-marked project.json aside to `.corrupt-<ts>` (sidelining is for the
 * boot and renderer loads only).
 */
export async function buildProjectsListBlob(src: ProjectsListSources): Promise<string> {
  const workspace = await src.workspace
    .load({ sideline: false })
    .then((w) => JSON.stringify(w))
    .catch(() => '')
  const status = await fs.readFile(path.join(src.userDataDir, AGENT_STATUS_FILE), 'utf8').catch(() => '')
  const sessions = (await src.listSessions().catch(() => [])).join('\n')
  return `${workspace}\n${PROJECTS_SPLIT_MARK}\n${sessions}\n${STATUS_SPLIT_MARK}\n${status}`
}

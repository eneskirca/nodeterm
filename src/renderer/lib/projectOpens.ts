import type { Project } from '@shared/types'
import { registeredCwd, sameSshEndpoint } from '../state/projects'

/**
 * One way a project can be asked to become open, named by the store action that will carry it out:
 * - `new` — `addProject`, or `adoptProject` of a probed folder (both always append an open project);
 * - `folder` — `openFolderProject(folder)`;
 * - `ssh` — `openSshProject(label, ssh)`;
 * - `reopen` — `reopenProject(id)` (through Canvas's `reopenProjectUnchecked`);
 * - `register` — `registerProject({ resolvedCwd: cwd })`, the agent `open-project` verb.
 */
export type OpenAction =
  | { kind: 'new' }
  | { kind: 'folder'; folder: string }
  | { kind: 'ssh'; ssh: NonNullable<Project['ssh']> }
  | { kind: 'reopen'; id: string }
  | { kind: 'register'; cwd: string }

/** Un-closing `p` makes it open: it is closed, and not a relay tab (those never count, spec §3). */
const reopens = (p: Project): boolean => !!p.closed && !p.remote

/**
 * Whether `a` makes a project OPEN that was not (docs/project-limit.md, "Opening a project") —
 * that is, whether the project-limit gate must be asked before it. Activating a project that is
 * already open is not an open, so it never meets the gate.
 *
 * Each branch finds the project exactly as its store action will (the same matcher, in the same
 * order), so the answer is a prediction of what that action does to the open count, not a second
 * opinion about which project a folder belongs to. Callers read `projects` at the moment they ask,
 * immediately before the gate and the mutation (see the placement rule in Canvas's open paths).
 */
export function opensProject(projects: readonly Project[], a: OpenAction): boolean {
  switch (a.kind) {
    case 'new':
      return true
    case 'folder': {
      // openFolderProject's match: never a relay tab, which carries the HOST's cwd.
      const existing = projects.find((p) => p.cwd === a.folder && !p.remote)
      return !existing || reopens(existing)
    }
    case 'ssh': {
      const existing = projects.find((p) => !!p.ssh && sameSshEndpoint(p.ssh, a.ssh))
      return !existing || reopens(existing)
    }
    case 'reopen': {
      const existing = projects.find((p) => p.id === a.id)
      return !!existing && reopens(existing)
    }
    case 'register': {
      const cwd = registeredCwd(a.cwd)
      const existing = projects.find((p) => p.cwd === cwd)
      return !existing || reopens(existing)
    }
  }
}

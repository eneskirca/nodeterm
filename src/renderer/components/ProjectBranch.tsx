import { useEffect } from 'react'
import type { Project } from '@shared/types'
import { useProjectSession } from '../session/session'
import { readBranchStatus, useGitBranch } from '../state/gitBranches'
import { useProjects } from '../state/projects'
import { MainDriftBadge } from './MainDriftBadge'
import type { BusyCheckNode } from '../lib/mainUpdate'

/** Project header only. A worktree header reads its OWN checkout, never this project's branch. */
export function ProjectBranch({
  project,
  liveNodes
}: {
  project: Project
  /** The active project's live React Flow nodes (the store's copy lags them); null otherwise. */
  liveNodes?: readonly BusyCheckNode[] | null
}): JSX.Element | null {
  const git = useProjectSession(project.id).api.git
  const cwd = project.ssh?.remoteCwd ?? project.cwd
  const sshId = project.ssh ? project.id : undefined
  const activeRemoteCwd = useProjects((s) =>
    s.projects.find((p) => p.id === s.activeProjectId)?.ssh?.remoteCwd)
  const canRead = !sshId && cwd !== activeRemoteCwd
  const branch = useGitBranch(git, cwd, sshId)
  useEffect(() => {
    // git.status routes ONLY the active SSH project's exact cwd. Background SSH connections
    // are not routable here, and a local cwd equal to the active remote cwd would hit that host.
    // SSH headers therefore observe Source's scoped refresh instead of issuing their own read.
    if (!cwd || !canRead) return
    void readBranchStatus(git, cwd, sshId).catch(() => {})
  }, [git, cwd, sshId, canRead])
  if (!branch) return null
  return (
    <>
      <span className="ss-group__branch">⎇ {branch}</span>
      <MainDriftBadge
        projectId={project.id}
        cwd={canRead ? cwd : undefined}
        // A node with no cwd of its own runs in the project folder.
        nodes={() => (liveNodes ?? project.nodes).map((n) => ({ ...n, cwd: n.cwd ?? cwd }))}
        onUpdated={() => {
          if (cwd) void readBranchStatus(git, cwd, sshId).catch(() => {})
        }}
      />
    </>
  )
}

import { useEffect } from 'react'
import type { Project } from '@shared/types'
import { useProjectSession } from '../session/session'
import { readBranchStatus, useGitBranch } from '../state/gitBranches'
import { useProjects } from '../state/projects'

/** Project header only. A worktree header reads its OWN checkout, never this project's branch. */
export function ProjectBranch({ project }: { project: Project }): JSX.Element | null {
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
  return branch ? <span className="ss-group__branch">⎇ {branch}</span> : null
}

// The open PR section for the canvas add menu and the Dock. It reads what this machine already
// holds (GitHub control status + the board's pull status memory) and follows the host's change
// events; it starts no poll and holds no host subscription.
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { GitHubControlView } from '@shared/github-issues'
import type { GitHubPullBoard } from '@shared/github-pull-status'
import type { OpenPullSection } from '../lib/addMenuSpec'
import { openPullSection } from '../lib/openPullMenu'
import { sessionForProject } from '../session/session'
import { readBranchStatus, useGitBranch } from './gitBranches'
import { useProjects } from './projects'

type Answer = { projectId: string; view?: GitHubControlView; board?: GitHubPullBoard }

// ponytail: once per project per app run, a menu that finds no read yet asks for the board's own
// refresh (the call the "Pull request…" approve step already makes), so the list fills.
const primed = new Set<string>()

export function useOpenPullSection(projectId: string): { section?: OpenPullSection; prime: () => void } {
  const session = sessionForProject(projectId || '')
  const relay = session.source === 'relay'
  const api = session.api
  const project = useProjects((s) => s.projects.find((p) => p.id === projectId))
  const cwd = project?.ssh?.remoteCwd ?? project?.cwd
  const sshId = project?.ssh ? project.id : undefined
  const branch = useGitBranch(api.git, cwd, sshId)
  const [answer, setAnswer] = useState<Answer>()

  const load = useCallback(async (): Promise<Answer | undefined> => {
    if (!projectId || relay) return undefined
    const view = await api.githubControl.status(projectId).catch(() => undefined)
    const board = view?.project?.approved
      ? await api.githubIssues.pullStatus(projectId).catch(() => undefined)
      : undefined
    const next = { projectId, view, board }
    setAnswer(next)
    return next
  }, [api, projectId, relay])

  useEffect(() => {
    if (!projectId || relay) return
    void load()
    return api.githubIssues.onChanged(projectId, () => { void load() })
  }, [api, projectId, relay, load])

  const prime = useCallback(() => {
    // git.status routes only the active SSH project's own cwd; a local folder is read here.
    if (cwd && !sshId) void readBranchStatus(api.git, cwd).catch(() => {})
    void load().then((next) => {
      if (!next?.view?.project?.approved || next.board?.observedAt !== undefined || primed.has(projectId)) return
      primed.add(projectId)
      void api.githubIssues.refresh(projectId).catch(() => {})
    })
  }, [api, cwd, sshId, load, projectId])

  const section = useMemo(
    () => (!relay && answer?.projectId === projectId ? openPullSection(answer.view, answer.board, branch || undefined) : undefined),
    [relay, answer, projectId, branch]
  )
  return { section, prime }
}

import type { GitHubControlApi } from '@shared/github-issues'

/**
 * Allow `repository` on this computer for `projectId`: the add menu's approve step, for the one
 * repository the host resolves for that project (its origin). The pull node's "Allow" button runs
 * it. True when the repository is allowed afterwards.
 */
export async function allowProjectRepo(
  api: Pick<GitHubControlApi, 'status' | 'approve'>,
  projectId: string,
  repository: string
): Promise<boolean> {
  const view = await api.status(projectId)
  const own = view.project?.repository
  if (!own || own.toLowerCase() !== repository.toLowerCase()) return false
  if (view.project?.approved) return true
  const next = await api.approve({ projectId, repository: own, expectedRevision: view.control.revision })
  return next.project?.approved === true
}

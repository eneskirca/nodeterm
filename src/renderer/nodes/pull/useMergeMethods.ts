import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitHubRepoMergeMethodsResult } from '@shared/github-pull-detail'
import type { PullNodeApi } from './shared'

export type MergeMethodsRead = GitHubRepoMergeMethodsResult | 'loading' | null

/**
 * The repository's allowed merge methods, read once per node by the shell and shared by the merge
 * box's method select and the proposal bar. `null` = not asked yet. `load` reads again only after a
 * failed or refused read, so a retry costs one request and a good answer none.
 * ponytail: the host holds the answer for the app run, so a settings change shows after a restart.
 */
export function useMergeMethods(api: Pick<PullNodeApi, 'repoMergeMethods'>, projectId: string, repository: string, wanted: boolean): {
  methods: MergeMethodsRead; load: () => void
} {
  const [methods, setMethods] = useState<MergeMethodsRead>(null)
  const current = useRef(methods)
  current.current = methods
  const load = useCallback(() => {
    const now = current.current
    if (now === 'loading' || now?.status === 'ok') return
    current.current = 'loading'
    setMethods('loading')
    void api.repoMergeMethods(projectId, repository)
      .catch((): GitHubRepoMergeMethodsResult => ({ status: 'failed', reason: 'unreachable' }))
      .then(setMethods)
  }, [api, projectId, repository])
  useEffect(() => { if (wanted && current.current === null) load() }, [wanted, load])
  return { methods, load }
}

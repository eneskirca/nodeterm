// The merge actions the header (NextAction) and the merge box share, so both run one path: the
// picked merge method, Update branch (with its head-moved reload and "GitHub is updating" state),
// and the conflict's two ways out.
import { useState } from 'react'
import type { GitHubPullDetail, PullMergeMethod, PullWriteReason } from '@shared/github-pull-detail'
import { useSendTo } from './SendTo'
import { useWrite, type ViewProps } from './shared'
import type { MergeMethodsRead } from './useMergeMethods'

/** The method the user picked, else the first one the repository allows. Null = none known. */
export function useMergeMethod(methods: MergeMethodsRead): { method: PullMergeMethod | null; pick: (method: PullMergeMethod) => void } {
  const [picked, pick] = useState<PullMergeMethod | null>(null)
  const ready = methods !== null && methods !== 'loading' && methods.status === 'ok' ? methods.methods : null
  return { method: picked && ready?.includes(picked) ? picked : ready?.[0] ?? null, pick }
}

export const UPDATE_MOVED_TEXT = 'The pull request changed since you loaded it, so the branch was not updated. It has been reloaded: check it, then update again.'

export interface UpdateBranch {
  run: () => void
  busy: boolean
  /** GitHub accepted the update (202) and the node still shows the head it started from. */
  updating: boolean
  refusal: PullWriteReason | null
}

/** "Update branch": tied to the head the node shows; a head-moved refusal reloads the node. */
export function useUpdateBranch({ api, projectId, pull, onWritten }: ViewProps, d: GitHubPullDetail | undefined): UpdateBranch {
  const [updatedFrom, setUpdatedFrom] = useState<string | null>(null)
  const write = useWrite(() => { if (d) setUpdatedFrom(d.head.sha); onWritten() })
  return {
    busy: write.busy,
    refusal: write.refusal,
    updating: !!d && updatedFrom === d.head.sha,
    run: () => {
      if (!d) return
      void write.run(async () => {
        const outcome = await api.updatePullBranch({ projectId, repository: pull.repository, pullNumber: pull.pullNumber, headSha: d.head.sha })
        if (!outcome.ok && outcome.reason === 'head-moved') onWritten()
        return outcome
      })
    }
  }
}

export interface ConflictChoice { key: 'agent' | 'myself'; label: string; disabled?: boolean; title?: string; act: () => void }

/** A conflict's two ways out: an agent in the Send to… picker, or a worktree agent of your own. */
export function useConflictChoices(d: GitHubPullDetail, onWork: ViewProps['onWork']): ConflictChoice[] {
  const { sendTo, why, name } = useSendTo()
  return [
    ...(sendTo || why ? [{
      key: 'agent' as const, label: name ? `Resolve with ${name}` : 'Resolve with agent', disabled: !sendTo, title: why,
      act: () => sendTo?.({ kind: 'conflict', base: d.base.ref })
    }] : []),
    ...(onWork ? [{ key: 'myself' as const, label: 'Resolve myself', title: 'Check out the branch in a new agent node.', act: () => onWork(d) }] : [])
  ]
}

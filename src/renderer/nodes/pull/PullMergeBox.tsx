import { useState } from 'react'
import type { GitHubPullDetail, PullMergeMethod, PullWriteReason, PullWriteResult } from '@shared/github-pull-detail'
import { isPlainRef } from '@shared/pull-work'
import { PullChecks } from '../../components/kanban/GitHubIssueSummaryModal'
import { mergeBlock, type PullChecksRead } from '../../lib/pullMergeBlock'
import { PullLifecycleActions } from './PullLifecycleActions'
import { FAILURE_TEXT, METHOD_TEXT, REFUSAL_TEXT, useWrite, WRITE_TEXT, type ViewProps } from './shared'
import type { MergeMethodsRead } from './useMergeMethods'

const AUTO_MOVED_TEXT = 'GitHub did not turn on auto-merge: the pull request changed since you loaded it, or it can merge now. It has been reloaded: check it, then try again.'

const UPDATE_MOVED_TEXT = 'The pull request changed since you loaded it, so the branch was not updated. It has been reloaded: check it, then update again.'

/**
 * The merge box, at the end of the Conversation tab: the head's checks (result, name, duration), why
 * Merge is off (draft, closed, conflict, behind, blocked) with its fix, the method select (only the
 * methods the repository allows) and the Merge button, whose confirmation is a modal over the node.
 * Nothing merges without Confirm. The merge is tied to the head the node shows, so GitHub refuses it (head-moved)
 * if the PR moved; the node then says so and reloads.
 */
export function PullMergeBox(props: ViewProps & {
  detail: GitHubPullDetail; checks: PullChecksRead
  /** The shell's one read of the allowed methods; `onLoadMethods` reads again after a failed one. */
  methods: MergeMethodsRead; onLoadMethods: () => void
}): React.JSX.Element {
  const { api, projectId, pull, detail: d, checks, methods, onWritten, onWork } = props
  // Which confirmation is open: a merge now, or "Merge when ready" (GitHub's auto-merge).
  const [open, setOpen] = useState<'merge' | 'auto' | null>(null)
  const [picked, setPicked] = useState<PullMergeMethod | null>(null)
  const [busy, setBusy] = useState(false)
  // The confirmation's refused write: a merge, or (`auto`) turning on auto-merge.
  const [refusal, setRefusal] = useState<{ reason: PullWriteReason; auto: boolean } | null>(null)
  const block = mergeBlock(d, checks)
  // The head an update was started from: GitHub updates in the background (202), so until the
  // node reads a new head the button stays off and the node says it is under way.
  const [updatedFrom, setUpdatedFrom] = useState<string | null>(null)
  const updating = updatedFrom === d.head.sha && block?.kind === 'behind'
  const update = useWrite(() => { setUpdatedFrom(d.head.sha); onWritten() })
  const cancelAuto = useWrite(onWritten)
  // Auto-merge waits for the reviews and checks branch protection asks for. It does not update a
  // branch, so a PR behind its base (or one that can merge now, or never can) gets none.
  const offersAuto = !d.autoMerge && block?.kind === 'blocked'

  const show = (mode: 'merge' | 'auto') => {
    setOpen(mode)
    setRefusal(null)
    // The allowed methods are read once per node; only a failed read is read again, on the next open.
    props.onLoadMethods()
  }
  const confirm = async () => {
    if (busy || !method || !open) return
    setBusy(true)
    const request = { projectId, repository: pull.repository, pullNumber: pull.pullNumber, method, headSha: d.head.sha }
    const outcome = await (open === 'auto' ? api.enablePullAutoMerge(request) : api.mergePull(request))
      .catch((): PullWriteResult => ({ ok: false, reason: 'network' }))
    setBusy(false)
    setOpen(null)
    if (!outcome.ok) setRefusal({ reason: outcome.reason, auto: open === 'auto' })
    if (outcome.ok || outcome.reason === 'head-moved') onWritten()
  }

  const ready = methods !== null && methods !== 'loading' && methods.status === 'ok' ? methods.methods : null
  // The picked method, else the first one the repository allows.
  const method = picked && ready?.includes(picked) ? picked : ready?.[0] ?? null
  // Why there is no method select: never a silent missing control (a token that may not push gets no methods).
  const methodsNote = methods === null || methods === 'loading' ? null
    : methods.status === 'refused' ? REFUSAL_TEXT[methods.reason](pull.repository)
      : methods.status === 'failed' ? FAILURE_TEXT[methods.reason]
        : methods.methods.length === 0 ? 'Your GitHub token may not merge in this repository. Merge on GitHub instead.' : null
  const confirmable = !!ready?.length && (open !== 'auto' || (methods as { autoMerge?: true }).autoMerge === true)
  return (
    <section className="pull-mergebox" data-pull-section="merge">
    <PullChecks result={checks} expectedHead={d.head.sha} onOpen={props.onOpenExternal} />
    <div className="pull-merge">
      <div className="pull-merge__row">
        <button className="pull-compose__button" disabled={!!block || busy} onClick={() => show('merge')}>Merge…</button>
        {!!ready?.length && (
          <select className="pull-merge__select" aria-label="Merge method" value={method ?? ''} disabled={busy}
            onChange={(event) => setPicked(event.target.value as PullMergeMethod)}>
            {ready.map((item) => <option key={item} value={item}>{METHOD_TEXT[item]}</option>)}
          </select>
        )}
        {methodsNote && <span className="pull-merge__note">{methodsNote}</span>}
      </div>
      {offersAuto && (
        <button className="pull-compose__button" disabled={busy} onClick={() => show('auto')}>Merge when ready…</button>
      )}
      {block && <p className="pull-merge__reason">{block.text}</p>}
      {d.autoMerge && (d.lifecycle === 'open' || d.lifecycle === 'draft') && (
        <>
          <p className="pull-node__state" role="status">
            Auto-merge is on ({METHOD_TEXT[d.autoMerge.method]}). GitHub merges it when the required reviews and checks pass.
          </p>
          <button className="pull-compose__button" disabled={cancelAuto.busy}
            onClick={() => void cancelAuto.run(() => api.disablePullAutoMerge({
              projectId, repository: pull.repository, pullNumber: pull.pullNumber
            }))}>Cancel auto-merge</button>
        </>
      )}
      {cancelAuto.refusal && <p className="pull-compose__error" role="alert">{WRITE_TEXT[cancelAuto.refusal]}</p>}
      {block?.kind === 'behind' && (
        <button className="pull-compose__button" disabled={update.busy || updating}
          onClick={() => void update.run(async () => {
            const outcome = await api.updatePullBranch({
              projectId, repository: pull.repository, pullNumber: pull.pullNumber, headSha: d.head.sha
            })
            if (!outcome.ok && outcome.reason === 'head-moved') onWritten()
            return outcome
          })}>Update branch</button>
      )}
      {block?.kind === 'conflict' && onWork && (isPlainRef(d.base.ref)
        ? <button className="pull-compose__button" onClick={() => onWork(d, true)}>Resolve conflicts with agent</button>
        : <p className="pull-merge__reason">The base branch name cannot be given to an agent, so resolve the conflicts by hand.</p>)}
      {updating && <p className="pull-node__state" role="status">GitHub is updating the branch. Refresh in a moment to see the new commit.</p>}
      {update.refusal && (
        <p className="pull-compose__error" role="alert">
          {update.refusal === 'head-moved' ? UPDATE_MOVED_TEXT : WRITE_TEXT[update.refusal]}
        </p>
      )}
      {refusal && (
        <p className="pull-compose__error" role="alert">
          {refusal.auto && refusal.reason === 'head-moved' ? AUTO_MOVED_TEXT : WRITE_TEXT[refusal.reason]}
        </p>
      )}
      <PullLifecycleActions {...props} detail={d} />
      {open && (
        <div className="pull-merge__backdrop">
          <div className="pull-merge__dialog" role="dialog" aria-modal="true"
            aria-label={open === 'auto' ? 'Merge pull request when ready' : 'Merge pull request'}>
            <p className="pull-merge__what">
              Merge <strong>#{d.number} {d.title}</strong> into <code>{d.base.ref}</code>
              {open === 'auto' ? ' when ready? GitHub merges it once the required reviews and checks pass.' : '?'}
            </p>
            {methods === null || methods === 'loading'
              ? <p className="pull-node__state">Loading the allowed merge methods…</p>
              : methods.status === 'refused'
                ? <p className="pull-node__state" role="status">{REFUSAL_TEXT[methods.reason](pull.repository)}</p>
                : methods.status === 'failed'
                  ? <p className="pull-node__state" role="status">{FAILURE_TEXT[methods.reason]}</p>
                  : open === 'auto' && !methods.autoMerge
                    ? <p className="pull-node__state" role="status">
                        This repository does not allow auto-merge. Turn on Allow auto-merge in its GitHub settings (General), or merge on GitHub.
                      </p>
                  : methods.methods.length === 0
                    ? <p className="pull-node__state" role="status">
                        This repository allows no merge method for your GitHub token. Merge on GitHub instead.
                      </p>
                    : method && <p className="pull-merge__method">Method: <strong>{METHOD_TEXT[method]}</strong></p>}
            <div className="pull-compose__actions">
              {confirmable && (
                <button className="pull-compose__button pull-merge__confirm" disabled={busy || !method}
                  onClick={() => void confirm()}>{open === 'auto' ? 'Enable auto-merge' : 'Confirm merge'}</button>
              )}
              <button className="pull-compose__button" disabled={busy} onClick={() => setOpen(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
    </section>
  )
}

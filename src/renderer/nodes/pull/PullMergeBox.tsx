import { useCallback, useRef, useState } from 'react'
import type { GitHubPullConversationResult, GitHubPullDetail, PullMergeMethod, PullWriteReason, PullWriteResult } from '@shared/github-pull-detail'
import type { GitHubPullTimelineResult } from '@shared/github-pull-timeline'
import { mergeBlock, type PullChecksRead } from '../../lib/pullMergeBlock'
import { Icon } from './Icon'
import { UPDATE_MOVED_TEXT, useConflictChoices, type UpdateBranch } from './mergeActions'
import { mergeRows, type MergeRow } from './mergeRows'
import { PullLifecycleActions } from './PullLifecycleActions'
import { usePullJump } from './PullJumpContext'
import { openThreadCount } from './readiness'
import { FAILURE_TEXT, METHOD_TEXT, REFUSAL_TEXT, useWrite, WRITE_TEXT, type Read, type ViewProps } from './shared'
import { useDismiss } from './useDismiss'
import type { MergeMethodsRead } from './useMergeMethods'
import './PullMergeBox.css'

const AUTO_MOVED_TEXT = 'GitHub did not turn on auto-merge: the pull request changed since you loaded it, or it can merge now. It has been reloaded: check it, then try again.'

/** One line under each method in the method menu (F4). */
function methodHint(method: PullMergeMethod, d: GitHubPullDetail): string {
  const commits = d.commits === undefined ? 'The commits' : `The ${d.commits} commit${d.commits === 1 ? '' : 's'}`
  if (method === 'merge') return 'All commits are added through a merge commit.'
  if (method === 'squash') return `${commits} become one on ${d.base.ref}.`
  return `${commits} are rebased onto ${d.base.ref}.`
}

/**
 * The merge box (F1), one card at the end of the Conversation tab: a state header for a draft, merged
 * or closed PR, the status rows (review, checks, unresolved threads, merge state), each with a link
 * that jumps to where it is acted on, and a footer with the method split button (its menu lists only
 * the methods the repository allows) and "Merge when ready". Nothing merges without Confirm in the
 * modal over the node. The merge is tied to the head the node shows, so GitHub refuses it
 * (head-moved) if the PR moved; the node then says so and reloads.
 */
export function PullMergeBox(props: ViewProps & {
  detail: GitHubPullDetail; checks: PullChecksRead
  /** The shell's one read of the allowed methods; `onLoadMethods` reads again after a failed one. */
  methods: MergeMethodsRead; onLoadMethods: () => void
  /** The shell's conversation read, for the unresolved threads row. Absent = no row. */
  conversation?: Read<GitHubPullConversationResult>
  /** The shell's picked method (shared with the header's lead button) and its setter. */
  method: PullMergeMethod | null; onPickMethod: (method: PullMergeMethod) => void
  /** The shell's one Update branch (the header's More actions runs the same one). */
  update: UpdateBranch
  /** The agent proposal, drawn as the card's top section (F1). */
  top?: React.ReactNode
  /** The first timeline page, for who merged or closed the PR and when. */
  timeline?: Read<GitHubPullTimelineResult>
}): React.JSX.Element {
  const { api, projectId, pull, detail: d, checks, methods, onWritten, onWork, method, onPickMethod, update } = props
  const jump = usePullJump()
  const conflictChoices = useConflictChoices(d, onWork)
  // Which confirmation is open: a merge now, or "Merge when ready" (GitHub's auto-merge).
  const [open, setOpen] = useState<'merge' | 'auto' | null>(null)
  const [menu, setMenu] = useState(false)
  const [busy, setBusy] = useState(false)
  // The confirmation's refused write: a merge, or (`auto`) turning on auto-merge.
  const [refusal, setRefusal] = useState<{ reason: PullWriteReason; auto: boolean } | null>(null)
  const block = mergeBlock(d, checks)
  const cancelAuto = useWrite(onWritten)
  // Auto-merge waits for the reviews and checks branch protection asks for. It does not update a
  // branch, so a PR behind its base (or one that can merge now, or never can) gets none.
  const offersAuto = !d.autoMerge && block?.kind === 'blocked'
  const menuRef = useRef<HTMLSpanElement>(null)
  useDismiss(menu, menuRef, useCallback(() => setMenu(false), []))

  const show = (mode: 'merge' | 'auto') => {
    setMenu(false)
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
  // Why there is no method menu: never a silent missing control (a token that may not push gets no methods).
  const methodsNote = methods === null || methods === 'loading' ? null
    : methods.status === 'refused' ? REFUSAL_TEXT[methods.reason](pull.repository)
      : methods.status === 'failed' ? FAILURE_TEXT[methods.reason]
        : methods.methods.length === 0 ? 'Your GitHub token may not merge in this repository. Merge on GitHub instead.' : null
  const confirmable = !!ready?.length && (open !== 'auto' || (methods as { autoMerge?: true }).autoMerge === true)
  const live = d.lifecycle === 'open' || d.lifecycle === 'draft'
  const openThreads = props.conversation ? openThreadCount(props.conversation) : undefined

  // The actions a merge-state row carries: the conflict's two ways out, the behind branch's update.
  const rowActions = (row: MergeRow): React.ReactNode => {
    if (row.key !== 'merge') return null
    if (d.merge === 'conflict') {
      if (!conflictChoices.length) return null
      return conflictChoices.map((choice) => (
        <button key={choice.key} type="button" className={choice.key === 'agent' ? 'pr-btn pr-btn--agent' : 'pr-btn'}
          disabled={choice.disabled} title={choice.title} onClick={choice.act}>
          {choice.key === 'agent' && <Icon name="agent" size={14} />}{choice.label}
        </button>
      ))
    }
    if (block?.kind === 'behind') {
      return (
        <button type="button" className="pr-btn" disabled={update.busy || update.updating}
          onClick={update.run}><Icon name="sync" size={14} />Update branch</button>
      )
    }
    return null
  }

  return (
    <section className="pull-mergebox pr-mbox" data-pull-section="merge" aria-label="Merge">
      {props.top}
      <PullLifecycleActions {...props} detail={d} />
      {live && mergeRows(d, checks, openThreads).map((row) => {
        const actions = rowActions(row)
        return (
          <div key={row.key} className={`pr-mrow pr-tone--${row.tone}`} data-row={row.key}>
            <Icon name={row.icon} />
            <span className="pr-mrow__text">
              <strong>{row.title}</strong>{row.sub && <> <span className="pr-mrow__sub">{row.sub}</span></>}
              {actions && <span className="pr-mrow__actions">{actions}</span>}
            </span>
            {row.link && jump
              ? <button type="button" className="pr-mrow__link" onClick={() => jump(row.link!.jump)}>{row.link.label}</button>
              : <span />}
          </div>
        )
      })}
      {d.lifecycle === 'open' && (
        <div className="pr-mbox__foot">
          <span className="pr-split" ref={menuRef}>
            <button type="button" className={`pr-btn pr-split__main${block ? '' : ' pr-btn--primary'}`} disabled={!!block || busy}
              onClick={() => show('merge')}>
              <Icon name="merge" />{method ? METHOD_TEXT[method] : 'Merge'}
            </button>
            <button type="button" className={`pr-btn pr-split__chev${block ? '' : ' pr-btn--primary'}`} aria-label="Choose merge method"
              aria-haspopup="menu" aria-expanded={menu} disabled={!ready?.length || busy}
              onClick={() => { props.onLoadMethods(); setMenu((shown) => !shown) }}>
              <Icon name="chevron" />
            </button>
            {menu && ready && (
              <div className="pr-menu pr-split__menu" role="menu" aria-label="Merge method">
                {ready.map((item) => (
                  <button key={item} type="button" role="menuitemradio" aria-checked={item === method} className="pr-menu__item"
                    onClick={() => { onPickMethod(item); setMenu(false) }}>
                    <Icon name="check" className={item === method ? undefined : 'pr-split__unchecked'} />
                    <span>{METHOD_TEXT[item]}<small>{methodHint(item, d)}</small></span>
                  </button>
                ))}
                {offersAuto && <>
                  <div className="pr-menu__sep" role="separator" />
                  <button type="button" role="menuitem" className="pr-menu__item" onClick={() => show('auto')}>
                    <Icon name="merge" />
                    <span>Merge when ready<small>Merges itself once checks and reviews pass.</small></span>
                  </button>
                </>}
              </div>
            )}
          </span>
          {offersAuto && <button type="button" className="pr-btn" disabled={busy} onClick={() => show('auto')}>Merge when ready</button>}
          {methodsNote && <span className="pr-mbox__note">{methodsNote}</span>}
        </div>
      )}
      {d.autoMerge && live && (
        <div className="pr-mbox__auto">
          <p className="pr-mbox__note" role="status">
            Auto-merge is on ({METHOD_TEXT[d.autoMerge.method]}). GitHub merges it when the required reviews and checks pass.
          </p>
          <button type="button" className="pr-btn" disabled={cancelAuto.busy}
            onClick={() => void cancelAuto.run(() => api.disablePullAutoMerge({
              projectId, repository: pull.repository, pullNumber: pull.pullNumber
            }))}>Cancel auto-merge</button>
        </div>
      )}
      {cancelAuto.refusal && <p className="pr-mbox__error" role="alert">{WRITE_TEXT[cancelAuto.refusal]}</p>}
      {update.updating && <p className="pr-mbox__note" role="status">GitHub is updating the branch. Refresh in a moment to see the new commit.</p>}
      {update.refusal && (
        <p className="pr-mbox__error" role="alert">
          {update.refusal === 'head-moved' ? UPDATE_MOVED_TEXT : WRITE_TEXT[update.refusal]}
        </p>
      )}
      {refusal && (
        <p className="pr-mbox__error" role="alert">
          {refusal.auto && refusal.reason === 'head-moved' ? AUTO_MOVED_TEXT : WRITE_TEXT[refusal.reason]}
        </p>
      )}
      {open && (
        <div className="pull-merge__backdrop">
          <div className="pull-merge__dialog" role="dialog" aria-modal="true"
            aria-label={open === 'auto' ? 'Merge pull request when ready' : 'Merge pull request'}>
            <p className="pull-merge__what">
              Merge <strong>#{d.number} {d.title}</strong> into <code>{d.base.ref}</code>
              {open === 'auto' ? ' when ready? GitHub merges it once the required reviews and checks pass.' : '?'}
            </p>
            {methods === null || methods === 'loading'
              ? <p className="pr-mbox__note">Loading the allowed merge methods…</p>
              : methods.status === 'refused'
                ? <p className="pr-mbox__note" role="status">{REFUSAL_TEXT[methods.reason](pull.repository)}</p>
                : methods.status === 'failed'
                  ? <p className="pr-mbox__note" role="status">{FAILURE_TEXT[methods.reason]}</p>
                  : open === 'auto' && !methods.autoMerge
                    ? <p className="pr-mbox__note" role="status">
                        This repository does not allow auto-merge. Turn on Allow auto-merge in its GitHub settings (General), or merge on GitHub.
                      </p>
                  : methods.methods.length === 0
                    ? <p className="pr-mbox__note" role="status">
                        This repository allows no merge method for your GitHub token. Merge on GitHub instead.
                      </p>
                    : method && <p className="pull-merge__method">Method: <strong>{METHOD_TEXT[method]}</strong> at <code>{d.head.sha.slice(0, 7)}</code></p>}
            <div className="pr-mbox__dialog-actions">
              <button type="button" className="pr-btn" disabled={busy} onClick={() => setOpen(null)}>Cancel</button>
              {confirmable && (
                <button type="button" className="pr-btn pr-btn--primary" disabled={busy || !method}
                  onClick={() => void confirm()}>{open === 'auto' ? 'Enable auto-merge' : 'Confirm merge'}</button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

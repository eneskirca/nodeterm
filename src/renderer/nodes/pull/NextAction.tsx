import { useEffect, useRef, useState } from 'react'
import type { GitHubPullDetail } from '@shared/github-pull-detail'
import { pullWebUrl } from '@shared/pull-node'
import { Icon, type IconName } from './Icon'
import type { NextStep, PullJump } from './readiness'
import { useWrite, WRITE_TEXT, type ViewProps } from './shared'

type NextActionProps = ViewProps & {
  detail: GitHubPullDetail
  /** `nextStep(...)` for this render; null = no lead button (a merged PR). */
  next: NextStep | null
  onJump: (jump: PullJump) => void
  onCopy?: (text: string) => void
}

/**
 * The header's lead button and its More actions menu (F1, F4). Every write here is one the node
 * already had (reopen, ready for review, update branch, close); Merge only jumps to the merge box,
 * so its confirm step and head pin stay the only way to merge.
 */
export function NextAction(props: NextActionProps): React.JSX.Element {
  const { api, projectId, pull, detail: d, next, onJump, onWritten, onWork } = props
  const write = useWrite(onWritten)
  const at = { projectId, repository: pull.repository, pullNumber: pull.pullNumber }
  const run = (step: NextStep) => {
    switch (step.kind) {
      case 'reopen': return void write.run(() => api.setPullState({ ...at, open: true }))
      case 'ready': return void write.run(() => api.markPullReady(at))
      // The existing "Resolve conflicts with agent" path; without it, the merge box says how.
      case 'conflicts': return onWork ? onWork(d, true) : onJump({ tab: 'conversation', section: 'merge' })
      case 'checks': return onJump({ tab: 'checks' })
      case 'threads': return onJump({ tab: 'files' })
      case 'merge': return onJump({ tab: 'conversation', section: 'merge' })
    }
  }
  return (
    <div className="pr-next">
      {next && (
        <button type="button" className={`pr-btn pr-btn--${next.tone}`} data-next={next.kind} disabled={write.busy}
          onClick={() => run(next)}>
          <Icon name={next.icon} />{next.label}
        </button>
      )}
      <MoreActions {...props} write={write} />
      {write.refusal && <p className="pr-next__error" role="alert">{WRITE_TEXT[write.refusal]}</p>}
    </div>
  )
}

type MenuItem = { label: string; hint?: string; icon: IconName; danger?: true; act: () => void }

function MoreActions(props: NextActionProps & { write: ReturnType<typeof useWrite> }): React.JSX.Element {
  const { api, projectId, pull, detail: d, write, onWork, onCopy, onOpenExternal } = props
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  // A click anywhere else or Escape closes the menu (the document is the outside system here).
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const at = { projectId, repository: pull.repository, pullNumber: pull.pullNumber }
  const live = d.lifecycle === 'open' || d.lifecycle === 'draft'
  const url = pullWebUrl(pull.repository, pull.pullNumber)
  const items: MenuItem[] = [
    ...(live && onWork ? [{ label: 'Work on this PR', hint: 'Check out the branch in a new agent node.', icon: 'terminal' as const, act: () => onWork(d) }] : []),
    ...(live ? [{
      label: 'Update branch', hint: `Merge ${d.base.ref} into ${d.head.ref}.`, icon: 'sync' as const,
      act: () => void write.run(() => api.updatePullBranch({ ...at, headSha: d.head.sha }))
    }] : []),
    ...(onCopy ? [{ label: 'Copy link', icon: 'link' as const, act: () => onCopy(url) }] : []),
    { label: 'Open on GitHub', icon: 'external', act: () => onOpenExternal(url) }
  ]
  const lifecycle: MenuItem | null = live
    ? { label: 'Close pull request', icon: 'closed', danger: true, act: () => void write.run(() => api.setPullState({ ...at, open: false })) }
    : d.lifecycle === 'closed'
      ? { label: 'Reopen pull request', icon: 'pr', act: () => void write.run(() => api.setPullState({ ...at, open: true })) }
      : null
  const item = (entry: MenuItem) => (
    <button key={entry.label} type="button" role="menuitem" className={`pr-menu__item${entry.danger ? ' pr-menu__item--danger' : ''}`}
      disabled={write.busy} onClick={() => { setOpen(false); entry.act() }}>
      <Icon name={entry.icon} />
      <span>{entry.label}{entry.hint && <small>{entry.hint}</small>}</span>
    </button>
  )
  return (
    <div className="pr-more" ref={ref}>
      <button type="button" className="pr-btn pr-btn--icon" aria-label="More actions" aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((shown) => !shown)}>
        <Icon name="more" />
      </button>
      {open && (
        <div className="pr-menu" role="menu" aria-label="More actions">
          {items.map(item)}
          {lifecycle && <><div className="pr-menu__sep" role="separator" />{item(lifecycle)}</>}
        </div>
      )}
    </div>
  )
}

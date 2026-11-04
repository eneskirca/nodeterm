import { useCallback, useRef, useState } from 'react'
import type { GitHubPullDetail } from '@shared/github-pull-detail'
import { pullWebUrl } from '@shared/pull-node'
import { Icon, type IconName } from './Icon'
import { useConflictChoices, type UpdateBranch } from './mergeActions'
import type { NextStep, PullJump } from './readiness'
import { useSendTo } from './SendTo'
import { useWrite, WRITE_TEXT, type ViewProps } from './shared'
import { useDismiss } from './useDismiss'

type NextActionProps = ViewProps & {
  detail: GitHubPullDetail
  /** `nextStep(...)` for this render; null = no lead button (a merged PR). */
  next: NextStep | null
  onJump: (jump: PullJump) => void
  onCopy?: (text: string) => void
  /** The shell's one Update branch, shared with the merge box (which shows its state). */
  update: UpdateBranch
}

/** A button that opens a menu; a click outside or Escape closes it. */
function useMenu(): { open: boolean; setOpen: (open: boolean | ((shown: boolean) => boolean)) => void; ref: React.RefObject<HTMLDivElement> } {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(open, ref, useCallback(() => setOpen(false), []))
  return { open, setOpen, ref }
}

/**
 * The header's lead button and its More actions menu (F1, F4). Every write here is one the node
 * already had (reopen, ready for review, update branch, close); Merge only jumps to the merge box,
 * so its confirm step and head pin stay the only way to merge.
 */
export function NextAction(props: NextActionProps): React.JSX.Element {
  const { api, projectId, pull, detail: d, next, onJump, onWritten, onWork } = props
  const write = useWrite(onWritten)
  const conflict = useMenu()
  const choices = useConflictChoices(d, onWork)
  const at = { projectId, repository: pull.repository, pullNumber: pull.pullNumber }
  const run = (step: NextStep) => {
    switch (step.kind) {
      case 'reopen': return void write.run(() => api.setPullState({ ...at, open: true }))
      case 'ready': return void write.run(() => api.markPullReady(at))
      // The merge box's two ways out; with neither, the merge box says how.
      case 'conflicts': return choices.length ? conflict.setOpen((shown) => !shown) : onJump({ tab: 'conversation', section: 'merge' })
      case 'checks': return onJump({ tab: 'checks' })
      case 'threads': return onJump({ tab: 'files' })
      case 'merge': return onJump({ tab: 'conversation', section: 'merge' })
    }
  }
  return (
    <div className="pr-next">
      {next && (
        <div className="pr-more" ref={conflict.ref}>
          <button type="button" className={`pr-btn pr-btn--${next.tone}`} data-next={next.kind} disabled={write.busy}
            aria-haspopup={next.kind === 'conflicts' && choices.length ? 'menu' : undefined}
            aria-expanded={next.kind === 'conflicts' && choices.length ? conflict.open : undefined}
            onClick={() => run(next)}>
            <Icon name={next.icon} />{next.label}
          </button>
          {conflict.open && next.kind === 'conflicts' && (
            <div className="pr-menu" role="menu" aria-label="Resolve conflicts">
              {choices.map((choice) => (
                <button key={choice.key} type="button" role="menuitem" className="pr-menu__item" disabled={choice.disabled} title={choice.title}
                  onClick={() => { conflict.setOpen(false); choice.act() }}>
                  <Icon name={choice.key === 'agent' ? 'agent' : 'terminal'} />
                  <span>{choice.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <MoreActions {...props} write={write} />
      {write.refusal && <p className="pr-next__error" role="alert">{WRITE_TEXT[write.refusal]}</p>}
    </div>
  )
}

type MenuItem = { label: string; hint?: string; icon: IconName; danger?: true; disabled?: boolean; title?: string; act: () => void }

function MoreActions(props: NextActionProps & { write: ReturnType<typeof useWrite> }): React.JSX.Element {
  const { api, projectId, pull, detail: d, write, onWork, onCopy, onOpenExternal, onJump, update } = props
  const { open, setOpen, ref } = useMenu()
  const { sendTo, why, name } = useSendTo()
  const at = { projectId, repository: pull.repository, pullNumber: pull.pullNumber }
  const live = d.lifecycle === 'open' || d.lifecycle === 'draft'
  const url = pullWebUrl(pull.repository, pull.pullNumber)
  const items: MenuItem[] = [
    ...(live && onWork ? [{ label: 'Work on this PR', hint: 'Check out the branch in a new agent node.', icon: 'terminal' as const, act: () => onWork(d) }] : []),
    ...(sendTo || why ? [{
      label: name ? `Send PR to ${name}` : 'Send PR to…', hint: 'The agent reads it and sums it up.', icon: 'agent' as const,
      disabled: !sendTo, title: why, act: () => sendTo?.({ kind: 'pr' })
    }] : []),
    ...(live ? [{
      label: 'Update branch', hint: `Merge ${d.base.ref} into ${d.head.ref}.`, icon: 'sync' as const, disabled: update.busy || update.updating,
      // The merge box shows the update's state and refusal.
      act: () => { update.run(); onJump({ tab: 'conversation', section: 'merge' }) }
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
      disabled={write.busy || entry.disabled} title={entry.title} onClick={() => { setOpen(false); entry.act() }}>
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

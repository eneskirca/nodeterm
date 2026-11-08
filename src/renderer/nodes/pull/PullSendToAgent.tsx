import { useState } from 'react'
import type { GitHubPullDetail } from '@shared/github-pull-detail'
import { pullFeedbackItems } from '../../lib/pullFeedback'
import type { PullChecksRead } from '../../lib/pullMergeBlock'
import { readState, usePullRead, type ViewProps } from './shared'
import { useSendTo } from './SendTo'

export const NO_AGENT_TEXT = 'No agent is linked to this node. Use Work on this PR, or draw a context link from an agent.'

/** "Send review" (the sidebar's Agent section): a checklist of the unresolved line comment threads and the failing checks, then
 *  "Send to…", which opens the picker of every agent node in this project (F-06). Nothing is written
 *  to GitHub. */
export function PullSendToAgent(props: ViewProps & { detail: GitHubPullDetail; checks: PullChecksRead }): React.JSX.Element {
  const { sendTo, why } = useSendTo()
  const [open, setOpen] = useState(false)
  return (
    <div className="pull-send">
      {!open && (
        <button className="pr-btn pr-btn--sm" disabled={!sendTo} onClick={() => setOpen(true)}>Send review</button>
      )}
      {!open && why && <span className="pull-node__empty">{why}</span>}
      {open && sendTo && <PullSendPanel {...props} sendTo={sendTo} onClose={() => setOpen(false)} />}
    </div>
  )
}

function PullSendPanel(props: ViewProps & {
  detail: GitHubPullDetail; checks: PullChecksRead; onClose: () => void
  sendTo: NonNullable<ReturnType<typeof useSendTo>['sendTo']>
}): React.JSX.Element {
  const { pull, detail: d, checks, sendTo, onClose } = props
  const { name } = useSendTo()
  const conversation = usePullRead(props.api.pullConversation, props)
  // The user's ticks over the defaults (outdated threads start unticked).
  const [ticks, setTicks] = useState<Record<string, boolean>>({})
  if (conversation === 'loading' || conversation.status !== 'ok') return readState(conversation, pull.repository)
  const items = pullFeedbackItems(conversation.lineComments, conversation.resolvedThreads, checks, d.head.sha)
    .map((item) => item.key in ticks ? { ...item, checked: ticks[item.key] } : item)
  const picked = items.filter((item) => item.checked)
  const send = () => {
    const threads = picked.flatMap((item) => item.kind === 'thread' ? [{ id: item.thread.id, path: item.path, line: item.thread.line }] : [])
    const failing = picked.flatMap((item) => item.kind === 'check' ? [item.name] : [])
    // Sent: untick everything, so a second click cannot send the same items again.
    sendTo({ kind: 'threads', threads, checks: failing }, () => setTicks(Object.fromEntries(items.map((item) => [item.key, false]))))
  }
  return (
    <div className="pull-send__panel">
      <p className="pull-node__empty">
        Pick what to send. The agent reads the threads itself; nothing is written to GitHub.
        {conversation.resolvedThreads ? '' : ' Could not read which threads are resolved, so all are listed.'}
      </p>
      {items.length === 0
        ? <p className="pull-node__empty">No unresolved line comments and no failing checks.</p>
        : (
          <ul className="pull-send__items">
            {items.map((item) => (
              <li key={item.key}>
                <label className="pull-send__item">
                  <input type="checkbox" checked={item.checked}
                    onChange={(event) => setTicks((t) => ({ ...t, [item.key]: event.target.checked }))} />
                  {item.kind === 'check'
                    ? <span>Failing check: <code>{item.name}</code></span>
                    : (
                      <span>
                        <code>{item.path}{item.thread.line !== null ? `:${item.thread.line}` : ''}</code>
                        {item.thread.outdated && ' (outdated)'}{' '}
                        {item.thread.comments[0]?.author?.login ?? 'someone'}: {item.thread.comments[0]?.body.slice(0, 120)}
                        {item.thread.comments.length > 1 && ` (+${item.thread.comments.length - 1} more)`}
                      </span>
                    )}
                </label>
              </li>
            ))}
          </ul>
        )}
      <div className="pull-compose__actions">
        <button className="pull-compose__button" disabled={picked.length === 0} onClick={send}>{name ? `Send to ${name}` : 'Send to…'}</button>
        <button className="pull-compose__button" onClick={onClose}>Close</button>
      </div>
    </div>
  )
}

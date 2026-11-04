import { useState } from 'react'
import type { GitHubPullDetail } from '@shared/github-pull-detail'
import { pullFeedbackItems, pullFeedbackMessage } from '../../lib/pullFeedback'
import type { PullChecksRead } from '../../lib/pullMergeBlock'
import type { LinkedAgent } from '../../state/pullAgent'
import { readState, usePullRead, type ViewProps } from './shared'

export const NO_AGENT_TEXT = 'No agent is linked to this node. Use Work on this PR, or draw a context link from an agent.'

/** "Send to agent…": a checklist of the unresolved line comment threads and the failing checks, the
 *  linked agent to send to (picked when there are several), then Send. Nothing is written to GitHub. */
export function PullSendToAgent(props: ViewProps & { detail: GitHubPullDetail; checks: PullChecksRead }): React.JSX.Element {
  const { agents = [], sendUnavailable, onSendToAgent } = props
  const [open, setOpen] = useState(false)
  const why = sendUnavailable ?? (agents.length === 0 ? NO_AGENT_TEXT : undefined)
  return (
    <div className="pull-send">
      {!open && (
        <button className="pull-compose__button" disabled={!!why || !onSendToAgent} onClick={() => setOpen(true)}>
          Send to agent…
        </button>
      )}
      {!open && why && <span className="pull-node__empty">{why}</span>}
      {open && !why && <PullSendPanel {...props} agents={agents} onClose={() => setOpen(false)} />}
    </div>
  )
}

function PullSendPanel(props: ViewProps & {
  detail: GitHubPullDetail; checks: PullChecksRead; agents: readonly LinkedAgent[]; onClose: () => void
}): React.JSX.Element {
  const { pull, detail: d, checks, agents, onSendToAgent, onClose } = props
  const conversation = usePullRead(props.api.pullConversation, props)
  // The user's ticks over the defaults (outdated threads start unticked).
  const [ticks, setTicks] = useState<Record<string, boolean>>({})
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null)
  if (conversation === 'loading' || conversation.status !== 'ok') return readState(conversation, pull.repository)
  const items = pullFeedbackItems(conversation.lineComments, conversation.resolvedThreads, checks, d.head.sha)
    .map((item) => item.key in ticks ? { ...item, checked: ticks[item.key] } : item)
  const message = pullFeedbackMessage({ repository: pull.repository, number: pull.pullNumber }, items)
  // One linked agent needs no pick; with several, only the one picked (still linked) counts.
  const to = agents.length === 1 ? agents[0] : agents.find((agent) => agent.id === target)
  const send = async () => {
    if (busy || !message || !to || !onSendToAgent) return
    setBusy(true)
    const refused = await onSendToAgent(to.id, message).catch(() => 'The message could not be sent.')
    setBusy(false)
    setOutcome(refused ? { ok: false, text: refused } : { ok: true, text: `Sent to ${to.title}.` })
    // Sent: untick everything, so a second click cannot send the same items again.
    if (!refused) setTicks(Object.fromEntries(items.map((item) => [item.key, false])))
  }
  return (
    <div className="pull-send__panel">
      <p className="pull-node__empty">
        Pick what to send. Comment text goes to the agent as quoted data; nothing is written to GitHub.
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
        {agents.length > 1 && (
          <select aria-label="Agent" value={target} onChange={(event) => setTarget(event.target.value)}>
            <option value="" disabled>Pick an agent…</option>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.title}</option>)}
          </select>
        )}
        <button className="pull-compose__button" disabled={busy || !message || !to} onClick={() => void send()}>
          {to && agents.length === 1 ? `Send to ${to.title}` : 'Send'}
        </button>
        <button className="pull-compose__button" disabled={busy} onClick={onClose}>Close</button>
      </div>
      {outcome && <p className={outcome.ok ? 'pull-node__empty' : 'pull-compose__error'} role={outcome.ok ? 'status' : 'alert'}>{outcome.text}</p>}
    </div>
  )
}

import { useState } from 'react'
import { checkDuration, type GitHubPullCheck } from '@shared/github-pull-status'
import { CHECK_GLYPH, PullChecks } from '../../components/kanban/GitHubIssueSummaryModal'
import { pullFeedbackMessage } from '../../lib/pullFeedback'
import type { PullChecksRead } from '../../lib/pullMergeBlock'
import { isGitHubPage } from '../../lib/openPullNode'
import { NO_AGENT_TEXT } from './PullSendToAgent'
import type { ViewProps } from './shared'

/** The checks of this head, or undefined while they are loading, absent, or of another commit. */
export function headChecks(checks: PullChecksRead | undefined, head: string | undefined): GitHubPullCheck[] | undefined {
  return checks && checks !== 'loading' && checks.status === 'ok' && checks.headRefOid === head ? checks.checks : undefined
}

/** The Checks tab: every check run of the head (result, name, duration), a Log that opens the run's
 *  GitHub page in a web node, and "Send failure to agent" on a failed run. It shows the shell's one
 *  checks read (the merge box shows the same one). */
export function PullChecksTab(props: ViewProps & { checks: PullChecksRead; head: string | undefined }): React.JSX.Element {
  const { checks, head, pull, agents = [], sendUnavailable, onSendToAgent, onOpenExternal, onOpenWeb } = props
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null)
  const runs = headChecks(checks, head)
  if (!runs) {
    if (checks === null) return <p className="pull-node__empty">Checks show for an open pull request.</p>
    if (checks !== 'loading' && checks.status === 'hidden') return <p className="pull-node__empty">Your GitHub token may not read checks.</p>
    return <><PullChecks result={checks} expectedHead={head} onOpen={onOpenExternal} /></>
  }
  const why = sendUnavailable ?? (agents.length === 0 ? NO_AGENT_TEXT : undefined)
  // One linked agent needs no pick; with several, only the one picked (still linked) counts.
  const to = agents.length === 1 ? agents[0] : agents.find((agent) => agent.id === target)
  const send = async (check: GitHubPullCheck) => {
    const message = pullFeedbackMessage({ repository: pull.repository, number: pull.pullNumber },
      [{ kind: 'check', key: `check:${check.name}`, checked: true, name: check.name }])
    if (busy || !message || !to || !onSendToAgent) return
    setBusy(true)
    const refused = await onSendToAgent(to.id, message).catch(() => 'The message could not be sent.')
    setBusy(false)
    setOutcome(refused ? { ok: false, text: refused } : { ok: true, text: `Sent ${check.name} to ${to.title}.` })
  }
  return (
    <div className="pull-checks-tab">
      {runs.length === 0 && <p className="pull-node__empty">No checks on the head commit.</p>}
      {runs.some((check) => check.state === 'failed') && (why
        ? <p className="pull-node__empty">{why}</p>
        : agents.length > 1 && (
          <select aria-label="Agent" value={target} onChange={(event) => setTarget(event.target.value)}>
            <option value="" disabled>Send failures to…</option>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.title}</option>)}
          </select>
        ))}
      {runs.length > 0 && (
        <table className="pull-checks-tab__table">
          <thead><tr><th>Result</th><th>Name</th><th>Duration</th><th /></tr></thead>
          <tbody>
            {runs.map((check, index) => (
              <tr key={`${check.name}:${index}`}>
                <td>
                  <span className={`pull-status__ci--${check.state}`} aria-hidden="true">{CHECK_GLYPH[check.state]}</span> {check.state}
                </td>
                <td className="pull-checks-tab__name">{check.name}</td>
                <td>{checkDuration(check) ?? ''}</td>
                <td className="pull-checks-tab__actions">
                  {isGitHubPage(check.url) && (
                    <button className="pull-node__web" onClick={() => (onOpenWeb ?? onOpenExternal)(check.url!)}>Log</button>
                  )}
                  {check.state === 'failed' && (
                    <button className="pull-compose__button" disabled={!!why || !to || !onSendToAgent || busy}
                      onClick={() => void send(check)}>Send failure to agent</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {checks && checks !== 'loading' && checks.status === 'ok' && checks.truncated && <p className="pull-checks__note">More checks on GitHub.</p>}
      {outcome && <p className={outcome.ok ? 'pull-node__empty' : 'pull-compose__error'} role={outcome.ok ? 'status' : 'alert'}>{outcome.text}</p>}
    </div>
  )
}

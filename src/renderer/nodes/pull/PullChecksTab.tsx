import { useCallback, useState } from 'react'
import { actionsJobOf } from '@shared/github-pull-check-log'
import { checkDuration, type GitHubPullCheck, type PullCheckState } from '@shared/github-pull-status'
import type { PullWriteReason } from '@shared/github-pull-detail'
import { PullChecks } from '../../components/kanban/GitHubIssueSummaryModal'
import type { PullChecksRead } from '../../lib/pullMergeBlock'
import { isGitHubPage } from '../../lib/openPullNode'
import { Icon, type IconName } from './Icon'
import { useSendTo } from './SendTo'
import { readState, usePullRead, WRITE_TEXT, type ViewProps } from './shared'

/** The checks of this head, or undefined while they are loading, absent, or of another commit. */
export function headChecks(checks: PullChecksRead | undefined, head: string | undefined): GitHubPullCheck[] | undefined {
  return checks && checks !== 'loading' && checks.status === 'ok' && checks.headRefOid === head ? checks.checks : undefined
}

const STATE_ICON: Record<PullCheckState, IconName> = {
  passed: 'check', failed: 'x', pending: 'sync', neutral: 'issue', skipped: 'chevron-right'
}

type Props = ViewProps & { checks: PullChecksRead; head: string | undefined }

/** The Checks tab (F3): a summary line with "Re-run failed", one row per check run of the head. An
 *  Actions row expands to its failing step's log tail with "Fix with agent" and "Full log" (a web
 *  node); a check from another app has a Details link only. It shows the shell's one checks read. */
export function PullChecksTab(props: Props): React.JSX.Element {
  const { checks, head, pull, api, projectId, onOpenExternal, onOpenWeb, onWritten } = props
  const { sendTo, why, name } = useSendTo()
  // undefined = nobody toggled: the first failing Actions run is open, as the mockup shows.
  const [toggled, setToggled] = useState<string | undefined>()
  const [rerun, setRerun] = useState<{ busy?: true; refusal?: PullWriteReason; sent?: number }>({})
  const runs = headChecks(checks, head)
  if (!runs) {
    if (checks === null) return <p className="pull-node__empty">Checks show for an open pull request.</p>
    if (checks !== 'loading' && checks.status === 'hidden') return <p className="pull-node__empty">Your GitHub token may not read checks.</p>
    return <><PullChecks result={checks} expectedHead={head} onOpen={onOpenExternal} /></>
  }
  const rows = runs.map((check, index) => ({ check, key: `${check.name}:${index}`, job: actionsJobOf(check.url, pull.repository) }))
  const failed = rows.filter((row) => row.check.state === 'failed')
  const count = (state: PullCheckState) => runs.filter((check) => check.state === state).length
  const failedRuns = [...new Set(failed.flatMap((row) => row.job ? [row.job.runId] : []))]
  const shown = toggled ?? failed.find((row) => row.job)?.key
  const rerunFailed = async () => {
    setRerun({ busy: true })
    for (const runId of failedRuns) {
      const result = await api.rerunFailedJobs({ projectId, repository: pull.repository, pullNumber: pull.pullNumber, runId })
        .catch(() => ({ ok: false as const, reason: 'network' as const }))
      if (!result.ok) { setRerun({ refusal: result.reason }); return }
    }
    setRerun({ sent: failedRuns.length })
    onWritten()
  }
  const open = (url: string) => (isGitHubPage(url) ? onOpenWeb ?? onOpenExternal : onOpenExternal)(url)
  return (
    <div className="pr-checks">
      {runs.length === 0 && <p className="pull-node__empty">No checks on the head commit.</p>}
      {runs.length > 0 && (
        <div className="pr-checks__summary">
          <span>
            {failed.length > 0 && <strong>{failed.length} failing</strong>}
            <span className="pr-checks__muted">
              {failed.length > 0 && ' · '}
              {[`${count('passed')} passed`, count('pending') ? `${count('pending')} running` : '', head ? `on ${head.slice(0, 7)}` : '']
                .filter(Boolean).join(' · ')}
            </span>
          </span>
          {failedRuns.length > 0 && (
            <button className="pr-btn pr-checks__rerun" disabled={rerun.busy} onClick={() => void rerunFailed()}>
              <Icon name="refresh" size={14} />Re-run failed
            </button>
          )}
        </div>
      )}
      {rerun.refusal && <p className="pull-compose__error" role="alert">{WRITE_TEXT[rerun.refusal]}</p>}
      {rerun.sent && <p className="pr-checks__note" role="status">GitHub is re-running the failed jobs.</p>}
      {rows.length > 0 && (
        <ul className="pr-checks__list">
          {rows.map(({ check, key, job }) => {
            const expanded = !!job && shown === key
            const head = (
              <>
                <Icon name={STATE_ICON[check.state]} className={`pr-checks__state pr-checks__state--${check.state}`} label={check.state} />
                <span className="pr-checks__name">{check.name}</span>
                <span className="pr-checks__time">{checkDuration(check) ?? ''}</span>
              </>
            )
            return (
              <li key={key} className={`pr-checks__run pr-checks__run--${check.state}`}>
                {job
                  ? (
                    <button className="pr-checks__row" aria-expanded={expanded} onClick={() => setToggled(expanded ? '' : key)}>
                      {head}<Icon name={expanded ? 'chevron' : 'chevron-right'} className="pr-checks__chevron" />
                    </button>
                  )
                  : (
                    <div className="pr-checks__row">
                      {head}
                      {check.url
                        ? <button className="pr-btn pr-checks__details" onClick={() => open(check.url!)}>Details</button>
                        : <span />}
                    </div>
                  )}
                {expanded && (
                  <CheckLog {...props} jobId={job.jobId} runId={job.runId} check={check} sendTo={sendTo} why={why} onFullLog={() => open(check.url!)} />
                )}
              </li>
            )
          })}
        </ul>
      )}
      {checks && checks !== 'loading' && checks.status === 'ok' && checks.truncated && <p className="pr-checks__note">More checks on GitHub.</p>}
      {failed.length > 0 && (
        <p className="pr-checks__footer">
          {why ?? `Fix with ${name ?? 'agent'} hands the failing check to ${name ?? 'an agent'} and draws a rope to it. Nothing is pushed without your click.`}
        </p>
      )}
    </div>
  )
}

/** The log excerpt of one Actions job, read when the row opens. */
function CheckLog(props: Props & {
  jobId: number; runId: number; check: GitHubPullCheck; onFullLog: () => void
  sendTo: ReturnType<typeof useSendTo>['sendTo']; why: string | undefined
}): React.JSX.Element {
  const { api, pull, jobId, runId, check, onFullLog, sendTo, why } = props
  const { name } = useSendTo()
  const read = useCallback(
    (projectId: string, repository: string, pullNumber: number) => api.pullCheckLog(projectId, repository, pullNumber, jobId),
    [api, jobId]
  )
  const result = usePullRead(read, props)
  // ponytail: GitHub's group markers are dropped, not drawn as folds.
  const lines = result !== 'loading' && result.status === 'ok'
    ? result.lines.filter((line) => line !== '##[endgroup]').map((line) => ({
      error: line.startsWith('##[error]'), text: line.replace(/^##\[(?:error|group|warning)\]/, '')
    }))
    : undefined
  return (
    <div className="pr-checks__log">
      {result === 'loading' && <p className="pr-checks__log-state">Loading the log…</p>}
      {lines && (lines.length
        ? <pre className="pr-checks__lines">{lines.map((line, i) => <span key={i} className={line.error ? 'pr-checks__line pr-checks__line--error' : 'pr-checks__line'}>{line.text}</span>)}</pre>
        : <p className="pr-checks__log-state">This job wrote no log.</p>)}
      {result !== 'loading' && result.status !== 'ok' && readState(result, pull.repository)}
      <div className="pr-checks__log-actions">
        {check.state === 'failed' && (
          <button className="pr-btn pr-checks__fix" disabled={!sendTo} title={why}
            onClick={() => sendTo?.({ kind: 'check', name: check.name, runId })}>
            <Icon name="agent" size={14} />{`Fix with ${name ?? 'agent'}`}
          </button>
        )}
        <button className="pr-btn" onClick={onFullLog}><Icon name="external" size={14} />Full log</button>
      </div>
    </div>
  )
}

// The Checks tab's GitHub Actions extras (F-05): a failed job's log tail (core `pullCheckLog`, a read)
// and "Re-run failed" (core `rerunFailedJobs`, a write: a user click only). Both need the Actions run
// and job ids, which a check run's GitHub page URL carries. A check from another app has none.
import type { PullReadFailure, PullRefusal } from './github-pull-detail'

/** The Actions run and job a check run's page belongs to, or undefined for any other URL (another
 *  app's check, a commit status, another repository). */
export function actionsJobOf(url: string | undefined, repository: string): { runId: number; jobId: number } | undefined {
  // ponytail: GraphQL's CheckRun.detailsUrl is the job page for Actions; parsing it avoids a second id field in the checks query.
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d{1,16})\/job\/(\d{1,16})(?:[?#/]|$)/.exec(url ?? '')
  if (!match || match[1].toLowerCase() !== repository.toLowerCase()) return undefined
  const runId = Number(match[2])
  const jobId = Number(match[3])
  return Number.isSafeInteger(runId) && Number.isSafeInteger(jobId) && runId > 0 && jobId > 0 ? { runId, jobId } : undefined
}

/** The last lines of the failing step of one job, ANSI codes and timestamps removed. */
export type GitHubPullCheckLogResult =
  | { status: 'ok'; lines: string[]; observedAt: number; stale?: PullReadFailure; retryAt?: number }
  | { status: 'refused'; reason: PullRefusal }
  | { status: 'failed'; reason: PullReadFailure; retryAt?: number }

/** How many log lines the tab shows. */
export const CHECK_LOG_LINES = 60

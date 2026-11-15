import type { SessionMemoryMetric } from '@shared/types'

/**
 * What the numbers are, per measure. It has to be said: a user comparing a row against `ps` or a
 * single process in `footprint` gets a smaller number and reads the panel as wrong (field report,
 * 2026-11-04: 1.7 GB here, 538 MB for claude alone, 635 MB of tree rss).
 */
export function metricNote(metric: SessionMemoryMetric | undefined): string {
  if (metric === 'footprint')
    return 'Each row adds up its whole process tree, by physical footprint as in Activity Monitor. That includes compressed memory, so ps shows less.'
  if (metric === 'working-set')
    return 'Each row adds up its whole process tree, by working set as in Task Manager. Memory that was paged out is not counted.'
  if (metric === 'rss')
    return 'Each row adds up its whole process tree, by resident memory (RSS). Memory that was compressed or swapped out is not counted.'
  return ''
}

/** The sentence for live sessions the sweep could not measure: Zellij-backed ones (the sweep reads
 *  tmux), or — `backend: 'session-host'` — sessions of a running session host older than this app,
 *  which can name its sessions but not describe their processes. */
export function unmeasuredNote(n: number | null, backend?: 'session-host'): string {
  if (backend === 'session-host') {
    if (n === null) return 'Some sessions could not be counted; only the measured ones are listed here.'
    const what = n === 1 ? '1 session is' : `${n} sessions are`
    return `${what} running here and not measured — the running session host predates this app version. They are measured once it restarts.`
  }
  if (n === null) return 'Zellij sessions could not be counted; only tmux sessions are measured here.'
  return n === 1
    ? '1 Zellij session is running here and is not measured (the sweep reads tmux).'
    : `${n} Zellij sessions are running here and are not measured (the sweep reads tmux).`
}

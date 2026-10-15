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

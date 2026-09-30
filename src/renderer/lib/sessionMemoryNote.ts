/** The sentence for live sessions the tmux sweep could not measure (Zellij-backed). */
export function unmeasuredNote(n: number | null): string {
  if (n === null) return 'Zellij sessions could not be counted; only tmux sessions are measured here.'
  return n === 1
    ? '1 Zellij session is running here and is not measured (the sweep reads tmux).'
    : `${n} Zellij sessions are running here and are not measured (the sweep reads tmux).`
}

export type ModelSwitchProgressRowState = 'pending' | 'running' | 'ok' | 'failed'

/**
 * Auto-dismiss is deliberately narrower than "the loop finished" or "nothing timed out".
 * Refusals are rendered as failed rows too, and those are exactly the sessions the user must be
 * able to inspect and retry. Only an all-successful, non-empty batch may disappear on a timer;
 * failed/pending/running rows remain until an explicit repair or dismissal changes them.
 */
export function modelSwitchProgressCanAutoDismiss(
  rows: readonly { state: ModelSwitchProgressRowState }[] | null | undefined
): boolean {
  return !!rows?.length && rows.every((row) => row.state === 'ok')
}

/**
 * A replacement shell whose separately proven agent child died is the one failure for which the
 * initial grouped pass should repeat the full recycle once. This is exactly what the user's later
 * Retry click does, made bounded and explicit so auth/model/config failures do not loop forever.
 */
export function modelSwitchShouldAutoForceRetry(
  initialPass: boolean,
  outcome: string,
  refusalReason: string | undefined
): boolean {
  return initialPass && outcome === 'exit-timeout' && refusalReason === 'agent-not-running'
}

export interface ModelSwitchRepairVerdict {
  state: 'ok' | 'failed'
  spendAsk: boolean
}

/** Lifecycle completion is success only when the accepted launch record proves the cure. */
export function modelSwitchRepairVerdict(
  outcome: string,
  cured: boolean
): ModelSwitchRepairVerdict {
  return outcome === 'restarted' && cured
    ? { state: 'ok', spendAsk: true }
    : { state: 'failed', spendAsk: false }
}

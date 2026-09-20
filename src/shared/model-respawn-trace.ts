/**
 * One deliberately narrow trace stream for model-provider respawns.
 *
 * Callers may only supply scalar metadata that is safe to mirror into the desktop log. Never
 * pass full commands/argv, environment values, credentials, gateway URLs, session ids, or raw
 * errors here. A tmux `pane_current_command` process name is intentionally allowed: distinguishing
 * an agent process from a shell is the lifecycle fact this trace exists to diagnose. Keeping the
 * complete payload on one line also makes Electron's renderer console forwarding preserve every
 * field in `nodeterm.log`.
 */
export type ModelRespawnTraceValue = string | number | boolean | null | undefined
export type ModelRespawnTraceFields = Record<string, ModelRespawnTraceValue>

export function modelRespawnTrace(event: string, fields: ModelRespawnTraceFields = {}): void {
  const compact: Record<string, Exclude<ModelRespawnTraceValue, undefined>> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) compact[key] = value
  }
  console.info(`[model-respawn] ${event} ${JSON.stringify(compact)}`)
}

/** Error classification without leaking message text, URLs, commands, or provider responses. */
export function modelRespawnErrorKind(error: unknown): string {
  if (error instanceof Error) return error.name || 'Error'
  return error === null ? 'null' : typeof error
}

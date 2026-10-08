import type { SessionHostRequestBody } from '../session-host/protocol'

/** Socket-write failures leave delivery uncertain. Only bounded reads may be sent again. */
export function retryInterruptedSessionRead(request: SessionHostRequestBody, error: unknown): boolean {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
  if (code !== 'EPIPE' && code !== 'ECONNRESET') return false
  return ['hasSession', 'capture', 'historySearchV1', 'listSessions', 'paneCommand', 'messageOwnerV1', 'messagePasteReadyV1'].includes(request.cmd)
}

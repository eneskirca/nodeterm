import type { PtyCreateResult } from './types'

/** Shared by canvas and board: account refusal is never an SSH connection failure. */
export function ptyRefusal(unavailable: NonNullable<PtyCreateResult['unavailable']>): {
  message: string
  connectionLost: boolean
} {
  if (unavailable === 'codex-account') {
    return {
      message: 'Codex account scope is unavailable. Local managed homes must exist; SSH managed accounts are not supported yet, and SSH system accounts require a resolved remote home. Nothing was started.',
      connectionLost: false
    }
  }
  return { message: 'not connected — nothing was started locally', connectionLost: true }
}

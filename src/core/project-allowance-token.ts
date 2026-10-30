/**
 * Offline verification of the project-allowance token (spec §6) — how many open projects a free
 * install may keep, for one device, on one machine, under one policy epoch.
 *
 * Wire format, as nodeterm-server's `createAllowanceSigner` writes it: `${P}.${S}`, where
 * `P = base64url(JSON payload)` with keys `typ, deviceId, machine, allowance, epoch, iat` and
 * `S = base64url(ed25519 signature over the ASCII text of P)` — the signed bytes are the payload
 * SEGMENT, not the decoded JSON. No padding; split at the first `.`. No `exp`: the server retires
 * tokens by bumping the epoch instead.
 *
 * Same scheme as the entitlement verifier in `license.ts`, implemented separately on purpose: that
 * `verify()` is private and bound to the entitlement key, the device-id file and the `exp` clock
 * anchor, and the Pro gate it feeds should not change for a feature that only reads this token.
 */
import crypto from 'node:crypto'
import { PROJECT_ALLOWANCE_PUBLIC_KEY } from './project-allowance-key'

const PROJECT_ALLOWANCE_KIND = 'project-allowance'

export interface VerifiedAllowance {
  allowance: number
  epoch: number
}

const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0

/**
 * The token's `{ allowance, epoch }` when it is signed by `publicKeyPem`, is a project-allowance
 * token (`typ`), was minted for this `deviceId` and `machine` (and `epoch`, when given), and carries
 * a non-negative integer allowance — else null. Never throws.
 *
 * `machine: null` skips the machine match and nothing else: the caller has no OS-read machine hash
 * yet (core/project-limit.ts trusts a stored token provisionally until it has one). It is an
 * explicit null rather than an optional key so that no caller can skip the check by omission.
 */
export function verifyAllowanceToken(
  token: string | undefined,
  expect: { deviceId: string; machine: string | null; epoch?: number },
  publicKeyPem: string = PROJECT_ALLOWANCE_PUBLIC_KEY
): VerifiedAllowance | null {
  // A runtime guard, not a type one: the token comes off disk, where any JSON value can stand in.
  if (typeof token !== 'string' || !token || !publicKeyPem) return null
  const dot = token.indexOf('.')
  if (dot < 1) return null
  const p = token.slice(0, dot)
  const s = token.slice(dot + 1)
  try {
    const key = crypto.createPublicKey(publicKeyPem)
    if (!crypto.verify(null, Buffer.from(p), key, Buffer.from(s, 'base64url'))) return null
    const payload: unknown = JSON.parse(Buffer.from(p, 'base64url').toString('utf-8'))
    if (typeof payload !== 'object' || payload === null) return null
    const { typ, deviceId, machine, allowance, epoch } = payload as Record<string, unknown>
    if (typ !== PROJECT_ALLOWANCE_KIND) return null
    if (deviceId !== expect.deviceId) return null
    if (expect.machine !== null && machine !== expect.machine) return null
    if (!isCount(allowance) || !isCount(epoch)) return null
    if (expect.epoch !== undefined && epoch !== expect.epoch) return null
    return { allowance, epoch }
  } catch {
    return null
  }
}

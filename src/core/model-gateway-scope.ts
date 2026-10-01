import { hkdfSync, randomBytes } from 'node:crypto'
import {
  modelGatewayRoutes,
  resolveModelGatewayApiKey,
  type ModelGatewaySettings
} from '../shared/agents/model-gateway'

/**
 * Process-local identity for the exact gateway catalogue that supplied launch metadata.
 * The keyed digest is deliberately opaque: callers can compare scopes, but cannot recover or
 * persist the credential material that made them distinct.
 */
export type ModelGatewayDiscoveryScope = string & {
  readonly __modelGatewayDiscoveryScope: unique symbol
}

/** The extract salt for every derivation this process makes. One per PROCESS (not per call): a
 *  scope's only use is equality against another scope derived in the same process (the snapshot's
 *  stored value vs the current one), so the salt must be stable for the process lifetime — and
 *  random per launch, so a scope value observed in one run says nothing in the next. */
const scopeSalt = randomBytes(32)

/** Scope the exact resolved credential used for one request. */
export function modelGatewayDiscoveryScope(
  settings: ModelGatewaySettings,
  resolvedCredential: string
): ModelGatewayDiscoveryScope | null {
  const routes = modelGatewayRoutes(settings?.baseUrl ?? '', settings?.discoveryPath)
  const selector = settings?.apiKey?.trim() ?? ''
  const credential = resolvedCredential.trim()
  if (!routes || !selector || !credential) return null

  // JSON supplies unambiguous tuple boundaries. The digest covers both the public selector and
  // its resolved value: a literal pre-save probe cannot impersonate the saved secret sentinel,
  // while a stored-key or environment-value rotation still invalidates an otherwise unchanged
  // setting. HKDF (RFC 5869) with a per-process random salt is an extract step, not a password
  // verifier: nothing here decides authentication, the input is never re-derived from the
  // digest, and nothing is persisted — the salt lives only as long as this process, so a scope
  // is comparable exactly within it. Same primitive `core/relay/e2ee.ts` uses for session keys.
  const okm = hkdfSync(
    'sha256',
    Buffer.from(JSON.stringify([routes.discovery, selector, credential]), 'utf8'),
    scopeSalt,
    'nodeterm-model-gateway-scope-v1',
    32
  )
  return Buffer.from(okm).toString('base64url') as ModelGatewayDiscoveryScope
}

/** Scope the gateway configuration that is current in core at the instant this is called. */
export function currentModelGatewayDiscoveryScope(
  settings: ModelGatewaySettings,
  storedSecret: string | null,
  env: Record<string, string | undefined> = process.env
): ModelGatewayDiscoveryScope | null {
  const resolved = resolveModelGatewayApiKey(settings?.apiKey ?? '', env, storedSecret)
  if (resolved.missing.length || resolved.storedSecretMissing) return null
  return modelGatewayDiscoveryScope(settings, resolved.value)
}

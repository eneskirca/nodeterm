import { randomBytes } from 'node:crypto'
import {
  modelGatewayRoutes,
  resolveModelGatewayApiKey,
  type ModelGatewaySettings
} from '../shared/agents/model-gateway'

/**
 * Process-local identity for the exact gateway catalogue that supplied launch metadata.
 * The scope is deliberately opaque: callers can compare scopes, but cannot recover or
 * persist the credential material that made them distinct.
 */
export type ModelGatewayDiscoveryScope = string & {
  readonly __modelGatewayDiscoveryScope: unique symbol
}

/**
 * Random stand-in per distinct resolved credential, keyed by the process-local table below.
 * The credential itself is NEVER digested — a scope is an identity for comparison, not a
 * derived value anyone (including this process) needs to reconstruct from the secret — so the
 * table lives only as long as the process and holds only tokens this module minted.
 */
const credentialTokens = new Map<string, string>()

/** Scope the exact resolved credential used for one request. */
export function modelGatewayDiscoveryScope(
  settings: ModelGatewaySettings,
  resolvedCredential: string
): ModelGatewayDiscoveryScope | null {
  const routes = modelGatewayRoutes(settings?.baseUrl ?? '', settings?.discoveryPath)
  const selector = settings?.apiKey?.trim() ?? ''
  const credential = resolvedCredential.trim()
  if (!routes || !selector || !credential) return null

  // The tuple identifies (route, selector, credential) WITHOUT hashing the credential: a random
  // per-distinct-value stand-in takes its place in the identity, so a literal pre-save probe
  // cannot impersonate the saved secret sentinel (different selector ⇒ different tuple), while a
  // stored-key or environment-value rotation still invalidates an otherwise unchanged setting
  // (a new value mints a new token). Two scopes compare equal iff all three parts match.
  let token = credentialTokens.get(credential)
  if (!token) {
    token = randomBytes(16).toString('base64url')
    credentialTokens.set(credential, token)
    // Bounded: each distinct gateway credential the process resolves gets one entry. A settings
    // rotation replaces, never accumulates, so a handful of entries is the realistic ceiling.
    if (credentialTokens.size > 32) {
      const oldest = credentialTokens.keys().next().value
      if (oldest !== undefined) credentialTokens.delete(oldest)
    }
  }
  return JSON.stringify([routes.discovery, selector, token]) as ModelGatewayDiscoveryScope
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

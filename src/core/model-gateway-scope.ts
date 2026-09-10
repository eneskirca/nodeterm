import { createHmac, randomBytes } from 'node:crypto'
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

const scopeKey = randomBytes(32)

/** Scope the exact resolved credential used for one request. */
export function modelGatewayDiscoveryScope(
  settings: ModelGatewaySettings,
  resolvedCredential: string
): ModelGatewayDiscoveryScope | null {
  const routes = modelGatewayRoutes(settings?.baseUrl ?? '', settings?.discoveryPath)
  const selector = settings?.apiKey?.trim() ?? ''
  const credential = resolvedCredential.trim()
  if (!routes || !selector || !credential) return null

  // JSON supplies unambiguous tuple boundaries. The HMAC covers both the public selector and its
  // resolved value: a literal pre-save probe cannot impersonate the saved secret sentinel, while a
  // stored-key or environment-value rotation still invalidates an otherwise unchanged setting.
  return createHmac('sha256', scopeKey)
    .update(JSON.stringify([routes.discovery, selector, credential]))
    .digest('base64url') as ModelGatewayDiscoveryScope
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

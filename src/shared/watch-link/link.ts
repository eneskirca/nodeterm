// The viewer URL: https://nodeterm.dev/s/<linkId>#1.<S>. The id names a link and unlocks nothing;
// S is in the FRAGMENT so it never reaches an HTTP request, a server log or a referrer.
import { b64urlToBytes, bytesToB64url } from './bytes'
import { WATCH_LINK_SECRET_BYTES } from './keys'

export const WATCH_LINK_ORIGIN = 'https://nodeterm.dev'
export const WATCH_LINK_FRAGMENT_VERSION = '1'
export const LINK_ID_RE = /^[A-Za-z0-9_-]{22}$/

/** A scheme and a host (and a port), nothing else: a path, query or fragment here would change what
 *  the URL names, or put the secret somewhere other than the fragment. */
const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/

/**
 * The viewer URL for a link. Throws on an input that would not make one — an id `parseWatchLinkLocation`
 * would refuse, a secret of the wrong length, an origin that is more than an origin — rather than
 * format a link nobody can open (or one whose secret leaves the fragment).
 */
export function formatWatchLink(linkId: string, secret: Uint8Array, origin: string = WATCH_LINK_ORIGIN): string {
  if (typeof linkId !== 'string' || !LINK_ID_RE.test(linkId)) throw new Error('A live link id is 22 base64url characters.')
  if (!secret || secret.length !== WATCH_LINK_SECRET_BYTES) throw new Error('A live link secret is 32 bytes.')
  if (typeof origin !== 'string' || !ORIGIN_RE.test(origin)) throw new Error('A live link origin is a scheme and a host.')
  return `${origin}/s/${linkId}#${WATCH_LINK_FRAGMENT_VERSION}.${bytesToB64url(secret)}`
}

export function parseWatchLinkLocation(pathname: string, hash: string): { linkId: string; secret: Uint8Array } | null {
  const m = /^\/s\/([^/]+)\/?$/.exec(pathname)
  if (!m || !LINK_ID_RE.test(m[1])) return null
  const frag = hash.startsWith('#') ? hash.slice(1) : hash
  const dot = frag.indexOf('.')
  if (dot < 0 || frag.slice(0, dot) !== WATCH_LINK_FRAGMENT_VERSION) return null
  const secret = b64urlToBytes(frag.slice(dot + 1))
  if (!secret || secret.length !== WATCH_LINK_SECRET_BYTES) return null
  return { linkId: m[1], secret }
}

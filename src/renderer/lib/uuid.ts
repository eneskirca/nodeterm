/**
 * RFC 4122 v4 UUID from crypto.getRandomValues.
 *
 * `crypto.randomUUID()` exists only in secure contexts (HTTPS / localhost), so it is
 * undefined in the Server Edition served over plain HTTP on a LAN — a click that calls
 * it throws silently and nothing happens. `crypto.getRandomValues` is available in
 * every context, so this helper works identically in Electron, the browser server, and
 * tests. Keep using it for ids that must not depend on the page's context.
 */
export function uuid(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40 // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // variant 10
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

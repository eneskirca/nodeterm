/** Keep untrusted identity/path formatting visible in native human confirmations. */
export function quoteIdentityValue(value: string): string {
  return JSON.stringify(value).replace(/[\p{Cf}\u2028\u2029]/gu,
    character => `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`)
}

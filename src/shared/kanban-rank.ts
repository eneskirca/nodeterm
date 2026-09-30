/**
 * Rank strings for board order — fractional indexing over base-62 digits.
 *
 * A card's position in a column is a string key compared with PLAIN string order (UTF-16 code
 * units; every key is ASCII, so byte order on every other surface agrees). Between any two distinct
 * keys there is always another, so moving one card writes one card's key: no neighbour renumbering,
 * no gap exhaustion, no rebalancing — which is what lets a move be a small diff that git merges
 * across machines (the board is git-shared).
 *
 * Key shape: an INTEGER part followed by an optional FRACTION.
 *  - The integer part is a head letter plus digits; the head says how many digits follow
 *    (`a`..`z` → 1..26 digits, ascending; `A`..`Z` → 26..1 digits, the negative range). Stepping the
 *    integer is what a "before the first" / "after the last" insert does, so the board's default —
 *    an unanchored move lands at the TOP — costs a decrement, not a longer key: a thousand
 *    consecutive top inserts stay four characters long. A plain digit-string scheme grows by one
 *    character every few top inserts instead.
 *  - The fraction is the midpoint between two keys that share an integer part; it never ends in
 *    the zero digit, so there is always room before it.
 *
 * `isValidRank` is the gate for anything read from a file: a key a hand edit mangled is treated as
 * ABSENT by the readers (the card's position then derives from array order), never fed to the
 * generator, which refuses it.
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const ZERO = DIGITS[0]
const LAST = DIGITS[DIGITS.length - 1]
/** The smallest integer part. Reserved: nothing may sort before it, so nothing may BE it — but a
 *  key may carry it with a fraction (`A00…0V`), which sorts after it: that is the room below the
 *  lowest plain integer, and without it `rankBetween(null, 'A00…01')` had no valid answer. */
const SMALLEST_INTEGER = `A${ZERO.repeat(26)}`
/** Longer than any key a board will ever mint; beyond it a "rank" is garbage, not a position. */
export const RANK_MAX_LENGTH = 256

const digitValue = (c: string): number => DIGITS.indexOf(c)

/** Digits after the head letter, or -1 for a character that is not a head. */
function integerDigits(head: string): number {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 'a'.charCodeAt(0) + 1
  if (head >= 'A' && head <= 'Z') return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 1
  return -1
}

function integerPart(key: string): string {
  const n = integerDigits(key[0] ?? '')
  if (n < 0 || key.length < n + 1) throw new Error(`invalid rank: ${key}`)
  return key.slice(0, n + 1)
}

/** Is `x` a rank this module could have minted (and can therefore extend)? Never throws. */
export function isValidRank(x: unknown): x is string {
  if (typeof x !== 'string' || x.length === 0 || x.length > RANK_MAX_LENGTH) return false
  for (const c of x) if (digitValue(c) === -1) return false
  const n = integerDigits(x[0])
  if (n < 0 || x.length < n + 1) return false
  if (x === SMALLEST_INTEGER) return false
  return !x.slice(n + 1).endsWith(ZERO)
}

/** A fraction strictly between `a` and `b` (`b` null = open-ended). Neither ends in ZERO. */
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    // Skip the common prefix (a is right-padded with zeros for the comparison).
    let n = 0
    while ((a[n] ?? ZERO) === b[n]) n++
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n))
  }
  const da = a ? digitValue(a[0]) : 0
  const db = b !== null ? digitValue(b[0]) : DIGITS.length
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)]
  // Adjacent digits: take a's first digit and recurse into the tail.
  if (b !== null && b.length > 1) return b.slice(0, 1)
  return DIGITS[da] + midpoint(a.slice(1), null)
}

function stepInteger(x: string, dir: 1 | -1): string | null {
  const head = x[0]
  const digits = x.slice(1).split('')
  let carry = true
  for (let i = digits.length - 1; carry && i >= 0; i--) {
    const d = digitValue(digits[i]) + dir
    if (d === DIGITS.length) digits[i] = ZERO
    else if (d === -1) digits[i] = LAST
    else {
      digits[i] = DIGITS[d]
      carry = false
    }
  }
  if (!carry) return head + digits.join('')
  if (dir === 1) {
    if (head === 'Z') return `a${ZERO}`
    if (head === 'z') return null
    const next = String.fromCharCode(head.charCodeAt(0) + 1)
    if (next > 'a') digits.push(ZERO)
    else digits.pop()
    return next + digits.join('')
  }
  if (head === 'a') return `Z${LAST}`
  if (head === 'A') return null
  const next = String.fromCharCode(head.charCodeAt(0) - 1)
  if (next < 'Z') digits.push(LAST)
  else digits.pop()
  return next + digits.join('')
}

/**
 * A key strictly between `a` and `b`; `null` means open on that side (`rankBetween(null, null)` is
 * a first key). Throws for an invalid key or `a >= b` — the caller is expected to have normalized
 * its neighbours first, and inventing an order here would hide a bug.
 */
export function rankBetween(a: string | null, b: string | null): string {
  if (a !== null && !isValidRank(a)) throw new Error(`invalid rank: ${a}`)
  if (b !== null && !isValidRank(b)) throw new Error(`invalid rank: ${b}`)
  if (a !== null && b !== null && a >= b) throw new Error(`rank ${a} is not before ${b}`)
  if (a === null) {
    if (b === null) return `a${ZERO}`
    const ib = integerPart(b)
    const fb = b.slice(ib.length)
    if (ib === SMALLEST_INTEGER) return ib + midpoint('', fb)
    if (ib < b) return ib
    const down = stepInteger(ib, -1)
    if (down === null) throw new Error('rank space exhausted below')
    // Stepping down onto the reserved integer: the key goes just under `b` with a fraction.
    return down === SMALLEST_INTEGER ? down + midpoint('', null) : down
  }
  if (b === null) {
    const ia = integerPart(a)
    const up = stepInteger(ia, 1)
    return up === null ? ia + midpoint(a.slice(ia.length), null) : up
  }
  const ia = integerPart(a)
  const ib = integerPart(b)
  if (ia === ib) return ia + midpoint(a.slice(ia.length), b.slice(ib.length))
  const up = stepInteger(ia, 1)
  if (up === null) throw new Error('rank space exhausted above')
  return up < b ? up : ia + midpoint(a.slice(ia.length), null)
}

/** `n` ascending keys strictly between `a` and `b` (same open-ended rules as `rankBetween`). */
export function ranksBetween(a: string | null, b: string | null, n: number): string[] {
  if (n <= 0) return []
  if (n === 1) return [rankBetween(a, b)]
  if (b === null) {
    const out: string[] = []
    let k = a
    for (let i = 0; i < n; i++) out.push((k = rankBetween(k, null)))
    return out
  }
  if (a === null) {
    const out: string[] = []
    let k: string | null = b
    for (let i = 0; i < n; i++) out.push((k = rankBetween(null, k)))
    return out.reverse()
  }
  const half = Math.floor(n / 2)
  const mid = rankBetween(a, b)
  return [...ranksBetween(a, mid, half), mid, ...ranksBetween(mid, b, n - half - 1)]
}

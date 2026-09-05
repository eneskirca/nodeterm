/** A single HTTP byte range. Malformed/multi-range requests are ignored (200);
 * valid but unsatisfiable requests return 416. Suffix ranges count back from EOF. */
export function mediaRange(header: string | null, size: number):
  { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (!m[1] && !m[2])) return null
  const first = m[1] ? Number(m[1]) : undefined
  const last = m[2] ? Number(m[2]) : undefined
  if ((first !== undefined && !Number.isSafeInteger(first)) ||
      (last !== undefined && !Number.isSafeInteger(last))) return 'unsatisfiable'
  if (size === 0) return 'unsatisfiable'
  if (first === undefined) {
    if (!last) return 'unsatisfiable'
    return { start: Math.max(0, size - last), end: size - 1 }
  }
  if (first >= size || (last !== undefined && last < first)) return 'unsatisfiable'
  return { start: first, end: Math.min(last ?? size - 1, size - 1) }
}

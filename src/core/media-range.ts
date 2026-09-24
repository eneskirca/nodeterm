/** One HTTP byte range. Unsupported/malformed ranges are ignored (serve 200), while a valid
 * but unsatisfiable range returns 416. Never pass reversed or unsafe offsets to fs streams. */
export function mediaRange(header: string | null, size: number):
  | { kind: 'full' }
  | { kind: 'unsatisfiable' }
  | { kind: 'partial'; start: number; end: number } {
  const m = header && /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (!m[1] && !m[2])) return { kind: 'full' }
  const first = m[1] ? Number(m[1]) : undefined
  const last = m[2] ? Number(m[2]) : undefined
  if ((first !== undefined && !Number.isSafeInteger(first)) ||
      (last !== undefined && !Number.isSafeInteger(last))) return { kind: 'full' }
  if (first !== undefined && last !== undefined && last < first) return { kind: 'full' }
  if (size === 0 || (first !== undefined && first >= size) ||
      (first === undefined && last === 0)) return { kind: 'unsatisfiable' }
  return {
    kind: 'partial',
    start: first ?? Math.max(0, size - last!),
    end: first === undefined ? size - 1 : Math.min(last ?? size - 1, size - 1)
  }
}

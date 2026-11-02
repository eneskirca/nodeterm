// The ⌘M thread's Edit/Write diff (nodes/ChatToolDiff.tsx): the line-by-line change a tool call
// asked for, from the old and new text the parser read off its input (`ChatToolDiff`, shared/types).
// No React — see chatDiff.test.ts for the pins.

export type DiffLine = { kind: 'ctx' | 'add' | 'del'; text: string }

/**
 * The largest old × new line product diffed properly. The table is O(n·m) in time and memory, and
 * each side can be a 64K-character text (`capText`), so past this an edit is shown as every old line
 * removed, then every new line added — still the whole change, just without the pairing.
 */
export const LINE_DIFF_MAX_CELLS = 250_000

/** The text's lines; a trailing newline ends the last line rather than starting an empty one. */
function linesOf(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** A line-level diff of `oldText` → `newText`: the longest common subsequence of lines is context. */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = linesOf(oldText)
  const b = linesOf(newText)
  const n = a.length
  const m = b.length
  if (n * m > LINE_DIFF_MAX_CELLS) {
    return [...a.map((text): DiffLine => ({ kind: 'del', text })), ...b.map((text): DiffLine => ({ kind: 'add', text }))]
  }
  // lcs[i * w + j] = the LCS length of a[i..] and b[j..].
  const w = m + 1
  const lcs = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'ctx', text: a[i] })
      i++
      j++
    } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
      // On a tie the removal comes first, so a replaced line reads `-old` then `+new`.
      out.push({ kind: 'del', text: a[i++] })
    } else {
      out.push({ kind: 'add', text: b[j++] })
    }
  }
  while (i < n) out.push({ kind: 'del', text: a[i++] })
  while (j < m) out.push({ kind: 'add', text: b[j++] })
  return out
}

/** The summary's `+N −M`: lines added and removed (context counts as neither). */
export function diffCounts(lines: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const l of lines) {
    if (l.kind === 'add') added++
    else if (l.kind === 'del') removed++
  }
  return { added, removed }
}

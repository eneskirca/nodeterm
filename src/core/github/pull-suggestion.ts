// "Apply suggestion": the lines of a review comment's suggestion block, and the file with them in place.

/** The lines of a comment's first ```suggestion block; [] = delete the lines. Null = no block.
 *  ponytail: a fence of exactly three backticks, as GitHub's "Insert a suggestion" writes it. */
export function suggestionOf(body: string): string[] | null {
  const lines = body.split(/\r?\n/)
  const open = lines.findIndex((line) => line.trim() === '```suggestion')
  if (open < 0) return null
  const close = lines.findIndex((line, index) => index > open && line.trim() === '```')
  return close < 0 ? null : lines.slice(open + 1, close)
}

/** `text` with lines `start`..`end` (1-based, inclusive) replaced, its line ending kept. Null = the
 *  range is not in the file (it changed). */
export function withSuggestion(text: string, start: number, end: number, replacement: readonly string[]): string | null {
  const lines = text.split(/\r?\n/)
  const count = lines.at(-1) === '' ? lines.length - 1 : lines.length
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > count) return null
  lines.splice(start - 1, end - start + 1, ...replacement)
  return lines.join(text.includes('\r\n') ? '\r\n' : '\n')
}

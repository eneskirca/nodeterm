// The ⌘M composer's command highlight (ChatComposer): Claude Code's TUI colors a `/name` in its
// input when the name is a real command (measured on 2.1.318: a skill's `/name` mid-sentence is colored,
// `/notaskill` stays plain). A textarea cannot color part of its text, so the composer draws these
// segments in a layer behind it — only while the draft holds a known command, so an ordinary draft
// renders exactly as before.

export interface ComposerSegment {
  text: string
  command: boolean
}

/** A `/name` at the start of the text or after whitespace (the places the `/` menu opens). */
const COMMAND_RE = /(^|\s)(\/[A-Za-z0-9._:-]+)/g

/** The draft cut into plain text and known `/commands`. Null when it holds none, so the caller can
 *  leave the plain textarea alone. */
export function commandSegments(text: string, known: ReadonlySet<string>): ComposerSegment[] | null {
  const out: ComposerSegment[] = []
  let from = 0
  let found = false
  for (const m of text.matchAll(COMMAND_RE)) {
    const start = (m.index ?? 0) + m[1].length
    const token = m[2]
    if (!known.has(token.slice(1))) continue
    // The token must end the word: `/explainx` is not `/explain`.
    const next = text[start + token.length]
    if (next !== undefined && !/\s/.test(next)) continue
    if (start > from) out.push({ text: text.slice(from, start), command: false })
    out.push({ text: token, command: true })
    from = start + token.length
    found = true
  }
  if (!found) return null
  if (from < text.length) out.push({ text: text.slice(from), command: false })
  return out
}

/** Whether the draft holds a `/x` the catalog should be fetched for (to color it). */
export function mentionsSlashToken(text: string): boolean {
  return /(^|\s)\/[A-Za-z0-9]/.test(text)
}

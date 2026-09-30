// Pure decisions behind the ⌘M composer's completion menu (ChatComposer): what the caret is in the
// middle of (`/command` at the start of the message, or an `@path` token anywhere), what the menu
// lists, and what accepting an item does to the draft. It only ever INSERTS text: sending stays the
// composer's existing gated send (`chatSendRefusal`), so completing `/clear` types nothing into the
// pane until the user presses Enter a second time on a message the gate allows.
import { rankCatalog, type ChatCatalogEntry } from '@shared/chat-catalog'
import { isSafeQuickOpenRelPath } from '@shared/quick-open-filter'
import { rankQuickOpenFiles, type QuickOpenIndexedFile } from './quickOpenSearch'

export type CompletionKind = 'slash' | 'file'

export interface CompletionTrigger {
  kind: CompletionKind
  /** What the user has typed after the `/` or `@`. */
  query: string
  /** Offsets of the whole token (the `/` or `@` included) in the draft. */
  start: number
  end: number
}

const NAME_CHAR = /[A-Za-z0-9._:-]/

/**
 * The token the caret is in, or null. A slash command is only a command at the very start of the
 * message (after optional whitespace) — every CLI measured reads `/x` mid-sentence as text — so
 * `see /usr` never opens the menu. An `@` opens it at the start of a word only, so an e-mail address
 * (`a@b`) does not. A selection (caret range) never completes.
 */
export function completionTriggerAt(text: string, caret: number, selectionEnd = caret): CompletionTrigger | null {
  if (caret !== selectionEnd || caret < 0 || caret > text.length) return null
  const before = text.slice(0, caret)
  const after = text.slice(caret)
  const slash = /^(\s*)\/([A-Za-z0-9._:-]*)$/.exec(before)
  if (slash) {
    let end = caret
    while (end < text.length && NAME_CHAR.test(text[end])) end++
    return { kind: 'slash', query: slash[2], start: slash[1].length, end }
  }
  const at = /(^|\s)@([^\s@]*)$/.exec(before)
  if (at) {
    const start = caret - at[2].length - 1
    const rest = /^[^\s]*/.exec(after)?.[0] ?? ''
    return { kind: 'file', query: at[2], start, end: caret + rest.length }
  }
  return null
}

/** Accepting an item: the token is replaced by `/name ` or `@path `, the caret lands after it. No
 *  second space when one already follows. */
export function applyCompletion(text: string, t: CompletionTrigger, value: string): { text: string; caret: number } {
  const token = (t.kind === 'slash' ? '/' : '@') + value
  const next = text.slice(t.end)
  const insert = /^\s/.test(next) ? token : token + ' '
  return { text: text.slice(0, t.start) + insert + next, caret: t.start + insert.length }
}

export const FILE_RESULT_LIMIT = 30

// Whitespace, control and format characters: a path holding one is not offered (it would be typed
// into the agent's pane on send, and a control byte in a file name is a sequence, not a name).
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNTYPEABLE = /[\s\x00-\x1f\x7f-\x9f\p{Cf}]/u

/** The `@` list: the node's file index ranked by the SAME fuzzy ranker as quick open. A path with
 *  whitespace (or a control / format character) is left out — `@a b.md` would read as `@a` plus a
 *  word, and no CLI we measured documents a quoting rule for it; a path that fails the traversal guard is left out too (an SSH
 *  index is remote-supplied). */
export function rankFileCompletions(index: readonly QuickOpenIndexedFile[], query: string, limit = FILE_RESULT_LIMIT): string[] {
  const out: string[] = []
  for (const r of rankQuickOpenFiles(query, index, limit * 2)) {
    if (UNTYPEABLE.test(r.path) || !isSafeQuickOpenRelPath(r.path)) continue
    out.push(r.path)
    if (out.length >= limit) break
  }
  return out
}

export type CompletionItem =
  | { kind: 'slash'; value: string; entry: ChatCatalogEntry }
  | { kind: 'file'; value: string }

export function completionItems(
  t: CompletionTrigger | null,
  catalog: readonly ChatCatalogEntry[],
  files: readonly QuickOpenIndexedFile[] | null
): CompletionItem[] {
  if (!t) return []
  if (t.kind === 'slash') return rankCatalog(catalog, t.query).map((entry) => ({ kind: 'slash', value: entry.name, entry }))
  if (!files) return []
  return rankFileCompletions(files, t.query).map((value) => ({ kind: 'file', value }))
}

/** A short, human label for where an entry came from — never the path it was read from. */
export function catalogEntryTag(e: ChatCatalogEntry): string {
  if (e.kind === 'skill') return e.scope === 'project' ? 'project skill' : 'skill'
  if (e.kind === 'command') return e.scope === 'project' ? 'project command' : 'command'
  return ''
}

/** How long a fetched catalog / file index is reused within one composer before the next `/` or
 *  `@` asks again. Not a poll: nothing is fetched unless the user opens the menu. Core's own mtime
 *  cache makes a re-ask of an unchanged folder cost stats, not reads. */
export const CATALOG_REUSE_MS = 30_000

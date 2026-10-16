/* Codex hook trust core. The hash serialization in computeTrustedHash() must
 * stay byte-identical to codex-rs or Codex silently
 * rejects the hook (it sits in the "review required" pile and never fires).
 *
 * Self-contained: only node fs/path/crypto. We port just the functions our
 * installer needs (trust hashing/keys, byte-preserving config.toml edits) and
 * deliberately drop the project-trust path (upsertProjectTrustLevel) — out
 * of scope. The rename itself goes through core/fs-atomic.ts.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { dirname, join } from 'path'
import { createHash, randomUUID } from 'crypto'
import { renameAtomicSync } from '../../fs-atomic'

// Why: Codex 0.129+ gates each hook on a `trusted_hash` entry in
// ~/.codex/config.toml under [hooks.state."<key>"]. Without it the hook is in
// the "review required" pile and never fires, so the agent-status badge
// silently goes blank. We reproduce Codex's hash so install() can register
// trust the same way `/hooks` would. Algorithm reverse-engineered from
// codex-rs/hooks/src/engine/discovery.rs (command_hook_hash) +
// codex-rs/config/src/fingerprint.rs (version_for_toml).

export type CodexEventLabel =
  | 'pre_tool_use'
  | 'permission_request'
  | 'post_tool_use'
  | 'pre_compact'
  | 'post_compact'
  | 'session_start'
  | 'user_prompt_submit'
  | 'stop'
  | 'subagent_start'
  | 'subagent_stop'

export type CodexTrustEntry = {
  /** Path on disk to the hooks.json that declares the hook (the "key_source"). */
  sourcePath: string
  /** Codex event label (snake_case). */
  eventLabel: CodexEventLabel
  /** 0-based index of the matcher group within the event array. */
  groupIndex: number
  /** 0-based index of the handler within the matcher group's `hooks` array. */
  handlerIndex: number
  /** The exact `command` string written to hooks.json. */
  command: string
  /** Effective timeout in seconds. When undefined, defaults to 600.
   *  Explicit values are clamped to a minimum of 1. */
  timeoutSec?: number
  /** Whether the handler is async. Defaults to false. */
  async?: boolean
  /** Optional matcher pattern (only meaningful for events that support it). */
  matcher?: string
  /** Optional statusMessage field. */
  statusMessage?: string
}

export type CodexHookTrustState = {
  trustedHash?: string
  enabled?: boolean
}

// Why: matches Codex's canonical_json. Sorts object keys recursively before
// SHA-256ing; arrays preserve order.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

// Why: reproduces command_hook_hash. NormalizedHookIdentity has `group:
// MatcherGroup` flattened in, so the wire shape is { event_name, matcher?,
// hooks: [<normalized handler>] }. `matcher` is omitted (not null) when
// absent — Rust's Option<String>=None drops through the TOML→JSON path.
// Handler is normalized to timeout=600 (or explicit, min 1) and async=false.
export function computeTrustedHash(entry: CodexTrustEntry): string {
  const handler: Record<string, unknown> = {
    type: 'command',
    command: entry.command,
    timeout: Math.max(1, entry.timeoutSec ?? 600),
    async: entry.async ?? false
  }
  if (entry.statusMessage !== undefined) {
    handler.statusMessage = entry.statusMessage
  }
  const identity: Record<string, unknown> = {
    event_name: entry.eventLabel,
    hooks: [handler]
  }
  if (entry.matcher !== undefined) {
    identity.matcher = entry.matcher
  }
  const serialized = JSON.stringify(canonicalize(identity))
  return `sha256:${createHash('sha256').update(serialized).digest('hex')}`
}

export function computeTrustKey(entry: CodexTrustEntry): string {
  return `${getCodexCanonicalTrustPath(entry.sourcePath)}:${entry.eventLabel}:${entry.groupIndex}:${entry.handlerIndex}`
}

export function getCodexCanonicalTrustPath(sourcePath: string): string {
  try {
    // Why: Codex canonicalizes trust paths before building config keys. On
    // macOS, /var is a symlink to /private/var; trusting the raw path still
    // leaves the TUI in review/trust prompts.
    return realpathSync.native(sourcePath)
  } catch {
    return sourcePath
  }
}

export function parseTrustKey(key: string): {
  sourcePath: string
  eventLabel: CodexEventLabel
  groupIndex: number
  handlerIndex: number
} | null {
  // Why: keys have shape `<sourcePath>:<eventLabel>:<groupIdx>:<handlerIdx>`.
  // sourcePath itself may contain `:` (Windows drive letters), so anchor the
  // parse at the LAST three colons rather than the first.
  const lastColon = key.lastIndexOf(':')
  if (lastColon === -1) {
    return null
  }
  const handlerStr = key.slice(lastColon + 1)
  if (!isCanonicalNonNegativeInt(handlerStr)) {
    return null
  }
  const secondLast = key.lastIndexOf(':', lastColon - 1)
  if (secondLast === -1) {
    return null
  }
  const groupStr = key.slice(secondLast + 1, lastColon)
  if (!isCanonicalNonNegativeInt(groupStr)) {
    return null
  }
  const thirdLast = key.lastIndexOf(':', secondLast - 1)
  if (thirdLast === -1) {
    return null
  }
  const eventLabel = key.slice(thirdLast + 1, secondLast)
  if (!isCodexEventLabel(eventLabel)) {
    return null
  }
  const sourcePath = key.slice(0, thirdLast)
  if (sourcePath.length === 0) {
    return null
  }
  return {
    sourcePath,
    eventLabel,
    groupIndex: Number(groupStr),
    handlerIndex: Number(handlerStr)
  }
}

// Why: Number('') === 0 and Number('1e2') === 100 both pass Number.isInteger,
// so reject any non-canonical decimal form before numeric conversion.
function isCanonicalNonNegativeInt(value: string): boolean {
  return /^(0|[1-9]\d*)$/.test(value)
}

function isCodexEventLabel(value: string): value is CodexEventLabel {
  return (
    value === 'pre_tool_use' ||
    value === 'permission_request' ||
    value === 'post_tool_use' ||
    value === 'pre_compact' ||
    value === 'post_compact' ||
    value === 'session_start' ||
    value === 'user_prompt_submit' ||
    value === 'stop'
  )
}

// Why: TOML 1.0 forbids BOMs but real-world editors (especially on Windows) sometimes
// write them. A leading ﻿ would break header regexes anchored at `^[ \t]*\[`, so
// strip it once at the file boundary and let the rest of the parser stay simple.
export function readTomlFile(configPath: string): string {
  const raw = readFileSync(configPath, 'utf-8')
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
}

// Why: regex-edit ~/.codex/config.toml rather than parse + reserialize. The
// file is hand-edited by users (and other tools) and a round-trip through
// any TOML library would lose comments, key ordering, and inline-table
// style. We only ever (a) replace an existing [hooks.state."<key>"] block
// keyed by *our* known hook keys, or (b) append a new block at EOF. Other
// content is byte-preserved.
// Why: this is a read-modify-write with no inter-process lock. Codex CLI's
// /hooks flow also writes [hooks.state.*] blocks in this file, so two
// concurrent writers can lose each other's edits. writeConfigAtomically
// prevents partial writes but not lost updates. install() is idempotent
// (deterministic hashes), so the next install() repairs drift.
export function upsertHookTrustEntries(
  configPath: string,
  entries: readonly CodexTrustEntry[]
): void {
  const existing = existsSync(configPath) ? readTomlFile(configPath) : ''
  const updated = upsertHookTrustEntriesInContent(existing, entries)
  if (updated === existing) {
    return
  }
  writeConfigAtomically(configPath, updated)
}

export function upsertHookTrustEntriesInContent(
  existingContent: string,
  entries: readonly CodexTrustEntry[]
): string {
  const existing =
    existingContent.charCodeAt(0) === 0xfeff ? existingContent.slice(1) : existingContent
  let updated = existing
  for (const entry of entries) {
    updated = upsertTrustBlock(updated, computeTrustKey(entry), computeTrustedHash(entry))
  }
  // Never hand back a config Codex refuses to load: one WE changed must not carry a table defined
  // twice ("duplicate key" = codex will not start). Throws; every caller fails open.
  if (updated !== existing) assertTomlTablesUnique(updated)
  return updated
}

// Why: build the canonical block we own. The two field names mirror what
// Codex itself writes when the user approves via /hooks (HookStateToml
// fields). `enabled` is plumbed through so an existing user-set
// `enabled = false` survives reinstall.
function buildTrustBlock(key: string, hash: string, enabled: boolean): string {
  return [
    `[hooks.state."${escapeTomlString(key)}"]`,
    `enabled = ${enabled}`,
    `trusted_hash = "${escapeTomlString(hash)}"`
  ].join('\n')
}

// Why: TOML basic strings forbid raw control chars; escape backslash first so
// later substitutions don't double-escape the inserted backslashes.
export function escapeTomlString(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\b', '\\b')
    .replaceAll('\f', '\\f')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')
}

function upsertTrustBlock(content: string, key: string, hash: string): string {
  const ranges = findTrustBlockRanges(content, key)
  if (ranges.length === 0) {
    const block = buildTrustBlock(key, hash, true)
    if (content.length === 0) {
      return `${block}\n`
    }
    // Why: leave one blank line before our appended block so the file stays
    // readable, but don't compound separators when the file already ends in
    // a blank line.
    const separator = content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n'
    return `${content}${separator}${block}\n`
  }

  // Why: preserve a user-set `enabled = false` so a hand-disabled hook is not
  // silently re-enabled by the next auto-install on app start.
  // If duplicate blocks already exist, treat any disabled copy as authoritative
  // while collapsing the malformed TOML back to one table.
  const enabled = !ranges.some((range) => {
    const existingBlock = content.slice(range.headerLineEnd, range.end)
    const enabledMatch = /^[ \t]*enabled[ \t]*=[ \t]*(true|false)[ \t\r]*(?:#.*)?$/m.exec(
      existingBlock
    )
    return enabledMatch?.[1] === 'false'
  })
  const block = buildTrustBlock(key, hash, enabled)
  let cursor = 0
  let deduped = ''
  ranges.forEach((range, index) => {
    deduped += content.slice(cursor, range.start)
    if (index === 0) {
      deduped += `${block}\n`
    }
    cursor = range.end
  })
  return deduped + content.slice(cursor)
}

// Why: a header is matched by its DECODED key path, never by spelling. Codex (or another tool)
// may write the same table as `[hooks.state.'C:\…']` (literal string) where we write
// `[hooks.state."C:\\…"]` (basic string) — one key to TOML. Matching only our spelling made a
// repair APPEND a second table for that key, and Codex then refused to start ("duplicate key";
// measured on a Windows desktop, 2026-10-07). The caller applies this only to complete physical
// lines outside TOML multi-line strings.
function isTrustHeaderFor(line: string, key: string): boolean {
  const path = tableHeaderPath(line)
  return (
    path !== null &&
    path.length === 3 &&
    path[0] === 'hooks' &&
    path[1] === 'state' &&
    path[2] === key
  )
}

/**
 * The decoded key path of a `[table]` header line (bare, `"basic"` and `'literal'` segments), or
 * null for anything else — including an `[[array.of.tables]]` header, which may repeat.
 */
export function tableHeaderPath(line: string): string[] | null {
  const text = line.replace(/\r$/, '').trimStart()
  if (!text.startsWith('[') || text.startsWith('[[')) return null
  const path: string[] = []
  let i = 1
  const skipWs = (): void => {
    while (text[i] === ' ' || text[i] === '\t') i++
  }
  for (;;) {
    skipWs()
    const ch = text[i]
    if (ch === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      if (j >= text.length) return null
      path.push(unescapeTomlString(text.slice(i + 1, j)))
      i = j + 1
    } else if (ch === "'") {
      const j = text.indexOf("'", i + 1)
      if (j === -1) return null
      path.push(text.slice(i + 1, j))
      i = j + 1
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(text.slice(i))
      if (!m) return null
      path.push(m[0])
      i += m[0].length
    }
    skipWs()
    if (text[i] === '.') {
      i++
      continue
    }
    if (text[i] !== ']') return null
    return /^\s*(#.*)?$/.test(text.slice(i + 1)) ? path : null
  }
}

/**
 * Throws when a `[table]` is defined twice (by decoded key path) — the way our line edits can
 * produce a config.toml Codex will not load. Not a full TOML validator (none is in our deps): it
 * guards the failure mode these edits can introduce, reading headers outside multi-line strings.
 */
export function assertTomlTablesUnique(content: string): void {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  let multilineState: TomlMultilineState = { basic: false, literal: false }
  for (const raw of content.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!isInsideTomlMultilineString(multilineState)) {
      const path = tableHeaderPath(line)
      if (path) {
        const id = JSON.stringify(path)
        if (seen.has(id)) dupes.add(path.join('.'))
        seen.add(id)
        continue
      }
    }
    multilineState = updateTomlMultilineState(multilineState, line)
  }
  if (dupes.size > 0) {
    throw new Error(`refusing to write config.toml: table defined twice: ${[...dupes].join(', ')}`)
  }
}

type TrustBlockRange = {
  start: number
  headerLineEnd: number
  end: number
}

function findTrustBlockRanges(content: string, key: string): TrustBlockRange[] {
  const ranges: TrustBlockRange[] = []
  let cursor = 0
  let multilineState: TomlMultilineState = { basic: false, literal: false }
  while (cursor < content.length) {
    const newlineIdx = content.indexOf('\n', cursor)
    const lineEnd = newlineIdx === -1 ? content.length : newlineIdx
    const rawLine = content.slice(cursor, lineEnd)
    const line = rawLine.replace(/\r$/, '')
    const nextCursor = newlineIdx === -1 ? content.length : newlineIdx + 1
    if (!isInsideTomlMultilineString(multilineState) && isTrustHeaderFor(line, key)) {
      const headerLineEnd = rawLine.endsWith('\r') ? lineEnd - 1 : lineEnd
      const after = content.slice(headerLineEnd)
      const nextHeaderRel = findNextTableHeader(after)
      const blockEnd = nextHeaderRel === -1 ? content.length : headerLineEnd + nextHeaderRel
      ranges.push({ start: cursor, headerLineEnd, end: blockEnd })
      cursor = Math.max(blockEnd, nextCursor)
      continue
    }
    multilineState = updateTomlMultilineState(multilineState, line)
    cursor = nextCursor
  }
  return ranges
}

// Why: quoted keys can contain `]` (e.g. `[hooks.state."a]b"]`) and `[` lines
// inside multi-line strings aren't headers, so we need a stateful scanner —
// a flat regex misclassifies both cases.
function findNextTableHeader(text: string): number {
  let cursor = 0
  let multilineState: TomlMultilineState = { basic: false, literal: false }
  while (cursor < text.length) {
    const newlineIdx = text.indexOf('\n', cursor)
    const lineEnd = newlineIdx === -1 ? text.length : newlineIdx
    const rawLine = text.slice(cursor, lineEnd)
    const line = rawLine.replace(/\r$/, '')
    if (!isInsideTomlMultilineString(multilineState)) {
      const trimmed = line.trimStart()
      // Why: stop at both `[table]` and `[[array.of.tables]]` — both end our
      // block. Skipping `[[ ]]` here would let our slice consume past array
      // entries into unrelated user content.
      if (trimmed.startsWith('[') && isCompleteTableHeader(trimmed)) {
        return cursor
      }
    }
    multilineState = updateTomlMultilineState(multilineState, line)
    if (newlineIdx === -1) {
      return -1
    }
    cursor = newlineIdx + 1
  }
  return -1
}

// Why: walk the header byte-by-byte so `]` inside a quoted key segment
// doesn't terminate us early. Basic strings honor `\` escapes; literal
// strings (single quotes) don't allow escapes per TOML spec.
// Accepts both `[table]` and `[[array.of.tables]]` since either ends a block.
function isCompleteTableHeader(line: string): boolean {
  if (!line.startsWith('[')) {
    return false
  }
  const isArrayHeader = line.startsWith('[[')
  let i = isArrayHeader ? 2 : 1
  let inBasicQuote = false
  let inLiteralQuote = false
  while (i < line.length) {
    const ch = line[i]
    if (inBasicQuote) {
      if (ch === '\\' && i + 1 < line.length) {
        i += 2
        continue
      }
      if (ch === '"') {
        inBasicQuote = false
      }
      i++
      continue
    }
    if (inLiteralQuote) {
      if (ch === "'") {
        inLiteralQuote = false
      }
      i++
      continue
    }
    if (ch === '"') {
      inBasicQuote = true
      i++
      continue
    }
    if (ch === "'") {
      inLiteralQuote = true
      i++
      continue
    }
    if (ch === ']') {
      if (isArrayHeader) {
        if (line[i + 1] !== ']') {
          return false
        }
        const tail = line.slice(i + 2)
        return /^\s*(#.*)?$/.test(tail)
      }
      const tail = line.slice(i + 1)
      return /^\s*(#.*)?$/.test(tail)
    }
    i++
  }
  return false
}

type TomlMultilineState = {
  basic: boolean
  literal: boolean
}

type TomlMultilineMode = 'basic' | 'literal' | null

function isInsideTomlMultilineString(state: TomlMultilineState): boolean {
  return state.basic || state.literal
}

function updateTomlMultilineState(state: TomlMultilineState, line: string): TomlMultilineState {
  let mode: TomlMultilineMode = state.basic ? 'basic' : state.literal ? 'literal' : null
  let index = 0
  while (index < line.length) {
    if (mode === 'basic') {
      if (line[index] === '\\') {
        index += 2
        continue
      }
      if (line.startsWith('"""', index)) {
        mode = null
        index += 3
        continue
      }
      index++
      continue
    }
    if (mode === 'literal') {
      if (line.startsWith("'''", index)) {
        mode = null
        index += 3
        continue
      }
      index++
      continue
    }

    const char = line[index]
    if (char === '#') {
      break
    }
    if (line.startsWith('"""', index)) {
      mode = 'basic'
      index += 3
      continue
    }
    if (line.startsWith("'''", index)) {
      mode = 'literal'
      index += 3
      continue
    }
    if (char === '"') {
      index = skipTomlBasicString(line, index + 1)
      continue
    }
    if (char === "'") {
      index = skipTomlLiteralString(line, index + 1)
      continue
    }
    index++
  }
  return { basic: mode === 'basic', literal: mode === 'literal' }
}

function skipTomlBasicString(line: string, startIndex: number): number {
  let index = startIndex
  while (index < line.length) {
    const char = line[index]
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === '"') {
      return index + 1
    }
    index++
  }
  return index
}

function skipTomlLiteralString(line: string, startIndex: number): number {
  const endIndex = line.indexOf("'", startIndex)
  return endIndex === -1 ? line.length : endIndex + 1
}

// Why: atomic-rename + .bak rotation — a half-written config.toml can brick a
// user's Codex install, so write to tmp and rename. Random-suffix tmp name
// avoids cross-process races on rapid reinstalls. The rename goes through
// renameAtomicSync (core/fs-atomic.ts) so a Windows sharing violation retries
// instead of losing the write; the .bak copy stays a plain copyFileSync.
export function writeConfigAtomically(configPath: string, contents: string): void {
  const dir = dirname(configPath)
  mkdirSync(dir, { recursive: true })
  const tmpPath = join(dir, `.${Date.now()}-${randomUUID()}.tmp`)
  let renamed = false
  try {
    writeFileSync(tmpPath, contents, 'utf-8')
    if (existsSync(configPath)) {
      // Why: rotate a .bak before overwriting so a user can recover if our
      // edit ever goes wrong. (on macOS
      // a plain copyFileSync is sufficient.)
      copyFileSync(configPath, `${configPath}.bak`)
    }
    renameAtomicSync(tmpPath, configPath)
    renamed = true
  } finally {
    if (!renamed && existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // best effort — surfacing the cleanup failure would mask the original write error
      }
    }
  }
}

export function removeHookTrustEntries(configPath: string, keys: readonly string[]): void {
  if (!existsSync(configPath)) {
    return
  }
  const existing = readTomlFile(configPath)
  let updated = existing
  for (const key of keys) {
    updated = removeTrustBlock(updated, key)
  }
  if (updated === existing) {
    return
  }
  writeConfigAtomically(configPath, updated)
}

function removeTrustBlock(content: string, key: string): string {
  const ranges = findTrustBlockRanges(content, key)
  if (ranges.length === 0) {
    return content
  }

  let cursor = 0
  let updated = ''
  for (const range of ranges) {
    updated += content.slice(cursor, range.start)
    cursor = range.end
  }
  return updated + content.slice(cursor)
}

export function readHookTrustEntries(configPath: string): Map<string, CodexHookTrustState> {
  const result = new Map<string, CodexHookTrustState>()
  if (!existsSync(configPath)) {
    return result
  }
  const content = readTomlFile(configPath)
  // Why: walk line-by-line so `[hooks.state."..."]` inside a `"""..."""` or
  // `'''...'''` multi-line string isn't mistaken for a real header.
  // Why: accept an optional `# inline comment` after `]` — TOML permits it,
  // and rejecting hides a real entry, making getStatus misreport trustMissing.
  let cursor = 0
  let multilineState: TomlMultilineState = { basic: false, literal: false }
  while (cursor < content.length) {
    const newlineIdx = content.indexOf('\n', cursor)
    const lineEnd = newlineIdx === -1 ? content.length : newlineIdx
    const rawLine = content.slice(cursor, lineEnd)
    const line = rawLine.replace(/\r$/, '')
    const nextCursor = newlineIdx === -1 ? content.length : newlineIdx + 1
    const headerPath = isInsideTomlMultilineString(multilineState) ? null : tableHeaderPath(line)
    if (
      headerPath &&
      headerPath.length === 3 &&
      headerPath[0] === 'hooks' &&
      headerPath[1] === 'state'
    ) {
      const key = headerPath[2]
      // Why: block ends at the next *real* header (multi-line aware).
      const after = content.slice(nextCursor)
      const nextHeaderRel = findNextTableHeader(after)
      const blockEnd = nextHeaderRel === -1 ? content.length : nextCursor + nextHeaderRel
      const block = content.slice(nextCursor, blockEnd)
      // Why: we own this block's shape (only `enabled` + `trusted_hash`), so
      // a line scan beats pulling in a full TOML value parser.
      const hashMatch = /^[ \t]*trusted_hash[ \t]*=[ \t]*"((?:[^"\\]|\\.)*)"/m.exec(block)
      const enabledMatch = /^[ \t]*enabled[ \t]*=[ \t]*(true|false)[ \t\r]*(?:#.*)?$/m.exec(block)
      result.set(key, {
        trustedHash: hashMatch ? unescapeTomlString(hashMatch[1]) : undefined,
        enabled: enabledMatch ? enabledMatch[1] === 'true' : undefined
      })
      cursor = nextCursor
      continue
    }
    multilineState = updateTomlMultilineState(multilineState, line)
    cursor = nextCursor
  }
  return result
}

function unescapeTomlString(escaped: string): string {
  let result = ''
  let i = 0
  while (i < escaped.length) {
    const ch = escaped[i]
    if (ch === '\\' && i + 1 < escaped.length) {
      const next = escaped[i + 1]
      if (next === 'n') {
        result += '\n'
      } else if (next === 'r') {
        result += '\r'
      } else if (next === 't') {
        result += '\t'
      } else if (next === 'b') {
        result += '\b'
      } else if (next === 'f') {
        result += '\f'
      } else if (next === '"') {
        result += '"'
      } else if (next === '\\') {
        result += '\\'
      } else if (next === 'u' || next === 'U') {
        // \uXXXX / \UXXXXXXXX: two spellings of one key must decode to the same key.
        const len = next === 'u' ? 4 : 8
        const hex = escaped.slice(i + 2, i + 2 + len)
        const cp = /^[0-9A-Fa-f]+$/.test(hex) && hex.length === len ? Number.parseInt(hex, 16) : -1
        if (cp >= 0 && cp <= 0x10ffff) {
          result += String.fromCodePoint(cp)
          i += 2 + len
          continue
        }
        result += `\\${next}`
      }
      // Why: unknown escapes round-trip — preserve the backslash so we don't
      // silently drop information.
      else {
        result += `\\${next}`
      }
      i += 2
    } else {
      result += ch
      i++
    }
  }
  return result
}

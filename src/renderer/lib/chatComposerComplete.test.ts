import { describe, expect, it } from 'vitest'
import { applyCompletion, completionItems, completionTriggerAt, rankFileCompletions } from './chatComposerComplete'
import { prepareQuickOpenFiles } from './quickOpenSearch'
import {
  BUILTIN_CATALOG_AGENTS,
  builtinSlashCommands,
  catalogDescription,
  catalogName,
  isInteractiveBuiltin,
  rankCatalog,
  sanitizeChatCatalog,
  type ChatCatalogEntry
} from '@shared/chat-catalog'

const e = (name: string, description = '', kind: ChatCatalogEntry['kind'] = 'builtin'): ChatCatalogEntry => ({
  name,
  description,
  kind,
  scope: kind === 'builtin' ? 'builtin' : 'project'
})

describe('completionTriggerAt', () => {
  it('a slash is a command only at the start of the message', () => {
    expect(completionTriggerAt('/mo', 3)).toEqual({ kind: 'slash', query: 'mo', start: 0, end: 3 })
    expect(completionTriggerAt('  /', 3)).toEqual({ kind: 'slash', query: '', start: 2, end: 3 })
    expect(completionTriggerAt('see /usr', 8)).toBeNull()
    expect(completionTriggerAt('/model x', 8)).toBeNull()
    // Caret inside the word: the token runs to its end.
    expect(completionTriggerAt('/model', 2)).toEqual({ kind: 'slash', query: 'm', start: 0, end: 6 })
  })

  it('an @ opens only at the start of a word, anywhere in the message', () => {
    expect(completionTriggerAt('read @src/ma', 12)).toEqual({ kind: 'file', query: 'src/ma', start: 5, end: 12 })
    expect(completionTriggerAt('@', 1)).toEqual({ kind: 'file', query: '', start: 0, end: 1 })
    expect(completionTriggerAt('mail a@b', 8)).toBeNull()
  })

  it('a selection never completes', () => {
    expect(completionTriggerAt('/mo', 1, 3)).toBeNull()
  })
})

describe('applyCompletion', () => {
  it('replaces the whole token and adds one trailing space', () => {
    const t = completionTriggerAt('/mo', 3)!
    expect(applyCompletion('/mo', t, 'model')).toEqual({ text: '/model ', caret: 7 })
    const f = completionTriggerAt('read @sr and', 8)!
    expect(applyCompletion('read @sr and', f, 'src/a.ts')).toEqual({ text: 'read @src/a.ts and', caret: 14 })
  })
})

describe('rankCatalog', () => {
  const list = [e('compact'), e('config'), e('context'), e('git:commit', 'Commit staged work', 'command'), e('clear')]
  it('prefix first, then contains, then description', () => {
    expect(rankCatalog(list, 'co').map((x) => x.name)).toEqual(['config', 'compact', 'context', 'git:commit'])
    expect(rankCatalog(list, 'commit').map((x) => x.name)).toEqual(['git:commit'])
    expect(rankCatalog(list, 'staged').map((x) => x.name)).toEqual(['git:commit'])
    expect(rankCatalog(list, 'st')).toEqual([])
  })
})

describe('files', () => {
  it('ranks the node index and leaves out untypeable or traversing paths', () => {
    const idx = prepareQuickOpenFiles(['src/main.ts', 'src/my file.ts', 'src/\u001b[31m.ts', '../etc/passwd', 'src/mail.ts'])
    const out = rankFileCompletions(idx, 'ma')
    expect(out).toEqual(expect.arrayContaining(['src/main.ts', 'src/mail.ts']))
    expect(out).not.toContain('src/my file.ts')
    expect(out.some((p) => p.includes('\u001b'))).toBe(false)
    expect(out).not.toContain('../etc/passwd')
    // No index yet = no items (never a guess).
    expect(completionItems(completionTriggerAt('@ma', 3), [], null)).toEqual([])
  })
})

describe('the shared catalog', () => {
  it('names have a closed alphabet', () => {
    expect(catalogName('git:commit')).toBe('git:commit')
    for (const bad of ['', ' x', 'a b', '-x', ':x', 'x;rm', 'x\u001b', 'x‮', 'a'.repeat(65), 42, null]) {
      expect(catalogName(bad)).toBeNull()
    }
  })

  it('descriptions are one line with control and format characters gone', () => {
    expect(catalogDescription('a\nb\u001b[2J‮​c')).toBe('a b [2Jc')
    expect(catalogDescription({})).toBe('')
  })

  it('a catalog from a wire is re-checked entry by entry', () => {
    const c = sanitizeChatCatalog({
      entries: [
        { name: 'ok', description: 'x', kind: 'command', scope: 'project' },
        { name: 'bad name', description: 'x', kind: 'command', scope: 'project' },
        { name: 'k', description: 'x', kind: 'weird', scope: 'project' },
        { name: 'k2', description: 'x', kind: 'skill', scope: 'elsewhere' },
        null,
        'str'
      ],
      partial: 'yes'
    })
    expect(c).toEqual({ version: 1, entries: [{ name: 'ok', description: 'x', kind: 'command', scope: 'project' }] })
    expect(sanitizeChatCatalog(undefined)).toEqual({ version: 1, entries: [] })
  })

  it('every measured table holds valid, unique names; a custom agent inherits its base', () => {
    // grok is deliberately absent: 1.0.44 could not be measured (browser sign-in) on the measuring host.
    expect([...BUILTIN_CATALOG_AGENTS].sort()).toEqual(['claude', 'codex', 'gemini', 'opencode'])
    for (const a of BUILTIN_CATALOG_AGENTS) {
      const list = builtinSlashCommands(a)
      expect(list.length).toBeGreaterThan(0)
      for (const x of list) expect(catalogName(x.name)).toBe(x.name)
      expect(new Set(list.map((x) => x.name)).size).toBe(list.length)
    }
    expect(builtinSlashCommands('copilot')).toEqual([])
    expect(builtinSlashCommands('grok')).toEqual([])
    expect(builtinSlashCommands(undefined)).toEqual([])
    expect(builtinSlashCommands('constructor')).toEqual([])
  })

  it('the picker commands the composer toolbar types are in claude’s measured table', () => {
    const n = builtinSlashCommands('claude').map((x) => x.name)
    expect(n).toEqual(expect.arrayContaining(['model', 'effort']))
  })

  it('built-ins that open a TUI dialog are tagged; unknown means dialog, only the measured no-dialog ones are not', () => {
    const tag = (a: string, n: string) => builtinSlashCommands(a).find((x) => x.name === n)?.interactive
    for (const n of ['model', 'effort', 'rewind', 'resume', 'config', 'permissions', 'mcp', 'hooks', 'memory', 'plugin', 'theme', 'tasks']) {
      expect(tag('claude', n)).toBe(true)
    }
    for (const n of ['clear', 'compact', 'init', 'recap']) expect(tag('claude', n)).toBeUndefined()
    expect(tag('codex', 'model')).toBe(true)
    expect(tag('gemini', 'compress')).toBeUndefined()
    expect(tag('opencode', 'models')).toBe(true)
  })

  it('isInteractiveBuiltin reads the SENT text: typed or completed, with or without arguments, never a custom command', () => {
    expect(isInteractiveBuiltin('claude', '/rewind')).toBe(true)
    expect(isInteractiveBuiltin('claude', '  /model sonnet ')).toBe(true)
    expect(isInteractiveBuiltin('claude', '/compact')).toBe(false)
    expect(isInteractiveBuiltin('claude', '/git:commit')).toBe(false)
    expect(isInteractiveBuiltin('claude', 'please /rewind')).toBe(false)
    expect(isInteractiveBuiltin('claude', '/Rewind')).toBe(false)
    expect(isInteractiveBuiltin('grok', '/model')).toBe(false)
    expect(isInteractiveBuiltin(undefined, '/model')).toBe(false)
  })

  it('the interactive tag survives a wire, only as a literal true', () => {
    const c = sanitizeChatCatalog({
      entries: [
        { name: 'a', description: '', kind: 'builtin', scope: 'builtin', interactive: true },
        { name: 'b', description: '', kind: 'builtin', scope: 'builtin', interactive: 'yes' }
      ]
    })
    expect(c.entries.map((e) => e.interactive)).toEqual([true, undefined])
  })
})

import { describe, it, expect } from 'vitest'
import {
  COMMAND_DEFINITIONS,
  COMMANDS_BY_ID,
  isCommandId,
  normalizeBindingForCommand,
  getEffectiveBindings,
  bindingIdentity,
  conflictBucket,
  findKeybindingConflicts,
  sanitizeKeybindingOverrides,
  resolveCommandForKeyEvent,
  normalizeTerminalShortcutPolicy,
  MAIN_INTERCEPTED_COMMAND_IDS,
  findMainInterceptShadowing
} from './keybindings'
import type { CommandId } from './keybindings'
import { AGENT_CONFIG, BUILTIN_AGENT_IDS } from './agents/config'
import { parseShortcut } from './shortcut'
import type { ShortcutKeyEvent } from './shortcut'

describe('registry invariants', () => {
  it('has unique ids and a map that covers them all', () => {
    const ids = COMMAND_DEFINITIONS.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(COMMANDS_BY_ID.size).toBe(ids.length)
    for (const d of COMMAND_DEFINITIONS) expect(COMMANDS_BY_ID.get(d.id)).toBe(d)
  })

  it('every default binding parses, and keyed defaults carry a key', () => {
    for (const d of COMMAND_DEFINITIONS) {
      for (const s of [...d.defaultBindings.darwin, ...d.defaultBindings.other]) {
        const p = parseShortcut(s)
        if (d.allowHoldChord) continue
        expect(p.key, `${d.id}: ${s}`).not.toBeNull()
      }
    }
  })

  it('pins the defaults that PR 2 will wire (behavior contract)', () => {
    expect(COMMANDS_BY_ID.get('app.commandPalette')?.defaultBindings.darwin).toEqual(['Cmd+K'])
    expect(COMMANDS_BY_ID.get('node.close')?.defaultBindings.other).toEqual(['Cmd+W'])
    expect(COMMANDS_BY_ID.get('canvas.redo')?.defaultBindings.other).toEqual(['Cmd+Shift+Z', 'Cmd+Y'])
    expect(COMMANDS_BY_ID.get('terminal.copySelection')?.defaultBindings.other).toEqual([
      'Cmd+Shift+C', 'Ctrl+Insert'
    ])
    expect(COMMANDS_BY_ID.get('canvas.deleteSelection')?.defaultBindings.other).toEqual(['Delete', 'Backspace'])
    expect(COMMANDS_BY_ID.get('speech.dictation')?.defaultBindings.darwin).toEqual(['Cmd+Alt'])
    expect(COMMANDS_BY_ID.get('canvas.fitAll')?.defaultBindings.darwin).toEqual([])
  })

  it('reopen-last-closed defaults to Cmd+Shift+T and works in a terminal', () => {
    const def = COMMANDS_BY_ID.get('app.reopenLastClosed')
    expect(def?.defaultBindings.darwin).toEqual(['Cmd+Shift+T'])
    expect(def?.defaultBindings.other).toEqual(['Cmd+Shift+T'])
    expect(def?.allowInTerminal).toBe(true)
  })

  it('pins the WHOLE table — every row PR 2 will dispatch on, in source order', () => {
    // Source order is contractual (first match wins in the resolver), so the array order is
    // asserted too. A dropped flag — allowInTerminal above all — reds this test.
    const table = COMMAND_DEFINITIONS.map((d) => ({
      id: d.id,
      title: d.title,
      group: d.group,
      scope: d.scope,
      darwin: d.defaultBindings.darwin,
      other: d.defaultBindings.other,
      allowWhileTyping: d.allowWhileTyping,
      allowInTerminal: d.allowInTerminal,
      allowBareKey: d.allowBareKey,
      allowHoldChord: d.allowHoldChord
    }))
    expect(table).toEqual([
      { id: 'app.commandPalette', title: 'Command palette', group: 'General', scope: 'app',
        darwin: ['Cmd+K'], other: ['Cmd+K'], allowInTerminal: true },
      { id: 'app.settings', title: 'Open settings', group: 'General', scope: 'app',
        darwin: ['Cmd+Comma'], other: ['Cmd+Comma'], allowInTerminal: true },
      { id: 'app.shortcutsPanel', title: 'Keyboard shortcuts panel', group: 'General', scope: 'app',
        darwin: ['Cmd+Slash'], other: ['Cmd+Slash'], allowInTerminal: true },
      { id: 'view.kanbanToggle', title: 'Toggle kanban board', group: 'General', scope: 'app',
        darwin: ['Cmd+Shift+B'], other: ['Cmd+Shift+B'], allowInTerminal: true },
      { id: 'view.globalKanbanToggle', title: 'Toggle global kanban (Omni)', group: 'General', scope: 'app',
        darwin: [], other: [], allowInTerminal: true },
      { id: 'view.focusMode', title: 'Toggle focus mode', group: 'General', scope: 'canvas',
        darwin: ['Cmd+Shift+F'], other: ['Cmd+Shift+F'], allowInTerminal: true },
      { id: 'panel.explorer', title: 'Toggle explorer panel', group: 'General', scope: 'app',
        darwin: ['Cmd+Shift+E'], other: ['Cmd+Shift+E'], allowInTerminal: true },
      { id: 'panel.sourceControl', title: 'Toggle source control panel', group: 'General',
        scope: 'app', darwin: ['Cmd+Shift+G'], other: ['Cmd+Shift+G'], allowInTerminal: true },
      { id: 'panel.sessions', title: 'Pin sessions sidebar', group: 'General', scope: 'app',
        darwin: ['Cmd+Shift+L'], other: ['Cmd+Shift+L'], allowInTerminal: true },
      { id: 'app.reopenLastClosed', title: 'Reopen last closed', group: 'General', scope: 'app',
        darwin: ['Cmd+Shift+T'], other: ['Cmd+Shift+T'], allowInTerminal: true },
      { id: 'canvas.undo', title: 'Undo', group: 'Canvas', scope: 'canvas',
        darwin: ['Cmd+Z'], other: ['Cmd+Z'] },
      { id: 'canvas.redo', title: 'Redo', group: 'Canvas', scope: 'canvas',
        darwin: ['Cmd+Shift+Z'], other: ['Cmd+Shift+Z', 'Cmd+Y'] },
      { id: 'canvas.goBack', title: 'Go back', group: 'Canvas', scope: 'canvas',
        darwin: ['Cmd+['], other: ['Cmd+['] },
      { id: 'canvas.goForward', title: 'Go forward', group: 'Canvas', scope: 'canvas',
        darwin: ['Cmd+]'], other: ['Cmd+]'] },
      { id: 'canvas.deleteSelection', title: 'Delete selection', group: 'Canvas', scope: 'canvas',
        darwin: ['Delete', 'Backspace'], other: ['Delete', 'Backspace'], allowBareKey: true },
      { id: 'canvas.fitAll', title: 'Fit all nodes in view', group: 'Canvas', scope: 'canvas',
        darwin: [], other: [] },
      { id: 'canvas.tidy', title: 'Tidy canvas', group: 'Canvas', scope: 'canvas',
        darwin: ['Cmd+Shift+A'], other: ['Cmd+Shift+A'] },
      { id: 'canvas.groupSelection', title: 'Group selection', group: 'Canvas', scope: 'canvas',
        darwin: [], other: [] },
      { id: 'node.newTerminal', title: 'New terminal node', group: 'Nodes', scope: 'canvas',
        darwin: ['Cmd+T'], other: ['Cmd+T'] },
      { id: 'node.newAgent', title: 'New agent node', group: 'Nodes', scope: 'canvas',
        darwin: ['Cmd+Shift+C'], other: ['Cmd+Shift+C'] },
      // The per-agent + per-node-kind creates: pool only, no default chord on either platform.
      { id: 'node.newAgent.claude', title: 'New Claude Code node', group: 'Nodes', scope: 'canvas',
        darwin: [], other: [] },
      { id: 'node.newAgent.codex', title: 'New Codex node', group: 'Nodes', scope: 'canvas',
        darwin: [], other: [] },
      { id: 'node.newAgent.gemini', title: 'New Gemini node', group: 'Nodes', scope: 'canvas',
        darwin: [], other: [] },
      { id: 'node.newAgent.opencode', title: 'New opencode node', group: 'Nodes', scope: 'canvas',
        darwin: [], other: [] },
      { id: 'node.newAgent.grok', title: 'New Grok node', group: 'Nodes', scope: 'canvas',
        darwin: [], other: [] },
      { id: 'node.newAgent.copilot', title: 'New GitHub Copilot node', group: 'Nodes',
        scope: 'canvas', darwin: [], other: [] },
      { id: 'node.newAgent.agy', title: 'New AGY node', group: 'Nodes', scope: 'canvas',
        darwin: [], other: [] },
      { id: 'node.newAgent.pi', title: 'New Pi node', group: 'Nodes', scope: 'canvas',
        darwin: [], other: [] },
      { id: 'node.newAgent.goose', title: 'New Goose node', group: 'Nodes', scope: 'canvas',
        darwin: [], other: [] },
      { id: 'node.newSticky', title: 'New sticky note', group: 'Nodes', scope: 'canvas',
        darwin: [], other: [] },
      { id: 'node.newBrowser', title: 'New browser node', group: 'Nodes', scope: 'canvas',
        darwin: [], other: [] },
      { id: 'node.newWebView', title: 'New web view node', group: 'Nodes', scope: 'canvas',
        darwin: [], other: [] },
      { id: 'node.newDino', title: 'New dino node', group: 'Nodes', scope: 'canvas',
        darwin: [], other: [] },
      { id: 'node.newFile', title: 'New file…', group: 'Nodes', scope: 'canvas',
        darwin: [], other: [] },
      { id: 'node.focusLeft', title: 'Focus node to the left', group: 'Nodes', scope: 'canvas',
        darwin: ['Cmd+ArrowLeft'], other: ['Ctrl+Shift+ArrowLeft'], allowInTerminal: true },
      { id: 'node.focusRight', title: 'Focus node to the right', group: 'Nodes', scope: 'canvas',
        darwin: ['Cmd+ArrowRight'], other: ['Ctrl+Shift+ArrowRight'], allowInTerminal: true },
      { id: 'node.focusUp', title: 'Focus node above', group: 'Nodes', scope: 'canvas',
        darwin: ['Cmd+ArrowUp'], other: ['Ctrl+Shift+ArrowUp'], allowInTerminal: true },
      { id: 'node.focusDown', title: 'Focus node below', group: 'Nodes', scope: 'canvas',
        darwin: ['Cmd+ArrowDown'], other: ['Ctrl+Shift+ArrowDown'], allowInTerminal: true },
      { id: 'node.maximize', title: 'Maximize / restore node', group: 'Nodes', scope: 'canvas',
        darwin: ['Cmd+Shift+Enter'], other: ['Cmd+Shift+Enter'], allowInTerminal: true },
      { id: 'node.zoneLeft', title: 'Snap node to left half', group: 'Nodes', scope: 'canvas',
        darwin: ['Ctrl+Alt+ArrowLeft'], other: [], allowInTerminal: true },
      { id: 'node.zoneRight', title: 'Snap node to right half', group: 'Nodes', scope: 'canvas',
        darwin: ['Ctrl+Alt+ArrowRight'], other: [], allowInTerminal: true },
      { id: 'node.zoneUp', title: 'Snap node to top half', group: 'Nodes', scope: 'canvas',
        darwin: ['Ctrl+Alt+ArrowUp'], other: [], allowInTerminal: true },
      { id: 'node.zoneDown', title: 'Snap node to bottom half', group: 'Nodes', scope: 'canvas',
        darwin: ['Ctrl+Alt+ArrowDown'], other: [], allowInTerminal: true },
      { id: 'node.close', title: 'Close node / window', group: 'Nodes', scope: 'app',
        darwin: ['Cmd+W'], other: ['Cmd+W'], allowInTerminal: true, allowWhileTyping: true },
      { id: 'node.toggleMarkdown', title: 'Toggle markdown view', group: 'Nodes', scope: 'app',
        darwin: ['Cmd+M'], other: ['Cmd+M'], allowInTerminal: true, allowWhileTyping: true },
      { id: 'terminal.find', title: 'Find in terminal', group: 'Terminal', scope: 'terminal',
        darwin: ['Cmd+F'], other: ['Cmd+F'] },
      { id: 'terminal.copySelection', title: 'Copy terminal selection', group: 'Terminal',
        scope: 'terminal', darwin: ['Cmd+C'], other: ['Cmd+Shift+C', 'Ctrl+Insert'] },
      { id: 'scm.commit', title: 'Commit', group: 'Source Control', scope: 'scm',
        darwin: ['Cmd+Enter'], other: ['Cmd+Enter'], allowWhileTyping: true },
      { id: 'speech.dictation', title: 'Dictate', group: 'Speech', scope: 'app',
        darwin: ['Cmd+Alt'], other: ['Cmd+Alt'],
        allowHoldChord: true, allowInTerminal: true, allowWhileTyping: true }
    ])
  })

  it('isCommandId accepts known ids and rejects unknowns', () => {
    expect(isCommandId('node.newTerminal')).toBe(true)
    expect(isCommandId('node.selfDestruct')).toBe(false)
  })

  // Parity with the agent registry, both directions. The union is spelled statically (so the
  // CommandId type stays literal), which means nothing but this test notices when builtin agent
  // #7 lands: it reds here until `node.newAgent.<id>` exists, and it reds again if a command
  // outlives the agent it creates.
  it('has one create command per builtin agent, titled from AGENT_CONFIG', () => {
    const perAgent = COMMAND_DEFINITIONS.map((d) => d.id).filter((id) =>
      id.startsWith('node.newAgent.')
    )
    expect([...perAgent].sort()).toEqual(
      BUILTIN_AGENT_IDS.map((a) => `node.newAgent.${a}`).sort()
    )
    for (const agentId of BUILTIN_AGENT_IDS) {
      const d = COMMANDS_BY_ID.get(`node.newAgent.${agentId}` as CommandId)
      expect(d?.title).toBe(`New ${AGENT_CONFIG[agentId].label} node`)
      expect(d?.group).toBe('Nodes')
      expect(d?.scope).toBe('canvas')
    }
  })

  // Every command this PR added ships with NO default chord — the pool grows, the out-of-box
  // key map does not. A default sneaking in here would shadow an existing binding or steal a
  // key from the terminal for a user who never asked for the command.
  it('ships the new create commands unbound on both platforms', () => {
    const added: readonly string[] = [
      ...BUILTIN_AGENT_IDS.map((a) => `node.newAgent.${a}`),
      'node.newSticky',
      'node.newBrowser',
      'node.newWebView',
      'node.newDino',
      'node.newFile'
    ]
    expect(added).toHaveLength(14)
    for (const id of added) {
      const d = COMMANDS_BY_ID.get(id as CommandId)
      expect(d, id).toBeDefined()
      expect(d!.defaultBindings.darwin, id).toEqual([])
      expect(d!.defaultBindings.other, id).toEqual([])
      expect(getEffectiveBindings(id as CommandId, {}, true), id).toEqual([])
      expect(getEffectiveBindings(id as CommandId, {}, false), id).toEqual([])
    }
  })
})

const def = (id: string) => {
  const d = COMMANDS_BY_ID.get(id as never)
  if (!d) throw new Error(`missing ${id}`)
  return d
}

describe('normalizeBindingForCommand', () => {
  it('canonicalizes token order and casing', () => {
    const r = normalizeBindingForCommand(def('node.newTerminal'), 'shift+t+cmd', true)
    expect(r).toEqual({ ok: true, value: 'Cmd+Shift+T' })
  })
  it('rejects a chord with no modifier for a normal command', () => {
    const r = normalizeBindingForCommand(def('node.newTerminal'), 'T', true)
    expect(r.ok).toBe(false)
  })
  it('rejects shift-only chords (stealing typed text)', () => {
    expect(normalizeBindingForCommand(def('node.newTerminal'), 'Shift+T', true).ok).toBe(false)
  })
  it('allows safe bare keys only with allowBareKey', () => {
    expect(normalizeBindingForCommand(def('canvas.deleteSelection'), 'Delete', true)).toEqual({
      ok: true, value: 'Delete'
    })
    expect(normalizeBindingForCommand(def('canvas.deleteSelection'), 'X', true).ok).toBe(false)
    expect(normalizeBindingForCommand(def('node.newTerminal'), 'Delete', true).ok).toBe(false)
  })
  it('allows hold chords only with allowHoldChord', () => {
    expect(normalizeBindingForCommand(def('speech.dictation'), 'Cmd+Alt', true)).toEqual({
      ok: true, value: 'Cmd+Alt'
    })
    expect(normalizeBindingForCommand(def('node.newTerminal'), 'Cmd+Alt', true).ok).toBe(false)
  })
  it('rejects Cmd combined with literal Ctrl on non-mac', () => {
    expect(normalizeBindingForCommand(def('node.newTerminal'), 'Cmd+Ctrl+T', false).ok).toBe(false)
    expect(normalizeBindingForCommand(def('node.newTerminal'), 'Cmd+Ctrl+T', true).ok).toBe(true)
  })
  it('rejects garbage', () => {
    expect(normalizeBindingForCommand(def('node.newTerminal'), '', true).ok).toBe(false)
    expect(normalizeBindingForCommand(def('node.newTerminal'), '+++', true).ok).toBe(false)
  })
  it('every default in the registry survives its own validation', () => {
    for (const d of COMMAND_DEFINITIONS) {
      for (const isMac of [true, false]) {
        for (const s of d.defaultBindings[isMac ? 'darwin' : 'other']) {
          const r = normalizeBindingForCommand(d, s, isMac)
          expect(r, `${d.id}: ${s} (isMac=${isMac})`).toEqual({ ok: true, value: s })
        }
      }
    }
  })
})

describe('getEffectiveBindings', () => {
  it('returns platform defaults with no override', () => {
    expect(getEffectiveBindings('terminal.copySelection', {}, true)).toEqual(['Cmd+C'])
    expect(getEffectiveBindings('terminal.copySelection', {}, false)).toEqual([
      'Cmd+Shift+C', 'Ctrl+Insert'
    ])
  })
  it('an override replaces defaults; [] disables', () => {
    const o = { 'node.newTerminal': ['Cmd+Shift+T'], 'canvas.undo': [] as string[] }
    expect(getEffectiveBindings('node.newTerminal', o, true)).toEqual(['Cmd+Shift+T'])
    expect(getEffectiveBindings('canvas.undo', o, true)).toEqual([])
  })
})

describe('bindingIdentity', () => {
  it('resolves Cmd and literal Ctrl to the same identity on non-mac', () => {
    expect(bindingIdentity('Cmd+K', false)).toBe(bindingIdentity('Ctrl+K', false))
  })
  it('keeps them distinct on mac', () => {
    expect(bindingIdentity('Cmd+K', true)).not.toBe(bindingIdentity('Ctrl+K', true))
  })
  it('collapses alias key spellings onto one identity', () => {
    expect(bindingIdentity('Cmd+Esc', true)).toBe(bindingIdentity('Cmd+Escape', true))
    expect(bindingIdentity('Cmd+Return', true)).toBe(bindingIdentity('Cmd+Enter', true))
  })
  it('still separates a modifier from a bare key, and a hold chord from a keyed one', () => {
    expect(bindingIdentity('Cmd+Delete', true)).not.toBe(bindingIdentity('Delete', true))
    expect(bindingIdentity('Cmd+Alt', true)).not.toBe(bindingIdentity('Cmd+Alt+D', true))
  })
})

describe('conflictBucket', () => {
  // The whole mapping, asserted over the REGISTRY rather than a hand-picked example per bucket:
  // 'app' and 'canvas' share the global keyspace, 'terminal' and 'scm' are their own, and
  // `speech.dictation` is the one command whose bucket comes from its id instead of its scope.
  // Kills two mutants a per-bucket sample can miss: a scope-mapping typo (folding 'scm' — or a
  // scope added later — into 'global', or dropping 'canvas' out of it), and the removal of the
  // dictation branch, which would send Dictate back into 'global' and re-report the collision
  // the bucket exists to stop.
  it('maps every command to its scope bucket, dictation excepted', () => {
    for (const def of COMMAND_DEFINITIONS) {
      if (def.id === 'speech.dictation') continue
      expect(conflictBucket(def)).toBe(
        def.scope === 'app' || def.scope === 'canvas' ? 'global' : def.scope
      )
    }
    expect(conflictBucket(COMMANDS_BY_ID.get('speech.dictation')!)).toBe('dictation')
  })
})

describe('findKeybindingConflicts', () => {
  it('reports nothing for pure defaults', () => {
    expect(findKeybindingConflicts({}, true)).toEqual([])
    expect(findKeybindingConflicts({}, false)).toEqual([])
  })
  it('the shipped default table is conflict-free even under full scrutiny', () => {
    expect(findKeybindingConflicts({}, true, { includeDefaults: true })).toEqual([])
    expect(findKeybindingConflicts({}, false, { includeDefaults: true })).toEqual([])
  })
  it('flags an override colliding with a default in the same bucket', () => {
    const conflicts = findKeybindingConflicts({ 'canvas.fitAll': ['Cmd+K'] }, true)
    expect(conflicts).toEqual([
      { binding: 'Cmd+K', commandIds: ['app.commandPalette', 'canvas.fitAll'] }
    ])
  })
  it('reports the canonical spelling, not the override as written', () => {
    expect(findKeybindingConflicts({ 'canvas.fitAll': ['cmd+k'] }, true)).toEqual([
      { binding: 'Cmd+K', commandIds: ['app.commandPalette', 'canvas.fitAll'] }
    ])
    // canvas.fitAll precedes node.newTerminal in the registry, so the override is the
    // entry-creating spelling here — the assertion above cannot see the canonicalization.
    expect(findKeybindingConflicts({ 'canvas.fitAll': ['cmd+t'] }, true)).toEqual([
      { binding: 'Cmd+T', commandIds: ['canvas.fitAll', 'node.newTerminal'] }
    ])
  })
  it('flags a cross-spelling collision on non-mac (Ctrl+K vs Cmd+K)', () => {
    const conflicts = findKeybindingConflicts({ 'canvas.fitAll': ['Ctrl+K'] }, false)
    expect(conflicts.map((c) => c.commandIds)).toEqual([['app.commandPalette', 'canvas.fitAll']])
  })
  it('does not flag collisions across buckets', () => {
    // terminal.find is Cmd+F in the terminal bucket; an app-bucket Cmd+F is legal.
    expect(findKeybindingConflicts({ 'canvas.fitAll': ['Cmd+F'] }, true)).toEqual([])
  })
  it('the scm bucket is its own keyspace, not part of global', () => {
    // scm.commit holds Cmd+Enter; a canvas (global-bucket) override on the same chord is legal,
    // because Commit dispatches from the focused composer. Reds if conflictBucket folds 'scm'
    // into 'global'.
    expect(findKeybindingConflicts({ 'canvas.fitAll': ['Cmd+Enter'] }, true)).toEqual([])
  })
  it('two disabled commands never conflict', () => {
    expect(
      findKeybindingConflicts({ 'canvas.fitAll': [], 'canvas.groupSelection': [] }, true)
    ).toEqual([])
  })
})

describe('sanitizeKeybindingOverrides', () => {
  it('passes through a clean override map', () => {
    const r = sanitizeKeybindingOverrides({ 'node.newTerminal': ['Cmd+Shift+Y'] }, true)
    expect(r).toEqual({ overrides: { 'node.newTerminal': ['Cmd+Shift+Y'] }, warnings: [] })
  })
  it('canonicalizes spellings', () => {
    const r = sanitizeKeybindingOverrides({ 'node.newTerminal': ['shift+cmd+y'] }, true)
    expect(r.overrides).toEqual({ 'node.newTerminal': ['Cmd+Shift+Y'] })
  })
  it('drops unknown ids with a warning, keeps the rest', () => {
    const r = sanitizeKeybindingOverrides(
      { 'node.selfDestruct': ['Cmd+X'], 'canvas.undo': [] }, true
    )
    expect(r.overrides).toEqual({ 'canvas.undo': [] })
    expect(r.warnings.some((w) => w.includes('node.selfDestruct'))).toBe(true)
  })
  it('drops an invalid binding string but keeps valid siblings', () => {
    const r = sanitizeKeybindingOverrides({ 'node.newTerminal': ['Cmd+Shift+Y', 'T'] }, true)
    expect(r.overrides).toEqual({ 'node.newTerminal': ['Cmd+Shift+Y'] })
    expect(r.warnings.length).toBe(1)
  })
  it('a non-empty list that is entirely invalid falls back to defaults, not disabled', () => {
    const r = sanitizeKeybindingOverrides({ 'node.newTerminal': ['T', '+++'] }, true)
    expect(r.overrides).toEqual({})
    expect(r.warnings.length).toBeGreaterThan(0)
  })
  it('an explicit empty array still means disabled', () => {
    expect(sanitizeKeybindingOverrides({ 'canvas.undo': [] }, true).overrides).toEqual({
      'canvas.undo': []
    })
  })
  it('strips BOTH sides of a conflicting override pair, naming the titles', () => {
    const r = sanitizeKeybindingOverrides(
      { 'canvas.fitAll': ['Cmd+P'], 'canvas.groupSelection': ['Cmd+P'] }, true
    )
    expect(r.overrides).toEqual({})
    expect(r.warnings.some((w) =>
      w.includes('Fit all nodes in view') && w.includes('Group selection')
    )).toBe(true)
  })
  it('an override conflicting with a DEFAULT strips only the override', () => {
    const r = sanitizeKeybindingOverrides({ 'canvas.fitAll': ['Cmd+K'] }, true)
    expect(r.overrides).toEqual({})
    expect(r.warnings.some((w) => w.includes('Command palette'))).toBe(true)
  })
  it('keeps stripping when a REVERTED default uncovers a second conflict', () => {
    // Pass 1: Cmd+P collides between the two overrides, so both are dropped — which reverts
    // app.commandPalette to its Cmd+K default, and THAT now collides with canvas.fitAll's
    // override. Pass 2 strips it. A single-shot strip would leave canvas.fitAll on Cmd+K,
    // ambiguous against the palette.
    const r = sanitizeKeybindingOverrides(
      {
        'app.commandPalette': ['Cmd+P'],
        'canvas.groupSelection': ['Cmd+P'],
        'canvas.fitAll': ['Cmd+K']
      },
      true
    )
    expect(r.overrides).toEqual({})
    expect(r.warnings.length).toBeGreaterThanOrEqual(2)
  })
  it('non-object / non-array shapes degrade to empty with a warning', () => {
    expect(sanitizeKeybindingOverrides('nope', true).overrides).toEqual({})
    expect(sanitizeKeybindingOverrides({ 'canvas.undo': 'Cmd+Z' }, true).overrides).toEqual({})
  })
  it('is a fixpoint: sanitizing its own output adds nothing', () => {
    const once = sanitizeKeybindingOverrides(
      { 'canvas.fitAll': ['Cmd+P'], 'node.newTerminal': ['Cmd+Shift+T'] }, true
    )
    const twice = sanitizeKeybindingOverrides(once.overrides, true)
    expect(twice).toEqual({ overrides: once.overrides, warnings: [] })
  })
})

const ev = (over: Partial<ShortcutKeyEvent>): ShortcutKeyEvent => ({
  metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, key: '', ...over
})
const ctx = (
  over: Partial<{
    typing: boolean; terminal: boolean; kanbanOpen: boolean; terminalFirst: boolean
  }> = {}
) => ({
  typing: false, terminal: false, kanbanOpen: false, terminalFirst: false, ...over
})

describe('resolveCommandForKeyEvent', () => {
  it('matches a default app chord', () => {
    expect(resolveCommandForKeyEvent(ev({ metaKey: true, key: 'k' }), ctx(), {}, true))
      .toBe('app.commandPalette')
  })
  it('matches the bracket chords from the KEY the DOM reports', () => {
    // The registry spells these `Cmd+[` / `Cmd+]` because the resolver compares against
    // `e.key`. Spelled as the `e.code` values (`BracketLeft`/`BracketRight`) they would
    // normalize to 'BRACKETLEFT' and match no keydown at all — a silently dead chord.
    expect(resolveCommandForKeyEvent(ev({ metaKey: true, key: '[' }), ctx(), {}, true))
      .toBe('canvas.goBack')
    expect(resolveCommandForKeyEvent(ev({ metaKey: true, key: ']' }), ctx(), {}, true))
      .toBe('canvas.goForward')
  })
  it('typing blocks commands without allowWhileTyping, allows the flagged ones', () => {
    expect(resolveCommandForKeyEvent(
      ev({ metaKey: true, key: 't' }), ctx({ typing: true }), {}, true
    )).toBeNull()
    expect(resolveCommandForKeyEvent(
      ev({ metaKey: true, key: 'w' }), ctx({ typing: true }), {}, true
    )).toBe('node.close')
  })
  it('terminal focus blocks canvas commands but passes allowInTerminal + terminal scope', () => {
    expect(resolveCommandForKeyEvent(
      ev({ metaKey: true, key: 't' }), ctx({ terminal: true }), {}, true
    )).toBeNull()
    expect(resolveCommandForKeyEvent(
      ev({ metaKey: true, key: 'k' }), ctx({ terminal: true }), {}, true
    )).toBe('app.commandPalette')
    expect(resolveCommandForKeyEvent(
      ev({ metaKey: true, key: 'f' }), ctx({ terminal: true }), {}, true
    )).toBe('terminal.find')
  })
  it('kanban open makes canvas-scope commands inert, app scope still fires', () => {
    expect(resolveCommandForKeyEvent(
      ev({ metaKey: true, key: 'z' }), ctx({ kanbanOpen: true }), {}, true
    )).toBeNull()
    expect(resolveCommandForKeyEvent(
      ev({ metaKey: true, shiftKey: true, key: 'b' }), ctx({ kanbanOpen: true }), {}, true
    )).toBe('view.kanbanToggle')
  })
  it('terminal.find does NOT fire outside terminal focus (scope-gated)', () => {
    expect(resolveCommandForKeyEvent(ev({ metaKey: true, key: 'f' }), ctx(), {}, true)).toBeNull()
  })
  it('respects overrides and disabled commands', () => {
    const o = { 'app.commandPalette': [] as string[], 'canvas.fitAll': ['Cmd+K'] }
    expect(resolveCommandForKeyEvent(ev({ metaKey: true, key: 'k' }), ctx(), o, true))
      .toBe('canvas.fitAll')
  })
  it('never resolves a hold chord', () => {
    expect(resolveCommandForKeyEvent(
      ev({ metaKey: true, altKey: true, key: 'Alt' }), ctx(), {}, true
    )).toBeNull()
  })
  it('never resolves scm-scope commands — they dispatch from their own composer', () => {
    expect(resolveCommandForKeyEvent(ev({ metaKey: true, key: 'Enter' }), ctx(), {}, true))
      .toBeNull()
  })
  it('never resolves speech.dictation — even a hand-edited KEYED override', () => {
    // The registry row is display-only; dictation dispatches from its own listeners reading
    // settings.speech.shortcut, so nothing here would ever handle it. Without the resolver skip
    // this override RESOLVES, finds no handler, and the chord is spent — the trailing gestures
    // (zoom / projectJump / copy) never see it, so a `Cmd+0` override kills zoom-to-100%.
    // Passed straight in, bypassing sanitize: this is exactly the hand-edited settings.json case.
    const o = { 'speech.dictation': ['Cmd+0'] }
    expect(resolveCommandForKeyEvent(ev({ metaKey: true, key: '0' }), ctx(), o, true)).toBeNull()
  })
  it('terminal focus admits terminal scope over a canvas command sharing the chord', () => {
    // Cmd+F sits on terminal.find; a canvas-scope override claims the same chord. The
    // terminal-focus gate drops canvas.fitAll before its bindings are ever read — this
    // witnesses the gate, NOT registry order (that is the tie test below).
    const o = { 'canvas.fitAll': ['Cmd+F'] }
    expect(resolveCommandForKeyEvent(
      ev({ metaKey: true, key: 'f' }), ctx({ terminal: true }), o, true
    )).toBe('terminal.find')
  })
  it('resolves the non-mac-only alternate default (Ctrl+Y → redo)', () => {
    expect(resolveCommandForKeyEvent(ev({ ctrlKey: true, key: 'y' }), ctx(), {}, false))
      .toBe('canvas.redo')
  })
  it('non-mac Ctrl+Shift+C is copy in a terminal and New agent outside one', () => {
    // By design, the two buckets double-book this chord: node.newAgent (global) and
    // terminal.copySelection (terminal) both default to it off-mac, and the focus gates — not
    // the conflict detector — are what keep them apart at dispatch time.
    const e = ev({ ctrlKey: true, shiftKey: true, key: 'C' })
    expect(resolveCommandForKeyEvent(e, ctx({ terminal: true }), {}, false))
      .toBe('terminal.copySelection')
    expect(resolveCommandForKeyEvent(e, ctx(), {}, false)).toBe('node.newAgent')
  })
  it('a bare key resolves, and typing still blocks it', () => {
    expect(resolveCommandForKeyEvent(ev({ key: 'Delete' }), ctx(), {}, true))
      .toBe('canvas.deleteSelection')
    expect(resolveCommandForKeyEvent(ev({ key: 'Delete' }), ctx({ typing: true }), {}, true))
      .toBeNull()
  })
  it('first matching definition in registry source order wins a tie', () => {
    // Deliberately unsanitized colliding override — the resolver must order the tie deterministically.
    const o = { 'canvas.redo': ['Cmd+Z'] }
    expect(resolveCommandForKeyEvent(ev({ metaKey: true, key: 'z' }), ctx(), o, true)).toBe('canvas.undo')
  })
})

describe('findMainInterceptShadowing', () => {
  it('flags a main-intercepted remap that shadows another bucket', () => {
    expect(findMainInterceptShadowing('node.close', 'Cmd+F', {}, true)).toEqual(['terminal.find'])
    expect(findMainInterceptShadowing('node.close', 'Cmd+Enter', {}, true)).toEqual(['scm.commit'])
  })
  it('same-bucket collisions are the sanitizer/conflict path, still reported here', () => {
    expect(findMainInterceptShadowing('node.toggleMarkdown', 'Cmd+K', {}, true)).toEqual([
      'app.commandPalette'
    ])
  })
  it('empty for a clean chord, for non-intercepted commands, and never self-reports', () => {
    expect(findMainInterceptShadowing('node.close', 'Cmd+Alt+F9', {}, true)).toEqual([])
    expect(findMainInterceptShadowing('canvas.undo', 'Cmd+F', {}, true)).toEqual([])
    expect(findMainInterceptShadowing('node.close', 'Cmd+W', {}, true)).toEqual([])
  })
  it('respects overrides and cross-spelling identities', () => {
    const o = { 'terminal.find': ['Cmd+Alt+F9'] }
    expect(findMainInterceptShadowing('node.close', 'Cmd+F', o, true)).toEqual([])
    expect(findMainInterceptShadowing('node.close', 'Ctrl+K', {}, false)).toEqual([
      'app.commandPalette'
    ])
  })
  it('names exactly the two main-intercepted commands', () => {
    expect(MAIN_INTERCEPTED_COMMAND_IDS).toEqual(['node.close', 'node.toggleMarkdown'])
  })
})

describe('normalizeTerminalShortcutPolicy', () => {
  it('defaults everything but the literal terminal-first to app-first', () => {
    expect(normalizeTerminalShortcutPolicy('terminal-first')).toBe('terminal-first')
    expect(normalizeTerminalShortcutPolicy('app-first')).toBe('app-first')
    expect(normalizeTerminalShortcutPolicy(undefined)).toBe('app-first')
    expect(normalizeTerminalShortcutPolicy('shell-first')).toBe('app-first')
  })
})

describe('resolver under terminal-first', () => {
  const term = (terminalFirst: boolean) => ({
    typing: false, terminal: true, kanbanOpen: false, terminalFirst
  })
  it('app-first keeps today: allowInTerminal app commands fire over a terminal', () => {
    expect(resolveCommandForKeyEvent(ev({ metaKey: true, key: 'k' }), term(false), {}, true))
      .toBe('app.commandPalette')
  })
  it('terminal-first blocks allowInTerminal app commands', () => {
    expect(resolveCommandForKeyEvent(ev({ metaKey: true, key: 'k' }), term(true), {}, true))
      .toBeNull()
    expect(resolveCommandForKeyEvent(ev({ metaKey: true, shiftKey: true, key: 'b' }), term(true), {}, true))
      .toBeNull()
  })
  it('terminal-first keeps terminal-scope commands alive', () => {
    expect(resolveCommandForKeyEvent(ev({ metaKey: true, key: 'f' }), term(true), {}, true))
      .toBe('terminal.find')
  })
  it('terminalFirst is inert outside terminal focus', () => {
    const app = { typing: false, terminal: false, kanbanOpen: false, terminalFirst: true }
    expect(resolveCommandForKeyEvent(ev({ metaKey: true, key: 'k' }), app, {}, true))
      .toBe('app.commandPalette')
  })
})

describe('dictation conflict bucket', () => {
  it("a dictation override sharing another command's chord is NOT a conflict", () => {
    expect(findKeybindingConflicts({ 'speech.dictation': ['Cmd+K'] }, true)).toEqual([])
  })
  it('sanitize keeps a colliding dictation override — the migration survival case', () => {
    const r = sanitizeKeybindingOverrides({ 'speech.dictation': ['Cmd+K'] }, true)
    expect(r).toEqual({ overrides: { 'speech.dictation': ['Cmd+K'] }, warnings: [] })
  })
  it("sanitize keeps BOTH sides when a user override shares dictation's chord", () => {
    const r = sanitizeKeybindingOverrides(
      { 'speech.dictation': ['Cmd+J'], 'app.commandPalette': ['Cmd+J'] },
      true
    )
    expect(r.overrides).toEqual({
      'speech.dictation': ['Cmd+J'],
      'app.commandPalette': ['Cmd+J']
    })
    expect(r.warnings).toEqual([])
  })
  // Dictation is now OUTSIDE `includeDefaults`' reach: a future default colliding with its
  // `Cmd+Alt` would not be caught here.
  it('the shipped defaults stay conflict-free under full scrutiny (unchanged invariant)', () => {
    expect(findKeybindingConflicts({}, true, { includeDefaults: true })).toEqual([])
    expect(findKeybindingConflicts({}, false, { includeDefaults: true })).toEqual([])
  })
})

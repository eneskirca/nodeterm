import { describe, expect, it } from 'vitest'

import {
  CONFIRM_WAIVABLE_VERBS,
  CONTROL_REQUEST_TIMEOUT_MS,
  confirmExpiresAt,
  decideControlConfirm,
  expiredDialogNotice,
  isWaivableVerb,
  pruneControlConfirmWaivers,
  withProjectWaiver,
  WAIVABLE_VERB_ACTIONS,
  projectWaiverState,
  otherWaiverHint,
  sanitizeControlConfirmWaivers,
  waiveChoices,
  waivedNotice
} from './control-confirm'
import { DESTRUCTIVE_VERBS } from './control-verbs'

describe('which verbs may be waived', () => {
  it('is a strict subset of the confirm-gated set', () => {
    for (const v of CONFIRM_WAIVABLE_VERBS) expect(DESTRUCTIVE_VERBS.has(v)).toBe(true)
    expect(CONFIRM_WAIVABLE_VERBS.size).toBeLessThan(DESTRUCTIVE_VERBS.size)
  })

  it('never admits settings, whatever the user asks for', () => {
    // A settings change can GRANT a capability; a standing waiver covering it would let an agent
    // hand itself a power on an answer the human gave about something else.
    expect(isWaivableVerb('settings')).toBe(false)
    // Every lever: the app-run set, the persisted list, the per-project map, and the bypass pair.
    expect(
      decideControlConfirm({ verb: 'settings', sessionWaived: new Set(['settings']) })
    ).toEqual({ skip: false, via: null })
    expect(
      decideControlConfirm({ verb: 'settings', persisted: { always: ['settings'] } })
    ).toEqual({ skip: false, via: null })
    expect(
      decideControlConfirm({
        verb: 'settings',
        persisted: { projects: { p1: ['settings'] } },
        projectId: 'p1'
      })
    ).toEqual({ skip: false, via: null })
    expect(
      decideControlConfirm({
        verb: 'settings',
        persisted: { bypassMode: true },
        permissionMode: 'bypassPermissions',
        permissionModeSource: 'global'
      })
    ).toEqual({ skip: false, via: null })
  })

  it('admits open-project — its dedupe is per caller NODE per app run, so it DID repeat', () => {
    // The 2026-10 report: an orchestrator in one project opening sessions in another got the
    // "Allow?" dialog again from every new orchestrator, every spawned station and every restart,
    // with no box to stop it. It now reads every lever exactly like write/close.
    expect(isWaivableVerb('open-project')).toBe(true)
    expect(
      decideControlConfirm({ verb: 'open-project', sessionWaived: new Set(['open-project']) })
    ).toEqual({ skip: true, via: 'session' })
    expect(
      decideControlConfirm({
        verb: 'open-project',
        persisted: { projects: { p1: ['open-project'] } },
        projectId: 'p1'
      })
    ).toEqual({ skip: true, via: 'project' })
    // Keyed on the CALLER's project: a grant for p1's agents says nothing about p2's.
    expect(
      decideControlConfirm({
        verb: 'open-project',
        persisted: { projects: { p1: ['open-project'] } },
        projectId: 'p2'
      }).skip
    ).toBe(false)
    // …and a waiver for `close` in p1 does not reach `open-project` in p1.
    expect(
      decideControlConfirm({
        verb: 'open-project',
        persisted: { projects: { p1: ['close'] } },
        projectId: 'p1'
      }).skip
    ).toBe(false)
  })

  it('does not answer for a verb that has no dialog at all', () => {
    expect(isWaivableVerb('list')).toBe(false)
    expect(decideControlConfirm({ verb: 'list', sessionWaived: new Set(['list']) }).skip).toBe(false)
  })
})

describe('decideControlConfirm — the default is to ask', () => {
  it('asks when nothing is waived', () => {
    for (const verb of ['write', 'close']) {
      expect(decideControlConfirm({ verb })).toEqual({ skip: false, via: null })
    }
  })

  it('honours an app-run waiver, per verb', () => {
    expect(decideControlConfirm({ verb: 'close', sessionWaived: new Set(['close']) })).toEqual({
      skip: true,
      via: 'session'
    })
    // Waiving `close` says nothing about `write` — the whole point of keying on the verb.
    expect(decideControlConfirm({ verb: 'write', sessionWaived: new Set(['close']) }).skip).toBe(
      false
    )
  })

  it('honours a permanent waiver', () => {
    expect(decideControlConfirm({ verb: 'write', persisted: { always: ['write'] } })).toEqual({
      skip: true,
      via: 'always'
    })
  })

  it('re-checks a hand-edited `always` entry against the table', () => {
    // Reachable: settings.json is hand-editable and the sanitizer runs at read, but the decision
    // must not depend on somebody having called it.
    expect(
      decideControlConfirm({ verb: 'settings', persisted: { always: ['settings'] } }).skip
    ).toBe(false)
  })
})

describe('the bypassPermissions branch needs BOTH locks', () => {
  const bypassGlobal = {
    verb: 'close',
    permissionMode: 'bypassPermissions',
    permissionModeSource: 'global'
  } as const

  it('skips when the machine opted in AND the mode is the user own global choice', () => {
    expect(decideControlConfirm({ ...bypassGlobal, persisted: { bypassMode: true } })).toEqual({
      skip: true,
      via: 'bypass'
    })
  })

  it('asks when the machine did not opt in', () => {
    expect(decideControlConfirm({ ...bypassGlobal }).skip).toBe(false)
    expect(decideControlConfirm({ ...bypassGlobal, persisted: { bypassMode: false } }).skip).toBe(
      false
    )
  })

  it('asks when bypassPermissions came from the PROJECT file — the cloned-repo trap', () => {
    // `.nodeterm/project.json` is git-shared, so `project.defaultPermissionMode` arrives with
    // somebody else's repository. It must never waive a local confirmation.
    expect(
      decideControlConfirm({
        verb: 'close',
        persisted: { bypassMode: true },
        permissionMode: 'bypassPermissions',
        permissionModeSource: 'project'
      }).skip
    ).toBe(false)
  })

  it('asks when nobody chose the mode at all', () => {
    expect(
      decideControlConfirm({
        verb: 'close',
        persisted: { bypassMode: true },
        permissionMode: 'bypassPermissions',
        permissionModeSource: 'default'
      }).skip
    ).toBe(false)
  })

  it('asks under every other permission mode', () => {
    for (const mode of ['manual', 'auto', 'acceptEdits', 'plan'] as const) {
      expect(
        decideControlConfirm({
          verb: 'close',
          persisted: { bypassMode: true },
          permissionMode: mode,
          permissionModeSource: 'global'
        }).skip
      ).toBe(false)
    }
  })
})

describe('sanitizeControlConfirmWaivers — settings.json is hostile input', () => {
  it('drops unwaivable and unknown verb names', () => {
    expect(
      sanitizeControlConfirmWaivers({ always: ['close', 'settings', 'rm -rf', 42] })
    ).toEqual({ always: ['close'] })
    // A waivable verb survives — the table decides, not a list here.
    expect(sanitizeControlConfirmWaivers({ always: ['open-project'] })).toEqual({
      always: ['open-project']
    })
  })

  it('collapses duplicates and omits an empty list', () => {
    expect(sanitizeControlConfirmWaivers({ always: ['write', 'write'] })).toEqual({
      always: ['write']
    })
    expect(sanitizeControlConfirmWaivers({ always: [] })).toEqual({})
  })

  it('accepts only a literal true for bypassMode', () => {
    expect(sanitizeControlConfirmWaivers({ bypassMode: true })).toEqual({ bypassMode: true })
    for (const v of ['true', 1, {}, null]) {
      expect(sanitizeControlConfirmWaivers({ bypassMode: v })).toEqual({})
    }
  })

  it('degrades any non-object to "ask"', () => {
    for (const raw of [undefined, null, 'close', 7, ['close']]) {
      expect(sanitizeControlConfirmWaivers(raw)).toEqual({})
    }
  })
})

describe('the dialog deadline', () => {
  it('is main own request budget, measured from the renderer receipt', () => {
    expect(confirmExpiresAt(1_000)).toBe(1_000 + CONTROL_REQUEST_TIMEOUT_MS)
    // Later than main started waiting, never earlier: the renderer receives the request after the
    // timer starts, so the dialog can never abandon a request main would still accept.
    expect(confirmExpiresAt(1_000)).toBeGreaterThan(CONTROL_REQUEST_TIMEOUT_MS)
  })
})

describe('expiredDialogNotice', () => {
  it('names who asked, and says nothing happened', () => {
    const n = expiredDialogNotice('orchestrator')
    expect(n).toContain('orchestrator')
    expect(n).toContain('expired')
    // The whole point of the sentence: the user must not be left wondering whether the worktree
    // was removed / the text was sent while they were away.
    expect(n).toContain('nothing was done')
  })

  it('falls back to "an agent" rather than printing undefined', () => {
    expect(expiredDialogNotice()).toContain('an agent')
    expect(expiredDialogNotice()).not.toContain('undefined')
  })

  it('is ONE sentence for every expiring dialog', () => {
    // Both callers (the canvas-control confirm and the worktree-removal dialog) render this. Two
    // wordings for the same event read as two different events.
    expect(expiredDialogNotice('x')).toBe(expiredDialogNotice('x'))
  })
})

describe('waivedNotice', () => {
  it('names the action and the waiver that let it through', () => {
    expect(waivedNotice('Agent "x" closed 3 nodes', 'session')).toContain('this app run')
    expect(waivedNotice('Agent "x" closed 3 nodes', 'always')).toContain('permanently')
    expect(waivedNotice('Agent "x" closed 3 nodes', 'bypass')).toContain('Bypass')
    // Every variant points at where to undo it — a waived destructive action is never silent.
    for (const via of ['session', 'always', 'bypass'] as const) {
      expect(waivedNotice('did a thing', via)).toContain('Settings → Agents')
      expect(waivedNotice('did a thing', via)).toContain('did a thing')
    }
  })
})

describe('the per-project waiver — a "don\'t ask again" that lasts, without going machine-wide', () => {
  it('skips only inside the project it was granted for', () => {
    const persisted = { projects: { p1: ['close'] } }
    expect(decideControlConfirm({ verb: 'close', persisted, projectId: 'p1' })).toEqual({
      skip: true,
      via: 'project'
    })
    // The whole point of the scope. A user who trusts the orchestrator in one repo has said
    // nothing at all about the next one.
    expect(decideControlConfirm({ verb: 'close', persisted, projectId: 'p2' })).toEqual({
      skip: false,
      via: null
    })
    // …and nothing about another verb in the same project.
    expect(decideControlConfirm({ verb: 'write', persisted, projectId: 'p1' })).toEqual({
      skip: false,
      via: null
    })
  })

  it('needs a real project id — an absent one must not match anything', () => {
    // Fail closed: canvas control can now answer a call whose owning project it could not resolve,
    // and `undefined` used as a map key would stringify to "undefined" and match a hand-edited
    // entry of that name.
    const persisted = { projects: { undefined: ['close'], '': ['close'] } }
    expect(decideControlConfirm({ verb: 'close', persisted }).skip).toBe(false)
    expect(decideControlConfirm({ verb: 'close', persisted, projectId: '' }).skip).toBe(false)
  })

  it('is outranked by the unwaivable table, like every other lever', () => {
    expect(
      decideControlConfirm({
        verb: 'settings',
        persisted: { projects: { p1: ['settings'] } },
        projectId: 'p1'
      })
    ).toEqual({ skip: false, via: null })
  })

  it('sits between the app-run waiver and the machine-wide one', () => {
    // Precedence is narrowest-first among the persisted grants, so the notice names the waiver the
    // user most likely wants back. A session waiver still outranks it: it is the most recent thing
    // they said.
    const persisted = { projects: { p1: ['close'] }, always: ['close'] }
    expect(decideControlConfirm({ verb: 'close', persisted, projectId: 'p1' }).via).toBe('project')
    expect(
      decideControlConfirm({
        verb: 'close',
        persisted,
        projectId: 'p1',
        sessionWaived: new Set(['close'])
      }).via
    ).toBe('session')
    // A project with no entry still falls through to the machine-wide one.
    expect(decideControlConfirm({ verb: 'close', persisted, projectId: 'p9' }).via).toBe('always')
  })

  it('a project entry never opens the bypass branch, and vice versa', () => {
    // They are independent locks; neither may stand in for the other.
    expect(
      decideControlConfirm({
        verb: 'close',
        persisted: { projects: { p1: ['close'] } },
        projectId: 'p2',
        permissionMode: 'bypassPermissions',
        permissionModeSource: 'global'
      }).skip
    ).toBe(false)
  })
})

describe('sanitizeControlConfirmWaivers — the per-project map is hostile input too', () => {
  it('applies the verb table per project, exactly as it does to `always`', () => {
    expect(
      sanitizeControlConfirmWaivers({
        projects: { p1: ['close', 'settings', 'nonsense', 'close', 'open-project'] }
      })
    ).toEqual({ projects: { p1: ['close', 'open-project'] } })
  })

  it('drops an entry that would waive nothing, key and all', () => {
    // An entry waiving nothing is indistinguishable from no entry to every reader, and keeping it
    // would put a row in Settings offering to revoke a waiver that does not exist.
    expect(sanitizeControlConfirmWaivers({ projects: { p1: [], p2: ['settings'] } })).toEqual({})
  })

  it('degrades a non-object `projects` to nothing rather than throwing', () => {
    for (const bad of [null, 'close', 42, ['close'], true]) {
      expect(sanitizeControlConfirmWaivers({ projects: bad })).toEqual({})
    }
    expect(sanitizeControlConfirmWaivers({ projects: { '': ['close'] } })).toEqual({})
  })

  it('keeps the other keys intact', () => {
    expect(
      sanitizeControlConfirmWaivers({
        always: ['write'],
        projects: { p1: ['close'] },
        bypassMode: true
      })
    ).toEqual({ always: ['write'], projects: { p1: ['close'] }, bypassMode: true })
  })
})

describe('pruneControlConfirmWaivers — settings.json is forever, project ids are not', () => {
  it('drops entries whose project is gone', () => {
    const w = { projects: { alive: ['close'], dead: ['write'] }, always: ['write'] }
    expect(pruneControlConfirmWaivers(w, new Set(['alive']))).toEqual({
      projects: { alive: ['close'] },
      always: ['write']
    })
  })

  it('removes the key entirely when nothing survives', () => {
    const pruned = pruneControlConfirmWaivers({ projects: { dead: ['close'] } }, new Set())
    expect(pruned).toEqual({})
    expect('projects' in pruned).toBe(false)
  })

  it('returns the SAME object when nothing would change, so a no-op never dirties settings', () => {
    const w = { projects: { alive: ['close'] } }
    expect(pruneControlConfirmWaivers(w, new Set(['alive']))).toBe(w)
    const none = { always: ['close'] }
    expect(pruneControlConfirmWaivers(none, new Set())).toBe(none)
  })
})

describe('waivedNotice names the per-project waiver by project', () => {
  it('names the project, because "this project" may not be the one on screen', () => {
    // Canvas control answers a background agent in its OWN project without moving the user's tab,
    // so a notice saying "this project" would point at whatever they happen to be looking at.
    expect(waivedNotice('Agent "A" closed n-1', 'project', 'web-app')).toContain('"web-app"')
    expect(waivedNotice('Agent "A" closed n-1', 'project', 'web-app')).toContain('Settings \u2192 Agents')
  })

  it('still says something true when the project name is unknown', () => {
    expect(waivedNotice('x', 'project')).toContain('that project')
    expect(waivedNotice('x', 'project')).not.toContain('undefined')
  })

  it('the other three are unchanged', () => {
    expect(waivedNotice('x', 'session')).toContain('this app run')
    expect(waivedNotice('x', 'always')).toContain('permanently')
    expect(waivedNotice('x', 'bypass')).toContain('Bypass')
  })
})

describe('waiveChoices — what the dialog offers, and what each choice promises', () => {
  it('starts on "ask", which grants nothing — an untouched dialog must not waive anything', () => {
    const choices = waiveChoices({ id: 'p1', name: 'web-app' })
    expect(choices[0]).toEqual({ value: 'ask', label: expect.stringContaining('Ask') })
  })

  it('offers the per-project choice BY NAME, visible without ticking anything first', () => {
    // The report: the per-repo answer read as missing, because it only appeared after a checkbox.
    const choices = waiveChoices({ id: 'p1', name: 'web-app' })
    expect(choices.map((c) => c.value)).toEqual(['ask', 'project', 'session'])
    const project = choices.find((c) => c.value === 'project')!
    expect(project.label).toContain('"web-app"')
    // Names the AGENTS whose calls it covers — the key is the caller's project, not the target.
    expect(project.label).toContain('agents in')
  })

  it('says the app-run choice covers EVERY project — it is per verb, not per project', () => {
    // `state/controlConfirm.ts` keys the app-run waiver on the verb alone. A label implying a
    // project bound would promise something the grant does not keep.
    const session = waiveChoices({ id: 'p1', name: 'web-app' }).find((c) => c.value === 'session')!
    expect(session.label).toContain('any project')
    expect(session.label).toContain('until nodeterm quits')
    expect(session.label).not.toContain('web-app')
  })

  it('does not offer a per-project grant when no project owns the call', () => {
    // `waiveControlConfirmForProject` would refuse it; offering it would be a promise the grant
    // cannot keep.
    for (const project of [undefined, {}, { name: 'x' }, { id: '' }]) {
      expect(waiveChoices(project).map((c) => c.value)).toEqual(['ask', 'session'])
    }
  })

  it('never prints undefined when the name is missing', () => {
    const project = waiveChoices({ id: 'p1' }).find((c) => c.value === 'project')!
    expect(project.label).not.toContain('undefined')
  })
})

describe('withProjectWaiver — the one write behind every per-project toggle', () => {
  const live = new Set(['p1', 'p2'])

  it('adds a verb to one project and leaves the rest of the waivers alone', () => {
    expect(withProjectWaiver({ always: ['write'] }, 'p1', 'close', true, live)).toEqual({
      always: ['write'],
      projects: { p1: ['close'] }
    })
  })

  it('removes a verb and drops the project key once it waives nothing', () => {
    const w = { projects: { p1: ['close', 'write'], p2: ['close'] } }
    expect(withProjectWaiver(w, 'p1', 'close', false, live)).toEqual({
      projects: { p1: ['write'], p2: ['close'] }
    })
    expect(withProjectWaiver(w, 'p2', 'close', false, live)).toEqual({
      projects: { p1: ['close', 'write'] }
    })
  })

  it('is idempotent and prunes projects that no longer exist', () => {
    const w = { projects: { gone: ['close'], p1: ['close'] } }
    expect(withProjectWaiver(w, 'p1', 'close', true, live)).toEqual({ projects: { p1: ['close'] } })
  })

  it('keeps the answer for the target even if that project vanished meanwhile', () => {
    expect(withProjectWaiver({}, 'late', 'close', true, live)).toEqual({ projects: { late: ['close'] } })
  })

  it('refuses an unwaivable verb or a missing project — nothing changes', () => {
    expect(withProjectWaiver({}, 'p1', 'settings', true, live)).toEqual({})
    expect(withProjectWaiver({}, undefined, 'close', true, live)).toEqual({})
  })

  it('has a menu label for every waivable verb', () => {
    for (const v of CONFIRM_WAIVABLE_VERBS) expect(WAIVABLE_VERB_ACTIONS[v], v).toBeTruthy()
  })
})

describe('projectWaiverState — what the per-project toggle may honestly show', () => {
  const base = { verb: 'close', projectId: 'p1' }

  it('asks by default', () => {
    expect(projectWaiverState(base)).toEqual({ granted: false, skips: false, otherVia: null })
  })

  it('reports the project grant, with nothing else in play', () => {
    expect(projectWaiverState({ ...base, persisted: { projects: { p1: ['close'] } } })).toEqual({
      granted: true,
      skips: true,
      otherVia: null
    })
  })

  it('names an app-run waiver that skips the dialog with or without the project grant', () => {
    const session = new Set(['close'])
    expect(projectWaiverState({ ...base, sessionWaived: session })).toEqual({
      granted: false,
      skips: true,
      otherVia: 'session'
    })
    // Removing the project grant would restore nothing — the row must not promise "ask again".
    expect(
      projectWaiverState({ ...base, sessionWaived: session, persisted: { projects: { p1: ['close'] } } })
    ).toEqual({ granted: true, skips: true, otherVia: 'session' })
  })

  it('names the machine-wide waiver', () => {
    expect(projectWaiverState({ ...base, persisted: { always: ['close'] } }).otherVia).toBe('always')
  })

  it('names global Bypass, but never a Bypass that came from the project file', () => {
    const bypass = { persisted: { bypassMode: true }, permissionMode: 'bypassPermissions' as const }
    expect(projectWaiverState({ ...base, ...bypass, permissionModeSource: 'global' }).otherVia).toBe('bypass')
    expect(projectWaiverState({ ...base, ...bypass, permissionModeSource: 'project' })).toEqual({
      granted: false,
      skips: false,
      otherVia: null
    })
  })

  it('never reports settings as waivable, whatever the file says', () => {
    expect(
      projectWaiverState({ ...base, verb: 'settings', persisted: { projects: { p1: ['settings'] } } })
    ).toEqual({ granted: false, skips: false, otherVia: null })
  })

  it('points every other waiver at the place it is revoked', () => {
    for (const via of ['session', 'always', 'bypass'] as const) {
      expect(otherWaiverHint(via)).toContain('Settings → Agents')
    }
  })
})

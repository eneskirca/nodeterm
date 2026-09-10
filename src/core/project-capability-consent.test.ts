import { describe, it, expect } from 'vitest'
import type { Project } from '../shared/types'
import {
  needsCapabilityNotice,
  projectCapabilityGranted,
  projectCapabilityGrantedFor,
  rearmDefaultCapabilityAcks,
  recordCapabilityAck
} from './project-capability-consent'
import * as shared from '../shared/project-capability-consent'
import { projectToFile, type IndexEntryV3 } from './workspace-files'

const baseProject: Project = {
  id: 'p1',
  name: 'p',
  color: '#fff',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: []
}

describe('needsCapabilityNotice', () => {
  const cap = 'agentBrowserControl' as const
  it('off in the file ⇒ never a notice', () => {
    expect(needsCapabilityNotice({ capability: cap, enabledInFile: false, answer: undefined })).toBe(false)
    expect(needsCapabilityNotice({ capability: cap, enabledInFile: false, answer: 'declined' })).toBe(false)
  })
  it('on in the file and never answered ON THIS MACHINE ⇒ notice', () => {
    expect(needsCapabilityNotice({ capability: cap, enabledInFile: true, answer: undefined })).toBe(true)
  })
  it('on and KEPT ⇒ silent thereafter', () => {
    expect(needsCapabilityNotice({ capability: cap, enabledInFile: true, answer: 'kept' })).toBe(false)
  })
  it('on and previously DECLINED ⇒ a NEW notice — the file re-arrived against a recorded no', () => {
    // C1 (PR #213 review): "Turn it off" deletes the field only in this working copy; a
    // `git checkout`/pull restores the hostile `true` and the watcher re-reads it. A recorded
    // decline must produce a fresh notice, never silence.
    expect(needsCapabilityNotice({ capability: cap, enabledInFile: true, answer: 'declined' })).toBe(true)
  })
})

describe('projectCapabilityGranted — only an explicit KEPT grants', () => {
  const cap = 'agentBrowserControl' as const
  it('a switch that is on but unanswered grants nothing', () => {
    // This is what the ledger (browser PR 4) and messagingEnabled (messaging PR 6) consult: the
    // window between a hostile clone's `agentBrowserControl: true` arriving and the user answering
    // the notice must be a refusal. Deleting the answer condition makes this red.
    expect(projectCapabilityGranted({ capability: cap, enabledInFile: true, answer: undefined })).toBe(false)
  })
  it('a DECLINED switch grants nothing even when the file says true again', () => {
    // C1's grant leg: decline → hostile true re-arrives → the standing "no" must refuse. An ack
    // that does not carry the answer cannot express this; treating any answer as consent is the
    // exact mutation this test exists to catch.
    expect(projectCapabilityGranted({ capability: cap, enabledInFile: true, answer: 'declined' })).toBe(false)
  })
  it('off in the file grants nothing, whatever was answered', () => {
    expect(projectCapabilityGranted({ capability: cap, enabledInFile: false, answer: 'kept' })).toBe(false)
  })
  it('on and kept is the one granting combination', () => {
    expect(projectCapabilityGranted({ capability: cap, enabledInFile: true, answer: 'kept' })).toBe(true)
  })
})

describe('projectCapabilityGrantedFor — the ONE consumer-facing wiring (PR 4 ledger, PR 6 messagingEnabled)', () => {
  const cap = 'agentBrowserControl' as const
  it('derives both halves from the project and refuses every non-granting shape', () => {
    expect(projectCapabilityGrantedFor(undefined, cap)).toBe(false)
    expect(projectCapabilityGrantedFor({ ...baseProject }, cap)).toBe(false)
    // pending notice (hostile clone window)
    expect(projectCapabilityGrantedFor({ ...baseProject, agentBrowserControl: true }, cap)).toBe(false)
    // recorded decline + re-arrived true
    expect(
      projectCapabilityGrantedFor(
        { ...baseProject, agentBrowserControl: true, capabilityAck: { [cap]: 'declined' } },
        cap
      )
    ).toBe(false)
    // non-literal-true file value never grants, answer or no answer
    expect(
      projectCapabilityGrantedFor(
        { ...baseProject, agentBrowserControl: 'true', capabilityAck: { [cap]: 'kept' } } as never,
        cap
      )
    ).toBe(false)
  })
  it('grants exactly for literal true + kept', () => {
    expect(
      projectCapabilityGrantedFor(
        { ...baseProject, agentBrowserControl: true, capabilityAck: { [cap]: 'kept' } },
        cap
      )
    ).toBe(true)
  })
  it('ignores a prototype-inherited flag or answer — own properties only', () => {
    // M-1 (PR #213 review): unreachable from JSON.parse, but in-process objects can inherit.
    const inheritedFlag = Object.create({ agentBrowserControl: true }) as Project
    expect(projectCapabilityGrantedFor({ ...baseProject, ...inheritedFlag, capabilityAck: { [cap]: 'kept' } }, cap)).toBe(false)
    const proto = Object.create({ agentBrowserControl: true, capabilityAck: { [cap]: 'kept' } }) as Project
    expect(projectCapabilityGrantedFor(proto, cap)).toBe(false)
  })
})

describe('the acknowledgment is MACHINE-LOCAL and carries the answer', () => {
  it('recordCapabilityAck writes the given answer to the index entry, never to the project file', () => {
    const kept = recordCapabilityAck({ id: 'p1', name: 'p', color: '#fff' } as IndexEntryV3, 'agentBrowserControl', 'kept')
    expect(kept.capabilityAck).toEqual({ agentBrowserControl: 'kept' })
    const declined = recordCapabilityAck({ id: 'p1', name: 'p', color: '#fff' } as IndexEntryV3, 'agentBrowserControl', 'declined')
    expect(declined.capabilityAck).toEqual({ agentBrowserControl: 'declined' })
    // The shared file must not learn about it: projectToFile writes only the capability FIELDS.
    // The project here CARRIES an ack (M-3: an ack-less input could never catch a leak).
    const file = projectToFile(
      { ...baseProject, agentBrowserControl: true, capabilityAck: { agentBrowserControl: 'kept' } },
      1,
      't',
      'l'
    )
    expect(Object.keys(file)).not.toContain('capabilityAck')
    expect(JSON.stringify(file)).not.toContain('capabilityAck')
    expect(JSON.stringify(projectToFile({
      ...baseProject,
      capabilityAckSource: { agentMessaging: 'local-default' }
    }, 1, 't'))).not.toContain('capabilityAckSource')
  })

  it('a later answer overwrites an earlier one, without mutating the input', () => {
    const before: IndexEntryV3 = {
      id: 'p1',
      name: 'p',
      color: '#fff',
      capabilityAck: { agentBrowserControl: 'declined' }
    }
    const after = recordCapabilityAck(before, 'agentBrowserControl', 'kept')
    expect(after).not.toBe(before)
    expect(before.capabilityAck).toEqual({ agentBrowserControl: 'declined' })
    expect(after.capabilityAck).toEqual({ agentBrowserControl: 'kept' })
  })

  it('re-arms only a global-default answer when external project content arrives', () => {
    const seeded: IndexEntryV3 = {
      id: 'p1', name: 'p', color: '#fff',
      capabilityAck: { agentMessaging: 'kept', agentBrowserControl: 'kept' },
      capabilityAckSource: { agentMessaging: 'local-default' }
    }
    const rearmed = rearmDefaultCapabilityAcks(seeded)
    expect(rearmed.capabilityAck).toEqual({ agentBrowserControl: 'kept' })
    expect(rearmed.capabilityAckSource).toBeUndefined()
    expect(seeded.capabilityAck?.agentMessaging).toBe('kept')
  })

  it('an explicit per-project answer replaces global-default provenance', () => {
    const answered = recordCapabilityAck({
      id: 'p1', name: 'p', color: '#fff',
      capabilityAck: { agentMessaging: 'kept' },
      capabilityAckSource: { agentMessaging: 'local-default' }
    } as IndexEntryV3, 'agentMessaging', 'kept')
    expect(answered.capabilityAck?.agentMessaging).toBe('kept')
    expect(answered.capabilityAckSource).toBeUndefined()
  })

  it('a SECOND WORKTREE of the same repo notifies again', () => {
    // node ids and project.json re-materialise in a second folder (git worktree add / checkout /
    // reset --hard), and workspace-files.ts is explicit that the index entry id is the only
    // authority for project identity. A second folder is a second entry, hence a second notice —
    // which is correct: it is a different working copy the user has not vetted.
    const a = recordCapabilityAck({ id: 'p1', name: 'p', color: '#fff' } as IndexEntryV3, 'agentBrowserControl', 'kept')
    const b: IndexEntryV3 = { id: 'p2', name: 'p', color: '#fff' } // same repo, second worktree, fresh entry
    expect(
      needsCapabilityNotice({
        capability: 'agentBrowserControl',
        enabledInFile: true,
        answer: a.capabilityAck?.agentBrowserControl
      })
    ).toBe(false)
    expect(
      needsCapabilityNotice({
        capability: 'agentBrowserControl',
        enabledInFile: true,
        answer: b.capabilityAck?.agentBrowserControl
      })
    ).toBe(true)
  })
})

describe('one decider, two consumers', () => {
  it('core re-exports the SAME functions the renderer imports from @shared — no drift possible', () => {
    // Same rule as isSafeNodeId: the renderer may not import src/core, so the implementation lives
    // in @shared/project-capability-consent and this core path re-exports it for main/core callers
    // (agent-messaging PR 6 Task 6.2 must not reimplement either function).
    expect(needsCapabilityNotice).toBe(shared.needsCapabilityNotice)
    expect(recordCapabilityAck).toBe(shared.recordCapabilityAck)
    expect(projectCapabilityGranted).toBe(shared.projectCapabilityGranted)
    expect(projectCapabilityGrantedFor).toBe(shared.projectCapabilityGrantedFor)
  })
})

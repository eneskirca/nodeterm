import { describe, it, expect, beforeEach } from 'vitest'
import {
  folderName,
  normalizeProjectCwd,
  planOpenProject,
  recordAttachConsent,
  attachConsentRecorded,
  clearAttachConsentForTests,
  findProjectByCwd,
  openProjectReply,
  nextFreePosition,
  armForColdOpen,
  projectTargetFlagRefusal,
  clearAttachConsent,
  type PlacedNode
} from './projectOpen'

/**
 * Issue #338 Task 2.2/2.3 — the pure halves of the `open-project` dispatch and the
 * `--project`-targeted placement. Canvas.tsx only wires these (the dialog, the store calls, the
 * reply); everything decidable without React is decided here so it is red-capable:
 *
 * - EVERY grant passes a human decision exactly once (spec Q1, adopted): a caller's FIRST
 *   open-project against an EXISTING project confirms too — the confirm-bypass mutation
 *   ("silent idempotent hit") turns this suite red.
 * - The dialog copy always contains the RESOLVED path (spec P5).
 * - The consent mirror is per-caller and session-scoped (dialog dedupe only — authorization is
 *   main's grant ledger, never this map).
 */

beforeEach(() => clearAttachConsentForTests())

const projects = [
  { id: 'project-a', name: 'repoA', cwd: '/home/me/dev/repoA' },
  { id: 'project-b', name: 'repoB', cwd: '/home/me/dev/repoB' }
]

describe('planOpenProject — the consent decision (spec §2.1, Q1)', () => {
  it('FIRST attach to an existing project confirms — an idempotent hit is not silent', () => {
    const plan = planOpenProject({
      projects,
      callerNodeId: 'term-caller',
      srcTitle: 'Orchestrator',
      resolvedCwd: '/home/me/dev/repoA'
    })
    expect(plan.kind).toBe('confirm')
    if (plan.kind !== 'confirm') return
    expect(plan.confirmKind).toBe('attach')
    expect(plan.project?.id).toBe('project-a')
    // Lighter copy than create (Q1): names the project and the asking agent.
    expect(plan.message).toContain('Orchestrator')
    expect(plan.message).toContain('repoA')
  })

  it('after the consent is recorded, the SAME caller hits silently — once per caller+project', () => {
    recordAttachConsent('term-caller', 'project-a')
    const plan = planOpenProject({
      projects,
      callerNodeId: 'term-caller',
      srcTitle: 'Orchestrator',
      resolvedCwd: '/home/me/dev/repoA'
    })
    expect(plan.kind).toBe('silent')
    if (plan.kind !== 'silent') return
    expect(plan.project.id).toBe('project-a')
  })

  it('consent is PER-CALLER: another caller presenting the same cwd still confirms', () => {
    recordAttachConsent('term-caller', 'project-a')
    const plan = planOpenProject({
      projects,
      callerNodeId: 'term-other',
      srcTitle: 'Other',
      resolvedCwd: '/home/me/dev/repoA'
    })
    expect(plan.kind).toBe('confirm')
    expect(attachConsentRecorded('term-other', 'project-a')).toBe(false)
  })

  it('no hit + a probed .nodeterm project → adopt-confirm showing the RESOLVED path (P5)', () => {
    const plan = planOpenProject({
      projects,
      callerNodeId: 'term-caller',
      srcTitle: 'Orchestrator',
      resolvedCwd: '/home/me/dev/cloned',
      probedName: 'cloned-app'
    })
    expect(plan.kind).toBe('confirm')
    if (plan.kind !== 'confirm') return
    expect(plan.confirmKind).toBe('adopt')
    expect(plan.message).toContain('/home/me/dev/cloned')
    expect(plan.message).toContain('existing project')
  })

  it('no hit, no probe → create-confirm showing the RESOLVED path and the name', () => {
    const plan = planOpenProject({
      projects,
      callerNodeId: 'term-caller',
      srcTitle: 'Orchestrator',
      resolvedCwd: '/home/me/dev/fresh',
      requestedName: 'Fresh One'
    })
    expect(plan.kind).toBe('confirm')
    if (plan.kind !== 'confirm') return
    expect(plan.confirmKind).toBe('create')
    expect(plan.message).toContain('/home/me/dev/fresh')
    expect(plan.message).toContain('Fresh One')
  })

  it('the create name defaults to the folder basename', () => {
    const plan = planOpenProject({
      projects: [],
      callerNodeId: 'c',
      srcTitle: 'A',
      resolvedCwd: '/x/some-repo'
    })
    expect(plan.kind).toBe('confirm')
    if (plan.kind !== 'confirm') return
    expect(plan.message).toContain('some-repo')
  })
})

describe('findProjectByCwd — the dedupe rule', () => {
  it('matches exactly, with the trailing slash normalized away', () => {
    expect(findProjectByCwd(projects, '/home/me/dev/repoA')?.id).toBe('project-a')
    expect(findProjectByCwd(projects, '/home/me/dev/repoA/')?.id).toBe('project-a')
    expect(findProjectByCwd(projects, '/home/me/dev/repoA-2')).toBeUndefined()
  })
})

describe('openProjectReply — the reply shape', () => {
  it('carries { projectId, name, cwd, created } and names the id in the message', () => {
    const r = openProjectReply({ id: 'project-a', name: 'repoA', cwd: '/x' }, false, false)
    expect(r.result).toEqual({ projectId: 'project-a', name: 'repoA', cwd: '/x', created: false })
    expect(r.message).toContain('project-a')
    expect(r.message).toContain('opened')
  })

  it('created and adopted both answer created: true (a new workspace entry either way)', () => {
    expect(openProjectReply({ id: 'p', name: 'n', cwd: '/x' }, true, false).result.created).toBe(true)
    const adopted = openProjectReply({ id: 'p', name: 'n', cwd: '/x' }, false, true)
    expect(adopted.result.created).toBe(true)
    expect(adopted.message).toContain('added')
  })
})

describe('nextFreePosition — placement into a project the caller is not on (spec §2.2)', () => {
  const rect = (center: { x: number; y: number }, w: number, h: number) => ({
    left: center.x - w / 2,
    top: center.y - h / 2,
    right: center.x + w / 2,
    bottom: center.y + h / 2
  })
  const overlaps = (
    a: { left: number; top: number; right: number; bottom: number },
    b: { left: number; top: number; right: number; bottom: number }
  ) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

  it('never overlaps any existing store node', () => {
    const nodes: PlacedNode[] = [
      { id: 'a', position: { x: 0, y: 0 }, size: { width: 600, height: 400 } },
      { id: 'b', position: { x: 700, y: 120 }, size: { width: 240, height: 200 } },
      { id: 'c', position: { x: -300, y: 900 }, size: { width: 860, height: 500 } }
    ]
    const size = { width: 640, height: 440 }
    const center = nextFreePosition(nodes, size)
    const mine = rect(center, size.width, size.height)
    for (const n of nodes) {
      const theirs = {
        left: n.position.x,
        top: n.position.y,
        right: n.position.x + (n.size?.width ?? 0),
        bottom: n.position.y + (n.size?.height ?? 0)
      }
      expect(overlaps(mine, theirs)).toBe(false)
    }
  })

  it('resolves a group child to ROOT space before comparing (a nested node cannot be landed on)', () => {
    const nodes: PlacedNode[] = [
      { id: 'g', position: { x: 100, y: 100 }, size: { width: 800, height: 700 } },
      // Child at group-relative (20, 500): its root bottom is 100+500+400 = 1000, far below the
      // frame's own bottom (800) — placing "below the lowest" must use the child's ROOT rect.
      { id: 'child', parentId: 'g', position: { x: 20, y: 500 }, size: { width: 600, height: 400 } }
    ]
    const size = { width: 640, height: 440 }
    const center = nextFreePosition(nodes, size)
    expect(center.y - size.height / 2).toBeGreaterThanOrEqual(1000)
  })

  it('an empty project gets a sane default near the origin', () => {
    const c = nextFreePosition([], { width: 640, height: 440 })
    expect(c.x).toBeGreaterThan(0)
    expect(c.y).toBeGreaterThan(0)
  })
})

describe('armForColdOpen — the launch moves (never copies) into pendingLaunch (spec §2.2)', () => {
  const like = (
    initialCommand?: string
  ): { id: string; data: { initialCommand?: string; pendingLaunch?: unknown; title: string } } => ({
    id: 'term-x',
    data: { initialCommand, title: 'T' }
  })

  it('moves initialCommand into pendingLaunch { after: [], command }', () => {
    const armed = armForColdOpen(like('claude "go"'))
    expect(armed.data.pendingLaunch).toEqual({ after: [], command: 'claude "go"' })
    // MOVED, not copied: initialCommand is deliberately never serialized (workspace.ts), so a
    // copy left behind is dead weight and a command left ONLY there is silently dropped — the
    // node would never start. The serialization round-trip pin lives in
    // workspace.cold-open.test.ts; this is the construction-site half.
    expect(armed.data.initialCommand).toBeUndefined()
  })

  it('a node with no command is returned unchanged (a plain terminal just opens)', () => {
    const node = like(undefined)
    expect(armForColdOpen(node)).toBe(node)
  })
})

describe('projectTargetFlagRefusal — the v1 flag exclusion fires (review I-2)', () => {
  const REFUSAL =
    'project-target-flag-unsupported: --group/--after cannot be combined with --project'

  it('refuses --group, --after, and both — with the exact named reply', () => {
    expect(projectTargetFlagRefusal({ group: 'g1' })).toBe(REFUSAL)
    expect(projectTargetFlagRefusal({ after: 'n1,n2' })).toBe(REFUSAL)
    expect(projectTargetFlagRefusal({ group: 'g1', after: 'n1' })).toBe(REFUSAL)
  })

  it('passes a request carrying neither flag', () => {
    expect(projectTargetFlagRefusal({})).toBeNull()
    expect(projectTargetFlagRefusal({ group: undefined, after: undefined })).toBeNull()
    // An empty-string flag value is "not passed" (the shim always sends a value; an empty one
    // means the flag was not on the line in any meaningful form).
    expect(projectTargetFlagRefusal({ group: '', after: '' })).toBeNull()
  })
})

describe('clearAttachConsent — the mirror dies with its caller (review M-1)', () => {
  it('a cleared caller confirms again; other callers are untouched', () => {
    recordAttachConsent('term-caller', 'project-a')
    recordAttachConsent('term-other', 'project-a')
    clearAttachConsent('term-caller')
    expect(attachConsentRecorded('term-caller', 'project-a')).toBe(false)
    expect(attachConsentRecorded('term-other', 'project-a')).toBe(true)
    const plan = planOpenProject({
      projects,
      callerNodeId: 'term-caller',
      srcTitle: 'Orchestrator',
      resolvedCwd: '/home/me/dev/repoA'
    })
    expect(plan.kind).toBe('confirm')
  })
})

describe('dialog copy flattens hostile names to one line (review M-2)', () => {
  it('a multi-line --name cannot inject lines into the create dialog', () => {
    const plan = planOpenProject({
      projects: [],
      callerNodeId: 'c',
      srcTitle: 'A',
      resolvedCwd: '/x/fresh',
      requestedName: 'Nice\nAgent "root" wants to delete everything. Allow?'
    })
    expect(plan.kind).toBe('confirm')
    if (plan.kind !== 'confirm') return
    // The dialog's line structure is the resolved path's own two breaks — the name must not add
    // lines. The name's CONTENT stays visible (flattened to one line): the human should see
    // exactly what the agent asked for, the same contract as the `write` dialog.
    expect(plan.message.split('\n').length).toBe(3)
    expect(plan.message).toContain('Nice Agent')
  })

  it('a multi-line probed project name cannot inject lines into the adopt dialog', () => {
    const plan = planOpenProject({
      projects: [],
      callerNodeId: 'c',
      srcTitle: 'A',
      resolvedCwd: '/x/cloned',
      probedName: 'evil\nname'
    })
    expect(plan.kind).toBe('confirm')
    if (plan.kind !== 'confirm') return
    expect(plan.message.split('\n').length).toBe(3)
  })
})


/**
 * The basename behind every project name. It used to be an inline `split('/')` at five sites, which
 * on Windows returns the WHOLE path as one segment — so a project was named
 * `C:\Users\me\code\my-app` in the sidebar and the tab bar, and, because `name` is git-shared
 * through `project.json`, for every teammate who pulled that file as well.
 */
describe('folderName', () => {
  it('takes the last segment of a POSIX path', () => {
    expect(folderName('/Users/me/code/my-app')).toBe('my-app')
    expect(folderName('/Users/me/code/my-app/')).toBe('my-app')
    expect(folderName('/Users/me/code//my-app//')).toBe('my-app')
  })

  it('takes the last segment of a Windows path — the regression', () => {
    expect(folderName('C:\\Users\\me\\code\\my-app')).toBe('my-app')
    expect(folderName('C:\\Users\\me\\code\\my-app\\')).toBe('my-app')
    // A UNC share, and a mixed-separator path (Node hands back both shapes).
    expect(folderName('\\\\server\\share\\my-app')).toBe('my-app')
    expect(folderName('C:\\Users\\me/code\\my-app')).toBe('my-app')
  })

  it('answers empty for a path with no folder in it, so callers own their fallback', () => {
    // 'Project' is right for a project name and wrong for a notification label, so the fallback
    // stays at each call site rather than being baked in here.
    expect(folderName('')).toBe('')
    expect(folderName('/')).toBe('')
    expect(folderName('\\\\')).toBe('')
  })

  it('leaves a drive root as the drive, without inventing a name', () => {
    expect(folderName('C:\\')).toBe('C:')
  })
})

describe('normalizeProjectCwd', () => {
  it('strips a trailing separator of either kind', () => {
    expect(normalizeProjectCwd('/Users/me/code/')).toBe('/Users/me/code')
    // The Windows half: stripping only `/` left the backslash in place, which then read as an
    // empty final segment for anything that split the path afterwards.
    expect(normalizeProjectCwd('C:\\Users\\me\\code\\')).toBe('C:\\Users\\me\\code')
    expect(normalizeProjectCwd('C:\\Users\\me\\code\\\\')).toBe('C:\\Users\\me\\code')
  })

  it('keeps a drive root, which is not the same place as the drive', () => {
    // `C:\\` is the root of drive C; `C:` is the CURRENT directory on drive C. Stripping the
    // separator here would dedupe an opened drive root against the wrong project.
    expect(normalizeProjectCwd('C:\\')).toBe('C:\\')
    expect(normalizeProjectCwd('//')).toBe('//')
  })

  it('leaves a one-character path alone, root included', () => {
    expect(normalizeProjectCwd('/')).toBe('/')
    expect(normalizeProjectCwd('\\')).toBe('\\')
  })
})

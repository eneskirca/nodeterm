// Live links: how Canvas wires the entry points (Task 17). Canvas.tsx is ~18k lines and cannot be
// mounted here, so what matters about its WIRING is pinned at source level — the decisions
// themselves are behaviour-tested in lib/liveLinkEntry(.gate).test and the dialog/section tests.
//
// Each assertion is a way an entry point could skip a rule and still compile:
//  - a dialog opened other than through `openLiveLink` skips availability-before-the-Pro-gate;
//  - a `revokeAll` outside the confirm skips R48;
//  - a create without `prepare` skips R47 (a just-opened node answers node-missing);
//  - the sync never started leaves the store empty and no chip ever shows.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(__dirname, 'Canvas.tsx'), 'utf8').replace(/\r\n/g, '\n')
const count = (needle: string | RegExp): number =>
  typeof needle === 'string' ? src.split(needle).length - 1 : (src.match(new RegExp(needle, 'g')) ?? []).length
/** The source of one `const name = useCallback(…)` up to the next top-level-ish `const`. */
function callback(name: string): string {
  const at = src.indexOf(`const ${name} = useCallback(`)
  expect(at, name).toBeGreaterThan(-1)
  const end = src.indexOf('\n  const ', at + 10)
  return src.slice(at, end === -1 ? undefined : end)
}

describe('Canvas live-link wiring', () => {
  it('starts the watch-link sync exactly once, in a mount-only effect', () => {
    expect(count('startWatchLinkSync(')).toBe(1)
    expect(src).toMatch(/startWatchLinkSync\(window\.nodeTerminal,[\s\S]{0,400}?\n {4}\[\]\n {2}\)/)
  })

  it('the dialog is shown ONLY through openLiveLink (availability, then the Pro gate)', () => {
    // The only writers of the dialog state: the opener's `show`, and close.
    expect(count('setLiveLinkDialog(')).toBe(1) // closeLiveLinkDialog → setLiveLinkDialog(null)
    expect(src).toContain('show: setLiveLinkDialog')
    expect(count('requireProOr')).toBe(2) // the import, and `requirePro: requireProOr` in the opener
    expect(callback('openLiveLinkFor')).toMatch(/openLiveLink\(\s*\{\s*facts: liveLinkFacts,\s*requirePro: requireProOr/)
  })

  it('judges availability by the NODE\'s project session, and the dialog\'s surface the same way', () => {
    expect(callback('liveLinkFacts')).toContain('source: sessionForProject(projectId).source')
    expect(callback('liveLinkFacts')).toContain('serverEdition: isBrowserRuntime()')
    expect(src).toMatch(/sessionForProject\(liveLinkDialog\.projectId\)\.source === 'relay'/)
  })

  it('R47: the dialog gets a prepare that saves the canvas on screen, never over a conflict', () => {
    const prep = callback('liveLinkPrepareFor')
    expect(prep).toContain('liveLinkPrepare({')
    expect(prep).toContain('conflict: !!conflictRef.current')
    expect(prep).toContain('save: persist')
    expect(prep).toMatch(/dirtyRef\.current &&\s*nodesRef\.current\.some\(\(n\) => n\.id === target\.nodeId\)/)
    expect(src).toContain('prepare={liveLinkPrepareFor(liveLinkDialog)}')
  })

  it("R63: the dialog knows an SSH project's node from its project (the host's tmux serves its viewers)", () => {
    expect(src).toContain('remoteNode={!!useProjects.getState().getProject(liveLinkDialog.projectId)?.ssh}')
    // …and reads THIS machine's session protection from the local core, never a relay peer's.
    expect(src).toContain('readPersistence={readLocalPersistence}')
    expect(callback('readLocalPersistence')).toContain('localSession.api.pty.tmuxStatus()')
  })

  it('R43: no Upgrade button from the dialog on the Server Edition', () => {
    expect(src).toContain("onUpgrade={isBrowserRuntime() ? undefined : () => void useEntitlement.getState().upgrade('pro')}")
  })

  it('R48: the palette\'s Stop all goes through the confirm; revoke-all runs nowhere else', () => {
    expect(count('watchLink.revokeAll(')).toBe(1)
    const confirm = callback('confirmStopAllLiveLinks')
    expect(confirm).toMatch(/setConfirm\(\s*stopAllConfirm\(\{/)
    expect(confirm).toContain('window.nodeTerminal.watchLink.revokeAll()')
    expect(src).toContain('confirmStopAll: confirmStopAllLiveLinks')
  })

  it('R62: what Stop all reached is always said, and it is offered to a Pro owner with no link here', () => {
    const confirm = callback('confirmStopAllLiveLinks')
    expect(confirm).toMatch(/stopAllLiveLinks\(\(\) => window\.nodeTerminal\.watchLink\.revokeAll\(\)\)\.then\(\(r\) =>\s*setNotice\(\{ kind: r\.ok \? 'info' : 'error', text: r\.text \}\)/)
    const cmds = src.slice(src.indexOf('...liveLinkCommands({'))
    expect(cmds.slice(0, 400)).toContain('entitled: useEntitlement.getState().isPremium,')
    expect(cmds.slice(0, 400)).toContain('serverEdition: isBrowserRuntime(),')
  })

  it("D2/M1: the row is composed by the lib with the facts FUNCTION (the node's project's facts)", () => {
    const items = callback('liveLinkMenuItems')
    expect(items).toContain('liveLinkMenuItemsFor({')
    expect(items).toContain('facts: liveLinkFacts,')
    expect(items).toContain('projectId,')
  })

  it('one row builder, declared before selectionItems and listed in its deps (H15)', () => {
    const builder = src.indexOf('const liveLinkMenuItems = useCallback(')
    const selection = src.indexOf('const selectionItems = useCallback(')
    expect(builder).toBeGreaterThan(-1)
    expect(builder).toBeLessThan(selection)
    const sel = src.slice(selection, src.indexOf('/** "New <agent>" creation entries', selection))
    // After "Refresh terminal", single selection only.
    expect(sel.indexOf("...(ids.length === 1 ? liveLinkMenuItems(ids[0]) : [])")).toBeGreaterThan(sel.indexOf("label: 'Refresh terminal'"))
    expect(sel).toMatch(/session\.source,\s*liveLinkMenuItems\s*\]\)/)
  })

  it('R49: every surface gets the row — non-active sidebar projects, both boards', () => {
    const row = src.slice(src.indexOf('const onRowContextMenu = useCallback('))
    expect(row.slice(0, row.indexOf('\n  // Stream live subagent'))).toContain('...liveLinkMenuItems(id, projectId),')
    expect(src).toContain('liveLinkMenuItems={liveLinkMenuItems}\n          onAutoMoveFromPulls')
    expect(src).toMatch(/<GlobalKanbanView[\s\S]{0,200}liveLinkMenuItems=\{liveLinkMenuItems\}/)
  })

  it('the card modal\'s action reaches the opener with its project', () => {
    expect(src).toContain("window.addEventListener('nodeterm:live-link', on)")
    expect(src).toMatch(/openLiveLinkFor\(\{ nodeId: d\.nodeId, title, projectId: d\.projectId \}\)/)
  })
})

import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

const SRC = fs.readFileSync(path.join(__dirname, 'TableView.tsx'), 'utf8')

describe('Mesa stage', () => {
  it('does not mount ChatPanel — the terminal is the conversation', () => {
    expect(SRC).not.toMatch(/\bChatPanel\b/)
    expect(SRC).toContain('mesa-stage__term')
    expect(SRC).toContain('ModalTerminal')
  })

  it('keeps Mesa viewers attach-only — canvas node or host types the CLI', () => {
    expect(SRC).toContain('mayLaunch={false}')
  })

  it('extracts the roster and keeps one Mesa viewer per bot across focus changes', () => {
    expect(SRC).toContain('MissionRoster')
    expect(SRC).toContain('mesa-stage__terms')
    expect(SRC).toContain('is-parked')
    expect(SRC).not.toContain('mesa-pty-park')
    expect(SRC).toContain('key={n.id}')
    expect(fs.existsSync(path.join(__dirname, 'MissionRoster.tsx'))).toBe(true)
  })

  it('parks an unfocused Mesa viewer without shrinking the tmux client', () => {
    const css = fs.readFileSync(path.join(__dirname, 'table.css'), 'utf8').replace(/\r\n/g, '\n')
    expect(css).toMatch(/\.mesa-stage__term\.is-parked\s*\{[^}]*visibility:\s*hidden/)
    expect(css).not.toMatch(/\.mesa-stage__term\.is-parked\s*\{[^}]*display:\s*none/)
    expect(css).not.toMatch(/\.mesa-stage__term\.is-parked\s*\{[^}]*(width|height):\s*0/)
  })

  it('parks the whole Mesa overlay on a view cycle without display:none', () => {
    expect(SRC).toContain('parked = false')
    expect(SRC).toContain("parked ? ' is-parked' : ''")
    const css = fs.readFileSync(path.join(__dirname, 'table.css'), 'utf8').replace(/\r\n/g, '\n')
    expect(css).toMatch(/\.mesa-overlay\.is-parked\s*\{[^}]*visibility:\s*hidden/)
    expect(css).toMatch(/\.mesa-overlay\.is-parked\s*\{[^}]*pointer-events:\s*none/)
    expect(css).not.toMatch(/\.mesa-overlay\.is-parked\s*\{[^}]*display:\s*none/)
  })

  it('hydrates Auto vs pinned from the host mission after reload', () => {
    expect(SRC).toContain("mission.modelPolicy === 'pinned' ? 'pinned' : 'auto'")
    expect(SRC).toContain('hostPolicy')
    expect(SRC).toContain('[mission?.id]')
  })

  it('publishes Mesa focus to isNodeWatched so Eco cannot /exit the bot on screen', () => {
    expect(SRC).toContain('setMesaWatchedNode(focusId)')
    expect(SRC).toContain('wakeHibernatedNode(focusId)')
    expect(SRC).toContain('setMesaWatchedNode(null)')
  })

  it('binds Nueva misión to the host-owned orchestrator, not the last canvas terminal', () => {
    expect(SRC).toContain('claimPendingOrchestrator')
    expect(SRC).toContain('pendingIgnoreIds')
    expect(SRC).not.toContain('terminals[terminals.length - 1]')
  })

  it('does not steal focus when the roster grows', () => {
    expect(SRC).not.toMatch(/prevTermCount/)
    expect(SRC).toContain('nextMesaFocus')
    expect(SRC).toContain('mesaVisibleTerminals')
    expect(SRC).toContain('preferFocusId')
  })

  it('makes Nueva misión the primary action and keeps the swarm form out of the stage', () => {
    expect(SRC).toContain('Diseña una API de inventario. Primero presenta el plan.')
    expect(SRC).toContain('Nueva misión')
    expect(SRC).toContain('MissionHeader')
    expect(SRC).toContain('objective={mission?.goal.objective}')
    expect(SRC).toContain('MissionRoster')
    expect(SRC).toContain('MissionInspector')
    expect(SRC).toContain('MissionStatusBar')
    expect(SRC).not.toMatch(/mesa-stage__tools[\s\S]*Qué hace el swarm/)
  })

  it('exposes host pause and cancel from the status bar', () => {
    expect(SRC).toContain('api.swarm.pause')
    expect(SRC).toContain('api.swarm.resume')
    expect(SRC).toContain('api.swarm.cancel')
    expect(SRC).toContain('onCancel')
    const bar = fs.readFileSync(path.join(__dirname, 'MissionStatusBar.tsx'), 'utf8')
    expect(bar).toContain("t.roleId === 'O'")
    expect(bar).toContain('Activar A')
  })

  it('refreshes the host-owned mission and reconnects the orchestrator TUI', () => {
    expect(SRC).toContain('api.swarm.get')
    expect(SRC).toContain('api.swarm.activate')
    expect(SRC).toContain('Misión en pausa. Reanudá primero.')
    expect(SRC).toContain('api.swarm.onChanged')
    expect(SRC).toContain('api.swarm.bind')
    expect(SRC).toContain('api.swarm.approve')
    expect(SRC).toContain('mission.paused || mission.cancelled')
    expect(SRC).toContain("t.status !== 'ready'")
    expect(SRC).toContain('mesa-console-down')
    expect(SRC).toContain('pane == null')
    expect(SRC).toContain('api.swarm.ensureTui(live.id, live.orchestratorNodeId)')
    expect(SRC).toContain('api.swarm.ensureTui(mission.id, mission.orchestratorNodeId)')
    expect(SRC).not.toContain('api.swarm.ensureTui(mission.id, focus.id)')
    expect(SRC).toContain('subscribeSessionReady((nodeId) => {')
    expect(SRC).toContain('r.running')
    expect(SRC).toContain('GRACE_MS')
    expect(SRC).toContain('api.swarm.caps')
    expect(SRC).toContain('subscribeSessionReady')
    expect(SRC).toContain('isSessionReady')
    expect(SRC).toContain('api.swarm.activate(mission.id, roleId)')
    expect(SRC).toContain('api.swarm.tick(m.id)')
    expect(SRC).toContain('onActivate={activateRole}')
    expect(SRC).toContain("onActivateA={() => activateRole('A')}")
    expect(SRC).toContain('onApprove={approveApproval}')
    expect(SRC).toContain('const approveApproval = (approvalId: string)')
    expect(SRC).toContain('writerWorktreeBlockLabel')
    expect(SRC).toContain('if (blocked) setNotice(blocked)')
  })

  it('spawns an agent terminal for an activated worker, not a second orchestrator', () => {
    expect(SRC).toContain('spawnQueue.current = []')
    expect(SRC).toContain('spawnedRoles.current = new Set()')
    expect(SRC).toContain('spawnQueue.current.push(task.roleId)')
    expect(SRC).toContain('needsWorkerPane(task)')
    expect(SRC).toContain('spawnedRoles.current.has(task.roleId)')
    expect(SRC).toContain("adapterMode !== 'live'")
    expect(SRC).toContain('npm run dev:mesa:swarm')
    expect(SRC).toContain('workerLaunchSpec({')
    expect(SRC).toContain('preferredAgent: mission.preferredAgent')
    expect(SRC).toContain("from '../../lib/mesaModels'")
    expect(SRC).not.toMatch(/onActivate[\s\S]*orchestrator: true/)
    expect(SRC).not.toMatch(/onActivate[\s\S]*onAddTerminal/)
    expect(SRC).toContain('preferredAgent: pickAgent')
    expect(SRC).toContain('permissionMode: MESA_FULL_ACCESS_MODE')
    expect(SRC).toContain('agentLaunchOverride(pickAgent, projectId')
    expect(SRC).toContain('codexSharedIdentity()')
  })

  it('rebinds the host task when Mesa changes the model so the next launch is not stale', () => {
    expect(SRC).toContain('const applyModel = (nodeId: string, model: string)')
    expect(SRC).toContain('agentModel: model')
    expect(SRC).toContain('onSetModel={onSetModel ? applyModel : undefined}')
  })

  it('roster activation does not steal orchestrator focus', () => {
    const start = SRC.indexOf('const activateRole = (roleId: SwarmRoleId)')
    const end = SRC.indexOf('const spawn = ()')
    const body = SRC.slice(start, end)
    expect(body).toContain('api.swarm.activate(mission.id, roleId)')
    expect(body).not.toContain('setFocusId')
    expect(body).not.toContain('preferFocusId')
  })

  it('does not steal orchestrator focus when a worker binds', () => {
    const start = SRC.indexOf('if (!mission || terminals.length === 0 || spawnQueue.current.length === 0)')
    const end = SRC.indexOf('}, [terminals, mission, api.swarm, onStampSwarm]')
    const bind = SRC.slice(start, end)
    expect(bind).toContain('api.swarm.bind')
    expect(bind).toContain('api.swarm.tick(m.id)')
    expect(bind).toContain('for (const node of unbound)')
    expect(bind).toContain("n.data.launchMode === 'runtime'")
    expect(bind).not.toContain('preferFocusId')
    expect(bind).not.toContain('setFocusId')
  })

  it('rebinds stamped nodes after restart when the host task lost nodeId', () => {
    expect(SRC).toContain('stamp.missionId !== mission.id')
    expect(SRC).toContain('!task || task.nodeId')
  })

  it('does not invent a local-mock mission when the host refuses create', () => {
    expect(SRC).not.toContain('local-mock')
    expect(SRC).not.toContain('function mockMission')
    expect(SRC).toContain('No se pudo crear la misión en el host.')
  })

  it('does not hand an SSH remoteCwd to local worktree materialize', () => {
    expect(SRC).toContain('workspaceRoot: projectIsSsh ? undefined : folderRoot')
    expect(SRC).toContain('api.swarm.setWorkspaceRoot')
    expect(SRC).toContain('mesaFolderRoot')
    expect(SRC).not.toContain('api.swarm.noteIdle')
    expect(SRC).not.toContain("agentById[t.nodeId]?.state !== 'done'")
  })

  it('stamps a writer node cwd to the worktree after approve so restart does not reopen the main checkout', () => {
    expect(SRC).toContain("t.workspace?.kind !== 'worktree'")
    expect(SRC).toContain('onStampCwd(t.nodeId, hint)')
  })

  it('sends an optional budget on Nueva misión and only marks it hard with a limit', () => {
    expect(SRC).toContain('budgetLimitUsd: budget.limitUsd')
    expect(SRC).toContain('adapterMode !== \'live\' && hardBudget && limitUsd != null')
    expect(SRC).toContain('Límite duro')
    expect(SRC).toContain('adapterMode === \'live\'')
    expect(SRC).toContain('orquestador sí arranca')
  })
})

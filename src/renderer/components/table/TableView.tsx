import { memo, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type FormEvent } from 'react'
import {
  AGENT_CONFIG,
  capabilityAgentId,
  hasSharedIdentity,
  type AgentId,
  type BuiltinAgentId
} from '@shared/agents/config'
import { DEFAULT_GROK_MODEL } from '@shared/agents/grok-models'
import type { GatewayModel } from '@shared/agents/model-gateway'
import type { CanvasNode } from '../../state/workspace'
import { agentLaunchOverride, resolveNewNodeAgent } from '../../state/workspace'
import { codexSharedIdentity } from '../../state/codexIdentity'
import { toKanbanSession } from '../../canvas/toKanbanSession'
import { ModalTerminal } from '../kanban/ModalTerminal'
import { useSession } from '../../session/session'
import { useAgentStatus } from '../../state/agentStatus'
import { useModelGateway } from '../../state/modelGateway'
import { useProjects } from '../../state/projects'
import { useSettings } from '../../state/settings'
import { callsignOf, ensureCallsigns } from '../../lib/callsign'
import { mesaColumns, mesaHasGroups } from '../../lib/mesaLayout'
import { claimPendingOrchestrator, mesaVisibleTerminals, nextMesaFocus } from '../../lib/mesaFocus'
import {
  mesaAgentOptions,
  mesaDefaultModel,
  mesaModelsFor,
  workerLaunchSpec,
  type MesaAgentOption
} from '../../lib/mesaModels'
import { formatTalkPayload } from '../../lib/talkMessage'
import type { SwarmMission, SwarmRoleId } from '@shared/swarm/types'
import {
  mesaFolderRoot,
  MESA_FULL_ACCESS_MODE,
  needsWorkerPane,
  writerWorktreeBlockLabel
} from '@shared/swarm/schemas'
import { IconTrash } from '../icons'
import { BotAvatar, presenceOf, presenceLabel } from './BotAvatar'
import { MissionHeader } from './MissionHeader'
import { MissionInspector } from './MissionInspector'
import { MissionRoster, type MesaTalkPick } from './MissionRoster'
import { MissionStatusBar } from './MissionStatusBar'
import { MESA_TERM_THEME } from '../../lib/mesaTheme'
import {
  isSessionReady,
  setMesaWatchedNode,
  subscribeSessionReady,
  wakeHibernatedNode
} from '../../nodes/TerminalNode'

const DEFAULT_MISSION_OBJECTIVE =
  'Diseña una API de inventario. Primero presenta el plan. No modifiques archivos ni ejecutes comandos sin aprobación.'

export interface TableViewProps {
  nodes: CanvasNode[]
  onStampCallsigns: (next: CanvasNode[]) => void
  onStampSwarm?: (nodeId: string, swarm: { missionId: string; roleId: SwarmRoleId }) => void
  onStampCwd?: (nodeId: string, cwd: string) => void
  onAddTerminal: (
    groupId?: string,
    launch?: { agentId?: AgentId; model?: string; orchestrator?: boolean; runtime?: boolean }
  ) => void
  onAddGroup: () => void
  onRename: (nodeId: string, title: string) => void
  onRenameGroup: (groupId: string, title: string) => void
  onMove: (nodeId: string, groupId: string | null) => void
  onDelete: (nodeId: string) => void
  onSpawnSwarm?: (leadId: string, task: string) => void
  onSetModel?: (nodeId: string, model: string) => void
  /** Same project, canvas/kanban on top — keep viewers mounted (visibility only). */
  parked?: boolean
}

type TalkPick = MesaTalkPick

export const TableView = memo(function TableView({
  nodes,
  onStampCallsigns,
  onStampSwarm,
  onStampCwd,
  onAddTerminal,
  onAddGroup,
  onRename,
  onRenameGroup,
  onMove,
  onDelete,
  onSpawnSwarm,
  onSetModel,
  parked = false
}: TableViewProps) {
  const { api } = useSession()
  const clearUnread = useAgentStatus((s) => s.clearUnread)
  const gatewayModels = useModelGateway((s) => s.models)
  const settings = useSettings((s) => s.settings)
  const projectId = useProjects((s) => s.activeProjectId)
  const projectCwd = useProjects((s) => s.projects.find((p) => p.id === s.activeProjectId)?.cwd)
  const projectIsSsh = useProjects((s) => !!s.projects.find((p) => p.id === s.activeProjectId)?.ssh)
  const defaultAgent = resolveNewNodeAgent(undefined, projectId, settings)
  const agents = useMemo(
    () =>
      mesaAgentOptions({
        customAgents: settings.customAgents,
        disabledAgents: settings.disabledAgents
      }),
    [settings.customAgents, settings.disabledAgents]
  )
  const [focusId, setFocusId] = useState<string | null>(null)
  const [talk, setTalk] = useState<TalkPick | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [log, setLog] = useState<Array<{ from: string; to: string; text: string; at: number }>>([])
  const [query, setQuery] = useState('')
  const [swarmDraft, setSwarmDraft] = useState('')
  const [swarmOpen, setSwarmOpen] = useState(false)
  const [composer, setComposer] = useState<{ groupId?: string; mission?: boolean } | null>(null)
  const [missionObjective, setMissionObjective] = useState('')
  const [budgetLimit, setBudgetLimit] = useState('')
  const [hardBudget, setHardBudget] = useState(false)
  const [modelPolicy, setModelPolicy] = useState<'auto' | 'pinned'>('auto')
  const [inspectOpen, setInspectOpen] = useState(false)
  const [openCoords, setOpenCoords] = useState<Record<string, boolean>>({ A: true })
  const [mission, setMission] = useState<SwarmMission | null>(null)
  const [adapterMode, setAdapterMode] = useState<'mock' | 'live'>('mock')
  const [pickAgent, setPickAgent] = useState<AgentId>(defaultAgent)
  const [pickModel, setPickModel] = useState(() => mesaDefaultModel(defaultAgent, gatewayModels))
  const dragId = useRef<string | null>(null)
  const preferFocusId = useRef<string | null>(null)
  const pendingMission = useRef<string | null>(null)
  const pendingIgnoreIds = useRef<Set<string>>(new Set())
  const pendingBudget = useRef<{ limitUsd?: number; hard?: boolean }>({})
  const spawnQueue = useRef<SwarmRoleId[]>([])
  const spawnedRoles = useRef<Set<SwarmRoleId>>(new Set())
  const sessionTickKeys = useRef<Set<string>>(new Set())
  const sessionTickMission = useRef<string | null>(null)

  useEffect(() => {
    const stamped = ensureCallsigns(nodes)
    if (stamped !== nodes) onStampCallsigns(stamped)
  }, [nodes, onStampCallsigns])

  const terminals = useMemo(() => nodes.filter((n) => n.type === 'terminal'), [nodes])
  const folderRoot = useMemo(() => {
    if (projectIsSsh) return undefined
    return mesaFolderRoot(projectCwd)
  }, [projectCwd, projectIsSsh])
  const mesaTerms = useMemo(() => mesaVisibleTerminals(terminals, mission?.id), [terminals, mission?.id])
  const columns = useMemo(
    () => mesaColumns([...nodes.filter((n) => n.type === 'group'), ...mesaTerms]),
    [nodes, mesaTerms]
  )
  const grouped = mesaHasGroups(nodes)
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])

  useEffect(() => {
    const ids = mesaTerms.map((t) => t.id)
    const prefer = preferFocusId.current
    setFocusId((current) => {
      const next = nextMesaFocus(ids, current, prefer)
      if (prefer && next === prefer) preferFocusId.current = null
      return next
    })
  }, [mesaTerms])

  useEffect(() => {
    void api.swarm.caps?.().then((caps) => {
      if (caps?.mode === 'live' || caps?.mode === 'mock') setAdapterMode(caps.mode)
    }).catch(() => {})
  }, [api.swarm])

  useEffect(() => {
    if (!projectId) return
    void api.swarm
      .list(projectId)
      .then((list) => {
        const live = list.find((m) => !m.cancelled) ?? list[0]
        if (!live) return
        setMission(live)
        if (live.orchestratorNodeId) {
          void api.swarm.ensureTui(live.id, live.orchestratorNodeId).catch(() => {})
        }
      })
      .catch(() => {})
  }, [projectId, api.swarm])

  useEffect(() => {
    if (!mission || mission.cancelled || mission.workspaceRoot) return
    if (projectIsSsh) return
    if (!folderRoot || !api.swarm.setWorkspaceRoot) return
    void api.swarm.setWorkspaceRoot(mission.id, folderRoot).then(async (m) => {
      if (!m) return
      const ticked = await api.swarm.tick(m.id).catch(() => m)
      setMission(ticked ?? m)
    })
  }, [mission?.id, mission?.workspaceRoot, mission?.cancelled, folderRoot, projectIsSsh, api.swarm])

  useEffect(() => {
    if (!mission || mission.cancelled || !mission.orchestratorNodeId) return
    let cancelled = false
    let tries = 0
    const kick = () => {
      if (cancelled || tries >= 24) return
      tries += 1
      void api.swarm
        .ensureTui(mission.id, mission.orchestratorNodeId)
        .then((r) => {
          if (cancelled || r.running) return
          window.setTimeout(kick, r.ok ? 1500 : 700)
        })
        .catch(() => {
          if (!cancelled) window.setTimeout(kick, 700)
        })
    }
    kick()
    const off = subscribeSessionReady((nodeId) => {
      if (nodeId !== mission.orchestratorNodeId) return
      tries = Math.min(tries, 20)
      kick()
    })
    return () => {
      cancelled = true
      off()
    }
  }, [mission?.id, mission?.orchestratorNodeId, mission?.cancelled, api.swarm])

  useEffect(() => {
    const objective = pendingMission.current
    if (!objective) return
    const orchId = claimPendingOrchestrator(terminals, pendingIgnoreIds.current)
    if (!orchId) return
    pendingMission.current = null
    pendingIgnoreIds.current = new Set()
    preferFocusId.current = orchId
    setFocusId(orchId)
    const pid = projectId ?? 'inline'
    const budget = pendingBudget.current
    pendingBudget.current = {}
    void api.swarm
      .create({
          projectId: pid,
          orchestratorNodeId: orchId,
          objective,
          workspaceRoot: projectIsSsh ? undefined : folderRoot,
          modelPolicy,
          preferredAgent: pickAgent,
          pinnedModel: modelPolicy === 'pinned' ? pickModel || undefined : undefined,
          permissionMode: MESA_FULL_ACCESS_MODE,
          launchCmdOverride: (() => {
            const layered = agentLaunchOverride(pickAgent, projectId ?? undefined)
            const global = agentLaunchOverride(pickAgent)
            return layered && layered !== global ? layered : undefined
          })(),
          sharedIdentity:
            !projectIsSsh && hasSharedIdentity(pickAgent) && codexSharedIdentity() ? true : undefined,
          budgetLimitUsd: budget.limitUsd,
          hardBudget: budget.hard === true
        })
      .then(async (created) => {
        if (!created) {
          setNotice('No se pudo crear la misión en el host.')
          return
        }
        const ticked = await api.swarm.tick(created.id).catch(() => created)
        const mission = ticked ?? created
        onStampSwarm?.(orchId, { missionId: mission.id, roleId: 'O' })
        setMission(mission)
        void api.swarm.ensureTui(mission.id, orchId).catch(() => {})
      })
      .catch(() => {
        setNotice('No se pudo crear la misión en el host.')
      })
  }, [
    terminals,
    projectId,
    folderRoot,
    projectIsSsh,
    api.swarm,
    onStampSwarm,
    modelPolicy,
    pickAgent,
    pickModel
  ])

  useEffect(() => {
    spawnQueue.current = []
    spawnedRoles.current = new Set()
  }, [mission?.id])

  useEffect(() => {
    if (!mission || mission.cancelled) return
    // Mock accepts without typing a CLI. A host-owned pane would sit as an empty
    // "opencode" / "grok" shell and look like the agent failed to open.
    if (adapterMode !== 'live') return
    const stamped = new Set(
      terminals
        .map((n) => n.data.swarm)
        .filter((s): s is NonNullable<typeof s> => !!s && s.missionId === mission.id)
        .map((s) => s.roleId)
    )
    for (const task of mission.tasks) {
      if (!needsWorkerPane(task)) continue
      if (stamped.has(task.roleId) || spawnedRoles.current.has(task.roleId)) continue
      spawnedRoles.current.add(task.roleId)
      spawnQueue.current.push(task.roleId)
      onAddTerminal(
        undefined,
        workerLaunchSpec({
          preferredAgent: mission.preferredAgent,
          modelPolicy: mission.modelPolicy,
          pinnedModel: mission.pinnedModel
        })
      )
    }
  }, [mission, terminals, onAddTerminal, adapterMode])

  useEffect(() => {
    if (!mission || terminals.length === 0 || spawnQueue.current.length === 0) return
    const unbound = terminals.filter(
      (n) =>
        n.id !== mission.orchestratorNodeId &&
        !n.data.swarm &&
        n.data.launchMode === 'runtime'
    )
    for (const node of unbound) {
      const role = spawnQueue.current[0]
      if (!role) break
      spawnQueue.current.shift()
      onStampSwarm?.(node.id, { missionId: mission.id, roleId: role })
      const agentId = typeof node.data.agentId === 'string' ? node.data.agentId : undefined
      const agentModel = typeof node.data.agentModel === 'string' ? node.data.agentModel : undefined
      const agentSessionId =
        typeof node.data.agentSessionId === 'string' ? node.data.agentSessionId : undefined
      void api.swarm.bind(mission.id, role, node.id, { agentId, agentModel, agentSessionId }).then(async (m) => {
        if (!m) return
        const ticked = await api.swarm.tick(m.id).catch(() => m)
        setMission(ticked ?? m)
      })
    }
  }, [terminals, mission, api.swarm, onStampSwarm])

  useEffect(() => {
    if (!mission) return
    for (const n of terminals) {
      const stamp = n.data.swarm
      if (!stamp || stamp.missionId !== mission.id) continue
      const task = mission.tasks.find((t) => t.roleId === stamp.roleId)
      if (!task || task.nodeId) continue
      void api.swarm
        .bind(mission.id, stamp.roleId, n.id, {
          agentId: typeof n.data.agentId === 'string' ? n.data.agentId : undefined,
          agentModel: typeof n.data.agentModel === 'string' ? n.data.agentModel : undefined,
          agentSessionId:
            typeof n.data.agentSessionId === 'string' ? n.data.agentSessionId : undefined
        })
        .then(async (m) => {
          if (!m) return
          const ticked = await api.swarm.tick(m.id).catch(() => m)
          setMission(ticked ?? m)
        })
    }
  }, [mission, terminals, api.swarm])

  useEffect(() => {
    if (!mission) return
    if (sessionTickMission.current !== mission.id) {
      sessionTickMission.current = mission.id
      sessionTickKeys.current.clear()
    }
    if (mission.paused || mission.cancelled) {
      sessionTickKeys.current.clear()
      return
    }
    for (const t of mission.tasks) {
      if (t.status !== 'ready') sessionTickKeys.current.delete(`${mission.id}:${t.id}`)
    }
    const tryTick = (nodeId: string) => {
      if (!isSessionReady(nodeId)) return
      const task = mission.tasks.find((t) => t.nodeId === nodeId && t.status === 'ready')
      if (!task) return
      const key = `${mission.id}:${task.id}`
      if (sessionTickKeys.current.has(key)) return
      sessionTickKeys.current.add(key)
      void api.swarm.tick(mission.id).then((m) => {
        if (m) setMission(m)
      })
    }
    for (const t of mission.tasks) {
      if (t.nodeId) tryTick(t.nodeId)
    }
    return subscribeSessionReady(tryTick)
  }, [mission, api.swarm])

  useEffect(() => {
    if (!mission || !onStampCwd) return
    for (const t of mission.tasks) {
      if (!t.nodeId || t.workspace?.kind !== 'worktree') continue
      const hint = t.workspace.pathHint
      if (!hint || !(hint.startsWith('/') || /^[A-Za-z]:[\\/]/.test(hint))) continue
      const n = byId.get(t.nodeId)
      if (!n || n.data.cwd === hint) continue
      onStampCwd(t.nodeId, hint)
    }
  }, [mission, byId, onStampCwd])

  useEffect(() => {
    if (!mission) return
    setModelPolicy(mission.modelPolicy === 'pinned' ? 'pinned' : 'auto')
    if (typeof mission.preferredAgent === 'string' && mission.preferredAgent) {
      setPickAgent(mission.preferredAgent as AgentId)
    }
    if (typeof mission.pinnedModel === 'string' && mission.pinnedModel) {
      setPickModel(mission.pinnedModel)
    }
  }, [mission?.id])

  useEffect(() => {
    if (focusId) clearUnread(focusId)
  }, [focusId, clearUnread])

  useEffect(() => {
    if (parked || !focusId) {
      setMesaWatchedNode(null)
      return
    }
    setMesaWatchedNode(focusId)
    wakeHibernatedNode(focusId)
    return () => setMesaWatchedNode(null)
  }, [parked, focusId])

  useEffect(() => {
    if (!mission?.id) return
    const id = mission.id
    const t = setInterval(() => {
      void api.swarm.get(id).then((m) => {
        if (m) setMission(m)
      })
    }, 2000)
    return () => clearInterval(t)
  }, [mission?.id, api.swarm])

  useEffect(() => {
    const unsub = api.swarm.onChanged?.((m) => {
      if (!m) return
      if (mission?.id) {
        if (m.id === mission.id) setMission(m)
        return
      }
      if (projectId && m.projectId === projectId && !m.cancelled) setMission(m)
    })
    return () => unsub?.()
  }, [api.swarm, mission?.id, projectId])

  const q = query.trim().toLowerCase()
  const match = (id: string) => {
    if (!q) return true
    const n = byId.get(id)
    if (!n) return false
    const title = String(n.data.title ?? '')
    const agent = String(n.data.agentId ?? '')
    return (
      callsignOf(n).toLowerCase().includes(q) ||
      title.toLowerCase().includes(q) ||
      agent.toLowerCase().includes(q)
    )
  }

  const startTalk = (fromId: string) => {
    setTalk({ fromId })
    setNotice('Elegí el bot que recibe')
  }

  const pickTarget = (toId: string) => {
    if (!talk || talk.fromId === toId) return
    setTalk({ fromId: talk.fromId, toId })
    setNotice(null)
  }

  const onRowClick = (id: string) => {
    if (talk && !('toId' in talk)) {
      pickTarget(id)
      return
    }
    preferFocusId.current = id
    setFocusId(id)
  }

  const sendTalk = async () => {
    if (!talk || !('toId' in talk)) return
    const body = draft.trim()
    if (!body) return
    const from = byId.get(talk.fromId)
    const to = byId.get(talk.toId)
    if (!from || !to) return
    setSending(true)
    try {
      const pane = await api.pty.paneCommand(talk.toId)
      if (pane == null) {
        setNotice('No se pudo entregar — el destinatario no está listo')
        return
      }
      const looksLikeShell = /^(zsh|bash|sh|fish|pwsh|powershell|cmd)$/i.test(pane)
      const forAgent = !!to.data.agentId && !looksLikeShell
      const payload = formatTalkPayload({
        fromCallsign: callsignOf(from),
        fromTitle: String(from.data.title ?? ''),
        toCallsign: callsignOf(to),
        toTitle: String(to.data.title ?? ''),
        body,
        forAgent
      })
      const ok = await api.pty.sendText(talk.toId, payload, { enter: forAgent })
      if (!ok) {
        setNotice('No se pudo entregar — el destinatario no está listo')
        return
      }
      setLog((rows) => [...rows, { from: talk.fromId, to: talk.toId, text: body, at: Date.now() }])
      setDraft('')
      setNotice(`Enviado a ${callsignOf(to)}`)
    } catch {
      setNotice('No se pudo entregar — el destinatario no está listo')
    } finally {
      setSending(false)
    }
  }

  const onDragStart = (e: DragEvent, id: string) => {
    dragId.current = id
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
  }
  const onDragOverCol = (e: DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }
  const onDropCol = (e: DragEvent, groupId: string | null) => {
    e.preventDefault()
    const id = dragId.current || e.dataTransfer.getData('text/plain')
    dragId.current = null
    if (id) onMove(id, groupId)
  }

  const applyModel = (nodeId: string, model: string) => {
    onSetModel?.(nodeId, model)
    if (!mission) return
    const node = byId.get(nodeId)
    const role = node?.data.swarm?.roleId
    if (!role) return
    void api.swarm
      .bind(mission.id, role, nodeId, {
        agentId: typeof node.data.agentId === 'string' ? node.data.agentId : undefined,
        agentModel: model,
        agentSessionId:
          typeof node.data.agentSessionId === 'string' ? node.data.agentSessionId : undefined
      })
      .then((m) => {
        if (m) setMission(m)
      })
  }

  const talkingTo = talk && 'toId' in talk ? talk : null
  const fromNode = talkingTo ? byId.get(talkingTo.fromId) : talk ? byId.get(talk.fromId) : undefined
  const toNode = talkingTo ? byId.get(talkingTo.toId) : undefined
  const focus = focusId ? byId.get(focusId) : undefined
  const hostPolicy = mission?.modelPolicy === 'pinned' ? 'pinned' : modelPolicy
  const emptyFace = emptyAvatar(defaultAgent, settings.customAgents)

  const activateRole = (roleId: SwarmRoleId) => {
    if (!mission) return
    if (mission.paused) {
      setNotice('Misión en pausa. Reanudá primero.')
      return
    }
    if (mission.cancelled) {
      setNotice('Misión cancelada. No se puede activar.')
      return
    }
    void api.swarm.activate(mission.id, roleId).then(async (m) => {
      if (!m) return
      const ticked = await api.swarm.tick(m.id).catch(() => m)
      setMission(ticked ?? m)
      if (adapterMode !== 'live') {
        setNotice('Mock no abre OpenCode ni otros CLIs. Arrancá con npm run dev:mesa:swarm.')
      }
    })
  }

  const approveApproval = (approvalId: string) => {
    if (!mission) return
    void api.swarm.approve(mission.id, approvalId).then(async (m) => {
      if (!m) return
      const ticked = await api.swarm.tick(m.id).catch(() => m)
      const next = ticked ?? m
      setMission(next)
      const still = next.approvals.find((a) => a.id === approvalId && a.status === 'pending')
      const blocked = writerWorktreeBlockLabel(still?.blockedReason)
      if (blocked) setNotice(blocked)
    })
  }

  const spawn = () => {
    const task = swarmDraft.trim()
    if (!focusId || !task || !onSpawnSwarm) return
    onSpawnSwarm(focusId, task)
    setSwarmDraft('')
    setSwarmOpen(false)
  }

  const openComposer = (groupId?: string, mission = false) => {
    setPickAgent(defaultAgent)
    setPickModel(mesaDefaultModel(defaultAgent, gatewayModels))
    setModelPolicy('auto')
    setMissionObjective(mission ? DEFAULT_MISSION_OBJECTIVE : '')
    setBudgetLimit('')
    setHardBudget(false)
    setComposer({ groupId, mission })
  }
  const commitComposer = () => {
    if (composer?.mission) {
      const objective = missionObjective.trim()
      if (!objective) return
      const limit = Number.parseFloat(budgetLimit)
      const limitUsd = Number.isFinite(limit) && limit > 0 ? limit : undefined
      pendingMission.current = objective
      pendingIgnoreIds.current = new Set(terminals.map((t) => t.id))
      pendingBudget.current = {
        limitUsd,
        hard: adapterMode !== 'live' && hardBudget && limitUsd != null
      }
      onAddTerminal(composer.groupId, { orchestrator: true })
      setComposer(null)
      return
    }
    onAddTerminal(composer?.groupId, {
      agentId: pickAgent,
      model: modelPolicy === 'pinned' ? pickModel || undefined : undefined
    })
    setComposer(null)
  }
  const composerForm = (
    <MesaComposer
      mission={!!composer?.mission}
      missionObjective={missionObjective}
      onObjective={setMissionObjective}
      budgetLimit={budgetLimit}
      onBudgetLimit={setBudgetLimit}
      hardBudget={hardBudget}
      onHardBudget={setHardBudget}
      adapterMode={adapterMode}
      modelPolicy={modelPolicy}
      onPolicy={setModelPolicy}
      agents={agents}
      pickAgent={pickAgent}
      pickModel={pickModel}
      gatewayModels={gatewayModels}
      onAgent={(id) => {
        setPickAgent(id)
        setPickModel(mesaDefaultModel(id, gatewayModels))
      }}
      onModel={setPickModel}
      onSubmit={commitComposer}
      onCancel={() => setComposer(null)}
    />
  )

  const missionNodeIds = new Set(
    [
      mission?.orchestratorNodeId,
      ...(mission?.tasks.map((t) => t.nodeId).filter((id): id is string => !!id) ?? [])
    ].filter((id): id is string => !!id)
  )

  const requestDelete = (id: string) => {
    const node = byId.get(id)
    const st = useAgentStatus.getState().byId[id]
    if (node?.data.pendingLaunch || st?.state === 'working') {
      setNotice('Cerrar un nodo activo requiere resolver su ejecución primero')
      return
    }
    onDelete(id)
  }

  return (
    <div
      className={`mesa-overlay mesa-grok${parked ? ' is-parked' : ''}`}
      aria-hidden={parked}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          setTalk(null)
          setNotice(null)
          setComposer(null)
          setSwarmOpen(false)
        }
      }}
    >
      <MissionHeader
        modelPolicy={hostPolicy}
        objective={mission?.goal.objective}
        onNewMission={() => openComposer(undefined, true)}
        onNewBot={() => openComposer()}
        onAddGroup={onAddGroup}
      />

      {mesaTerms.length === 0 ? (
        <div className="mesa-empty">
          <BotAvatar letter={emptyFace.letter} color={emptyFace.color} size={72} />
          <p className="mesa-empty__title">Consola de swarm</p>
          <p className="mesa-empty__sub">
            El orquestador tiene su propia sesión de terminal. Cada bot tiene su propia sesión; las
            tareas de escritura pueden ir a workspaces aislados.
          </p>
          <button
            type="button"
            className="mesa-btn mesa-btn--primary mesa-btn--lg"
            onClick={() => openComposer(undefined, true)}
          >
            Nueva misión
          </button>
        </div>
      ) : (
        <div className={`mesa-grok__body${inspectOpen ? ' has-inspector' : ''}`}>
          <MissionRoster
            query={query}
            onQuery={setQuery}
            mission={mission}
            columns={columns}
            grouped={grouped}
            byId={byId}
            focusId={focusId}
            talk={talk}
            match={match}
            missionNodeIds={missionNodeIds}
            openCoords={openCoords}
            snippetOf={(node) => lastSnippet(node, log)}
            onToggleCoord={(coord) =>
              setOpenCoords((prev) => ({ ...prev, [coord]: !(prev[coord] !== false) }))
            }
            onSelect={onRowClick}
            onTalk={startTalk}
            onDragStart={onDragStart}
            onDragOverCol={onDragOverCol}
            onDropCol={onDropCol}
            onRenameGroup={onRenameGroup}
            onAddInColumn={(groupId) => openComposer(groupId)}
            onActivate={activateRole}
          />

          <section className="mesa-stage">
            {focus ? (
              <BotStage
                node={focus}
                onRename={(t) => onRename(focus.id, t)}
                onDelete={() => requestDelete(focus.id)}
                onOpenSwarm={onSpawnSwarm ? () => setSwarmOpen(true) : undefined}
                modelPolicy={hostPolicy}
                mission={mission}
                onSetModel={onSetModel ? applyModel : undefined}
                onEnsureTui={
                  mission
                    ? () => api.swarm.ensureTui(mission.id, mission.orchestratorNodeId)
                    : undefined
                }
              />
            ) : (
              <div className="mesa-stage__empty">Elegí un bot</div>
            )}
            {mesaTerms.length > 0 && (
              <div className="mesa-stage__terms">
                {mesaTerms.map((n) => {
                  const spawnSpec = toKanbanSession(n)?.spawn ?? {}
                  const front = focusId === n.id
                  return (
                    <div
                      key={n.id}
                      className={`mesa-stage__term${front ? '' : ' is-parked'}`}
                    >
                      <ModalTerminal
                        nodeId={n.id}
                        spawn={spawnSpec}
                        searchOpen={false}
                        onCloseSearch={() => {}}
                        autoFocus={front}
                        // Attach-only: the canvas TerminalNode or the swarm host types the CLI.
                        // A parked Mesa viewer with mayLaunch would race claimNodeLaunch.
                        mayLaunch={false}
                        themePatch={MESA_TERM_THEME}
                      />
                    </div>
                  )
                })}
              </div>
            )}
          </section>
          {inspectOpen && (
            <MissionInspector
              mission={mission}
              onActivate={activateRole}
              onApprove={approveApproval}
              onClose={() => setInspectOpen(false)}
            />
          )}
        </div>
      )}

      {mesaTerms.length > 0 && (
        <MissionStatusBar
          mission={mission}
          adapterMode={adapterMode}
          inspectOpen={inspectOpen}
          onToggleInspect={() => setInspectOpen((v) => !v)}
          onPause={() => {
            if (!mission) return
            void api.swarm.pause(mission.id).then((m) => {
              if (m) setMission(m)
            })
          }}
          onResume={() => {
            if (!mission) return
            void api.swarm.resume(mission.id).then(async (m) => {
              if (!m) return
              const ticked = await api.swarm.tick(m.id).catch(() => m)
              setMission(ticked ?? m)
            })
          }}
          onCancel={() => {
            if (!mission) return
            void api.swarm.cancel(mission.id).then((m) => {
              if (m) setMission(m)
            })
          }}
          onActivateA={() => activateRole('A')}
          onApprove={approveApproval}
        />
      )}

      {composer && (
        <div className="mesa-dialog" role="dialog" aria-label={composer.mission ? 'Nueva misión' : 'Nuevo bot'}>
          <div className="mesa-dialog__card">{composerForm}</div>
        </div>
      )}

      {swarmOpen && (
        <div className="mesa-dialog" role="dialog" aria-label="Configurar swarm">
          <form
            className="mesa-dialog__card mesa-swarm"
            onSubmit={(e) => {
              e.preventDefault()
              spawn()
            }}
          >
            <p className="mesa-dialog__title">Swarm legacy</p>
            <p className="mesa-dialog__hint">
              El planner de tres roles se conserva durante la transición. La misión jerárquica vive
              en el runtime del host.
            </p>
            <input
              className="mesa-swarm__input"
              value={swarmDraft}
              onChange={(e) => setSwarmDraft(e.target.value)}
              placeholder="Qué hace el swarm…"
              autoFocus
            />
            <div className="mesa-dialog__actions">
              <button type="submit" className="mesa-btn mesa-btn--primary" disabled={!swarmDraft.trim()}>
                Armar
              </button>
              <button type="button" className="mesa-btn" onClick={() => setSwarmOpen(false)}>
                Cancelar
              </button>
            </div>
          </form>
        </div>
      )}

      {(talk || notice) && (
        <footer className="mesa-talk">
          {talkingTo && fromNode && toNode ? (
            <>
              <span className="mesa-talk__who">
                <b>{callsignOf(fromNode)}</b>
                <span aria-hidden>→</span>
                <b>{callsignOf(toNode)}</b>
              </span>
              <input
                className="mesa-talk__input"
                autoFocus
                placeholder={`Escribile a ${displayName(toNode)}…`}
                value={draft}
                disabled={sending}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void sendTalk()
                  }
                }}
              />
              <button
                type="button"
                className="mesa-btn mesa-btn--primary"
                disabled={sending || !draft.trim()}
                onClick={() => void sendTalk()}
              >
                Enviar
              </button>
              <button type="button" className="mesa-btn" onClick={() => setTalk(null)}>
                Listo
              </button>
            </>
          ) : (
            <span className="mesa-talk__hint">{notice ?? 'Elegí el destino'}</span>
          )}
        </footer>
      )}
    </div>
  )
})

function emptyAvatar(
  agentId: AgentId,
  customAgents: ReadonlyArray<{ id: string; label: string }>
): { letter: string; color: string } {
  const builtin = (agentId in AGENT_CONFIG ? AGENT_CONFIG[agentId as BuiltinAgentId] : undefined)
  const custom = customAgents.find((c) => c.id === agentId)
  const label = builtin?.label ?? custom?.label ?? 'Mesa'
  return { letter: label.charAt(0).toUpperCase(), color: builtin?.color ?? '#0a84ff' }
}

function MesaComposer({
  mission,
  missionObjective,
  onObjective,
  budgetLimit,
  onBudgetLimit,
  hardBudget,
  onHardBudget,
  adapterMode = 'mock',
  modelPolicy,
  onPolicy,
  agents,
  pickAgent,
  pickModel,
  gatewayModels,
  onAgent,
  onModel,
  onSubmit,
  onCancel
}: {
  mission: boolean
  missionObjective: string
  onObjective: (v: string) => void
  budgetLimit: string
  onBudgetLimit: (v: string) => void
  hardBudget: boolean
  onHardBudget: (v: boolean) => void
  adapterMode?: 'mock' | 'live'
  modelPolicy: 'auto' | 'pinned'
  onPolicy: (v: 'auto' | 'pinned') => void
  agents: MesaAgentOption[]
  pickAgent: AgentId
  pickModel: string
  gatewayModels: readonly GatewayModel[]
  onAgent: (id: AgentId) => void
  onModel: (id: string) => void
  onSubmit: () => void
  onCancel: () => void
}) {
  const modelChoices = mesaModelsFor(pickAgent, gatewayModels)
  return (
    <form
      className="mesa-composer mesa-composer--dialog"
      onSubmit={(e: FormEvent) => {
        e.preventDefault()
        onSubmit()
      }}
    >
      <p className="mesa-dialog__title">{mission ? 'Nueva misión' : 'Nuevo bot'}</p>
      {mission && (
        <textarea
          className="mesa-composer__obj"
          value={missionObjective}
          onChange={(e) => onObjective(e.target.value)}
          placeholder="Objetivo y criterios…"
          rows={3}
          autoFocus
        />
      )}
      {mission && adapterMode !== 'live' && (
        <p className="mesa-dialog__hint">
          Mock acepta roles sin abrir OpenCode, Grok ni Claude. Para CLIs reales:{' '}
          <code>npm run dev:mesa:swarm</code>.
        </p>
      )}
      {mission && (
        <div className="mesa-composer__budget">
          <input
            className="mesa-composer__sel"
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            placeholder="Límite USD (opcional)"
            aria-label="Límite de presupuesto en USD"
            value={budgetLimit}
            onChange={(e) => onBudgetLimit(e.target.value)}
          />
          <label className="mesa-composer__hard">
            <input
              type="checkbox"
              checked={hardBudget && adapterMode !== 'live'}
              disabled={!budgetLimit.trim() || adapterMode === 'live'}
              onChange={(e) => onHardBudget(e.target.checked)}
            />
            Límite duro
          </label>
          {adapterMode === 'live' ? (
            <p className="mesa-dialog__hint">
              CLIs reales no imponen un corte duro: el JSON todavía no trae usage medido. El
              orquestador sí arranca; los workers no, si el host ya tiene un límite duro.
            </p>
          ) : hardBudget ? (
            <p className="mesa-dialog__hint">Mock estima y corta al llegar al límite.</p>
          ) : null}
        </div>
      )}
      <select
        className="mesa-composer__sel"
        value={pickAgent}
        onChange={(e) => onAgent(e.target.value as AgentId)}
        aria-label="CLI"
      >
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label}
          </option>
        ))}
      </select>
      {modelChoices.length > 0 && (
        <>
          <select
            className="mesa-composer__sel"
            value={modelPolicy}
            onChange={(e) => onPolicy(e.target.value as 'auto' | 'pinned')}
            aria-label="Política de modelo"
          >
            <option value="auto">Auto · el router elige</option>
            <option value="pinned">Modelo fijo</option>
          </select>
          <select
            className="mesa-composer__sel"
            value={pickModel}
            disabled={modelPolicy === 'auto'}
            onChange={(e) => onModel(e.target.value)}
            aria-label="Modelo"
            title={modelPolicy === 'auto' ? 'Modelo de referencia; Auto no lo fija' : 'Modelo fijo'}
          >
            {modelChoices.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </>
      )}
      <div className="mesa-dialog__actions">
        <button type="submit" className="mesa-btn mesa-btn--primary" disabled={mission && !missionObjective.trim()}>
          Crear
        </button>
        <button type="button" className="mesa-btn" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </form>
  )
}

function displayName(node: CanvasNode): string {
  const title = String(node.data.title ?? '').trim()
  return title || callsignOf(node)
}

function lastSnippet(
  node: CanvasNode,
  log: Array<{ from: string; to: string; text: string; at: number }>
): string {
  const row = [...log].reverse().find((r) => r.to === node.id || r.from === node.id)
  if (row) return row.text
  return jobTitle(node)
}

function jobTitle(node: CanvasNode): string {
  const agent = node.data.agentId as string | undefined
  if (agent) return agent
  return 'Terminal'
}

function BotStage({
  node,
  onRename,
  onDelete,
  onOpenSwarm,
  modelPolicy,
  mission,
  onSetModel,
  onEnsureTui
}: {
  node: CanvasNode
  onRename: (title: string) => void
  onDelete: () => void
  onOpenSwarm?: () => void
  modelPolicy: 'auto' | 'pinned'
  mission: SwarmMission | null
  onSetModel?: (nodeId: string, model: string) => void
  onEnsureTui?: () => Promise<{ ok: boolean; running: boolean }>
}) {
  const letter = callsignOf(node)
  const name = displayName(node)
  const color = String(node.data.color ?? '#bf5af2')
  const agent = node.data.agentId as AgentId | undefined
  const status = useAgentStatus((s) => s.byId[node.id])
  const gatewayModels = useModelGateway((s) => s.models)
  const armed = !!node.data.pendingLaunch
  const presence = presenceOf(status?.state, armed)
  const modelChoices = agent ? mesaModelsFor(agent, gatewayModels) : []
  const currentModel =
    typeof node.data.agentModel === 'string' && node.data.agentModel
      ? node.data.agentModel
      : agent && capabilityAgentId(agent) === 'grok'
        ? DEFAULT_GROK_MODEL
        : ''
  const [editing, setEditing] = useState(false)
  const [menu, setMenu] = useState(false)
  const [disconnected, setDisconnected] = useState(false)
  const [value, setValue] = useState(name)
  const { api } = useSession()
  const orch = mission?.orchestratorNodeId === node.id
  useEffect(() => setValue(name), [name])
  useEffect(() => {
    if (!orch) {
      setDisconnected(false)
      return
    }
    let cancelled = false
    let shellSince: number | null = null
    const GRACE_MS = 12_000
    const probe = async () => {
      const pane = await api.pty.paneCommand(node.id)
      if (cancelled) return
      if (pane == null) return
      const shell = /^(zsh|bash|sh|fish|pwsh|powershell|cmd)$/i.test(pane)
      if (!shell) {
        shellSince = null
        setDisconnected(false)
        return
      }
      if (shellSince == null) shellSince = Date.now()
      setDisconnected(Date.now() - shellSince >= GRACE_MS)
    }
    void probe()
    const t = setInterval(() => void probe(), 2500)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [orch, node.id, api.pty])
  const commit = () => {
    setEditing(false)
    const t = value.trim()
    if (t && t !== name) onRename(t)
    else setValue(name)
  }
  const busy = armed || status?.state === 'working'

  return (
    <>
      <header className="mesa-stage__bar">
        <BotAvatar
          letter={letter}
          color={color}
          presence={presence}
          size={32}
          compact
          showStatus
          title={presenceLabel(presence)}
        />
        {editing ? (
          <input
            className="mesa-stage__rename"
            value={value}
            autoFocus
            onChange={(e) => setValue(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') {
                setValue(name)
                setEditing(false)
              }
            }}
          />
        ) : (
          <button type="button" className="mesa-stage__name" onClick={() => setEditing(true)}>
            {orch ? '◎ Orquestador' : name}
          </button>
        )}
        <span className="mesa-stage__job">
          {orch ? mission?.goal.objective ?? jobTitle(node) : jobTitle(node)}
        </span>
        <span className="mesa-stage__policy">
          {modelPolicy === 'auto' ? 'AUTO' : 'FIJO'}
          {currentModel ? ` → ${currentModel}` : ''}
        </span>
        {modelChoices.length > 0 && onSetModel && (
          <select
            className="mesa-composer__sel mesa-stage__model"
            value={currentModel}
            title="Modelo efectivo de este bot"
            onChange={(e) => {
              const next = e.target.value
              if (next && next !== currentModel) onSetModel(node.id, next)
            }}
          >
            {modelChoices.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        )}
        <div className="mesa-stage__more">
          <button type="button" className="mesa-stage__kill" title="Más" onClick={() => setMenu((v) => !v)}>
            ⋯
          </button>
          {menu && (
            <div className="mesa-stage__menu">
              {onOpenSwarm && (
                <button type="button" onClick={() => { setMenu(false); onOpenSwarm() }}>
                  Swarm legacy…
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                title={busy ? 'Resolvé la ejecución primero' : 'Cerrar'}
                onClick={() => {
                  setMenu(false)
                  onDelete()
                }}
              >
                <IconTrash /> Cerrar
              </button>
            </div>
          )}
        </div>
      </header>

      {disconnected && (
        <div className="mesa-console-down">
          <span>Consola desconectada</span>
          {onEnsureTui && (
            <button
              type="button"
              className="mesa-btn mesa-btn--primary"
              onClick={() => {
                void onEnsureTui().then((r) => {
                  if (r.ok || r.running) setDisconnected(false)
                })
              }}
            >
              Reconectar
            </button>
          )}
        </div>
      )}

      {armed && (
        <div className="mesa-stage__tools">
          <div className="mesa-routine">
            <span>Esperando resultados validados, no solo idle</span>
            <em>Armado</em>
          </div>
        </div>
      )}
    </>
  )
}

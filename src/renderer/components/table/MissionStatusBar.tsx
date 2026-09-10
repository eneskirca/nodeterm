import { ALL_SWARM_ROLES } from '@shared/swarm/types'
import type { SwarmApproval, SwarmMission } from '@shared/swarm/types'
import {
  countActiveTasks,
  formatBudgetLine,
  missionProgress,
  taskFailLabel,
  writerWorktreeBlock,
  writerWorktreeBlockLabel
} from '@shared/swarm/schemas'

/** Writers wait here — do not hide the button behind a closed inspector. */
export function pendingSwarmApprovals(mission: SwarmMission | null): SwarmApproval[] {
  if (!mission || mission.cancelled || mission.paused) return []
  return mission.approvals.filter((a) => a.status === 'pending')
}

export function approvalRoleLabel(mission: SwarmMission, approval: SwarmApproval): string {
  return mission.tasks.find((t) => t.id === approval.taskId)?.roleId ?? approval.action.args[0] ?? 'write'
}

export function MissionStatusBar({
  mission,
  adapterMode = 'mock',
  inspectOpen,
  onToggleInspect,
  onPause,
  onResume,
  onCancel,
  onActivateA,
  onApprove
}: {
  mission: SwarmMission | null
  adapterMode?: 'mock' | 'live'
  inspectOpen: boolean
  onToggleInspect: () => void
  onPause?: () => void
  onResume?: () => void
  onCancel?: () => void
  onActivateA?: () => void
  onApprove?: (approvalId: string) => void
}) {
  const active = mission ? countActiveTasks(mission.tasks) : 0
  const budget = mission
    ? formatBudgetLine({ kind: mission.budget.spent.kind, usd: mission.budget.spent.usd })
    : { label: 'Coste no disponible' }
  const progress = missionProgress(mission)
  const phase = progress.label
  const failHint = mission
    ? mission.tasks.map((t) => taskFailLabel(t.failReason)).find((x) => !!x)
    : null
  const onlyOrch =
    !!mission &&
    !mission.cancelled &&
    !mission.paused &&
    mission.tasks.length > 0 &&
    mission.tasks.every((t) => t.roleId === 'O')
  const worktreeBlock = writerWorktreeBlock(mission)
  const worktreeHint = writerWorktreeBlockLabel(worktreeBlock)
  return (
    <footer className="mesa-status">
      <span>
        {phase} · {adapterMode === 'live' ? 'CLIs reales' : 'mock (sin CLIs)'} · {active}/4 slots ·{' '}
        {ALL_SWARM_ROLES.length} roles disponibles · {onlyOrch ? 'A dormido' : '/help'}
      </span>
      <span className="mesa-status__budget">
        {budget.label}
        {mission?.budget.hard ? ' · duro' : ''}
      </span>
      {onlyOrch && onActivateA && (
        <button type="button" className="mesa-btn mesa-btn--primary" onClick={onActivateA}>
          Activar A
        </button>
      )}
      {(progress.hint || failHint || worktreeHint) && (
        <span className="mesa-status__hint" title={progress.hint || failHint || worktreeHint || undefined}>
          {progress.hint || failHint || worktreeHint}
        </span>
      )}
      {mission &&
        onApprove &&
        pendingSwarmApprovals(mission).map((a) => (
          <button
            key={a.id}
            type="button"
            className="mesa-btn mesa-btn--primary"
            disabled={!!worktreeBlock}
            title={worktreeHint ?? undefined}
            onClick={() => onApprove(a.id)}
          >
            Aprobar {approvalRoleLabel(mission, a)}
          </button>
        ))}
      {mission && !mission.cancelled && (
        <>
          {mission.paused ? (
            <button type="button" className="mesa-btn" onClick={onResume} disabled={!onResume}>
              Reanudar
            </button>
          ) : (
            <button type="button" className="mesa-btn" onClick={onPause} disabled={!onPause}>
              Pausar
            </button>
          )}
          <button type="button" className="mesa-btn" onClick={onCancel} disabled={!onCancel}>
            Cancelar misión
          </button>
        </>
      )}
      <button type="button" className="mesa-btn" onClick={onToggleInspect}>
        {inspectOpen ? 'Ocultar inspector' : 'Inspeccionar'}
      </button>
    </footer>
  )
}

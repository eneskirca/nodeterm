import type { SwarmMission, SwarmRoleId } from '@shared/swarm/types'
import { approvalRoleLabel } from './MissionStatusBar'
import { ALL_SWARM_ROLES, SWARM_ROLE_LABEL } from '@shared/swarm/types'
import {
  countActivatedRoles,
  countActiveTasks,
  countUnobservableExecutions,
  countVerifiedGoalCriteria,
  formatBudgetLine,
  missionProgress,
  roleNeedsActivation,
  taskFailLabel,
  taskLifecycleLabel,
  cliEffectiveLabel,
  writerWorktreeBlock,
  writerWorktreeBlockLabel
} from '@shared/swarm/schemas'

export function MissionInspector({
  mission,
  onActivate,
  onApprove,
  onClose
}: {
  mission: SwarmMission | null
  onActivate?: (roleId: SwarmRoleId) => void
  onApprove?: (approvalId: string) => void
  onClose: () => void
}) {
  const budget = mission
    ? formatBudgetLine({ kind: mission.budget.spent.kind, usd: mission.budget.spent.usd })
    : formatBudgetLine({ kind: 'unavailable' })
  const { met, total } = countActivatedRoles(mission)
  const goal = countVerifiedGoalCriteria(mission)
  const active = mission ? countActiveTasks(mission.tasks) : 0
  const unobs = mission ? countUnobservableExecutions(mission.tasks) : 0
  const worktreeHint = writerWorktreeBlockLabel(writerWorktreeBlock(mission))
  const worktreeBlocked = !!writerWorktreeBlock(mission)
  return (
    <aside className="mesa-inspector">
      <header className="mesa-inspector__bar">
        <span>Inspector</span>
        <button type="button" className="mesa-btn mesa-btn--quiet" onClick={onClose}>
          Cerrar
        </button>
      </header>
      {!mission && (
        <p className="mesa-inspector__empty">No hay misión. «Nueva misión» crea el orquestador.</p>
      )}
      <section className="mesa-inspector__block">
        <div className="mesa-inspector__kicker">
          {mission ? `OBJETIVO v${mission.goal.version}` : 'OBJETIVO'}
        </div>
        <p>{mission?.goal.objective ?? 'Sin objetivo todavía'}</p>
        <p className="mesa-inspector__meta">
          {missionProgress(mission).label} · Roles: {met}/{total || '—'} aceptados · Objetivo:{' '}
          {goal.total === 0 ? 'Sin criterios' : goal.met === 0 ? 'Sin verificar' : `${goal.met}/${goal.total} criterios`}
          {' · '}
          {active} activas{unobs ? ` · ${unobs} sin conexión` : ''} · {budget.label}
          {mission?.budget.hard ? ' · límite duro' : mission?.budget.limitUsd != null ? ' · límite blando' : ''}
        </p>
        {missionProgress(mission).hint && (
          <p className="mesa-inspector__meta">{missionProgress(mission).hint}</p>
        )}
        {mission?.tasks
          .filter((t) => t.status === 'running' || t.failReason)
          .map((t) => (
            <p key={t.id} className="mesa-inspector__meta">
              {t.roleId}: {t.failReason ? taskFailLabel(t.failReason) : cliEffectiveLabel(t)}
            </p>
          ))}
        {mission?.budget.blockedReason && (
          <p className="mesa-inspector__meta">
            Despacho detenido: {mission.budget.blockedReason === 'budget-exhausted'
              ? 'el gasto estimado llegó al límite'
              : 'el adaptador no puede imponer un límite duro (falta usage medido)'}
          </p>
        )}
        {worktreeHint && <p className="mesa-inspector__meta">{worktreeHint}</p>}
        {mission?.paused && !mission.cancelled && (
          <p className="mesa-inspector__meta">Misión en pausa. Reanudá para activar roles.</p>
        )}
        {mission?.cancelled && (
          <p className="mesa-inspector__meta">Misión cancelada. No se pueden activar roles.</p>
        )}
      </section>
      {!!mission?.approvals.some((a) => a.status === 'pending') && (
        <section className="mesa-inspector__block">
          <div className="mesa-inspector__kicker">Aprobaciones</div>
          <ul className="mesa-inspector__roles">
            {mission.approvals
              .filter((a) => a.status === 'pending')
              .map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    className="mesa-inspector__role"
                    disabled={!onApprove || worktreeBlocked}
                    title={worktreeHint ?? undefined}
                    onClick={() => onApprove?.(a.id)}
                  >
                    <b>Aprobar {approvalRoleLabel(mission, a)}</b>
                    <em>{a.action.cwd || 'worktree'}</em>
                  </button>
                </li>
              ))}
          </ul>
        </section>
      )}
      <section className="mesa-inspector__block">
        <div className="mesa-inspector__kicker">Roles</div>
        <ul className="mesa-inspector__roles">
          {ALL_SWARM_ROLES.map((id) => {
            const task = mission?.tasks.find((t) => t.roleId === id)
            const retryable = !!task && roleNeedsActivation(task)
            return (
              <li key={id}>
                <button
                  type="button"
                  className="mesa-inspector__role"
                  disabled={
                    !mission ||
                    !onActivate ||
                    mission.paused ||
                    mission.cancelled ||
                    !roleNeedsActivation(task)
                  }
                  onClick={() => onActivate?.(id)}
                >
                  <b>{id}</b> {SWARM_ROLE_LABEL[id]}
                  <em>
                    {retryable ? `${taskLifecycleLabel(task)} · reintentar` : taskLifecycleLabel(task)}
                    {task?.workspace?.kind === 'worktree' ? ' · worktree' : ''}
                  </em>
                </button>
              </li>
            )
          })}
        </ul>
      </section>
    </aside>
  )
}

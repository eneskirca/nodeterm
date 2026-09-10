import type { SwarmMission } from '../shared/swarm/types'
import { formatRolePlan, isSwarmRoleId, missionProgress } from '../shared/swarm/schemas'
import { formatBudget } from '../core/swarm/budget'
import { compactGoal } from '../core/swarm/context'
import { countActivatedRoles, countActive } from '../core/swarm/scheduler'

export const MESA_TUI_COMMANDS = [
  '/goal',
  '/plan',
  '/agents',
  '/budget',
  '/artifacts',
  '/approve',
  '/activate',
  '/pause',
  '/resume',
  '/cancel',
  '/help'
] as const

export type MesaTuiCommand = (typeof MESA_TUI_COMMANDS)[number]

export function parseTuiLine(line: string): { kind: 'command'; name: MesaTuiCommand; arg: string } | { kind: 'prompt'; text: string } | { kind: 'empty' } {
  const text = line.replace(/\s+$/u, '')
  if (!text.trim()) return { kind: 'empty' }
  if (text.startsWith('/')) {
    const [raw, ...rest] = text.slice(1).split(/\s+/)
    const name = (`/${raw}` as MesaTuiCommand)
    if ((MESA_TUI_COMMANDS as readonly string[]).includes(name)) {
      return { kind: 'command', name, arg: rest.join(' ') }
    }
    return { kind: 'prompt', text }
  }
  return { kind: 'prompt', text }
}

export function renderTuiHelp(): string {
  return [
    'Mesa orchestrator — commands stay in this TUI, not in Claude/Codex/shell.',
    '/goal                 Objetivo y criterios',
    '/plan                 DAG y progreso',
    '/agents               Roles, tareas y modelos',
    '/budget               Consumido, reservado y límite',
    '/artifacts            Resultados',
    '/approve <id>         Aprobar una acción',
    '/activate <rol>       Despertar A–D / A1–D4 (el host crea el terminal)',
    '/pause                No despachar nuevas tareas',
    '/resume               Continuar',
    '/cancel               Solicitar cancelación',
    '/help                 Ayuda'
  ].join('\n')
}

export function renderMission(mission: SwarmMission | null): Record<MesaTuiCommand, string> {
  if (!mission) {
    const empty = 'No hay misión activa.'
    return {
      '/goal': empty,
      '/plan': empty,
      '/agents': empty,
      '/budget': empty,
      '/artifacts': empty,
      '/approve': empty,
      '/activate': empty,
      '/pause': empty,
      '/resume': empty,
      '/cancel': empty,
      '/help': renderTuiHelp()
    }
  }
  const { met, total } = countActivatedRoles(mission)
  const budget = formatBudget(mission.budget)
  return {
    '/goal': compactGoal(mission.goal),
    '/plan': `${missionProgress(mission).label}\n${formatRolePlan(mission.tasks)}`,
    '/agents': mission.tasks.map((t) => `${t.roleId} ${t.status}${t.executionId ? ` exec=${t.executionId}` : ''}`).join('\n'),
    '/budget': `${budget.label} (${budget.kind}) · activos ${countActive(mission)} · roles ${met}/${total}`,
    '/artifacts': mission.artifacts.map((a) => `${a.id} ${a.kind}`).join('\n') || '(ninguno)',
    '/approve': mission.approvals.filter((a) => a.status === 'pending').map((a) => a.id).join(' ') || '(nada pendiente)',
    '/activate': 'Usá /activate A … D4. O ya está activo.',
    '/pause': mission.paused ? 'Ya en pausa.' : 'Pausa pedida.',
    '/resume': mission.paused ? 'Reanudando.' : 'No estaba en pausa.',
    '/cancel': mission.cancelled ? 'Ya cancelada.' : 'Cancelación pedida.',
    '/help': renderTuiHelp()
  }
}

export function applyTuiCommand(
  mission: SwarmMission | null,
  parsed: ReturnType<typeof parseTuiLine>
): { reply: string; action?: { type: 'pause' | 'resume' | 'cancel' | 'approve' | 'set-goal' | 'activate'; arg?: string } } {
  if (parsed.kind === 'empty') return { reply: '' }
  if (parsed.kind === 'prompt') {
    return { reply: `mesa › Objetivo recibido.\n${parsed.text}`, action: { type: 'set-goal', arg: parsed.text } }
  }
  const views = renderMission(mission)
  if (parsed.name === '/pause') return { reply: views['/pause'], action: { type: 'pause' } }
  if (parsed.name === '/resume') return { reply: views['/resume'], action: { type: 'resume' } }
  if (parsed.name === '/cancel') return { reply: views['/cancel'], action: { type: 'cancel' } }
  if (parsed.name === '/approve') return { reply: views['/approve'], action: { type: 'approve', arg: parsed.arg } }
  if (parsed.name === '/activate') {
    const role = parsed.arg.trim().toUpperCase()
    if (!isSwarmRoleId(role)) {
      return { reply: 'Usá /activate A … D4. O ya está activo.' }
    }
    if (mission?.paused) return { reply: 'Misión en pausa. /resume primero.' }
    if (mission?.cancelled) return { reply: 'Misión cancelada. No se puede activar.' }
    const existing = mission?.tasks.find((t) => t.roleId === role)
    const retryable = existing?.status === 'failed' || existing?.status === 'stale'
    if (role === 'O' && !retryable) {
      return { reply: 'Usá /activate A … D4. O ya está activo.' }
    }
    if (existing && !retryable) {
      if (
        existing.status === 'running' ||
        existing.status === 'ready' ||
        existing.status === 'queued' ||
        existing.status === 'waiting_approval' ||
        existing.status === 'validating'
      ) {
        return {
          reply: `${role} sigue en curso (${existing.status}). Mesa no marca terminado hasta un resultado validado. Idle no cuenta. Si falló, /activate ${role} reintenta.`
        }
      }
      return { reply: `${role} ya está activo (${existing.status}).` }
    }
    return {
      reply: retryable ? `Reintentando ${role}.` : `Activando ${role}.`,
      action: { type: 'activate', arg: role }
    }
  }
  return { reply: views[parsed.name] }
}

import { IconPlus } from '../icons'

export function MissionHeader({
  modelPolicy,
  objective,
  onNewMission,
  onNewBot,
  onAddGroup
}: {
  modelPolicy: 'auto' | 'pinned'
  objective?: string
  onNewMission: () => void
  onNewBot: () => void
  onAddGroup: () => void
}) {
  return (
    <header className="mesa-bar">
      <div className="mesa-bar__brand">
        <span className="mesa-bar__kicker">Mesa</span>
        <span className="mesa-bar__hint">
          {objective?.trim()
            ? objective.trim()
            : `${modelPolicy === 'auto' ? 'Auto' : 'Modelo fijo'} · cada bot tiene su propia sesión`}
        </span>
      </div>
      <div className="mesa-bar__actions">
        <button type="button" className="mesa-btn mesa-btn--primary" onClick={onNewMission}>
          Nueva misión
        </button>
        <button type="button" className="mesa-btn" onClick={onNewBot}>
          Nuevo bot
        </button>
        <button type="button" className="mesa-btn" onClick={onAddGroup}>
          <IconPlus /> Grupo
        </button>
      </div>
    </header>
  )
}

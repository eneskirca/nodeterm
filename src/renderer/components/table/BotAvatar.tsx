import type { AgentState } from '@shared/agents/normalize'

/** Grok Bot presence. `thinking` is not a nodeterm hook state — we map working's first beat to it only if asked. */
export type BotPresence = 'idle' | 'working' | 'waiting' | 'blocked' | 'done'

export function presenceOf(state?: AgentState, armed?: boolean): BotPresence {
  if (armed && state !== 'working' && state !== 'done') return 'waiting'
  if (state === 'working') return 'working'
  if (state === 'waiting') return 'waiting'
  if (state === 'blocked') return 'blocked'
  if (state === 'done') return 'done'
  return 'idle'
}

export function presenceLabel(p: BotPresence): string {
  switch (p) {
    case 'working':
      return 'Working'
    case 'waiting':
      return 'Waiting'
    case 'blocked':
      return 'Needs you'
    case 'done':
      return 'Done'
    default:
      return 'Idle'
  }
}

const SHAPES = ['circle', 'squircle', 'hex', 'diamond'] as const

function shapeOf(letter: string): (typeof SHAPES)[number] {
  const n = letter.toUpperCase().charCodeAt(0) || 65
  return SHAPES[n % SHAPES.length]
}

function accessoryOf(letter: string): 'none' | 'hat' | 'glasses' | 'bow' | 'antenna' {
  const n = letter.toUpperCase().charCodeAt(letter.length - 1) || 65
  return (['none', 'hat', 'glasses', 'bow', 'antenna'] as const)[n % 5]
}

export function BotAvatar({
  letter,
  color,
  presence = 'idle',
  title,
  size = 40,
  compact = false,
  showStatus = false
}: {
  letter: string
  color: string
  presence?: BotPresence
  title?: string
  size?: number
  compact?: boolean
  showStatus?: boolean
}) {
  const shape = shapeOf(letter)
  const accessory = accessoryOf(letter)
  const label = title ?? presenceLabel(presence)
  return (
    <span
      className={`bot-avatar is-${presence} is-${shape}${compact ? ' is-compact' : ''}`}
      style={{ ['--bot' as string]: color, width: size, height: size }}
      title={label}
      aria-label={label}
      data-status={showStatus ? presenceLabel(presence) : undefined}
    >
      <span className="bot-avatar__face" aria-hidden>
        {accessory === 'hat' && <span className="bot-avatar__acc bot-avatar__acc--hat" />}
        {accessory === 'antenna' && <span className="bot-avatar__acc bot-avatar__acc--antenna" />}
        {accessory === 'bow' && <span className="bot-avatar__acc bot-avatar__acc--bow" />}
        <span className="bot-avatar__eyes">
          <i />
          <i />
        </span>
        {accessory === 'glasses' && <span className="bot-avatar__acc bot-avatar__acc--glasses" />}
      </span>
    </span>
  )
}

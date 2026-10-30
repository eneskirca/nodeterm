import { AGENT_CONFIG, BUILTIN_AGENT_IDS } from '@shared/agents/config'
import { effectiveLimit } from '@shared/project-limit'
import { useProjectLimit } from '../../../state/projectLimit'

const AGENT_NODES = `Agent nodes (${BUILTIN_AGENT_IDS.map((id) => AGENT_CONFIG[id].label).join(' / ')})`
const CORE_REST = [
  'Groups, worktrees, git & diff',
  AGENT_NODES,
  'QR phone pairing on your LAN',
  'Remote access from your phone (relay, E2E encrypted)'
]
/** The Core list while the free-tier project limit is off: exactly the copy that shipped before it
 *  existed (and the Server Edition's permanent list — its limit is never on). */
const CORE = ['Unlimited local terminals & canvas', 'Unlimited SSH projects', ...CORE_REST]
const PRO = [
  'nodeterm mobile Pro included',
  '3 team seats included (extra seats $5/seat/mo)',
  'Live links to a terminal: watch, chat, or let people type — viewers need nothing installed',
  'Larger on-device dictation models (base, small, large-v3-turbo)'
]

/** Core vs Pro comparison. While the open-project limit is on, Core must not read "free forever" or
 *  an unqualified "unlimited" (docs/project-limit.md): it names the user's allowance, and Pro gains
 *  unlimited open projects. */
export function ProCompare(): React.JSX.Element {
  const limitState = useProjectLimit((s) => s.state)
  const active = limitState.active
  const core = active
    ? [
        `Up to ${effectiveLimit(limitState)} open projects`,
        'Unlimited terminals & canvas in each project',
        'SSH projects',
        ...CORE_REST
      ]
    : CORE
  const pro = active ? ['Unlimited open projects', ...PRO] : PRO
  return (
    <div className="grid grid-cols-2 gap-4 text-sm">
      <div className="space-y-2">
        <h4 className="text-[13px] font-medium text-muted">{active ? 'Core — free' : 'Core — free forever'}</h4>
        {core.map((f) => (
          <p key={f} className="text-text">
            ✓ {f}
          </p>
        ))}
      </div>
      <div className="space-y-2">
        <h4 className="text-[13px] font-medium" style={{ color: 'var(--accent)' }}>
          Pro
        </h4>
        <p className="text-text">✓ Everything in Core</p>
        {pro.map((f) => (
          <p key={f} className="text-text">
            ✓ {f}
          </p>
        ))}
      </div>
    </div>
  )
}

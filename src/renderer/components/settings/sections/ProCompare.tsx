import { AGENT_CONFIG, BUILTIN_AGENT_IDS } from '@shared/agents/config'

const CORE = [
  'Unlimited local terminals & canvas',
  'Unlimited SSH projects',
  'Groups, worktrees, git & diff',
  `Agent nodes (${BUILTIN_AGENT_IDS.map((id) => AGENT_CONFIG[id].label).join(' / ')})`,
  'QR phone pairing on your LAN',
  'Remote access from your phone (relay, E2E encrypted)'
]
const PRO = [
  'nodeterm mobile Pro included',
  '3 team seats included (extra seats $5/seat/mo)',
  'Live read-only links to a terminal — viewers need nothing installed'
]

/** Core vs Pro comparison. */
export function ProCompare(): React.JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-4 text-sm">
      <div className="space-y-2">
        <h4 className="text-[13px] font-medium text-muted">Core — free forever</h4>
        {CORE.map((f) => (
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
        {PRO.map((f) => (
          <p key={f} className="text-text">
            ✓ {f}
          </p>
        ))}
      </div>
    </div>
  )
}

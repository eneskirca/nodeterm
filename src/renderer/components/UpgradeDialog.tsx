import { createPortal } from 'react-dom'
import { useEntitlement } from '../state/entitlement'
import { useUpgradeGate } from '../state/upgradeGate'
import { thisMachine } from '../lib/machineName'
import { useProjectLimit } from '../state/projectLimit'

/**
 * Pro upgrade prompt shown when a free user triggers a gated feature. Closes automatically
 * once an active entitlement arrives (entitlement onChange flips isPremium).
 */
export function UpgradeDialog() {
  const { open, feature, hide } = useUpgradeGate()
  const isPremium = useEntitlement((s) => s.isPremium)
  const upgrade = useEntitlement((s) => s.upgrade)
  // While the free-tier project limit is on, unlimited open projects is part of what Pro adds
  // (spec §8); while it is off there is no limit to lift, so the sentence does not mention one.
  const limitActive = useProjectLimit((s) => s.state.active)
  if (!open || isPremium) return null
  return createPortal(
    <div className="confirm-overlay" onClick={hide}>
      <div className="confirm" onClick={(e) => e.stopPropagation()}>
        <p className="confirm__msg">{feature} is a Pro feature</p>
        <p className="confirm__msg">
          Pro adds {limitActive ? 'unlimited open projects, ' : ''}live links to a terminal (watch,
          chat, or let people type), 3 team seats to share {thisMachine()}, the larger on-device
          dictation models, and nodeterm mobile Pro. Complete your purchase in the browser — Pro
          unlocks here automatically.
        </p>
        <div className="confirm__actions">
          <button className="confirm__btn" onClick={hide}>
            Maybe later
          </button>
          <button className="confirm__btn primary" autoFocus onClick={() => void upgrade()}>
            Upgrade to Pro — $10/mo
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

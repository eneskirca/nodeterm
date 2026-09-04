// S6 PR 8 — the identity + provenance pills rendered on every Codex account surface (settings,
// node chrome, create/switch menus). Based on @Corvin's #112 (`AccountIdentityPills.tsx`).

import type { AccountPresentation } from '../lib/accountPresentation'
import { IconCheck } from './icons'

/**
 * Renders a presented account as an identity pill + a Local/SSH provenance pill, with an optional
 * "selected" check. The whole cluster shares one native tooltip (the presentation's `tooltip`), so
 * the same account reads identically wherever it appears.
 */
export function AccountIdentityPills({
  account,
  selected = false,
  warning = false,
  className = ''
}: {
  account: AccountPresentation
  selected?: boolean
  warning?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <span
      className={`account-identity-pills${warning ? ' account-identity-pills--warning' : ''}${
        className ? ` ${className}` : ''
      }`}
      title={account.tooltip}
    >
      <span className="account-identity-pill">{account.identity}</span>
      <span className="account-provenance-pill">{account.provenance}</span>
      {selected ? (
        <span className="account-identity-check" aria-label="Selected">
          <IconCheck />
        </span>
      ) : null}
    </span>
  )
}

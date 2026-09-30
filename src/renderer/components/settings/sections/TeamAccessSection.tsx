import { useState } from 'react'
import { useEntitlement } from '../../../state/entitlement'
import { useTeamAccess } from '../../../state/teamAccess'
import { listSeats, usedCount, type SeatEntry } from '../../../state/teamAccessCore'
import { inviteShare, seatFullMessage, teamAccessView } from '../teamAccessView'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Button } from '@renderer/ui/Button'
import { thisMachine } from '@renderer/lib/machineName'
import { CopyButton } from '@renderer/ui/CopyButton'
import { Input } from '@renderer/ui/Input'

const ROWS = {
  team: {
    title: 'Team Access',
    keywords: ['team', 'seat', 'invite', 'share', 'collaborate', 'remote']
  }
}
const ENTRIES = Object.values(ROWS)

function SeatRow({ seat }: { seat: SeatEntry }): React.JSX.Element {
  const label = seat.email?.trim() || 'Teammate'
  const connected = seat.status === 'connected'
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="truncate text-sm text-text">{label}</div>
        <div className="text-xs text-muted">
          {connected ? 'connected' : 'waiting to connect…'}
        </div>
      </div>
      <Button onClick={() => window.nodeTerminal.relayHost.revoke(seat.id)}>Remove</Button>
    </div>
  )
}

export function TeamAccessSection({
  isActive
}: {
  isActive: boolean
  onClose?: () => void
}): React.JSX.Element {
  const ent = useEntitlement()
  const seats = useEntitlement((s) => s.seats)
  const used = useTeamAccess((s) => usedCount(s.seats))
  const seatList = useTeamAccess((s) => listSeats(s.seats))
  const view = teamAccessView({ premium: ent.isPremium, seats, used })

  const [email, setEmail] = useState('')
  const [offer, setOffer] = useState('')
  const [offerEmail, setOfferEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [atCap, setAtCap] = useState(false)
  const [error, setError] = useState('')

  const generateInvite = async () => {
    setError('')
    setAtCap(false)
    setBusy(true)
    const invitedEmail = email.trim()
    try {
      const { offer: code, id } = await window.nodeTerminal.relayHost.invite({
        email: invitedEmail || undefined
      })
      // Show the pending row immediately — the store also flips it to connected on relay:host:open.
      useTeamAccess.getState().addPending(id, invitedEmail || undefined)
      setOffer(code)
      setOfferEmail(invitedEmail)
      setEmail('')
    } catch (err) {
      if (seatFullMessage(err)) setAtCap(true)
      else setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const share = offer ? inviteShare({ offer, email: offerEmail }) : null

  return (
    <SettingsSection
      id="team-access"
      title="Team seats"
      description={`Share ${thisMachine()} with your team — Pro includes 3 seats, extra seats $5/seat/month.`}
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.team}>
        {!view.gated ? (
          <div className="space-y-5">
            {/* Seat counter */}
            <div className="flex items-center justify-between gap-3">
              <div>
                <h4 className="text-[13px] font-medium text-text">Seats</h4>
                <p className="text-sm text-muted">{view.counterText}</p>
                <p className="text-xs text-muted">3 included with Pro · extra seats $5/seat/month</p>
              </div>
              <Button onClick={() => void ent.upgrade('seats')}>Add seats</Button>
            </div>

            {/* Connected devices */}
            <div className="space-y-2">
              <h4 className="text-[13px] font-medium text-text">Connected devices</h4>
              {seatList.length === 0 ? (
                <p className="text-sm text-muted">No teammates connected yet.</p>
              ) : (
                <div className="space-y-2">
                  {seatList.map((seat) => (
                    <SeatRow key={seat.id} seat={seat} />
                  ))}
                </div>
              )}
            </div>

            {/* Invite */}
            <div className="space-y-3">
              <h4 className="text-[13px] font-medium text-text">Invite a teammate</h4>
              <p className="text-sm text-muted">
                A teammate on a seat gets full access to {thisMachine()} as you — every project,
                and commands in any folder — the same as giving them SSH access. Only invite people
                you trust.
              </p>
              <FieldRow
                label="Teammate email"
                control={
                  <Input
                    className="w-72"
                    type="email"
                    placeholder="teammate@example.com (optional)"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                }
              />
              <Button
                variant="primary"
                disabled={busy || !view.canInvite}
                onClick={() => void generateInvite()}
              >
                {busy ? 'Generating…' : 'Generate invite'}
              </Button>
              {!view.canInvite ? (
                <p className="text-sm text-muted">All seats in use — add a seat.</p>
              ) : null}
              {atCap ? (
                <p className="text-sm" style={{ color: 'var(--warn)' }}>
                  All seats in use — add a seat.
                </p>
              ) : null}
              {error ? (
                <p className="text-sm" style={{ color: 'var(--warn)' }}>
                  {error}
                </p>
              ) : null}
              {offer && share ? (
                <div className="space-y-2">
                  <p className="text-sm text-muted">
                    Share this single-use pairing code with{' '}
                    <strong className="text-text">{offerEmail || 'your teammate'}</strong> — they
                    paste it in nodeterm → New Remote Connection:
                  </p>
                  <FieldRow
                    label="Pairing code"
                    control={
                      <Input
                        className="w-72"
                        readOnly
                        value={offer}
                        onFocus={(e) => e.target.select()}
                      />
                    }
                  />
                  <div className="flex gap-2">
                    <CopyButton text={share.copyText} label="Copy" />
                    <Button onClick={() => window.nodeTerminal.shell.openExternal(share.mailtoUrl)}>
                      Open in Mail
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <h4 className="text-[13px] font-medium text-text">
              Upgrade to Pro — 3 collaborator seats included
            </h4>
            <p className="text-sm text-muted">
              Pro comes with 3 seats to share {thisMachine()} with your team. Need more? Extra
              seats are $5/seat/month. Each teammate connects from their own device over the
              end-to-end encrypted relay.
            </p>
            <p className="text-sm text-muted">
              A seat grants full access: a teammate on a seat can run commands on{' '}
              {thisMachine()} as you, in every project — the same as giving them SSH access. Every connection is still
              verified with a one-time pairing code you compare together.
            </p>
            <Button variant="primary" onClick={() => void ent.upgrade()}>
              Upgrade to Pro — get 3 free seats
            </Button>
          </div>
        )}
      </SearchableRow>
    </SettingsSection>
  )
}

import { useEffect, useState } from 'react'
import { IconClose } from './icons'
import { createPortal } from 'react-dom'
import { useDialogStack } from './dialog-stack'
import { useEntitlement } from '../state/entitlement'
import { useProjects } from '../state/projects'
import { hostShareOptions } from '../lib/relayHostShare'
import { thisMachine } from '../lib/machineName'
import { Button } from '@renderer/ui/Button'
import { CopyButton } from '@renderer/ui/CopyButton'
import { Input } from '@renderer/ui/Input'
import { Select } from '@renderer/ui/Select'

/**
 * Remote access dialog — a self-contained popup reachable from the project (tab) caret menu, so
 * remote access isn't buried in Settings. Mirrors the Settings RemoteSection flow over the NEW
 * relay tunnel (`relayHost` / `relayClient`):
 *  - Host "Allow remote access" (Pro): start → show the single-use pairing offer + copy/stop.
 *  - Non-Pro: hosting is gated — show the upgrade popup (Upgrade → Stripe checkout).
 *  - Client "Connect to a host" (free): paste an offer → Canvas runs the SAS-compare + open-tab flow.
 * It deliberately does NOT import RemoteSection (which the Settings redesign owns).
 */
export function RemoteAccessDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const isPremium = useEntitlement((s) => s.isPremium)
  const upgrade = useEntitlement((s) => s.upgrade)
  const projects = useProjects((s) => s.projects)
  const activeProjectId = useProjects((s) => s.activeProjectId)
  const [hostOffer, setHostOffer] = useState('')
  const [hostBusy, setHostBusy] = useState(false)
  const [error, setError] = useState('')
  const [clientCode, setClientCode] = useState('')

  // Which project this host shares with the joiner. Default = the active project (hoisted first
  // by hostShareOptions); the user can pick any other OPEN project before minting the offer.
  const shareOptions = hostShareOptions(projects, activeProjectId)
  const [shareId, setShareId] = useState('')
  const effectiveShareId = shareOptions.some((o) => o.id === shareId)
    ? shareId
    : (shareOptions[0]?.id ?? '')
  const sharedName = shareOptions.find((o) => o.id === effectiveShareId)?.name ?? ''

  // Only the topmost modal answers a key (./dialog-stack) — the host approval ConfirmDialog opens
  // on top of THIS dialog, and its Escape must not also close the one underneath.
  const isTop = useDialogStack()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isTop()) return
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isTop, onClose])

  // HOST side — the NEW relay tunnel (`relayHost`). `start()` returns the single-use pairing offer;
  // a connecting peer's approval + canvas sync are handled globally by Canvas (`relayHost.onPeerPending`
  // / `relayHost.confirm`, and the CorePlatform seq-stamped reflector).
  const startHosting = async () => {
    setError('')
    setHostBusy(true)
    try {
      const { offer } = await window.nodeTerminal.relayHost.start(effectiveShareId || undefined)
      setHostOffer(offer)
    } catch (err) {
      setError((err as Error).message)
      setHostBusy(false)
    }
  }
  const stopHosting = async () => {
    await window.nodeTerminal.relayHost.stop()
    setHostOffer('')
    setHostBusy(false)
  }
  // CLIENT side — hand the offer to Canvas, which runs the relay connect → SAS compare (window.confirm)
  // → open-tab flow (the same `connectOffer` the dock/palette entry uses). No `relayClient.connect`
  // here, so the SAS handshake lives in exactly one place.
  const connect = () => {
    const code = clientCode.trim()
    if (!code) return
    setClientCode('')
    window.dispatchEvent(
      new CustomEvent('nodeterm:open-remote-terminal', { detail: { offer: code } })
    )
    onClose()
  }

  return createPortal(
    <div className="confirm-overlay" onClick={onClose}>
      <div className="remote-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="remote-dialog__head">
          <h3>Remote access</h3>
          <button className="remote-dialog__x" onClick={onClose} title="Close">
            <IconClose />
          </button>
        </div>
        <p className="remote-dialog__desc">
          Open terminals that run on another machine you own — end-to-end encrypted over the relay.
          Hosting (sharing this machine) is Pro; connecting to a host is free.
        </p>

        <h4 className="remote-dialog__head4">Allow remote access</h4>
        {isPremium ? (
          hostOffer ? (
            <div className="remote-dialog__block">
              <p className="remote-dialog__hint">
                Sharing <strong>{sharedName || 'this project'}</strong> — the joiner will see this
                project and can run commands on {thisMachine()}. Share this pairing code (single
                use):
              </p>
              <Input
                className="w-full"
                readOnly
                value={hostOffer}
                onFocus={(e) => e.target.select()}
              />
              <div className="remote-dialog__row">
                <CopyButton text={hostOffer} label="Copy code" />
                <Button onClick={() => void stopHosting()}>Stop sharing</Button>
              </div>
            </div>
          ) : (
            <div className="remote-dialog__block">
              {shareOptions.length > 1 ? (
                <label className="remote-dialog__hint">
                  Project to share
                  <Select
                    className="w-full mt-1"
                    value={effectiveShareId}
                    onChange={(e) => setShareId(e.target.value)}
                  >
                    {shareOptions.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </Select>
                </label>
              ) : (
                <p className="remote-dialog__hint">
                  Sharing <strong>{sharedName || 'this project'}</strong> — the joiner sees this
                  project and can run commands on {thisMachine()}.
                </p>
              )}
              <Button disabled={hostBusy} onClick={() => void startHosting()}>
                {hostBusy ? 'Starting…' : 'Allow remote access'}
              </Button>
            </div>
          )
        ) : (
          <div className="remote-dialog__block">
            <p className="remote-dialog__hint">
              Sharing this machine requires nodeterm Pro. Connecting to a host you were given a code
              for is free.
            </p>
            <Button onClick={() => void upgrade()}>Upgrade to Pro — $10/mo</Button>
          </div>
        )}

        <h4 className="remote-dialog__head4">Connect to a host</h4>
        <div className="remote-dialog__block">
          <Input
            className="w-full"
            placeholder="paste the host's code"
            value={clientCode}
            onChange={(e) => setClientCode(e.target.value)}
          />
          <Button disabled={!clientCode.trim()} onClick={connect}>
            Connect
          </Button>
        </div>

        {error ? <p className="remote-dialog__err">{error}</p> : null}
      </div>
    </div>,
    document.body
  )
}

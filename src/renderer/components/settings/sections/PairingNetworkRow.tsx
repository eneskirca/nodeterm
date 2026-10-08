import { useEffect, useRef, useState } from 'react'
import type { PairingNetworkChoice } from '@shared/pairing-network'
import { useSettings } from '@renderer/state/settings'
import { Select } from '@renderer/ui/Select'
import { Button } from '@renderer/ui/Button'

/** This preference belongs to the computer, and follows an adapter rather than a DHCP address. */
export function PairingNetworkRow({
  isActive, pairingBusy, waiting, stopPairing, restartPairing
}: {
  isActive: boolean
  pairingBusy: boolean
  waiting: boolean
  stopPairing: () => void
  restartPairing: () => Promise<void>
}): React.JSX.Element | null {
  const selected = useSettings((state) => state.settings.phonePairingInterface)
  const [choices, setChoices] = useState<PairingNetworkChoice[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [unsupported, setUnsupported] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState<{ interfaceName: string; restart: boolean } | null>(null)
  const stop = useRef(stopPairing)
  stop.current = stopPairing
  const current = useRef({ active: isActive, generation: 0, saving: false })
  current.current.active = isActive

  const refresh = async (generation: number): Promise<void> => {
    setLoading(true)
    try {
      const next = await window.nodeTerminal.pairing.listNetworks()
      if (!current.current.active || current.current.generation !== generation) return
      setChoices(next)
      setUnsupported(false)
      setError('')
    } catch (cause) {
      if (!current.current.active || current.current.generation !== generation) return
      if ((cause as { code?: string })?.code === 'E_UNSUPPORTED') setUnsupported(true)
      else setError('Could not read the computer’s networks. Refresh to try again.')
    } finally {
      if (current.current.active && current.current.generation === generation) setLoading(false)
    }
  }

  useEffect(() => {
    current.current.active = isActive
    const generation = ++current.current.generation
    current.current.saving = false
    setSaving(false)
    setRetry(null)
    if (isActive) void refresh(generation)
    return () => {
      current.current.active = false
      current.current.generation++
      // PhoneSection's hook can outlive this row (Settings search/section filtering).
      // Its owner guard retires our hidden listener without stopping another pairing view.
      stop.current()
    }
  }, [isActive])

  const saveChoice = async (interfaceName: string, restart: boolean): Promise<void> => {
    if (current.current.saving || pairingBusy || !current.current.active) return
    const generation = ++current.current.generation
    current.current.saving = true
    setSaving(true)
    setRetry(null)
    setError('')
    // An old QR is tied to the prior address: hide/retire it before waiting for the save.
    if (restart) stopPairing()
    useSettings.getState().update({ phonePairingInterface: interfaceName })
    try {
      await useSettings.getState().flush()
      if (!current.current.active || current.current.generation !== generation) return
      if (restart) await restartPairing()
      if (current.current.active && current.current.generation === generation) await refresh(generation)
    } catch {
      if (current.current.active && current.current.generation === generation) {
        setError('Could not save the pairing network. No new code was started. Retry the save or choose another network.')
        setRetry({ interfaceName, restart })
      }
    } finally {
      if (current.current.active && current.current.generation === generation) {
        current.current.saving = false
        setSaving(false)
      }
    }
  }

  // The browser Server shell deliberately does not implement host pairing/adapter control.
  if (unsupported) return null
  const unavailable = !!selected && !choices.some((choice) => choice.interfaceName === selected)
  return (
    <div className="space-y-2">
      <label className="block text-[13px] font-medium text-text" htmlFor="phone-pairing-network">Pairing network</label>
      <div className="flex flex-wrap items-center gap-2">
        <Select id="phone-pairing-network" value={selected ?? ''} disabled={saving || pairingBusy || loading}
          onChange={(event) => void saveChoice(event.target.value, waiting)}>
          <option value="">Automatic</option>
          {unavailable ? <option value={selected}>{selected} — unavailable</option> : null}
          {choices.map((choice) => <option key={choice.interfaceName} value={choice.interfaceName}>
            {choice.interfaceName} — {choice.address}
          </option>)}
        </Select>
        <Button disabled={saving || pairingBusy || loading} onClick={() => void refresh(current.current.generation)}>Refresh networks</Button>
        {retry ? <Button disabled={saving || pairingBusy || loading}
          onClick={() => void saveChoice(retry.interfaceName, retry.restart)}>Retry save</Button> : null}
      </div>
      <p className="text-xs text-muted">Automatic prefers a LAN adapter. Select your VPN or another adapter when needed. These are current addresses, not a test of whether your phone can reach them.</p>
      {unavailable && !loading ? <p className="text-sm" style={{ color: 'var(--warn)' }}>The selected network has no current IPv4 address. No pairing address will be substituted; reconnect it or choose another network.</p> : null}
      {error ? <p role="alert" className="text-sm" style={{ color: 'var(--warn)' }}>{error}</p> : null}
    </div>
  )
}

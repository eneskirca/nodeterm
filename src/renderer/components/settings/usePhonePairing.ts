import { useEffect, useRef, useState } from 'react'
import { toDataURL } from 'qrcode'
import { DEFAULT_PAIR_QR_FORM, encodePairQr, type PairQrForm } from '@shared/pair-qr'

export type PairingPhase = 'idle' | 'waiting' | 'paired' | 'timeout'

/** How often the Remote Login warning re-probes sshd while it is showing. */
const SSH_RECHECK_MS = 2000

/**
 * The phone-pairing state machine, shared by Settings → Phone and the quick-pair popover:
 * start/stop, the QR data URL, the completion event, and the live Remote-Login (sshd) re-probe
 * while the warning is visible. Any in-flight pairing is stopped when the OWNING view unmounts —
 * both hosts are transient surfaces, and a headless listener would silently pair whoever scans a
 * QR that is no longer on screen.
 */
export function usePhonePairing(onPaired?: () => void): {
  phase: PairingPhase
  qr: string
  /** Which envelope the QR on screen encodes. Switching it re-renders the SAME live token —
   *  it never restarts pairing (eneskirca/nodeterm#745). */
  qrForm: PairQrForm
  setQrForm: (form: PairQrForm) => void
  sshOpen: boolean
  sshHealed: boolean
  /** On phase 'paired': whether the pairing came with a relay leg ('off' = toggle disabled,
   *  'failed' = mint failed → LAN-only). Surfaced so the silent degrade is visible at the one
   *  moment the user is looking. */
  relayResult: 'ok' | 'off' | 'failed' | 'dev' | null
  /** While 'waiting': what the QR on screen WILL mint — lets the surfaces warn beside the QR
   *  (esp. 'dev': unpackaged build, relay off regardless of the toggle). */
  relayPlan: 'ok' | 'dev' | 'off' | null
  error: string
  busy: boolean
  start: () => Promise<void>
  stop: () => void
  reset: () => void
} {
  const [phase, setPhase] = useState<PairingPhase>('idle')
  const [qr, setQr] = useState('')
  // The built payload JSON, kept so the QR can be re-encoded in the other envelope without
  // minting a new token — the listener on the other end is keyed to THIS one.
  const [payload, setPayload] = useState('')
  const [qrForm, setQrForm] = useState<PairQrForm>(DEFAULT_PAIR_QR_FORM)
  const [sshOpen, setSshOpen] = useState(true)
  // Went from unreachable → reachable while the warning was showing: show a green confirmation
  // instead of silently dropping the warning (the user just flipped a toggle; acknowledge it).
  const [sshHealed, setSshHealed] = useState(false)
  const [relayResult, setRelayResult] = useState<'ok' | 'off' | 'failed' | 'dev' | null>(null)
  const [relayPlan, setRelayPlan] = useState<'ok' | 'dev' | 'off' | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // Track whether a pairing listener is currently running so unmount can stop it.
  const runningRef = useRef(false)

  // Live re-check while the Remote Login warning is visible: the initial probe runs once at
  // pairing start, so without this the warning could never clear — the user enables Remote Login
  // in System Settings and nothing changes on screen. Poll only in that exact state (waiting +
  // unreachable); the interval dies with the warning.
  useEffect(() => {
    if (phase !== 'waiting' || sshOpen) return
    let cancelled = false
    const timer = setInterval(() => {
      void window.nodeTerminal.pairing
        .probeSsh()
        .then((open) => {
          if (!cancelled && open) {
            setSshOpen(true)
            setSshHealed(true)
          }
        })
        .catch(() => {
          // transient probe error: keep the warning, try again on the next tick
        })
    }, SSH_RECHECK_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [phase, sshOpen])

  const start = async (): Promise<void> => {
    setError('')
    setBusy(true)
    try {
      const { payload: built, sshOpen: open, relayPlan: plan } = await window.nodeTerminal.pairing.start()
      setRelayPlan(plan ?? null)
      // The image itself is rendered by the effect below, which also handles a later switch
      // between the JSON and URL envelopes.
      setPayload(built)
      setSshOpen(open)
      setSshHealed(false)
      setRelayResult(null)
      setPhase('waiting')
      runningRef.current = true
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // Render the QR for whatever payload + envelope is current. Re-runs when the user switches
  // envelope, which is deliberately NOT a restart: same token, same listener, different
  // encoding of the same bytes.
  useEffect(() => {
    if (!payload) {
      setQr('')
      return
    }
    let cancelled = false
    void toDataURL(encodePairQr(payload, qrForm), { margin: 1, width: 240 })
      .then((dataUrl) => {
        if (!cancelled) setQr(dataUrl)
      })
      .catch(() => {
        // Keep whatever image is already up; the pairing listener is unaffected by a render
        // failure, and a blank QR with no explanation is the failure mode #745 was about.
      })
    return () => {
      cancelled = true
    }
  }, [payload, qrForm])

  const stop = (): void => {
    if (runningRef.current) {
      runningRef.current = false
      void window.nodeTerminal.pairing.stop()
    }
    setPhase('idle')
    setPayload('')
    setQr('')
  }

  // Subscribe to the completion event; drives paired/timeout state. `onPaired` rides a ref so
  // a re-rendered callback never resubscribes the event.
  const onPairedRef = useRef(onPaired)
  onPairedRef.current = onPaired
  useEffect(() => {
    return window.nodeTerminal.pairing.onDone((result) => {
      runningRef.current = false
      setPayload('')
      setQr('')
      setPhase(result.ok ? 'paired' : 'timeout')
      setRelayResult(result.ok ? (result.relay ?? null) : null)
      if (result.ok) onPairedRef.current?.()
    })
  }, [])

  // Stop any in-flight pairing when the owning view unmounts (closed / navigated away).
  useEffect(() => {
    return () => {
      if (runningRef.current) {
        runningRef.current = false
        void window.nodeTerminal.pairing.stop()
      }
    }
  }, [])

  return {
    phase,
    qr,
    qrForm,
    setQrForm,
    sshOpen,
    sshHealed,
    relayResult,
    relayPlan,
    error,
    busy,
    start,
    stop,
    reset: () => setPhase('idle')
  }
}

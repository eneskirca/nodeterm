import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Switch } from '@renderer/ui/Switch'
import { useSettings } from '@renderer/state/settings'
import { usePhonePairing } from './settings/usePhonePairing'
import { IOS_APP_STORE_URL } from '@renderer/lib/links'

const isMac = /Mac/i.test(navigator.platform || navigator.userAgent)

/**
 * Quick phone pairing, anchored under the top-right phone button: opens straight into a live QR
 * (no "Start pairing" click — that's the whole point of the shortcut), with the standing
 * "Reach this Mac from anywhere" toggle below and a link into the full Phone settings.
 * Closing the popover stops an unfinished pairing (the shared hook's unmount rule).
 */
export function PhonePairPopover({
  anchor,
  onClose,
  onOpenSettings
}: {
  /** Viewport rect of the phone button — the popover right-aligns under it. */
  anchor: { right: number; bottom: number }
  onClose: () => void
  onOpenSettings: () => void
}): React.JSX.Element {
  const { phase, qr, sshOpen, sshHealed, relayResult, relayPlan, error, busy, start } = usePhonePairing()

  const phoneAccessEnabled = useSettings((s) => s.settings.phoneAccessEnabled)
  const updateSettings = useSettings((s) => s.update)

  const togglePhoneAccess = (next: boolean): void => {
    updateSettings({ phoneAccessEnabled: next })
    // Start/stop the standing relay host immediately.
    window.nodeTerminal.remoteHost.setPhoneAccess(next)
    // The relay block is baked into the QR when the listener STARTS — a code already on
    // screen doesn't know about this flip, and scanning it would still produce a LAN-only
    // pairing (the field failure: works at home, dies on cellular). Regenerate; start()
    // cancels the old listener silently.
    if (phase === 'waiting') void start()
  }

  // Straight into the QR on open (local-network pairing is free — no gate here).
  useEffect(() => {
    void start()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run exactly once, on open
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <>
      <div className="phone-pair__backdrop" onClick={onClose} />
      <div
        className="phone-pair"
        style={{ top: anchor.bottom + 8, right: Math.max(8, window.innerWidth - anchor.right) }}
        role="dialog"
        aria-label="Pair phone"
      >
        <div className="phone-pair__title">Pair your phone</div>

        {phase === 'waiting' && qr ? (
          !sshOpen ? (
            // No QR while Remote Login is off — pairing against an unreachable sshd installs a
            // key the phone can never use. The live probe flips sshOpen and the QR appears.
            <div className="phone-pair__warn">
              <strong>Remote Login</strong> is off — the pairing QR appears the moment it is on
              {isMac ? (
                <>
                  {' '}
                  (
                  <button
                    className="phone-pair__link"
                    onClick={() => void window.nodeTerminal.pairing.openRemoteLoginSettings()}
                  >
                    System Settings
                  </button>
                  &nbsp;— watching).
                </>
              ) : (
                '.'
              )}
            </div>
          ) : (
            <>
              <img src={qr} width={208} height={208} alt="Pairing QR code" className="phone-pair__qr" />
              <div className="phone-pair__hint">Scan with the nodeterm iOS app · waiting (10 min)</div>
              {relayPlan === 'dev' ? (
                <div className="phone-pair__warn">
                  Dev build: the relay is off regardless of the toggle, so this code pairs
                  LAN-only. Run a packaged build — or set NODETERM_RELAY_URL — for remote access.
                </div>
              ) : !phoneAccessEnabled ? (
                <div className="phone-pair__warn">
                  LAN-only code: the phone will reach this Mac only on this network. Flip the
                  toggle below first to also connect from anywhere — the QR refreshes by itself.
                </div>
              ) : null}
              {sshHealed ? <div className="phone-pair__ok">✓ Remote Login is on.</div> : null}
            </>
          )
        ) : phase === 'paired' ? (
          <>
            <div className="phone-pair__ok">✓ Paired — your phone can now connect.</div>
            {relayResult === 'ok' ? (
              <div className="phone-pair__ok">Remote access is set up — reachable from anywhere.</div>
            ) : relayResult === 'failed' ? (
              <div className="phone-pair__warn">
                ⚠ Remote-access setup failed — this pairing is LAN-only for now. Check the
                internet connection and pair again to retry.
              </div>
            ) : relayResult === 'off' ? (
              <div className="phone-pair__hint">LAN-only pairing — remote access is off.</div>
            ) : relayResult === 'dev' ? (
              <div className="phone-pair__hint">
                LAN-only pairing — dev builds disable the relay (set NODETERM_RELAY_URL to test).
              </div>
            ) : null}
          </>
        ) : phase === 'timeout' ? (
          <>
            <div className="phone-pair__hint">Pairing timed out.</div>
            <button className="phone-pair__btn" disabled={busy} onClick={() => void start()}>
              Show a new code
            </button>
          </>
        ) : (
          <div className="phone-pair__hint">{busy ? 'Starting…' : error || 'Starting…'}</div>
        )}
        {error && phase !== 'idle' ? <div className="phone-pair__warn">{error}</div> : null}

        <div className="phone-pair__divider" />

        <div className="phone-pair__row">
          <div className="phone-pair__row-text">
            <div className="phone-pair__row-title">Reach this Mac from anywhere</div>
            <div className="phone-pair__row-sub">E2E encrypted over the relay — not just your LAN.</div>
          </div>
          <Switch
            checked={phoneAccessEnabled}
            onChange={togglePhoneAccess}
            ariaLabel="Reach this Mac from anywhere"
          />
        </div>

        <button
          className="phone-pair__link phone-pair__footer"
          onClick={() => window.nodeTerminal.shell.openExternal(IOS_APP_STORE_URL)}
        >
          Get the nodeterm iOS app ↗
        </button>
        <button className="phone-pair__link phone-pair__footer" onClick={onOpenSettings}>
          All phone settings…
        </button>
      </div>
    </>,
    document.body
  )
}

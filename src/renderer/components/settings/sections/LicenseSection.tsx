import { useEffect, useState } from 'react'
import { useEntitlement } from '../../../state/entitlement'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { ConfirmDialog } from '../../ConfirmDialog'
import { ProCompare } from './ProCompare'
import { Button } from '@renderer/ui/Button'
import { machineNoun, otherMachines, thisMachine } from '@renderer/lib/machineName'
import { isBrowserRuntime } from '@renderer/bridge/runtime'
import type { SettingsSectionId } from '../nav'
import { Input } from '@renderer/ui/Input'
import {
  licenseSentence,
  proStatusLine,
  canReleaseDevices,
  canUseKeyElsewhere,
  releaseFailureSentence,
  activationErrorSentence
} from '@renderer/lib/licenseCopy'

/** How long the Copy button reports success before returning to its label. */
const COPIED_MS = 1600

const ROWS = {
  license: {
    title: 'License',
    keywords: [
      'pro',
      'upgrade',
      'license',
      'key',
      'subscription',
      'activate',
      'compare',
      'core',
      'remote access',
      'quota',
      'devices',
      'seats',
      'release',
      'copy key',
      'app store',
      'iphone',
      'pairing'
    ]
  }
}
const ENTRIES = Object.values(ROWS)

// Pairing can expose an existing entitlement; it cannot repair a purchase without a linked
// phone identity (nodeterm-ios#31). Keep the same qualification beside both purchase routes.
function AppStorePairingHint(): React.JSX.Element {
  return (
    <p className="text-sm text-muted">
      Already have Pro from the App Store? Pairing the phone with that subscription can unlock Pro
      in the desktop app without a license key.{' '}
      {isBrowserRuntime()
        ? 'In the desktop app, open Settings → Phone to pair. Server Edition does not support this activation route. '
        : 'Open Settings → Phone to pair. '}
      Some purchases cannot be linked by pairing; if Pro stays inactive, contact support before
      buying again.
    </p>
  )
}

export function LicenseSection({
  isActive,
  onNavigate
}: {
  isActive: boolean
  onNavigate: (id: SettingsSectionId) => void
}): React.JSX.Element {
  const ent = useEntitlement()
  const [licenseKey, setLicenseKey] = useState('')
  const [upgrading, setUpgrading] = useState(false)
  const [releasing, setReleasing] = useState(false)
  const [copied, setCopied] = useState(false)
  const [confirming, setConfirming] = useState<'release' | 'deactivate' | null>(null)
  // The reason code of a release that did not land — NOT a boolean, and NOT merged into `detail`:
  // "offline" and "this machine is not authorized" owe the user different sentences, and neither of
  // them is a statement about the license the panel is displaying. See `releaseFailureSentence`.
  const [releaseError, setReleaseError] = useState<string | null>(null)
  // `loadDetail` REJECTS on the Server Edition (`E_UNSUPPORTED` — there is no license layer in
  // src/server), and the store deliberately does not swallow it. Catching here is not optional:
  // uncaught, this is an unhandled rejection on every browser session. And what we show there is
  // NOTHING — a read that could not run is not "no key, 0 devices".
  const [detailUnavailable, setDetailUnavailable] = useState(false)
  useEffect(() => {
    if (!ent.isPremium) return
    void ent.loadDetail().catch(() => setDetailUnavailable(true))
    // `ent.loadDetail` is a stable zustand action; the entitlement becoming premium is the event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ent.isPremium])

  // The receipt yields to a clipboard FAILURE. Only the browser build can fail (the desktop
  // preload writes synchronously and cannot), and it reports that as a `nodeterm:toast` error
  // banner — a green "Copied" beside a red banner is the app contradicting itself in one glance.
  // Same rule as the terminal's copy pill (`terminal/useCopyFeedback.ts`).
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_MS)
    const onToast = (e: Event): void => {
      if ((e as CustomEvent<{ kind?: string }>).detail?.kind === 'error') setCopied(false)
    }
    window.addEventListener('nodeterm:toast', onToast)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('nodeterm:toast', onToast)
    }
  }, [copied])

  const detail = detailUnavailable ? null : ent.detail
  const sentence = licenseSentence(detail)
  const releaseNote = releaseFailureSentence(releaseError)
  // Read out here, not off `detail` inside the click handler: TypeScript drops a property
  // narrowing at a closure boundary, and the key must not be re-read at click time anyway.
  const keyOnFile = detail?.key ?? null

  const runRelease = (): void => {
    setConfirming(null)
    setReleasing(true)
    setReleaseError(null)
    void ent
      .releaseOthers()
      // Resolves to null when the release landed (or was refused on terms the sentence above
      // already carries), else the reason code. Same uncaught-rejection rule as `loadDetail` —
      // plus an IPC failure here would otherwise leave the button stuck on "Releasing…". A
      // rejection is not a code, so it takes the "we do not know what happened" branch.
      .then((code) => setReleaseError(code))
      .catch(() => setReleaseError('unknown'))
      .finally(() => setReleasing(false))
  }
  return (
    <SettingsSection
      id="license"
      title="License"
      description="Manage your nodeterm Pro subscription."
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.license}>
        {ent.isPremium ? (
          <div className="space-y-3">
            <ProCompare />
            <p className="text-sm text-muted">{proStatusLine(ent.status)}</p>
            {detail ? (
              <>
                {/* No key ⇒ no field. A row reading "not available" beside a sentence saying there
                    IS no key (an App Store subscription, a failed read) contradicts itself on the
                    first screen those users ever see — "not available" means "exists, could not be
                    fetched". The sentence below is the whole story in every keyless case. */}
                {keyOnFile ? (
                  <FieldRow
                    label="License key"
                    control={
                      <div className="flex items-center gap-2">
                        <Input className="w-64" readOnly value={keyOnFile} />
                        <Button
                          onClick={() => {
                            // The app's own clipboard channel, not `navigator.clipboard`: it
                            // returns void (no unhandled rejection) and the browser bridge raises
                            // its own error banner when a copy cannot happen.
                            window.nodeTerminal.clipboard.writeText(keyOnFile)
                            setCopied(true)
                          }}
                        >
                          {copied ? 'Copied' : 'Copy'}
                        </Button>
                      </div>
                    }
                  />
                ) : null}
                {sentence ? <p className="text-sm text-muted">{sentence}</p> : null}
                {canUseKeyElsewhere(detail) ? (
                  <p className="text-sm text-muted">
                    To use Pro on another {machineNoun()}, open Settings → License there and paste
                    this key.
                  </p>
                ) : null}
                {canReleaseDevices(detail) ? (
                  <div className="space-y-2">
                    <Button disabled={releasing} onClick={() => setConfirming('release')}>
                      {releasing ? 'Releasing…' : 'Release other devices'}
                    </Button>
                    {releaseNote ? (
                      <p className="text-sm" style={{ color: '#ff9f0a' }}>
                        {releaseNote}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}
            <Button onClick={() => setConfirming('deactivate')}>Deactivate on this device</Button>
          </div>
        ) : (
          <div className="space-y-3">
            <ProCompare />
            <AppStorePairingHint />
            {!isBrowserRuntime() ? (
              <Button onClick={() => onNavigate('phone')}>Open Settings → Phone</Button>
            ) : null}
            <Button
              variant="primary"
              onClick={() => {
                setUpgrading(true)
                void ent.upgrade()
              }}
            >
              Upgrade to Pro — $10/mo
            </Button>
            <p className="text-sm text-muted">
              {upgrading
                ? 'Complete your purchase in the browser — Pro unlocks here automatically.'
                : 'Unlock Pro features.'}
            </p>
            <details>
              <summary className="cursor-pointer text-sm text-muted">Have a license key?</summary>
              <div className="mt-3 space-y-2">
                <AppStorePairingHint />
                <FieldRow
                  label="License key"
                  control={
                    <Input
                      className="w-64"
                      placeholder="paste your key"
                      value={licenseKey}
                      onChange={(e) => setLicenseKey(e.target.value)}
                    />
                  }
                />
                <Button
                  onClick={() => {
                    if (licenseKey.trim()) void ent.activate(licenseKey.trim())
                  }}
                >
                  Activate
                </Button>
                {/* The server's reason code is never rendered raw. A buyer at the device cap is
                    exactly who this screen exists for, and `Could not activate (seat_limit).` is
                    a dead end: the word is unsearchable and names no way out. */}
                {ent.status.error ? (
                  <p className="text-sm" style={{ color: '#ff9f0a' }}>
                    {activationErrorSentence(ent.status.error)}
                  </p>
                ) : null}
              </div>
            </details>
          </div>
        )}
      </SearchableRow>

      {/* Both actions are destructive, one-click and hard to undo, so both are confirmed — the
          house pattern (a single phone revoke gets a ConfirmDialog; these are larger). */}
      {confirming === 'release' ? (
        <ConfirmDialog
          message={`Release every other device on this license? Your ${otherMachines()} and every paired phone lose Pro until they are activated again — ${thisMachine()} keeps it. Devices can only be released once every 30 days.`}
          confirmLabel="Release others"
          onConfirm={runRelease}
          onCancel={() => setConfirming(null)}
        />
      ) : null}
      {confirming === 'deactivate' ? (
        <ConfirmDialog
          // Deactivating clears the stored entitlement, and with it the only in-app copy of the
          // key: the detail read that produced it needs that entitlement to authorize. Without
          // this sentence the buyer is back in the support queue this whole screen exists to end.
          message={
            keyOnFile
              ? `Deactivate Pro on ${thisMachine()}? Copy your license key first — it is shown here only while Pro is active, and you need it to activate again.`
              : `Deactivate Pro on ${thisMachine()}? Pro features stop here until this device is activated again.`
          }
          confirmLabel="Deactivate"
          onConfirm={() => {
            setConfirming(null)
            void ent.deactivate()
          }}
          onCancel={() => setConfirming(null)}
        />
      ) : null}
    </SettingsSection>
  )
}

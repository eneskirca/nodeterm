import { useCallback, useEffect, useState } from 'react'
import { Button } from '@renderer/ui/Button'
import { ConfirmDialog } from '../../ConfirmDialog'
import {
  PUSH_WEBHOOK_BODY_MAX,
  PUSH_WEBHOOK_TITLE_MAX,
  PUSH_WEBHOOK_TOKEN_ENV,
  pushWebhookCurlExample,
  pushWebhookErrorText,
  pushWebhookPowerShellExample,
  type PushWebhookResult,
  type PushWebhookError,
  type PushWebhookTokenInfo
} from '@shared/push-webhook'

/**
 * The last status answer, kept across REMOUNTS. Settings search unmounts and remounts every row it
 * filters, and each mount used to cost a challenge + status round trip against a per-IP budget
 * that everyone behind one NAT shares. An answer is reused for STATUS_REUSE_MS; a mint or revoke
 * replaces it with what that call returned. It never holds the token — only what status reports.
 */
const STATUS_REUSE_MS = 5 * 60_000
let lastStatus: { at: number; result: PushWebhookResult<PushWebhookTokenInfo | null> } | null = null

/** Test seam: forget the cached status. */
export function resetPushWebhookStatusCache(): void {
  lastStatus = null
}

function remember(result: PushWebhookResult<PushWebhookTokenInfo | null>): void {
  lastStatus = { at: Date.now(), result }
}

function formatWhen(iso: string | null): string {
  if (!iso) return 'never'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 'unknown'
  return new Date(t).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/**
 * Settings → Phone → Push webhook. A script or CI job POSTs to one URL with a bearer token and the
 * paired phone rings. The token is shown exactly once, right after it is minted, and held only in
 * this component's state until the user dismisses it — it is never written to settings, storage
 * or logs (the backend keeps only its hash, and there is no way to show it again: rotate instead).
 */
export function PushWebhookPanel(): React.JSX.Element {
  const api = window.nodeTerminal.pairing
  const cached = lastStatus && Date.now() - lastStatus.at < STATUS_REUSE_MS ? lastStatus.result : null
  const [loading, setLoading] = useState(cached === null)
  const [info, setInfo] = useState<PushWebhookTokenInfo | null>(cached?.ok ? cached.value : null)
  const [error, setError] = useState<PushWebhookError | null>(cached && !cached.ok ? cached.error : null)
  const [busy, setBusy] = useState(false)
  const [revealed, setRevealed] = useState<string | null>(null)
  const [copied, setCopied] = useState<'token' | 'sh' | 'powershell' | null>(null)
  const [confirm, setConfirm] = useState<'rotate' | 'revoke' | null>(null)
  const [endpoint, setEndpoint] = useState<string | undefined>(undefined)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const r = await api.webhookStatus()
      remember(r)
      if (r.ok) {
        setInfo(r.value)
        setError(null)
      } else setError(r.error)
    } catch {
      setError('unreachable')
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    // A remount inside the reuse window shows the remembered answer and asks nothing. The main
    // process also refuses to call out at all while no phone is paired (core/push-webhook.ts).
    if (!lastStatus || Date.now() - lastStatus.at >= STATUS_REUSE_MS) void refresh()
    api.webhookEndpoint().then(setEndpoint, () => undefined)
  }, [api, refresh])

  const mint = async (): Promise<void> => {
    setConfirm(null)
    setBusy(true)
    setCopied(null)
    try {
      const r = await api.webhookMint()
      if (r.ok) {
        const { token, ...rest } = r.value
        setRevealed(token)
        setInfo(rest)
        remember({ ok: true, value: rest })
        setError(null)
      } else setError(r.error)
    } catch {
      setError('unreachable')
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (): Promise<void> => {
    setConfirm(null)
    setBusy(true)
    try {
      const r = await api.webhookRevoke()
      if (r.ok) {
        setInfo(null)
        setRevealed(null)
        remember({ ok: true, value: null })
        setError(null)
      } else setError(r.error)
    } catch {
      setError('unreachable')
    } finally {
      setBusy(false)
    }
  }

  const copy = (text: string, what: 'token' | 'sh' | 'powershell'): void => {
    window.nodeTerminal.clipboard.writeText(text)
    setCopied(what)
  }

  const examples = [
    { id: 'sh' as const, label: 'sh (macOS, Linux, CI)', text: pushWebhookCurlExample(endpoint) },
    { id: 'powershell' as const, label: 'PowerShell (Windows)', text: pushWebhookPowerShellExample(endpoint) }
  ]

  return (
    <div className="space-y-3">
      <h4 className="text-[13px] font-medium text-text">Push webhook</h4>
      <p className="text-sm text-muted">
        Let a script, a CI job or a long build ring your phone when it finishes. It sends a plain
        text notification to the phones paired with this machine, marked as coming from a webhook —
        not from an agent. Title up to {PUSH_WEBHOOK_TITLE_MAX} characters, body up to{' '}
        {PUSH_WEBHOOK_BODY_MAX}; links are not opened.
      </p>

      {loading ? <p className="text-sm text-muted">Checking…</p> : null}

      {revealed ? (
        <div
          className="space-y-2 rounded-md border border-border px-3 py-2"
          data-testid="webhook-token-reveal"
        >
          <p className="text-sm font-medium text-text">
            Copy this token now — it won’t be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-bg px-2 py-1 font-mono text-[12px] text-text">
              {revealed}
            </code>
            <Button onClick={() => copy(revealed, 'token')}>
              {copied === 'token' ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <p className="text-xs text-muted">
            Store it as a secret named <code>{PUSH_WEBHOOK_TOKEN_ENV}</code> in your CI or shell
            environment. Anyone with it can send notifications to your phone.
          </p>
          <Button onClick={() => setRevealed(null)}>Done</Button>
        </div>
      ) : null}

      {!loading && !revealed ? (
        info ? (
          <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
            <div className="min-w-0">
              <div className="truncate font-mono text-sm text-text">{info.tokenPrefix}…</div>
              <div className="text-[12px] text-muted">
                Created {formatWhen(info.createdAt)} · Last used {formatWhen(info.lastUsedAt)}
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button disabled={busy} onClick={() => setConfirm('rotate')}>
                Rotate
              </Button>
              <Button disabled={busy} onClick={() => setConfirm('revoke')}>
                Revoke
              </Button>
            </div>
          </div>
        ) : error === null ? (
          <Button variant="primary" disabled={busy} onClick={() => void mint()}>
            {busy ? 'Creating…' : 'Create webhook token'}
          </Button>
        ) : null
      ) : null}

      {error ? (
        <div className="space-y-2">
          <p className="text-sm" style={{ color: 'var(--warn)' }}>
            {pushWebhookErrorText(error)}
          </p>
          <Button disabled={busy} onClick={() => void refresh()}>
            Retry
          </Button>
        </div>
      ) : null}

      {info || revealed ? (
        <div className="space-y-2">
          <p className="text-xs text-muted">
            Examples read the token from ${PUSH_WEBHOOK_TOKEN_ENV}, so it never appears on a
            command line.
          </p>
          {examples.map((ex) => (
            <div key={ex.id} className="space-y-1" data-testid={`webhook-example-${ex.id}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted">{ex.label}</span>
                <Button onClick={() => copy(ex.text, ex.id)}>{copied === ex.id ? 'Copied' : 'Copy'}</Button>
              </div>
              <pre className="overflow-x-auto rounded bg-bg px-2 py-1 font-mono text-[11px] text-text">
                {ex.text}
              </pre>
            </div>
          ))}
        </div>
      ) : null}

      {confirm === 'rotate' ? (
        <ConfirmDialog
          message="Rotate the webhook token? The current token stops working immediately; update every script that uses it with the new one."
          confirmLabel="Rotate"
          danger
          onConfirm={() => void mint()}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
      {confirm === 'revoke' ? (
        <ConfirmDialog
          message="Revoke the webhook token? Scripts using it will no longer reach your phone."
          confirmLabel="Revoke"
          danger
          onConfirm={() => void revoke()}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
    </div>
  )
}

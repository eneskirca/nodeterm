/**
 * The push webhook: a per-host token that lets a script, a CI job or a long build push a plain-text
 * notification to the phones paired with this machine ("the build is done") without an agent in
 * the loop. The backend owns the token (it stores only a hash); this machine proves it owns the
 * relay host key to mint, inspect or revoke one (`core/push-webhook.ts`). Nothing here is secret.
 */

export const PUSH_WEBHOOK_PATH = '/v1/push/webhook'
export const PUSH_WEBHOOK_DEFAULT_API_BASE = 'https://api.nodeterm.dev'
/** The environment variable every example reads the token from — a CI secret, never a literal. */
export const PUSH_WEBHOOK_TOKEN_ENV = 'NODETERM_WEBHOOK_TOKEN'
/** Display caps the backend applies after stripping control characters (code points). */
export const PUSH_WEBHOOK_TITLE_MAX = 120
export const PUSH_WEBHOOK_BODY_MAX = 500

/** What is live for this machine, as the backend reports it. Never the token itself. */
export interface PushWebhookTokenInfo {
  tokenId: string
  /** The first few characters (`ntwh_abcd`), so the user can tell which token is live. */
  tokenPrefix: string
  createdAt: string
  lastUsedAt: string | null
}

/** Why a webhook call did not happen. Each has its own sentence in the UI (`pushWebhookErrorText`). */
export type PushWebhookError =
  /** Unpackaged build with no NODETERM_API_BASE: the backend is not reachable from here on purpose. */
  | 'dev-build'
  /** The relay host key could not be read (keyring locked) — nothing to prove ownership with. */
  | 'no-host-key'
  /** The backend knows no live phone pairing for this machine, so a token could only ever send 0. */
  | 'no-paired-phone'
  /** The backend refused the ownership proof. */
  | 'refused'
  /** The backend could not read the request (a 400) — this build and the server disagree. */
  | 'bad-request'
  | 'rate-limited'
  /** Network error, timeout, 5xx or an answer we could not read. */
  | 'unreachable'

export type PushWebhookResult<T> = { ok: true; value: T } | { ok: false; error: PushWebhookError }

/** A freshly minted token: the ONLY time the full value exists outside the user's own storage. */
export interface PushWebhookMinted extends PushWebhookTokenInfo {
  token: string
}

export interface PushWebhookApi {
  status(): Promise<PushWebhookResult<PushWebhookTokenInfo | null>>
  /** Mint a token; revokes the one that was live (that is the rotation). */
  mint(): Promise<PushWebhookResult<PushWebhookMinted>>
  revoke(): Promise<PushWebhookResult<true>>
}

export function pushWebhookErrorText(error: PushWebhookError): string {
  switch (error) {
    case 'dev-build':
      return 'Unavailable in a development build — set NODETERM_API_BASE to test against a backend.'
    case 'no-host-key':
      return 'Couldn’t read this machine’s remote-access key (is the keychain locked?). Try again.'
    case 'no-paired-phone':
      return 'Pair a phone with remote access first — the webhook pushes to the phones paired with this machine.'
    case 'refused':
      return 'The server did not accept this machine’s proof of its remote-access key. Try again; if it keeps failing, report it.'
    case 'bad-request':
      return 'The server could not read the request — this version of nodeterm and the server disagree. Update nodeterm and try again.'
    case 'rate-limited':
      return 'Too many requests — wait a minute and try again.'
    case 'unreachable':
      return 'Couldn’t reach the nodeterm server. Check the connection and try again.'
  }
}

/**
 * The copyable example. The token is read from an environment variable and handed to curl on
 * STDIN (`--config -`), never on its command line: argv is readable by every user on the machine
 * through `ps`, and a CI runner is exactly such a machine. `printf` is a shell builtin in sh, bash
 * and zsh, so the token is not on its argv either.
 */
function webhookUrl(apiBase: string): string {
  return apiBase.replace(/\/+$/, '') + PUSH_WEBHOOK_PATH
}

export function pushWebhookCurlExample(apiBase: string = PUSH_WEBHOOK_DEFAULT_API_BASE): string {
  const url = webhookUrl(apiBase)
  return [
    `printf 'header = "Authorization: Bearer %s"\\n' "$${PUSH_WEBHOOK_TOKEN_ENV}" |`,
    `  curl -fsS --config - -H 'Content-Type: application/json' \\`,
    `    -d '{"title":"Build finished","body":"main is green"}' \\`,
    `    ${url}`
  ].join('\n')
}

/**
 * The PowerShell counterpart (Windows has no `sh`). `Invoke-RestMethod` is a cmdlet, so the request
 * — header included — is made inside the PowerShell process: no child process, no argv for `ps` to
 * show. (`curl.exe` from PowerShell would need the header on stdin too, and Windows PowerShell 5.1
 * mangles the double quotes of a JSON argument to native programs.)
 */
export function pushWebhookPowerShellExample(apiBase: string = PUSH_WEBHOOK_DEFAULT_API_BASE): string {
  return [
    `Invoke-RestMethod -Method Post -Uri '${webhookUrl(apiBase)}' \``,
    `  -Headers @{ Authorization = "Bearer $env:${PUSH_WEBHOOK_TOKEN_ENV}" } \``,
    `  -ContentType 'application/json' \``,
    `  -Body '{"title":"Build finished","body":"main is green"}'`
  ].join('\n')
}

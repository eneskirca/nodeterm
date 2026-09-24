// SSH usage reads credentials and performs HTTP on the host. Only sanitized quota windows return.
// No app-server fallback: a usage refresh must not start an auth-refreshing process remotely.
import type { ProviderUsage } from '../../shared/types'
import type { CodexAccount } from '../../shared/codex-account'
import { posixQuote } from '../../shared/ssh'
import { isSafeAccountId } from '../codex-accounts-core'
import { remoteCodexHomeExpression, remoteCodexLoginCommand } from '../remote-ssh/codex-home'
import { isSafeRemoteHome } from '../remote-safety'
import { CODEX_BACKEND_USAGE_URL, mapCodexLimits } from './codex-usage'
import type { RemoteUsageRunner, RemoteUsageTarget } from './remote-claude-usage'

const BEGIN = '__NT_CODEX_USAGE_BEGIN__'
const END = '__NT_CODEX_USAGE_END__'

export function remoteCodexUsageTargets(
  connected: readonly { projectId: string; hostKey: string; remoteHome?: string; connectionKey?: string }[],
  accounts: readonly CodexAccount[]
): RemoteUsageTarget[] {
  const seen = new Set<string>()
  return connected.flatMap(connection => {
    if (!connection.hostKey || seen.has(connection.hostKey)) return []
    seen.add(connection.hostKey)
    const row = (accountId: string | null, label: string): RemoteUsageTarget => ({
      ...connection, provider: 'codex', accountId, label,
      key: `codex:${JSON.stringify([connection.hostKey, accountId, connection.remoteHome, connection.connectionKey])}`
    })
    return [row(null, connection.hostKey), ...accounts.filter(a =>
      a.host === connection.hostKey && !a.pending && isSafeAccountId(a.id)
    ).map(a => row(a.id, a.label || a.id))]
  })
}

/** Real JSON parsing (tokens.access_token/account_id only); no regex extraction or credential argv. */
export function remoteCodexUsageCommand(target: Pick<RemoteUsageTarget, 'accountId' | 'remoteHome'>): string {
  if (target.accountId !== null && (!isSafeAccountId(target.accountId) || !isSafeRemoteHome(target.remoteHome))) {
    throw new Error('Remote Codex account scope unavailable')
  }
  const home = remoteCodexHomeExpression(target.remoteHome, target.accountId ?? undefined)
  // JSON.stringify supplies curl-config quoting for quotes/backslashes. Header control bytes are
  // rejected before config construction; curl's own config, redirects and stderr are disabled.
  const program = String.raw`
const fs = require('fs'), path = require('path'), cp = require('child_process');
const emit = value => process.stdout.write('${BEGIN}' + JSON.stringify(value) + '${END}');
const fail = status => emit({status});
try {
  const home = process.argv[1];
  if (!home || !path.isAbsolute(home) || /[\x00-\x1f\x7f]/.test(home)) { fail('error'); process.exit(0); }
  let auth;
  try {
    const file = path.join(home, 'auth.json');
    if (fs.statSync(file).size > 1048576) throw new Error();
    auth = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { fail(e.code === 'ENOENT' ? 'unavailable' : 'error'); process.exit(0); }
  const token = auth && auth.tokens && auth.tokens.access_token;
  const account = auth && auth.tokens && auth.tokens.account_id;
  if (typeof token !== 'string' || !token) { fail('unavailable'); process.exit(0); }
  if (/[\x00-\x1f\x7f]/.test(token) || (account != null && (typeof account !== 'string' || /[\x00-\x1f\x7f]/.test(account)))) {
    fail('error'); process.exit(0);
  }
  const headers = ['authorization: Bearer ' + token, 'user-agent: codex-cli', 'openai-beta: codex-1', 'originator: Codex Desktop'];
  if (account) headers.push('chatgpt-account-id: ' + account);
  const config = headers.map(h => 'header = ' + JSON.stringify(h)).join('\n') + '\n';
  const result = cp.spawnSync('curl', ['-q', '-sS', '--max-time', '10', '--max-filesize', '262144',
    '--proto', '=https', '--max-redirs', '0', '--config', '-', '-w', '\n%{http_code}',
    '${CODEX_BACKEND_USAGE_URL}'], { input: config, encoding: 'utf8',
    timeout: 12000, maxBuffer: 262144, stdio: ['pipe', 'pipe', 'ignore'] });
  if (result.error || result.status !== 0) { fail('error'); process.exit(0); }
  const raw = result.stdout || '', split = raw.lastIndexOf('\n'), code = Number(raw.slice(split + 1));
  if (code === 401 || code === 403) { fail('unavailable'); process.exit(0); }
  if (code !== 200) { fail('error'); process.exit(0); }
  const payload = JSON.parse(raw.slice(0, split));
  if (!payload || typeof payload.plan_type !== 'string') { fail('error'); process.exit(0); }
  // Never forward raw error bodies, identity strings or unexpected server fields to the desktop.
  const clean = w => {
    if (!w || typeof w !== 'object') return undefined;
    const out = {};
    for (const k of ['used_percent', 'limit_window_seconds', 'reset_at']) {
      if (typeof w[k] === 'number' && Number.isFinite(w[k])) out[k] = w[k];
    }
    return out;
  };
  emit({status: 'ok', rate_limit: {
    primary_window: clean(payload.rate_limit && payload.rate_limit.primary_window),
    secondary_window: clean(payload.rate_limit && payload.rate_limit.secondary_window)
  }});
} catch (_) { fail('error'); }
`
  // A single login-shell attempt matches Codex's host environment. Failure is unknown, never a
  // retry under another home (which might read a different account).
  return `${remoteCodexLoginCommand(`node -e ${posixQuote(program)} ${home}`)} 2>/dev/null`
}

export async function fetchRemoteCodexUsage(target: RemoteUsageTarget, run: RemoteUsageRunner, now: number): Promise<ProviderUsage> {
  const result = (status: ProviderUsage['status'], limits: ProviderUsage['limits'] = []): ProviderUsage => ({
    provider: 'codex', accountId: target.accountId ?? undefined, account: target.accountId ? target.label : null,
    limits, status, updatedAt: now
  })
  try {
    const stdout = await run(target, remoteCodexUsageCommand(target))
    const start = stdout?.indexOf(BEGIN) ?? -1
    const end = stdout?.indexOf(END, start + BEGIN.length) ?? -1
    if (!stdout || start < 0 || end < 0) return result('error')
    const payload = JSON.parse(stdout.slice(start + BEGIN.length, end))
    if (payload.status !== 'ok') return result(payload.status === 'unavailable' ? 'unavailable' : 'error')
    const limits = mapCodexLimits(payload.rate_limit)
    // An absent quota window is unknown, never a manufactured 0% reading.
    return result(limits.length ? 'ok' : 'unavailable', limits)
  } catch { return result('error') }
}

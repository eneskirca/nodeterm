import { createHash, randomUUID } from 'crypto'
import { parseEndpointEnv } from '../../core/agents/hook-endpoint-parse'
import { posixQuote } from '../../shared/ssh'

/** A project name alone is not ownership. Only a bearer already held by this installation
 * permits migration. Unknown legacy files stay untouched; sessions can use bounded discovery. */
export function legacyEndpointMigration(
  file: string, snapshot: string, contents: string, ownedTokens: readonly string[]
): { command: string; stdin: string } | null {
  const token = parseEndpointEnv(snapshot).NODETERM_HOOK_TOKEN
  if (!token || !ownedTokens.some((owned) => owned && owned === token)) return null
  const q = posixQuote(file)
  const stage = posixQuote(`${file}.migration-${randomUUID()}`)
  const digest = createHash('sha256').update(snapshot).digest('hex')
  // A digest is public comparison data, never the old or new bearer. Both credentials stay
  // off argv. Refuse symlinks, concurrent changes and overlapping migration writers.
  const cleanup = posixQuote(`rm -f -- ${stage}; rmdir ${q}.migration-lock`)
  const command = `umask 077; mkdir ${q}.migration-lock 2>/dev/null || exit 1; ` +
    `trap ${cleanup} EXIT; ` +
    `cat > ${stage} && chmod 600 ${stage} && test ! -L ${q} && test -f ${q} && ` +
    `test "$( (sha256sum < ${q} 2>/dev/null || shasum -a 256 < ${q}) | cut -d ' ' -f 1)" = '${digest}' && mv -f -- ${stage} ${q}`
  return { command, stdin: contents }
}

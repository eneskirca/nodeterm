import { lstatSync, readFileSync, unlinkSync } from 'fs'
import { createConnection } from 'net'
import { request } from 'http'
import { randomUUID } from 'crypto'
import { parseEndpointEnv } from './hook-endpoint-parse'

export class HookSocketOwnedError extends Error {
  constructor(reason = 'Another listener may own this hook endpoint') {
    super(
      `hook-endpoint-owned: ${reason}; its advertisement was left unchanged.`
    )
  }
}

/** An old advertisement can point at a tunnel, even when our local bind path is different.
 *  Inspect it as data, never source it. Only a failed connect proves that it is safe to replace. */
export async function assertHookEndpointAvailable(file: string): Promise<void> {
  let env: Record<string, string>
  try {
    env = parseEndpointEnv(readFileSync(file, 'utf8'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new HookSocketOwnedError()
  }
  const port = Number(env.NODETERM_HOOK_PORT)
  const targets = [
    ...(env.NODETERM_HOOK_SOCK ? [{ socketPath: env.NODETERM_HOOK_SOCK }] : []),
    ...(Number.isInteger(port) && port > 0 && port <= 65535 ? [{ host: '127.0.0.1', port }] : [])
  ]
  if (!targets.length) throw new HookSocketOwnedError('The endpoint file is malformed')
  for (const target of targets) {
    const probe = (token: string): Promise<number | 'stale' | 'unknown'> => new Promise((resolve) => {
      let req: ReturnType<typeof request>
      const deadline = setTimeout(() => finish('unknown'), 500)
      const finish = (value: number | 'stale' | 'unknown'): void => {
        clearTimeout(deadline)
        req?.destroy()
        resolve(value)
      }
      try {
        req = request({
          ...target, path: '/verify', method: 'POST', timeout: 500,
          headers: { 'X-Nodeterm-Hook-Token': token }
        })
        req.once('response', (res) => finish(res.statusCode ?? 'unknown'))
        req.once('timeout', () => finish('unknown'))
        req.once('error', (e: NodeJS.ErrnoException) =>
          finish(e.code === 'ECONNREFUSED' || e.code === 'ENOENT' ? 'stale' : 'unknown'))
        req.end()
      } catch { finish('unknown') }
    })
    const answer = await probe(env.NODETERM_HOOK_TOKEN ?? '')
    if (answer === 'stale') continue
    // A generic 204 listener is not nodeterm. Prove that /verify accepts the advertised
    // bearer AND rejects an unrelated one, including pre-421 nodeterm releases.
    const negative = answer === 204 && env.NODETERM_HOOK_TOKEN ? await probe(randomUUID()) : null
    if (answer === 204 && (negative === 403 || negative === 421)) {
      throw new HookSocketOwnedError('A live nodeterm owner authenticated the advertised bearer')
    }
    throw new HookSocketOwnedError('The advertised listener could not be authenticated as nodeterm')
  }
}

/** Only ECONNREFUSED proves a leftover socket. Timeouts and permission errors prove nothing. */
export async function clearStaleHookSocket(sock: string): Promise<void> {
  let before
  try {
    before = lstatSync(sock)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
    throw e
  }
  if (!before.isSocket()) throw new HookSocketOwnedError()
  const stale = await new Promise<boolean>((resolve) => {
    const client = createConnection(sock)
    const finish = (value: boolean): void => {
      client.destroy()
      resolve(value)
    }
    client.once('connect', () => finish(false))
    client.once('error', (e: NodeJS.ErrnoException) => finish(e.code === 'ECONNREFUSED'))
    client.setTimeout(500, () => finish(false))
  })
  if (!stale) throw new HookSocketOwnedError()
  // Do not delete a replacement that appeared while connect was in flight.
  const after = lstatSync(sock)
  if (before.dev !== after.dev || before.ino !== after.ino) throw new HookSocketOwnedError()
  unlinkSync(sock)
}

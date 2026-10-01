// Load a passphrase-unlocked key into an ssh-agent — the native transport's `AddKeysToAgent`.
//
// ssh2's AgentProtocol only lists and signs; adding a key is SSH2_AGENTC_ADD_IDENTITY (17) or
// SSH2_AGENTC_ADD_ID_CONSTRAINED (25) from the agent protocol (draft-miller-ssh-agent), with the
// PRIVATE key in OpenSSH wire format. We write that one message ourselves.
//
// Wire format of the key (draft-miller-ssh-agent §3.2.x), each field an SSH `string`/`mpint`:
//   ssh-ed25519          string type, string ENC(A) (32 B), string k || ENC(A) (64 B)
//   ecdsa-sha2-nistpNNN  string type, string curve ("nistpNNN"), string Q (0x04||x||y), mpint d
//   ssh-rsa              string type, mpint n, mpint e, mpint d, mpint iqmp, mpint p, mpint q
// then `string comment`, then (message 25 only) constraints: byte 1 + uint32 seconds = lifetime.
// The components come from node's own JWK export of the key ssh2 already parsed — JWK `qi` is
// q^-1 mod p, which is exactly OpenSSH's iqmp.
//
// FAIL-OPEN by construction: `addKeyToAgent` never throws and never waits longer than its timeout.
// The connection that unlocked the key is already authenticated; the agent is a convenience for the
// NEXT one, so nothing it answers (or fails to answer) may reach the connection.

import net from 'net'
import crypto from 'crypto'
import type { ParsedKey } from 'ssh2'

export const SSH2_AGENTC_ADD_IDENTITY = 17
export const SSH2_AGENTC_ADD_ID_CONSTRAINED = 25
export const SSH2_AGENTC_REMOVE_IDENTITY = 18
export const SSH_AGENT_CONSTRAIN_LIFETIME = 1
export const SSH_AGENT_SUCCESS = 6
export const SSH_AGENT_FAILURE = 5

/** An agent reply we cannot wait for longer than this; the connection never waits on it anyway. */
export const AGENT_ADD_TIMEOUT_MS = 3_000

function u32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0)
  return b
}

function sshString(b: Buffer | string): Buffer {
  const buf = typeof b === 'string' ? Buffer.from(b, 'utf8') : b
  return Buffer.concat([u32(buf.length), buf])
}

/** SSH mpint of a non-negative big-endian magnitude: leading zeros stripped, 0x00 prefixed when
 *  the high bit is set (it would otherwise read as negative), zero as the empty string. */
export function sshMpint(magnitude: Buffer): Buffer {
  let i = 0
  while (i < magnitude.length && magnitude[i] === 0) i++
  let m = magnitude.subarray(i)
  if (m.length && m[0] & 0x80) m = Buffer.concat([Buffer.from([0]), m])
  return sshString(m)
}

const b64u = (s: string | undefined): Buffer => {
  if (!s) throw new Error('key component missing')
  return Buffer.from(s, 'base64url')
}

const CURVES: Record<string, { name: string; jwk: string }> = {
  'ecdsa-sha2-nistp256': { name: 'nistp256', jwk: 'P-256' },
  'ecdsa-sha2-nistp384': { name: 'nistp384', jwk: 'P-384' },
  'ecdsa-sha2-nistp521': { name: 'nistp521', jwk: 'P-521' }
}

/** Coordinate/scalar to the curve's full byte width (JWK already pads, but be exact). */
function pad(b: Buffer, len: number): Buffer {
  return b.length >= len ? b : Buffer.concat([Buffer.alloc(len - b.length), b])
}

/**
 * The private-key body of an add-identity message (type through the last key field, no comment),
 * or null for a key type we do not encode (DSA, security keys, certificates).
 */
export function agentKeyBlob(key: ParsedKey): Buffer | null {
  let jwk: crypto.webcrypto.JsonWebKey
  try {
    jwk = crypto.createPrivateKey(key.getPrivatePEM()).export({ format: 'jwk' })
  } catch {
    return null
  }
  try {
    if (key.type === 'ssh-ed25519') {
      if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') return null
      const a = b64u(jwk.x)
      const k = b64u(jwk.d)
      if (a.length !== 32 || k.length !== 32) return null
      return Buffer.concat([sshString('ssh-ed25519'), sshString(a), sshString(Buffer.concat([k, a]))])
    }
    const curve = CURVES[key.type]
    if (curve) {
      if (jwk.kty !== 'EC' || jwk.crv !== curve.jwk) return null
      const width = curve.jwk === 'P-521' ? 66 : curve.jwk === 'P-384' ? 48 : 32
      const q = Buffer.concat([Buffer.from([4]), pad(b64u(jwk.x), width), pad(b64u(jwk.y), width)])
      return Buffer.concat([sshString(key.type), sshString(curve.name), sshString(q), sshMpint(b64u(jwk.d))])
    }
    if (key.type === 'ssh-rsa') {
      if (jwk.kty !== 'RSA') return null
      return Buffer.concat([
        sshString('ssh-rsa'),
        sshMpint(b64u(jwk.n)),
        sshMpint(b64u(jwk.e)),
        sshMpint(b64u(jwk.d)),
        sshMpint(b64u(jwk.qi)),
        sshMpint(b64u(jwk.p)),
        sshMpint(b64u(jwk.q))
      ])
    }
  } catch {
    return null
  }
  return null
}

/** One framed add-identity request (uint32 length + body), constrained when `lifetimeSec` is set. */
export function addIdentityRequest(key: ParsedKey, comment: string, opts: { lifetimeSec?: number } = {}): Buffer | null {
  const blob = agentKeyBlob(key)
  if (!blob) return null
  const constrained = opts.lifetimeSec !== undefined
  if (constrained && !(Number.isInteger(opts.lifetimeSec) && (opts.lifetimeSec as number) > 0)) return null
  const body = Buffer.concat([
    Buffer.from([constrained ? SSH2_AGENTC_ADD_ID_CONSTRAINED : SSH2_AGENTC_ADD_IDENTITY]),
    blob,
    sshString(comment),
    constrained ? Buffer.concat([Buffer.from([SSH_AGENT_CONSTRAIN_LIFETIME]), u32(opts.lifetimeSec as number)]) : Buffer.alloc(0)
  ])
  return Buffer.concat([u32(body.length), body])
}

/** A framed remove-identity request for the key's public blob (used by the tests to clean up). */
export function removeIdentityRequest(key: ParsedKey): Buffer {
  const body = Buffer.concat([Buffer.from([SSH2_AGENTC_REMOVE_IDENTITY]), sshString(key.getPublicSSH())])
  return Buffer.concat([u32(body.length), body])
}

export type AgentAddResult = 'added' | 'refused' | 'unsupported-key' | 'error'

/**
 * Send one request to the agent at `agentPath` (a unix socket or a Windows named pipe) and read
 * its one-byte verdict. Never throws: every failure is 'error', a FAILURE reply is 'refused'.
 */
export function sendAgentRequest(
  agentPath: string,
  request: Buffer,
  opts: { timeoutMs?: number; connect?: (p: string) => net.Socket } = {}
): Promise<Exclude<AgentAddResult, 'unsupported-key'>> {
  return new Promise((resolve) => {
    let done = false
    let sock: net.Socket | null = null
    const finish = (r: Exclude<AgentAddResult, 'unsupported-key'>): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        sock?.destroy()
      } catch {
        /* ignore */
      }
      resolve(r)
    }
    const timer = setTimeout(() => finish('error'), opts.timeoutMs ?? AGENT_ADD_TIMEOUT_MS)
    try {
      sock = (opts.connect ?? ((p: string) => net.connect(p)))(agentPath)
    } catch {
      return finish('error')
    }
    let buf = Buffer.alloc(0)
    sock.on('error', () => finish('error'))
    sock.on('close', () => finish('error'))
    sock.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d])
      if (buf.length < 5) return
      const len = buf.readUInt32BE(0)
      if (len < 1 || len > 256 * 1024) return finish('error')
      if (buf.length < 4 + len) return
      const type = buf[4]
      finish(type === SSH_AGENT_SUCCESS ? 'added' : type === SSH_AGENT_FAILURE ? 'refused' : 'error')
    })
    sock.on('connect', () => {
      try {
        sock?.write(request)
      } catch {
        finish('error')
      }
    })
  })
}

/** Add `key` to the agent at `agentPath`. Never throws. */
export async function addKeyToAgent(
  agentPath: string,
  key: ParsedKey,
  comment: string,
  opts: { lifetimeSec?: number; timeoutMs?: number; connect?: (p: string) => net.Socket } = {}
): Promise<AgentAddResult> {
  let req: Buffer | null
  try {
    req = addIdentityRequest(key, comment, { lifetimeSec: opts.lifetimeSec })
  } catch {
    req = null
  }
  if (!req) return 'unsupported-key'
  return sendAgentRequest(agentPath, req, opts)
}

/** What the user's own config asks for: `AddKeysToAgent` as `ssh -G` prints it. */
export type AddKeysRequest = { add: false } | { add: true; lifetimeSec?: number }

/**
 * `ssh -G`'s `addkeystoagent` value → what to do. `true`/`yes` add, a positive number of seconds
 * adds with that lifetime. `ask` and `confirm` are NOT honoured (ask needs a second prompt, confirm
 * a per-use confirmation this app cannot show) and read as "no"; so does anything unrecognised —
 * a spelling we do not know must never widen what lands in an agent.
 */
export function parseAddKeysToAgent(v: string | undefined): AddKeysRequest {
  const s = (v ?? '').trim().toLowerCase()
  if (s === 'true' || s === 'yes') return { add: true }
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    return n > 0 && Number.isSafeInteger(n) ? { add: true, lifetimeSec: n } : { add: false }
  }
  return { add: false }
}

/** The Windows OpenSSH agent service's pipe (duplicated from native-mux to keep this a leaf). */
const WINDOWS_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent'

/**
 * Whether to load a freshly unlocked key into `agentPath`, and with what lifetime. null = do not.
 *
 * MEASURED on windows-latest (OpenSSH_for_Windows_9.5p2, 2026-09-30): the Windows agent service
 * REFUSES every constrained add (`ssh-add -t 5` and `ssh-add -c` both "agent refused operation",
 * and our own ADD_ID_CONSTRAINED gets SSH_AGENT_FAILURE), and an unconstrained add is STORED —
 * DPAPI-encrypted under HKCU\Software\OpenSSH\Agent\Keys — and is still listed after
 * `Restart-Service ssh-agent` and a stop/start. So on that agent an add means "until the user
 * removes it", and the app does that only when the user asked:
 *  - their own ssh config says `AddKeysToAgent yes` for the host (what Windows' ssh.exe would do
 *    for them), or a lifetime (sent constrained; Windows refuses it and nothing is stored — never
 *    retried without the constraint);
 *  - or the machine-wide opt-in (`settings.windowsSshAgentAddKeys`), for the Windows pipe only,
 *    whose Settings copy says the key is kept until removed.
 * Any OTHER agent (a configured IdentityAgent, or POSIX under NODETERM_NATIVE_SSH=1) follows the
 * host config alone, exactly as OpenSSH's AddKeysToAgent would.
 */
export function decideAgentAdd(req: {
  agentPath: string
  addKeysToAgent: string | undefined
  windowsAgentOptIn: boolean
}): { lifetimeSec?: number } | null {
  const cfg = parseAddKeysToAgent(req.addKeysToAgent)
  if (cfg.add) return cfg.lifetimeSec !== undefined ? { lifetimeSec: cfg.lifetimeSec } : {}
  if (req.windowsAgentOptIn && req.agentPath.toLowerCase() === WINDOWS_AGENT_PIPE) return {}
  return null
}

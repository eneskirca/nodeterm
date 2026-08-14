// SSH_ASKPASS support for the project ControlMaster (ssh-project.ts), which spawns ssh with no
// tty (stdio ignored), so OpenSSH has nowhere to prompt for an encrypted identity file's
// passphrase. This gives it somewhere: a generated askpass script that curls a unix socket served
// here, which in turn asks the renderer (via an injected prompt handler). No electron import,
// unit-testable like hook-server.ts's HookServer, against a real socket in a tmpdir.
//
// This server deliberately holds NO passphrase state. masterArgs sets `AddKeysToAgent=yes`, so a
// successful unlock loads the key into an ssh-agent and every later connect (reconnect, watchdog
// respawn) authenticates through it without askpass ever being invoked (measured against a real
// sshd: second connect on a fresh master, zero prompts, even with SSH_ASKPASS removed). The agent
// supersedes the in-app passphrase cache an earlier revision of this change used: it holds
// the decrypted key in a purpose-built process instead of a plaintext string in Electron main
// memory. That agent is nodeterm's OWN (ssh-agent.ts), spawned and killed with the app, so the
// unlock lasts one app run rather than until the user's next logout. When no agent is reachable
// ssh skips the add silently and this prompt simply fires once per connect, the pre-cache behavior.
//
// Two OpenSSH behaviors (verified against sshconnect2.c / readpass.c) shape what remains:
//
//  - ssh re-invokes askpass with the BYTE-IDENTICAL "Enter passphrase for key ..." prompt when
//    the previous answer failed to decrypt the key (the "Bad passphrase, try again" wording
//    belongs to ssh-add, not ssh). Prompt text can therefore never signal a retry. Instead the
//    script reports its $PPID (the invoking ssh process), and a SECOND passphrase ask from the
//    same (key, ssh pid) pair means the last answer did not work: see `asked`, which exists
//    solely to put the "that passphrase didn't work" wording on the dialog.
//  - An EMPTY answer makes ssh abandon that key immediately rather than retrying, which is what
//    makes Cancel clean, and what makes declining a non-passphrase prompt safe (see below). It is
//    also why there is NO per-(key, pid) cancel latch here: a declined ssh process never asks for
//    that key again, so a latch could only ever fire on a RECYCLED pid, silently suppressing a
//    brand-new master's legitimate prompt.
//
// SSH_ASKPASS_REQUIRE=force routes EVERY interactive prompt through this helper, including the
// server's password / keyboard-interactive prompts when publickey auth is rejected. Those are
// not ours to answer: this feature unlocks local key files. Answering them would send a server
// password where a key passphrase belongs and mislabel the dialog, so a non-passphrase prompt is
// declined with an empty answer, which is exactly the behavior of the tty-less master before
// askpass existed.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { randomUUID, timingSafeEqual } from 'crypto'
import { promises as fs, rmSync } from 'fs'
import os from 'os'
import path from 'path'
import { instanceSockId } from './ssh-agent'
import { curlHeaderConfigSh } from '../../core/agents/hook-curl-config-sh'

const ASKPASS_SCRIPT_NAME = 'ssh-askpass.sh'
/** A passphrase prompt body is a few bytes; cap generously against a misbehaving caller. */
const MAX_BODY_BYTES = 65_536
/** Ask-counter ceiling. Entries are keyed by (key path, ssh pid) and a finished ssh process
 *  never asks again, so they are dead weight once its connect ends; there is no exit signal to
 *  prune them by, so the whole map is dropped when it grows past this. Worst case after a drop:
 *  one retry prompt reads as a first ask and loses its "didn't work" wording. Cosmetic. */
const MAX_ASK_ENTRIES = 500

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let bytes = 0
    req.on('data', (c: Buffer) => {
      chunks.push(c)
      bytes += c.length
      if (bytes > MAX_BODY_BYTES) req.destroy()
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', () => resolve(''))
    // req.destroy() (the oversize path above) emits neither 'end' nor 'error', only 'close'.
    // Resolving on close keeps the handler from waiting forever on a dropped request. A double
    // resolve on the normal path is harmless, promises settle once.
    req.on('close', () => resolve(''))
  })
}

/** ssh's key-passphrase prompt: `Enter passphrase for key '/home/u/.ssh/id_ed25519': `. The
 *  wording is a hardcoded English literal in OpenSSH (no i18n upstream, none in distro patches),
 *  and the quoted path is the key ssh actually wants unlocked, which is NOT always the `-i`
 *  identity: without IdentitiesOnly, ssh also offers the default identities. */
const PASSPHRASE_PROMPT = /enter passphrase for key\s*'([^']*)'/i

/**
 * Classify what ssh is asking for. `keyPath` is the key named by the prompt when it carries one,
 * and it is what the retry counting and dialog coalescing key by: the configured `-i` identity is
 * not always the key ssh is unlocking (with no `-i` at all, ssh offers the default identities).
 */
export function classifyPrompt(prompt: string): { passphrase: boolean; keyPath?: string } {
  const m = PASSPHRASE_PROMPT.exec(prompt)
  if (m) return { passphrase: true, keyPath: m[1] || undefined }
  // Defensive: a passphrase ask whose shape we do not recognize still must not be mistaken for
  // a server password prompt ("...@host's password:" never contains the word "passphrase").
  if (/passphrase/i.test(prompt)) return { passphrase: true }
  return { passphrase: false }
}

/**
 * The SSH_ASKPASS helper ssh invokes when it needs a passphrase and has no tty to prompt into.
 * One curl POST to our 0600 unix socket, printing whatever it returns (the passphrase, or nothing
 * on cancel) to stdout, which is exactly SSH_ASKPASS's contract. Generated at runtime into
 * userData rather than bundled via electron-builder, so packaging needs no changes (mirrors how
 * hook-server.ts writes hook-endpoint.env there); curl is already a hard runtime dependency of
 * this app's agent hooks, so this introduces nothing new. Values are env-expanded by sh and the
 * results are never re-parsed, so hostile characters in a path cannot inject.
 */
/** Per-instance socket path, sharing the app agent's short home and hashing (a unix socket path
 *  is capped near 104 bytes, which userData eats). The socket gets its OWN subdir rather than
 *  sitting in ~/.nodeterm directly: that root is created 0755 by the hook installer and mkdir's
 *  `mode` never fixes up an existing dir, so only a dir this feature owns can be forced to 0700
 *  (start() chmods it explicitly, the pairing-service pattern). With the dir owner-only BEFORE
 *  the socket exists, the bind-then-chmod-0600 window is actually closed, not just narrated.
 *  The bearer token stays as a second factor. */
function askpassSockPath(): string {
  return path.join(os.homedir(), '.nodeterm', 'askpass', `${instanceSockId()}.sock`)
}

/**
 * The bearer that authenticates this helper to the socket, handed to curl on STDIN as a config
 * file rather than as an `-H` argument. Same emitter (and same stripping rule) as the hook clients
 * — see `core/agents/hook-curl-config-sh.ts` for why a command line is not a private channel.
 *
 * This one is the WORST of the family to leak by duration: a passphrase prompt sits on
 * `--max-time 300`, so an argv header here is readable in `ps` / /proc/<pid>/cmdline for up to
 * five minutes, not the milliseconds a hook POST takes. Whoever reads it can drive this socket's
 * /prompt endpoint themselves — i.e. make the app pop passphrase dialogs — for as long as the app
 * runs. (The 0600 socket in its 0700 dir already keeps a co-tenant off the socket itself; this is
 * the second factor, and a second factor everyone can read is not one.)
 */
const ASKPASS_CURL_HEADERS_SH = curlHeaderConfigSh(
  'nt_askpass_headers',
  [{ name: 'X-Nodeterm-Askpass-Token', valueRef: '$NODETERM_ASKPASS_TOKEN' }],
  `# The bearer goes to curl on STDIN as a config file, never in argv: a command line is
# world-readable through \`ps\` / /proc/<pid>/cmdline for the life of the process, and this curl
# lives up to --max-time 300 waiting for a human to type a passphrase.
#
# Quoting: a curl config file is LINE-based, so a \`"\`, a \`\\\` or either line break in the value
# could end the header line and start a directive of its own; all four are stripped. Belt and
# braces — the token is a randomUUID(), i.e. hex and dashes, so none of them can ever occur, which
# is exactly what makes STRIPPING rather than escaping safe: nothing legitimate is altered.
#
# An EMPTY value behaves as \`-H\` did: nothing after the colon means curl sends no header, the
# server answers 403, and -f turns that into the non-zero exit the breadcrumb below reports.`
)

export function buildAskpassScript(): string {
  return [
    '#!/bin/sh',
    ASKPASS_CURL_HEADERS_SH,
    // -f: an HTTP error (403 from a stale token after another instance rebound the socket) must
    // exit non-zero and hit the breadcrumb below, not read as "empty answer" and die silently.
    // The status of a pipeline is its LAST command's (POSIX), so `$?` below is still curl's own
    // exit code, exactly as when curl was the only command in this substitution.
    'answer=$(nt_askpass_headers |',
    '  curl -sSf --max-time 300 --unix-socket "${NODETERM_ASKPASS_SOCK}" -X POST "http://localhost/prompt" \\',
    '  --config - \\',
    '  --data-urlencode "identity=${NODETERM_ASKPASS_IDENTITY}" \\',
    '  --data-urlencode "caller=$PPID" \\',
    '  --data-urlencode "prompt=$1")',
    // A failure here is otherwise INVISIBLE: ssh reads empty stdout as "no passphrase", abandons
    // the key, and the connect dies with a bare "Permission denied (publickey)" that says nothing
    // about the helper. (Exactly how a container with no curl looked.) The breadcrumb goes to
    // stderr, which is the master's captured stderr, so it reaches the app's log.
    '[ $? -eq 0 ] || { echo "nodeterm-askpass: no answer from the app on ${NODETERM_ASKPASS_SOCK} (curl missing or the app is gone)" >&2; exit 1; }',
    "printf '%s' \"$answer\"",
    ''
  ].join('\n')
}

/** Write the askpass script into userData (idempotent overwrite each launch) and return its path. */
export async function ensureAskpassScript(userDataDir: string): Promise<string> {
  const p = path.join(userDataDir, ASKPASS_SCRIPT_NAME)
  await fs.mkdir(userDataDir, { recursive: true })
  // 0o700: invoked by ssh with the user's own env, owner-only like the ControlMaster socket dir.
  await fs.writeFile(p, buildAskpassScript(), { encoding: 'utf8', mode: 0o700 })
  return p
}

export interface AskpassPromptRequest {
  identityFile: string
  /** True when the SAME ssh process already asked for this key, i.e. the previous answer failed
   *  to decrypt it. Drives the "that passphrase didn't work" dialog copy. */
  retry: boolean
  /** The asking ssh master's pid (the helper's $PPID), when it reported one. The handler maps it
   *  back to the connection being unlocked so the dialog can name the server. Empty for a caller
   *  that cannot report a pid. */
  caller: string
}

/** `null` = the user actively declined. `undefined` = nobody answered (prompt expired, or there
 *  was no UI to ask). Both send ssh an empty answer, but only a decline is reported as a
 *  cancellation, so someone who simply walked away is not told they cancelled. */
type PromptHandler = (req: AskpassPromptRequest) => Promise<string | null | undefined>

export class AskpassServer {
  private server: Server | null = null
  private sockPath = ''
  private token = ''
  private promptHandler: PromptHandler | null = null
  /** Caller pids (the ssh process the askpass helper reported as its $PPID) whose prompt the user
   *  DECLINED. Verified against a real sshd: the helper's $PPID is exactly the master process the
   *  app spawned, so connect() can ask "was MY master's prompt cancelled" and get an exact answer
   *  instead of the time-scoped guess below. Capped like `asked` (no exit signal to prune by).
   *  Known residual: an entry outlives its process, so on a pid-wrapping host a much later master
   *  that happens to reuse a recorded pid AND fails without ever prompting gets its failure
   *  phrased as "cancelled". Cosmetic (the connect failed either way), bounded by the cap. */
  private cancelledCallers = new Set<string>()
  /** When the last cancel happened. Fallback ONLY for callers that cannot report a master pid
   *  (an adopted orphan master, test fakes). Being process-global, it can attribute one project's
   *  cancel to another project's unrelated failure inside the window, which is exactly why the
   *  pid-keyed set above is preferred whenever a pid is available. */
  private lastCancelAt = 0
  /** Passphrase-ask counts keyed by key path + NUL + caller pid (NUL cannot occur in a path, so
   *  keys never collide). Kept for ONE purpose now that the agent replaced the passphrase cache:
   *  a count above zero means the same ssh process is asking again, i.e. the previous answer
   *  failed to decrypt the key, and that is what selects the "that passphrase didn't work"
   *  dialog copy (ssh's retry prompt is byte-identical to the first, so the text cannot carry
   *  it). Deliberately NOT cleared per attempt: a fresh master always has a fresh pid, so
   *  clearing would only wipe a CONCURRENT attempt's counters (two projects can share one key)
   *  and mislabel that attempt's retry as a first ask. */
  private asked = new Map<string, number>()
  /** Serializes dialogs across keys: the renderer shows one passphrase prompt at a time. */
  private queue: Promise<unknown> = Promise.resolve()
  /** In-flight prompt per key, so concurrent asks (two projects sharing a key) collapse into one
   *  dialog whose answer feeds every waiter. `callers` collects EVERY master pid that joined the
   *  dialog, not just the first asker's: a decline must be recorded for each of them, or the
   *  second project's connect would miss the cancel (`wasCancelledBy` its own pid = false) and
   *  report the generic connection error instead of the "needs its passphrase" one. */
  private inflight = new Map<string, { done: Promise<string | null>; callers: Set<string> }>()

  getSockPath(): string {
    return this.sockPath
  }
  getToken(): string {
    return this.token
  }

  setPromptHandler(cb: PromptHandler): void {
    this.promptHandler = cb
  }

  async start(sockPath?: string): Promise<void> {
    if (this.server) return
    // Only the production default dir is chmod-hardened: a test's tmpdir socket must never have
    // its PARENT (the shared OS tmpdir) forced to 0700.
    const isDefaultDir = !sockPath
    sockPath = sockPath ?? askpassSockPath()
    this.token = randomUUID()
    this.sockPath = sockPath
    // mkdir's mode only applies to dirs it creates; chmod covers the pre-existing case (see
    // askpassSockPath). The dir being owner-only BEFORE the bind is what gates the socket's own
    // pre-chmod window. A stale socket file from a crash would EADDRINUSE, hence the rm.
    await fs.mkdir(path.dirname(sockPath), { recursive: true, mode: 0o700 })
    if (isDefaultDir) await fs.chmod(path.dirname(sockPath), 0o700).catch(() => {})
    await fs.rm(sockPath, { force: true })
    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      try {
        if (req.method !== 'POST' || !(req.url ?? '').startsWith('/prompt')) {
          res.writeHead(404)
          res.end()
          return
        }
        if (!this.tokenMatches(req.headers['x-nodeterm-askpass-token'])) {
          res.writeHead(403)
          res.end()
          return
        }
        const body = new URLSearchParams(await readBody(req))
        const answer = await this.resolvePassphrase(
          body.get('identity') ?? '',
          body.get('caller') ?? '',
          body.get('prompt') ?? ''
        )
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(answer ?? '')
      } catch {
        // SSH_ASKPASS contract: empty stdout means "no passphrase" to ssh, never a hang. ssh
        // abandons the key on an empty answer, so a failure here degrades to a clean auth error.
        // headersSent guard: this callback is async and nothing awaits it, so a throw AFTER a
        // response was already headed (the 404/403 bails, or res.end on a dead socket) would make
        // this second writeHead throw ERR_HTTP_HEADERS_SENT into an unhandled rejection, i.e. a
        // main-process crash for a request that had already been answered.
        if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('')
      }
    })
    await new Promise<void>((resolve, reject) => {
      const onErr = (e: Error): void => {
        this.server?.off('listening', onOk)
        reject(e)
      }
      const onOk = (): void => {
        this.server?.off('error', onErr)
        this.server?.on('error', (e) => console.error('[ssh-askpass] server error', e))
        resolve()
      }
      this.server!.once('error', onErr)
      this.server!.listen(sockPath, onOk)
    })
    // listen() binds with umask permissions; tighten to owner-only. The 0700 dir above closes
    // the window between bind and this chmod.
    await fs.chmod(sockPath, 0o600)
  }

  stop(): void {
    this.server?.close()
    this.server = null
    this.token = ''
    if (this.sockPath) {
      try {
        rmSync(this.sockPath, { force: true })
      } catch {
        // best effort: a leftover socket file is unlinked by the next start()
      }
      this.sockPath = ''
    }
  }

  private async resolvePassphrase(
    identityEnv: string,
    caller: string,
    prompt: string
  ): Promise<string | null> {
    const kind = classifyPrompt(prompt)
    // Not a key passphrase (server password, keyboard-interactive/2FA): decline. ssh treats the
    // empty answer as "no answer" and moves on, exactly as it did before askpass was wired up.
    if (!kind.passphrase) return null
    // Prefer the key named by the prompt: ssh may be unlocking a default identity rather than
    // the configured `-i` one, and latching/counting under the configured path would be wrong.
    const identityFile = kind.keyPath || identityEnv
    if (!identityFile) return null

    const askKey = `${identityFile}\u0000${caller}`
    const seen = this.asked.get(askKey) ?? 0
    if (this.asked.size >= MAX_ASK_ENTRIES) this.asked.clear()
    this.asked.set(askKey, seen + 1)

    if (!this.promptHandler) return null
    // seen > 0: the SAME ssh process asking again, so the previous answer failed to decrypt.
    // No cancel latch guards this path: a declined ssh process abandons the key immediately on
    // the empty answer (see the header), so it never asks for the same key again.
    return this.askUser(identityFile, caller, seen > 0)
  }

  private askUser(identityFile: string, caller: string, retry: boolean): Promise<string | null> {
    const existing = this.inflight.get(identityFile)
    if (existing) {
      // A second master joining the dialog must be attributable too: record its pid alongside
      // the first asker's, so a decline marks BOTH connects as cancelled (see `inflight`).
      if (caller) existing.callers.add(caller)
      return existing.done
    }
    const callers = new Set<string>(caller ? [caller] : [])
    const turn = this.queue.then(async () => {
      // The FIRST asker's pid is what the dialog is labelled from: joiners share this one dialog
      // (see `inflight`), so a key serving two servers names whichever asked first.
      const answer = await this.promptHandler!({ identityFile, retry, caller })
      if (answer == null) {
        // A decline is recorded per joined master pid so each waiter's connect can attribute it.
        // An expiry records nothing: the user declined nothing, and reporting "you cancelled"
        // for a prompt that merely timed out would be a lie.
        if (answer === null) {
          for (const c of callers) {
            if (this.cancelledCallers.size >= MAX_ASK_ENTRIES) this.cancelledCallers.clear()
            this.cancelledCallers.add(c)
          }
          this.lastCancelAt = Date.now()
        }
        return null
      }
      return answer
    })
    this.queue = turn.then(
      () => undefined,
      () => undefined
    )
    const done = turn.finally(() => {
      this.inflight.delete(identityFile)
    })
    this.inflight.set(identityFile, { done, callers })
    return done
  }

  /**
   * Did the user cancel a passphrase prompt in the last `withinMs`? Used only to phrase the
   * connect failure ("needs its passphrase" vs a generic error). Time-scoped rather than keyed by
   * identity because a connection with no configured identity file cannot know which key ssh will
   * ask about until the prompt arrives, and by then the attempt has already failed.
   */
  cancelledRecently(withinMs = 60_000): boolean {
    return this.lastCancelAt > 0 && Date.now() - this.lastCancelAt <= withinMs
  }

  /**
   * Did THIS master ever ask for a passphrase? A connect that failed without ever asking had no
   * key FILE in play at all, which is what separates "wrong/declined passphrase" from "the only
   * credential lives in an agent we are not pointing at" (see connectOnce's agent-only hint).
   */
  askedBy(masterPid?: number): boolean {
    if (masterPid === undefined) return false
    // `asked` is keyed `<key path>\u0000<caller pid>` (see resolvePassphrase); NUL cannot occur
    // in a path, so a suffix match is exact. Scanning beats a second index: the map is capped.
    const suffix = `\u0000${masterPid}`
    for (const k of this.asked.keys()) if (k.endsWith(suffix)) return true
    return false
  }

  /**
   * Did the user decline the prompt raised by THIS master? Exact when the caller can name its
   * master's pid, because the askpass helper's $PPID is that same process. Without a pid (adopted
   * orphan, test fake) it degrades to the time-scoped answer, which can misattribute another
   * project's cancel and is therefore only a last resort.
   */
  wasCancelledBy(masterPid?: number): boolean {
    if (masterPid !== undefined) return this.cancelledCallers.has(String(masterPid))
    return this.cancelledRecently()
  }

  /**
   * Env vars for the ControlMaster spawn so ssh routes its passphrase prompt through us.
   *
   * Set for EVERY connection, including ones with no configured identity file. That is the whole
   * point: a saved server usually has `identityFile: null` (the app only fills it in when
   * `~/.ssh/config` named an `IdentityFile`), and ssh then offers the DEFAULT identities
   * (`~/.ssh/id_ed25519`, `id_rsa`, …). Those are exactly the keys most likely to be encrypted.
   * Gating this on a configured identity file made the whole feature dead code for the common
   * case: the tty-less master had no way to prompt and simply failed auth.
   *
   * Harmless when nothing needs unlocking: ssh only executes the helper if it actually has to ask
   * (agent auth and unencrypted keys never invoke it, which is also why a key already loaded by
   * `AddKeysToAgent` produces no prompt at all). `identityFile` is passed only as a hint; the
   * authoritative key is the one named by the prompt (see `classifyPrompt`).
   */
  envFor(identityFile: string | undefined, scriptPath: string): Record<string, string> {
    // A failed/never-run start() means there is nothing to point ssh at: hand back no askpass env
    // at all, so the connect degrades to the pre-feature behavior (fail with ssh's real error)
    // instead of a helper curling a blank socket path on every prompt.
    if (!this.sockPath) return {}
    return {
      SSH_ASKPASS: scriptPath,
      // Modern OpenSSH (8.4+) forces askpass with this even though the master has no tty. Older
      // OpenSSH instead gates askpass on DISPLAY being set (with no tty); set both for portability.
      SSH_ASKPASS_REQUIRE: 'force',
      DISPLAY: process.env.DISPLAY || ':0',
      NODETERM_ASKPASS_SOCK: this.sockPath,
      NODETERM_ASKPASS_TOKEN: this.token,
      // Only a hint, and often absent: a saved server usually has no configured identity file.
      // The prompt names the key ssh actually wants, and that is what the latch/counting key by.
      NODETERM_ASKPASS_IDENTITY: identityFile ?? ''
    }
  }

  /** Is ANY passphrase prompt outstanding (shown, or queued behind another dialog)? A connect
   *  whose server has no configured identity file does not know which key ssh will ask about, so
   *  it can only ask the unkeyed question. Used purely to keep waiting, and only by spawners
   *  that cannot report process exit. */
  isPromptingAny(): boolean {
    return this.inflight.size > 0
  }

  // Constant-time bearer-token check (avoids a timing side channel on the compare).
  private tokenMatches(provided: string | string[] | undefined): boolean {
    if (typeof provided !== 'string' || !this.token) return false
    const a = Buffer.from(provided)
    const b = Buffer.from(this.token)
    return a.length === b.length && timingSafeEqual(a, b)
  }
}

export const askpassServer = new AskpassServer()

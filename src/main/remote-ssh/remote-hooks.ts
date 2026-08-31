// Connection-time remote hook setup for SSH projects: opens the reverse unix-socket tunnel
// (local loopback hook server → remote socket), writes the owner-only remote endpoint file,
// and installs the managed hook into the remote agent configs (claude + gemini JSON settings,
// codex's hooks.json + config.toml trust, and grok's own file inside the host's hooks directory).
// Every step fails open: any remote failure → setup returns null (or, for codex/grok, that agent
// simply runs without status). Takes an INJECTED runner so the flow is unit-testable without real
// ssh/electron.
import { childArgs, hookForwardArgs, hookForwardCancelArgs, remoteEndpointFileContents } from '../../core/remote-ssh/control-master'
import type { ManagedHookEvent } from '@shared/agents/hook-events'
import { CLAUDE_HOOK_EVENTS, DEVIN_HOOK_EVENTS, GEMINI_HOOK_EVENTS } from '@shared/agents/hook-events'
import { GROK_EVENTS } from '../../core/agents/hooks/grok'
import { GROK_HOOK_FILE, isSafeRemoteGrokHome } from '../../core/agents/grok-paths'
import { isSafeNodeId, isSafeRemoteHome } from '../../core/remote-safety'
import { hookServer } from '../../core/agents/hook-server'
import { remoteAtomicWrite } from '../remote-atomic-write'
import { curlHeaderConfigLine } from '../../core/agents/hook-curl-config-sh'
import { buildManagedScript } from '../../core/agents/hooks/managed-script'
import {
  buildCopilotHookConfig,
  COPILOT_HOOK_FILE,
  isSafeRemoteCopilotHome
} from '../../core/agents/hooks/copilot'

/**
 * Remote hook scripts get NO Codex thread-identity root.
 *
 * The default root is THIS machine's data dir, and baking it into a script written to someone
 * else's host puts a path like `/Users/<you>/Library/Application Support/…` on that host — inert
 * (nothing there can read it) but a needless leak of the desktop's layout. Shared identity for SSH
 * hosts is a later slice; when it lands, this becomes the REMOTE host's root, not null.
 */
const REMOTE_IDENTITY_ROOT = null
import { buildManagedHookCommand, mergeManagedHook, type HookSettings } from '../../core/agents/hooks/install-helper'
import {
  buildCodexHooksAndTrust,
  buildManagedCommand as buildCodexManagedCommand,
  type HooksConfig as CodexHooksConfig
} from '../../core/agents/hooks/codex'
import { upsertHookTrustEntriesInContent } from '../../core/agents/hooks/codex-trust'
import { ensureFullscreenTui, type TuiSettings } from '../../core/agents/hooks/claude-tui'
import {
  CONTROL_SHIM_SCRIPT,
  buildCanvasControlInstructions,
  buildCanvasSkillBody,
  mergeCanvasControlBlock
} from '../../core/canvas-control-core'
import {
  CONTEXT_SHIM_SCRIPT,
  buildContextLinkSkillBody,
  buildLinkedContextInstructions,
  mergeInstructionsBlock
} from '../../core/context-link-core'
import { posixQuote, type SshConnection } from '../../shared/ssh'

/** POSIX dirname of an absolute remote path. `path.dirname` would apply the LOCAL separator
 *  rules, which is wrong the moment the desktop is Windows and the host is Linux. */
function dirnameOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i > 0 ? p.slice(0, i) : '/'
}

/**
 * The remote opencode instructions path, as a `{ prelude, pathExpr }` pair for
 * `mergeRemoteInstructions`.
 *
 * opencode is XDG-respecting and the DESKTOP's `$XDG_CONFIG_HOME` says nothing about the host, so
 * this one target must stay expandable BY THE REMOTE SHELL — it cannot be a `posixQuote`d literal
 * like its codex/gemini siblings. That is what made it dangerous: the obvious spelling,
 * `"${XDG_CONFIG_HOME:-<remoteHome>/.config}/…"`, interpolates the host-reported `$HOME` inside
 * DOUBLE quotes, where `$` and backticks are still live — so a `$HOME` of `/home/u$(id)` (which
 * `isSafeRemoteHome` accepts, and should: it is a legal path) executed on the host.
 *
 * The fix binds the untrusted half to a shell VARIABLE first. A parameter expansion's RESULT is
 * not re-expanded, so `"$NT_H"` is inert no matter what bytes it holds, while
 * `${XDG_CONFIG_HOME:-…}` keeps its fallback semantics. Verified against real `/bin/sh`: the
 * payload never runs, and the whole expression stays ONE argument (ARGC=1) with the variable set,
 * unset, and holding a space.
 */
export function openCodeInstructionsTarget(remoteHome: string): { prelude: string; pathExpr: string } {
  return {
    prelude: `NT_H=${posixQuote(remoteHome)}; `,
    pathExpr: `"\${XDG_CONFIG_HOME:-$NT_H/.config}/opencode/AGENTS.md"`
  }
}

export interface RemoteRunner {
  /** Run one ssh child command (over the master); optional stdin written to the child. */
  run: (args: string[], stdin?: string) => Promise<{ code: number; stdout: string }>
}

// Per-agent remote install targets (JSON-settings agents merged via mergeManagedHook). Codex
// is installed separately (installCodexRemote) because it needs a hooks.json merge PLUS a
// config.toml trust write — see that method. Grok is separate too (installGrokRemote): its config
// path is NOT $HOME-relative when the host sets GROK_HOME, which is exactly what this list assumes.
// Paths are relative to the remote $HOME and are made absolute once it is resolved at setup
// (a literal `~` is NOT expanded inside double quotes or when passed as data, so the merged
// hook command / endpoint file / `-R` bind path would otherwise carry an unexpanded tilde).
// The SAME lists the local installer uses (shared/agents/hook-events.ts). They were duplicated
// here and had drifted: claude was missing StopFailure/PermissionRequest (an errored remote turn
// stuck on "working"), and gemini was subscribed to CLAUDE's event names, which it never fires —
// so remote gemini nodes reported nothing at all.
const AGENT_TARGETS: { agentId: string; config: string; events: readonly ManagedHookEvent[] }[] = [
  { agentId: 'claude', config: '.claude/settings.json', events: CLAUDE_HOOK_EVENTS },
  { agentId: 'gemini', config: '.gemini/settings.json', events: GEMINI_HOOK_EVENTS },
  { agentId: 'devin', config: '.config/devin/config.json', events: DEVIN_HOOK_EVENTS }
]

export class RemoteHooks {
  // Remember the absolute sock path + hook port used at setup per project so teardown cancels
  // the exact `-R` spec (teardown does not re-resolve $HOME).
  private specs = new Map<string, { sock: string; port: number }>()

  constructor(private r: RemoteRunner) {}

  async setup(
    projectId: string,
    conn: SshConnection,
    controlPath: string,
    hook: { port: number; token: string; version: string }
  ): Promise<{ endpointPath: string } | null> {
    if (!hook.port || !hook.token) {
      // Not just fail-open noise: on a reused live-orphan ControlMaster this leaves the master
      // serving a PREVIOUS app run's forward (dead port) with nothing ever rebinding it.
      console.warn('[remote-hooks] hook server not ready at connect — remote agents run without hooks')
      return null
    }
    try {
      // 0. resolve the remote $HOME once → build all remote paths absolute (no unexpanded ~).
      const { code, stdout } = await this.r.run(childArgs(conn, controlPath, 'printf %s "$HOME"'))
      // Trim at the READ site (`printf %s` emits no newline, but a login-shell banner or a shell
      // wrapper can add one), then VALIDATE: every path below is spliced into a remote SHELL LINE,
      // so a `$HOME` carrying a newline would append a second command to it. The host's answer is
      // data, not truth. Fail-open in the direction this whole method already takes — an unusable
      // answer means no hooks, never a half-built remote path. (Layer two is the quoting below;
      // both are needed: the validator bounds what can arrive, the quoting bounds what it can do.)
      const home = stdout.trim()
      if (code !== 0 || !home) return null // fail-open: nothing else would work
      // The host's answer is interpolated into every remote path below — all of them quoted now,
      // but a `$HOME` that is not a plain path is still refused OUTRIGHT rather than escaped case
      // by case. LOUD, because unlike the rest of this file's fail-open steps the user loses hooks
      // entirely and there would otherwise be nothing anywhere saying why.
      if (!isSafeRemoteHome(home)) {
        console.warn(
          '[remote-hooks] the host reported a $HOME that is not a plain path — refusing to build ' +
            'remote commands from it; this host runs without status hooks'
        )
        return null
      }
      const remoteDir = `${home}/.nodeterm`
      const sock = `${remoteDir}/hook-${projectId}.sock`
      // PER-PROJECT endpoint file. The sock is already per-project, but the endpoint file used to
      // be a single shared `hook-endpoint.env`: every connect — a real project AND every transient
      // folder-picker browse (projectId `ssh-browse-*`, same connect() path) — overwrote it with
      // its own sock. A browse's tunnel dies when the picker closes, leaving the shared file
      // pointing at a dead socket, so every real project's hook POSTs (`curl --unix-socket`) failed
      // silently → no status badge / context meter / subagent cards / session-name sync on ANY SSH
      // node. A per-project file means each session sources ITS OWN project's live sock.
      const endpoint = `${remoteDir}/hook-endpoint-${projectId}.env`
      // 1. reverse unix-socket forward, VERIFIED end-to-end before anything advertises it.
      // A reused live-orphan master (app relaunch; ControlMaster children outlive the app) can
      // carry a stale forward from the previous run — same path, DEAD port. sshd even serves
      // several listeners for one path across rm+rebind cycles (observed in the field: two fds
      // on one sshd). Binding is therefore not evidence of a working tunnel; only an HTTP
      // answer from THIS app run's hook server is. Field case: every remote hook POST died
      // against a dead port for hours — no badges, no context meter — with zero symptoms,
      // because every step here was silently fail-open.
      let verified = false
      for (let attempt = 0; attempt < 2 && !verified; attempt++) {
        if (attempt > 0) {
          // Our own spec may already be registered (a reconnect this run) — clear it first.
          await this.r.run(hookForwardCancelArgs(conn, controlPath, sock, hook.port)).catch(() => {})
        }
        await this.r.run(
          childArgs(conn, controlPath, `mkdir -p ${posixQuote(remoteDir)} && rm -f ${posixQuote(sock)}`)
        )
        const fwd = await this.r.run(hookForwardArgs(conn, controlPath, sock, hook.port))
        if (fwd.code !== 0) continue
        verified = await this.verifyTunnel(conn, controlPath, sock, hook.token)
      }
      if (!verified) {
        console.warn(
          `[remote-hooks] reverse hook tunnel failed verification for ${projectId} — remote agents run without status hooks`
        )
        return null
      }
      this.specs.set(projectId, { sock, port: hook.port })
      // 2. Remote endpoint file — written only after the tunnel proved live, so sessions are
      // never pointed at a socket that answers nothing. The file carries the hook bearer. A
      // direct `cat > endpoint` both exposed partial bytes and preserved an old permissive mode;
      // publish a new 0600 inode through an invocation-owned temp instead.
      const endpointWrite = remoteAtomicWrite(endpoint, {
        restrictPermissions: true,
        chmod600: true,
        makeParent: false
      })
      const endpointResult = await this.r.run(
        childArgs(conn, controlPath, endpointWrite.command),
        remoteEndpointFileContents(sock, hook.token, hook.version, `${remoteDir}/node-tokens`)
      )
      if (endpointResult.code !== 0) return null
      // 3. install the managed hook for each JSON agent (script + merged config).
      for (const t of AGENT_TARGETS) {
        const script = `${remoteDir}/agent-hooks/${t.agentId}.sh`
        const config = `${home}/${t.config}`
        await this.r.run(
          childArgs(
            conn,
            controlPath,
            `mkdir -p ${posixQuote(`${remoteDir}/agent-hooks`)} && cat > ${posixQuote(script)} && chmod 755 ${posixQuote(script)}`
          ),
          buildManagedScript(t.agentId, REMOTE_IDENTITY_ROOT)
        )
        const { stdout: cfgRaw } = await this.r.run(
          childArgs(conn, controlPath, `cat ${posixQuote(config)} 2>/dev/null || echo '{}'`)
        )
        let cfg: HookSettings = {}
        try {
          cfg = JSON.parse(cfgRaw || '{}') as HookSettings
        } catch {
          cfg = {}
        }
        const merged = mergeManagedHook(cfg, buildManagedHookCommand(script), t.events)
        await this.r.run(
          // `$(dirname …)` is itself QUOTED (same reason as installGrokRemote): a home with a
          // space would otherwise word-split into two mkdir args, the directory would never be
          // created, and the correctly-quoted `cat >` would then fail — silently, fail-open.
          childArgs(conn, controlPath, `mkdir -p "$(dirname ${posixQuote(config)})" && cat > ${posixQuote(config)}`),
          JSON.stringify(merged, null, 2)
        )
      }
      // 4. codex: hooks.json merge + config.toml trust (its own shape — not a JSON-settings agent).
      await this.installCodexRemote(conn, controlPath, home, remoteDir)
      // 5. grok: our own file in its hooks DIRECTORY, under the HOST's $GROK_HOME.
      await this.installGrokRemote(conn, controlPath, home, remoteDir)
      // 6. copilot: its own file/grammar under the HOST's $COPILOT_HOME hooks directory.
      await this.installCopilotRemote(conn, controlPath, home, remoteDir)
      return { endpointPath: endpoint }
    } catch {
      return null // fail-open: agent runs without hooks
    }
  }

  /**
   * Materialise this instance's per-node tokens ON THE HOST — `<home>/.nodeterm/node-tokens/<id>`,
   * 0600 in a 0700 dir, exactly the layout the endpoint file already advertises as
   * `NODETERM_NODE_TOKEN_DIR` and the managed script already reads (`head -n 1 "$DIR/$NODE_ID"`).
   * Nothing wrote it before this, which is why every remote node was permanently `legacy`.
   *
   * THE INVARIANT — a credential NEVER rides an ssh command line. The host's process table is
   * readable by its OTHER users (`ps` shows full argv), and a remote command line is argv on both
   * ends. So the token goes on STDIN, as the endpoint-file write above already does, and only the
   * (non-secret) path is interpolated. Do not "simplify" this into `printf %s <token> > file`.
   *
   * Fail-open per node AND overall. A connect that died over an identity file would be a far worse
   * regression than an unverified remote node: a node with no token file presents an empty header,
   * which the server reads as `legacy` — the designed state, not an outage.
   *
   * `mint` returning '' is a REFUSAL (no secret, or the case-fold collision guard), and a refusal
   * SWEEPS: an earlier connect's file for that id is precisely the token its colliding twin would
   * read, so leaving it in place is the attack the local `node-token-service` sweeps for.
   *
   * Fail-open does NOT mean fail-silent: a node whose write did not land has no token to present,
   * and the trust-on-first-proof latch lives at the DESKTOP and is keyed by node id, so leaving it
   * armed over a token that is not there is a permanent 403 (invariant 7). Every failure path here
   * therefore calls `hookServer.forgetProvenNode`.
   *
   * KNOWN LIMITATION — the dir is flat, i.e. per HOST ACCOUNT, not per nodeterm instance. Two
   * instances driving the same host+user (two desktops sharing a deploy account, or a desktop
   * whose SSH project points at a host that also runs a headless Server Edition under the same
   * $HOME) mint with DIFFERENT secrets and overwrite each other's files. The loser's sessions then
   * present a token carrying the winner's kid, which `verifyNodeToken` reads as `legacy` — never as
   * another node, and never as `forged`. So the cost is a silent drop to the fail-open state, not a
   * mis-verification. Scoping the dir as `node-tokens/<kid>/<id>` would close it and needs NO client
   * change (the client uses whatever dir the endpoint file names) — it is left out here only to keep
   * the remote layout identical to the local one; see the task A11 report.
   */
  async writeNodeTokens(
    conn: SshConnection,
    controlPath: string,
    home: string,
    nodeIds: readonly string[],
    mint: (nodeId: string) => string
  ): Promise<void> {
    try {
      if (!isSafeRemoteHome(home)) return
      const dir = `${home}/.nodeterm/node-tokens`
      // Gate BEFORE any path join: the ids come from `project.json`, which travels in shared and
      // cloned repos, and `..` under the token dir resolves to its PARENT. De-duplicated so a
      // canvas listing one node twice is one write, not two.
      const ids = [...new Set(nodeIds)].filter((id) => isSafeNodeId(id))
      // Mint FIRST, so a set with nothing to do costs no round-trip at all (and an all-unsafe
      // list costs not one remote command).
      const writes: { id: string; token: string }[] = []
      const sweeps: string[] = []
      for (const id of ids) {
        let token = ''
        try {
          token = mint(id)
        } catch {
          token = '' // a minter that throws is a refusal, not a crashed connect
        }
        if (token) writes.push({ id, token })
        else sweeps.push(id)
      }
      for (const id of sweeps) {
        await this.r
          .run(childArgs(conn, controlPath, `rm -f ${posixQuote(`${dir}/${id}`)}`))
          .catch(() => {})
      }
      if (!writes.length) return
      // `umask 077` so the dir is 0700 the moment it exists; `chmod 700` because an EXISTING dir
      // keeps its old mode (the same belt-and-braces the local writer applies).
      const mk = await this.r.run(
        childArgs(conn, controlPath, `umask 077; mkdir -p ${posixQuote(dir)} && chmod 700 ${posixQuote(dir)}`)
      )
      if (mk.code !== 0) return // no dir ⇒ no files; the nodes stay `legacy`
      for (const { id, token } of writes) {
        const filePath = `${dir}/${id}`
        // TMP + RENAME, the same shape the local writer uses, and for a reason that is not
        // cosmetic: `cat > <file>` TRUNCATES before the write can fail, so a host that is out of
        // quota or disk left the node holding an EMPTY token file. An empty header reads as
        // `legacy`, and a node still latched at the desktop then takes a hard 403 on every
        // canvas-control call for the rest of the session. Writing beside the file and renaming
        // means a failure costs the node nothing it already had.
        let wrote = false
        try {
          // chmod on the TMP, so the mode is right before the name exists; `mv` within one dir is
          // a rename, which carries the tmp's 0600 over whatever the destination's mode was.
          const write = remoteAtomicWrite(filePath, {
            restrictPermissions: true,
            chmod600: true,
            makeParent: false
          })
          const w = await this.r.run(
            childArgs(conn, controlPath, write.command),
            `${token}\n` // newline-terminated: the client reads it with `head -n 1`
          )
          // The runner RESOLVES on a non-zero exit — a failed write is a `code`, not a throw, and
          // reading only the throw is how this failure stayed invisible.
          wrote = w.code === 0
        } catch {
          /* fail-open per node: one unwritable token must not cost the others theirs */
        }
        // INVARIANT 7 — a node with no token must not stay latched. Every other path that takes a
        // token away releases the latch (`sweepToken` in node-token-service); this one silently did
        // not, and the desktop's latch is instance-global, so a remote node whose write failed was
        // refused permanently with advice to restart that could not help.
        if (!wrote) hookServer.forgetProvenNode(id)
      }
    } catch {
      /* fail-open: an identity file must never be able to fail a connect */
    }
  }

  /**
   * Install the managed codex status hook on the REMOTE host: write `codex.sh`, merge our handler
   * into `~/.codex/hooks.json`, and — the part that makes codex different from claude/gemini — write
   * the matching TRUST entries into `~/.codex/config.toml`. Codex will NOT run a hook whose
   * `[hooks.state."<key>"].trusted_hash` doesn't equal its own hash of the hook definition, so the
   * hooks.json merge alone (the desktop's local `codex.ts` learned this) leaves a remote codex
   * session dark. This mirrors that local flow over the ControlMaster.
   *
   * The trust hash is computed over the EXACT `command` string (which embeds the remote script
   * path), so the command written into hooks.json and the command hashed into config.toml MUST be
   * the same bytes — both come from `buildCodexManagedCommand(script)`. The trust KEY is keyed by
   * the hooks.json path as codex canonicalizes it (`key_source` → realpath), so we resolve the
   * remote path with `readlink -f` ON THE HOST rather than realpath'ing it against the desktop fs
   * (which would resolve the wrong machine's symlinks, or fall back to a path codex never uses).
   *
   * Fail-open at every step; an unparseable remote hooks.json is left untouched (never clobbered).
   */
  private async installCodexRemote(
    conn: SshConnection,
    controlPath: string,
    home: string,
    remoteDir: string
  ): Promise<void> {
    try {
      const script = `${remoteDir}/agent-hooks/codex.sh`
      await this.r.run(
        childArgs(
          conn,
          controlPath,
          `mkdir -p ${posixQuote(`${remoteDir}/agent-hooks`)} && cat > ${posixQuote(script)} && chmod 755 ${posixQuote(script)}`
        ),
        buildManagedScript('codex', REMOTE_IDENTITY_ROOT)
      )
      // POSIX explicitly: the platform argument is the HOST's, never this desktop's. A Windows
      // desktop writes a `.cmd` command locally (issue #567) and must not put one on a Linux server.
      const command = buildCodexManagedCommand(script, 'linux')
      const codexHome = `${home}/.codex`
      const hooksFile = `${codexHome}/hooks.json`
      const configToml = `${codexHome}/config.toml`

      // Resolve the canonical remote hooks.json path (codex realpath's key_source before keying the
      // trust entry). Falls back to the plain path when readlink can't resolve it yet.
      const { stdout: canonRaw } = await this.r.run(
        childArgs(
          conn,
          controlPath,
          `mkdir -p ${posixQuote(codexHome)}; readlink -f ${posixQuote(hooksFile)} 2>/dev/null || printf %s ${posixQuote(hooksFile)}`
        )
      )
      const sourcePath = canonRaw.trim() || hooksFile

      // Read the current hooks.json. `|| echo '{}'` only fires when the file is MISSING, so a
      // present-but-malformed file reaches JSON.parse and throws → we skip (never clobber it).
      const { stdout: hooksRaw } = await this.r.run(
        childArgs(conn, controlPath, `cat ${posixQuote(hooksFile)} 2>/dev/null || echo '{}'`)
      )
      let existing: CodexHooksConfig | null
      try {
        const parsed = JSON.parse(hooksRaw || '{}') as unknown
        existing =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as CodexHooksConfig)
            : null
      } catch {
        existing = null
      }
      const built = buildCodexHooksAndTrust(existing, command, sourcePath)
      if (!built) return // missing is fine ({}); unparseable/odd shape → leave the host's file alone

      await this.r.run(
        childArgs(conn, controlPath, `mkdir -p ${posixQuote(codexHome)} && cat > ${posixQuote(hooksFile)}`),
        `${JSON.stringify(built.config, null, 2)}\n`
      )

      // Trust LAST: read config.toml, line-merge our trust blocks (preserving all other content),
      // write back only if it changed. `|| true` so a missing config.toml reads as empty.
      const { stdout: tomlRaw } = await this.r.run(
        childArgs(conn, controlPath, `cat ${posixQuote(configToml)} 2>/dev/null || true`)
      )
      const nextToml = upsertHookTrustEntriesInContent(tomlRaw, built.trustEntries)
      if (nextToml !== tomlRaw) {
        await this.r.run(
          childArgs(conn, controlPath, `mkdir -p ${posixQuote(codexHome)} && cat > ${posixQuote(configToml)}`),
          nextToml
        )
      }
    } catch {
      /* fail-open: the remote codex session simply runs without status hooks */
    }
  }

  /**
   * Install the managed grok status hook on the REMOTE host. Grok differs from claude/gemini in two
   * ways that keep it out of AGENT_TARGETS: its config lives in a hooks DIRECTORY (we own one file
   * there outright, so nothing of the user's is at risk inside it), and its path is not
   * $HOME-relative when the host sets GROK_HOME — which we therefore ASK THE HOST for, and
   * validate, because a host-reported string is data and not truth.
   *
   * Because the file is ours outright, an unparseable one is HEALED (parse error → `{}` → write our
   * fresh config), exactly as the local installer does (`installHooksInto`). Skipping the write
   * instead — the guard codex and the AGENT_TARGETS loop need, because those write the USER's
   * files — would leave a host's grok nodes permanently dark with no in-app repair.
   *
   * Fail-open at every step: a remote grok session simply runs without status hooks.
   */
  private async installGrokRemote(
    conn: SshConnection,
    controlPath: string,
    home: string,
    remoteDir: string
  ): Promise<void> {
    try {
      const { stdout: rawHome } = await this.r.run(
        childArgs(conn, controlPath, 'printf %s "${GROK_HOME:-}"')
      )
      // Trim at the READ site: isSafeRemoteGrokHome judges the exact string we would go on to
      // interpolate into a remote command line, so it (correctly) refuses an untrimmed value.
      const reported = rawHome.trim()
      // `|| '/'`: a host that genuinely reports `/` means `/`, and letting the strip leave `''`
      // would make `grokHome` a value no host ever said.
      const stripped = reported.replace(/\/+$/, '') || '/'
      const grokHome = isSafeRemoteGrokHome(reported) ? stripped : `${home}/.grok`
      // Joined so the separator is never doubled (`//hooks` is implementation-defined in POSIX).
      const config = `${grokHome.replace(/\/$/, '')}/hooks/${GROK_HOOK_FILE}`
      const script = `${remoteDir}/agent-hooks/grok.sh`

      await this.r.run(
        childArgs(
          conn,
          controlPath,
          `mkdir -p ${posixQuote(`${remoteDir}/agent-hooks`)} && cat > ${posixQuote(script)} && chmod 755 ${posixQuote(script)}`
        ),
        buildManagedScript('grok', REMOTE_IDENTITY_ROOT)
      )
      // `|| echo '{}'` fires ONLY when the file is missing — still the read that distinguishes a
      // missing file from an unreadable one. An unreadable one is then HEALED, not preserved: this
      // file is ours by name and we rewrite it wholesale, so there is no user content to lose.
      const { stdout: cfgRaw } = await this.r.run(
        childArgs(conn, controlPath, `cat ${posixQuote(config)} 2>/dev/null || echo '{}'`)
      )
      let cfg: HookSettings = {}
      try {
        cfg = JSON.parse(cfgRaw || '{}') as HookSettings
      } catch {
        cfg = {}
      }
      const merged = mergeManagedHook(cfg, buildManagedHookCommand(script), GROK_EVENTS)
      // The `$(dirname …)` is QUOTED: a valid $GROK_HOME may contain spaces, which would otherwise
      // word-split into two mkdir args, leave the directory absent, and fail the quoted `cat >`.
      await this.r.run(
        childArgs(conn, controlPath, `mkdir -p "$(dirname ${posixQuote(config)})" && cat > ${posixQuote(config)}`),
        JSON.stringify(merged, null, 2)
      )
    } catch {
      /* fail-open: the remote grok session simply runs without status hooks */
    }
  }

  /** Install Copilot's owned hook file using the same config builder as the local installer. */
  private async installCopilotRemote(
    conn: SshConnection,
    controlPath: string,
    home: string,
    remoteDir: string
  ): Promise<void> {
    try {
      const copilotHome = await this.resolveCopilotHome(conn, controlPath, home)
      const config = `${copilotHome.replace(/\/$/, '')}/hooks/${COPILOT_HOOK_FILE}`
      const script = `${remoteDir}/agent-hooks/copilot.sh`
      await this.r.run(
        childArgs(
          conn,
          controlPath,
          `mkdir -p ${posixQuote(`${remoteDir}/agent-hooks`)} && cat > ${posixQuote(script)} && chmod 755 ${posixQuote(script)}`
        ),
        buildManagedScript('copilot', REMOTE_IDENTITY_ROOT)
      )
      await this.r.run(
        childArgs(
          conn,
          controlPath,
          `mkdir -p "$(dirname ${posixQuote(config)})" && cat > ${posixQuote(config)}`
        ),
        `${JSON.stringify(buildCopilotHookConfig(buildManagedHookCommand(script)), null, 2)}\n`
      )
    } catch {
      /* fail-open: the remote copilot session simply runs without status hooks */
    }
  }

  private async resolveCopilotHome(
    conn: SshConnection,
    controlPath: string,
    home: string
  ): Promise<string> {
    const { stdout } = await this.r.run(
      childArgs(conn, controlPath, 'printf %s "${COPILOT_HOME:-}"')
    )
    const reported = stdout.trim()
    const stripped = reported.replace(/\/+$/, '') || '/'
    return isSafeRemoteCopilotHome(reported) ? stripped : `${home}/.copilot`
  }

  /**
   * Merge the managed claude hook into a REMOTE managed-account config dir's `settings.json`, so an
   * agent that runs under `CLAUDE_CONFIG_DIR=<accountDir>` reports status like the default
   * `~/.claude` does (badges / notifications / subagent viz). The claude CLI reads its hooks from
   * `$CLAUDE_CONFIG_DIR/settings.json`, so `setup()`'s merge into `~/.claude/settings.json` does NOT
   * cover account sessions — this fills the gap. Reuses the same hook SCRIPT `setup()` wrote (writing
   * it idempotently in case setup didn't run) + the shared merge helper, preserving any hooks the
   * account dir already has. `remoteHome` is the resolved remote `$HOME`; every path is absolute
   * (a literal `~` inside the merged `sh "…"` command would not expand). Fail-open.
   */
  async installIntoAccountDir(
    conn: SshConnection,
    controlPath: string,
    remoteHome: string,
    accountId: string
  ): Promise<void> {
    try {
      const remoteDir = `${remoteHome}/.nodeterm`
      const script = `${remoteDir}/agent-hooks/claude.sh`
      const accountDir = `${remoteHome}/.nodeterm/claude-accounts/${accountId}`
      const config = `${accountDir}/settings.json`
      const events = AGENT_TARGETS.find((t) => t.agentId === 'claude')?.events ?? []
      // Idempotently (re)write the shared hook script — setup() may not have run (fail-open) yet.
      await this.r.run(
        childArgs(conn, controlPath, `mkdir -p ${posixQuote(`${remoteDir}/agent-hooks`)} && cat > ${posixQuote(script)} && chmod 755 ${posixQuote(script)}`),
        buildManagedScript('claude', REMOTE_IDENTITY_ROOT)
      )
      const { stdout: cfgRaw } = await this.r.run(
        childArgs(conn, controlPath, `cat ${posixQuote(config)} 2>/dev/null || echo '{}'`)
      )
      let cfg: HookSettings = {}
      try {
        cfg = JSON.parse(cfgRaw || '{}') as HookSettings
      } catch {
        cfg = {}
      }
      const merged = mergeManagedHook(cfg, buildManagedHookCommand(script), events)
      await this.r.run(
        childArgs(conn, controlPath, `mkdir -p ${posixQuote(accountDir)} && cat > ${posixQuote(config)}`),
        JSON.stringify(merged, null, 2)
      )
    } catch {
      /* fail-open: the account session simply runs without status hooks */
    }
  }

  /**
   * Install the canvas-control CLI + its discovery docs on the REMOTE host, so an agent running
   * in an SSH project can create and organize canvas nodes exactly like a local one.
   *
   * The desktop installs the same two artifacts into its own home (`canvas-control.ts`); this is
   * the SSH counterpart. Nothing machine-specific crosses over: the shim is pure sh + curl and
   * reads its endpoint from `$NODETERM_HOOK_ENDPOINT` (the per-project file `setup()` wrote), so
   * the *remote* copy reaches this desktop through the same reverse tunnel the status hooks use.
   * The old Electron-as-Node shim could not be installed here at any price — it hardcoded the
   * desktop's `process.execPath`.
   *
   * The CALLER gates this on `setup()` having verified the tunnel: a skill pointing at a socket
   * that answers nothing is worse than no skill, because the agent retries a dead endpoint
   * instead of telling the user canvas control is unavailable. Fail-open per step otherwise.
   */
  async installCanvasControl(conn: SshConnection, controlPath: string, remoteHome: string): Promise<void> {
    try {
      const shim = `${remoteHome}/.nodeterm/nodeterm.sh`
      await this.writeRemoteShim(conn, controlPath, shim, CONTROL_SHIM_SCRIPT)
      await this.writeRemoteSkill(
        conn,
        controlPath,
        `${remoteHome}/.claude`,
        'manage-nodeterm-canvas',
        buildCanvasSkillBody(shim)
      )
      // codex / gemini / opencode have no skill system — same marker-delimited instruction block
      // the desktop merges into their global instruction files. The opencode path is expanded by
      // the REMOTE shell (it is XDG-respecting and the local value says nothing about the host).
      const block = buildCanvasControlInstructions(shim)
      // codex/gemini are plain quoted literals; opencode must stay shell-expandable and so
      // carries a prelude that binds the untrusted $HOME to a variable (see the helper).
      const targets: { pathExpr: string; prelude?: string }[] = [
        { pathExpr: posixQuote(`${remoteHome}/.codex/AGENTS.md`) },
        { pathExpr: posixQuote(`${remoteHome}/.gemini/GEMINI.md`) },
        {
          pathExpr: posixQuote(
            `${await this.resolveCopilotHome(conn, controlPath, remoteHome)}/copilot-instructions.md`
          )
        },
        openCodeInstructionsTarget(remoteHome)
      ]
      for (const t of targets) {
        await this.mergeRemoteInstructions(conn, controlPath, t.pathExpr, block, mergeCanvasControlBlock, t.prelude)
      }
    } catch {
      /* fail-open: the remote agent simply runs without canvas control */
    }
  }

  /**
   * Same skill, installed into a REMOTE managed-account config dir. Claude Code resolves user
   * skills relative to CLAUDE_CONFIG_DIR, so an account session sees `~/.claude/skills` not at
   * all — the exact reason `installIntoAccountDir` exists for the status hook.
   */
  async installCanvasSkillIntoAccountDir(
    conn: SshConnection,
    controlPath: string,
    remoteHome: string,
    accountId: string
  ): Promise<void> {
    try {
      const shim = `${remoteHome}/.nodeterm/nodeterm.sh`
      // Idempotently (re)write the shim: installCanvasControl may not have run (fail-open) yet.
      await this.writeRemoteShim(conn, controlPath, shim, CONTROL_SHIM_SCRIPT)
      const accountDir = `${remoteHome}/.nodeterm/claude-accounts/${accountId}`
      await this.writeRemoteSkill(
        conn,
        controlPath,
        accountDir,
        'manage-nodeterm-canvas',
        buildCanvasSkillBody(shim)
      )
    } catch {
      /* fail-open */
    }
  }

  /**
   * Install the context-link CLI + its discovery docs on the REMOTE host, so a linked agent node
   * in an SSH project can read what its neighbours are doing.
   *
   * Same thin-client shape as canvas control, for a sharper reason: reading and parsing the
   * transcripts happens on the desktop (three formats, and the host may have no node at all), so
   * all the host needs is sh + curl aimed at the reverse tunnel. Gated by the caller on a
   * verified tunnel; fail-open per step.
   */
  async installContextLink(conn: SshConnection, controlPath: string, remoteHome: string): Promise<void> {
    try {
      const shim = `${remoteHome}/.nodeterm/context.sh`
      await this.writeRemoteShim(conn, controlPath, shim, CONTEXT_SHIM_SCRIPT)
      await this.writeRemoteSkill(
        conn,
        controlPath,
        `${remoteHome}/.claude`,
        'get-linked-context',
        buildContextLinkSkillBody(shim)
      )
      const block = buildLinkedContextInstructions(shim)
      // codex/gemini are plain quoted literals; opencode must stay shell-expandable and so
      // carries a prelude that binds the untrusted $HOME to a variable (see the helper).
      const targets: { pathExpr: string; prelude?: string }[] = [
        { pathExpr: posixQuote(`${remoteHome}/.codex/AGENTS.md`) },
        { pathExpr: posixQuote(`${remoteHome}/.gemini/GEMINI.md`) },
        openCodeInstructionsTarget(remoteHome)
      ]
      for (const t of targets) {
        await this.mergeRemoteInstructions(conn, controlPath, t.pathExpr, block, mergeInstructionsBlock, t.prelude)
      }
    } catch {
      /* fail-open: the remote agent simply runs without context link */
    }
  }

  /** The context-link skill for a REMOTE managed-account config dir (see the canvas twin). */
  async installContextLinkSkillIntoAccountDir(
    conn: SshConnection,
    controlPath: string,
    remoteHome: string,
    accountId: string
  ): Promise<void> {
    try {
      const shim = `${remoteHome}/.nodeterm/context.sh`
      await this.writeRemoteShim(conn, controlPath, shim, CONTEXT_SHIM_SCRIPT)
      await this.writeRemoteSkill(
        conn,
        controlPath,
        `${remoteHome}/.nodeterm/claude-accounts/${accountId}`,
        'get-linked-context',
        buildContextLinkSkillBody(shim)
      )
    } catch {
      /* fail-open */
    }
  }

  private async writeRemoteShim(
    conn: SshConnection,
    controlPath: string,
    shim: string,
    body: string
  ): Promise<void> {
    const q = posixQuote(shim)
    await this.r.run(
      childArgs(conn, controlPath, `mkdir -p ${posixQuote(dirnameOf(shim))} && cat > ${q} && chmod 755 ${q}`),
      body
    )
  }

  private async writeRemoteSkill(
    conn: SshConnection,
    controlPath: string,
    configDir: string,
    name: string,
    body: string
  ): Promise<void> {
    const skill = `${configDir}/skills/${name}/SKILL.md`
    await this.r.run(
      childArgs(conn, controlPath, `mkdir -p ${posixQuote(dirnameOf(skill))} && cat > ${posixQuote(skill)}`),
      body
    )
  }

  /** Read-merge-write one marker-delimited instructions block at a remote path EXPRESSION
   *  (already quoted / shell-expandable). Everything outside the markers is preserved — including
   *  the OTHER feature's block, which is why the merge function is a parameter: canvas control and
   *  context link own different markers in the same files.
   *
   *  `prelude` is shell prepended to BOTH commands — it exists so a caller can bind an untrusted
   *  value (the host-reported `$HOME`) to a shell VARIABLE once and then refer to it as `$NT_H`
   *  inside an expression that must stay shell-expandable. See `openCodeInstructionsTarget`. */
  private async mergeRemoteInstructions(
    conn: SshConnection,
    controlPath: string,
    pathExpr: string,
    block: string,
    merge: (existing: string, block: string) => string,
    prelude = ''
  ): Promise<void> {
    try {
      const { stdout: existing } = await this.r.run(
        childArgs(conn, controlPath, `${prelude}cat ${pathExpr} 2>/dev/null || true`)
      )
      const merged = merge(existing, block)
      if (merged === existing) return
      await this.r.run(
        childArgs(conn, controlPath, `${prelude}mkdir -p "$(dirname ${pathExpr})" && cat > ${pathExpr}`),
        merged
      )
    } catch {
      /* fail-open: one unwritable instruction file must never break the connect */
    }
  }

  /**
   * Ensure `"tui": "fullscreen"` in the REMOTE host's `~/.claude/settings.json` — write-if-absent,
   * so a remote Claude session takes the alternate screen + mouse and behaves natively in the
   * host's tmux. The CALLER gates this on the host CLI being >= 2.1.89 (the remote `claude --version`
   * already cached on the connection — no second probe). `remoteHome` is the resolved remote `$HOME`
   * so the path is absolute (a literal `~` would not expand). Fail-open.
   */
  async ensureFullscreenTui(conn: SshConnection, controlPath: string, remoteHome: string): Promise<void> {
    await this.ensureFullscreenTuiAt(conn, controlPath, `${remoteHome}/.claude/settings.json`)
  }

  /** Same guardrails, for a REMOTE managed-account config dir's `settings.json`. */
  async ensureFullscreenTuiInAccountDir(
    conn: SshConnection,
    controlPath: string,
    remoteHome: string,
    accountId: string
  ): Promise<void> {
    const config = `${remoteHome}/.nodeterm/claude-accounts/${accountId}/settings.json`
    await this.ensureFullscreenTuiAt(conn, controlPath, config)
  }

  /** Read-merge-write the fullscreen-tui key at one absolute remote config path, over the master.
   *  Same read-if-present, write-only-if-changed, fail-open mechanics as the hook merge above. */
  private async ensureFullscreenTuiAt(conn: SshConnection, controlPath: string, config: string): Promise<void> {
    try {
      const { stdout: raw } = await this.r.run(
        childArgs(conn, controlPath, `cat ${posixQuote(config)} 2>/dev/null || echo '{}'`)
      )
      let cfg: TuiSettings = {}
      if (raw.trim() && raw.trim() !== '{}') {
        try {
          cfg = JSON.parse(raw) as TuiSettings
        } catch {
          // The file EXISTS but does not parse (`|| echo '{}'` only fires when it is missing):
          // never replace the user's settings with {tui:...} — same guard as the local wrapper.
          return
        }
      }
      const { config: next, changed } = ensureFullscreenTui(cfg)
      if (!changed) return // key already present (any value) → never overwrite the user's `/tui`
      await this.r.run(
        // `$(dirname …)` QUOTED, like the other three sites. Unquoted, a home with a space
        // (`/Users/Enes Kirca`) word-splits the substitution into two mkdir args — measured
        // ARGC=2 — so junk directories are created, the correctly-quoted `cat >` then fails, and
        // the catch below swallows it. Symptom: fullscreen-TUI silently never written for any
        // macOS user whose home has a space in it.
        childArgs(conn, controlPath, `mkdir -p "$(dirname ${posixQuote(config)})" && cat > ${posixQuote(config)}`),
        JSON.stringify(next, null, 2)
      )
    } catch {
      /* fail-open: a failed remote read/write must never break the connect */
    }
  }

  /**
   * Prove the forward reaches THIS app run: POST through the remote sock with the fresh token
   * and require the hook server's own 204 — the same transport (`curl --unix-socket`) the
   * managed hook script uses, run ON the host. `000`/curl-fail = the listener's target is dead
   * (a stale forward from a previous run). No `payload` field is sent, so the server records
   * nothing (its listener path needs one).
   *
   * THE BEARER GOES ON STDIN, NEVER ARGV. This used to send `-H 'x-nodeterm-hook-token: <token>'`
   * on the curl command line — and a remote command line is argv on BOTH ends: for as long as that
   * curl lives, every OTHER user on the host can read the app-wide hook bearer out of `ps` /
   * `/proc/<pid>/cmdline`. It is the same leak already measured and closed on the local side (the
   * tmux `-e` channel), just pointed at someone else's machine. `curl --config -` reads options
   * from stdin, where `header = "..."` sets the same header with nothing to see in the process
   * table; `codex-identity-proxy.ts` already uses this exact idiom, and the runner already writes
   * stdin (the endpoint-file write does).
   *
   * There is deliberately NO argv fallback for a curl too old for `--config` (it has had it since
   * the 1990s): a fallback that puts the token back on argv would simply undo this. The probe
   * failing is already a designed state — an unverified tunnel means remote agents run without
   * hooks, loudly warned — and that is strictly better than leaking the bearer.
   *
   * What counts as SUCCESS is unchanged: exit 0 and a body of exactly `204`.
   */
  private async verifyTunnel(
    conn: SshConnection,
    controlPath: string,
    sock: string,
    token: string
  ): Promise<boolean> {
    try {
      const cmd =
        `curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST --unix-socket ${posixQuote(sock)} ` +
        // `/verify` — the probe's OWN route, which answers 204 on the bearer alone and takes no
        // node identity at all. It used to POST `/hook/verify`, where it 204'd only as a side
        // effect of sending no payload; the identity label on `/hook/*` would have started judging
        // it there. `nodeId=verify` is kept in the body only so an OLDER desktop's script and this
        // one send the same bytes; the route reads nothing.
        `--config - http://localhost/verify --data nodeId=verify`
      // ONE COPY OF THE QUOTING RULE. This used to build its own `header = "…"` line, escaping `\`
      // and `"` and ignoring the two line breaks — a second, weaker version of the rule that
      // `hook-curl-config-sh.ts` states for the generated sh clients. `curlHeaderConfigLine` is
      // that same rule for a config file WE write; a rule with two copies is a rule where one copy
      // is wrong.
      const r = await this.r.run(
        childArgs(conn, controlPath, cmd),
        curlHeaderConfigLine('x-nodeterm-hook-token', token)
      )
      return r.code === 0 && r.stdout.trim() === '204'
    } catch {
      return false
    }
  }

  async teardown(projectId: string, conn: SshConnection, controlPath: string): Promise<void> {
    const spec = this.specs.get(projectId)
    this.specs.delete(projectId)
    if (!spec) return // nothing was set up (or already torn down)
    try {
      await this.r.run(hookForwardCancelArgs(conn, controlPath, spec.sock, spec.port))
    } catch {
      /* fail open */
    }
  }
}

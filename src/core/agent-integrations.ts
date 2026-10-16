// Agent-integration lifecycle (issue #744): the ONE place that decides what nodeterm writes into
// user-owned global agent configuration on THIS machine, shared by the desktop and the Server
// Edition. Consent is `settings.agentIntegrations` (`@shared/agent-integrations`).
//
// Per agent:
//   enabled   → install/refresh its status hook + its skills (canvas control, context link) in the
//               agent's OWN skills dir; strip the legacy marker blocks older builds merged into its
//               global instruction file (skills replaced them — they were ~17 KB in AGENTS.md).
//   declined  → remove exactly what we wrote: our hook entries (exact command match), our skill
//               files (exact-content receipts — a file the user edited is KEPT and reported), our
//               legacy blocks, and our hook script.
//   undecided → nothing at all, in either direction. A new install writes nothing until asked.
//
// The Server Edition's `installHooks: false` is a hard veto that outranks every choice.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import {
  INTEGRATION_AGENT_IDS,
  grandfatheredIntegrations,
  integrationsOf,
  localIntegrationSignature,
  type IntegrationAgentId
} from '../shared/agent-integrations'
import { canContextLink, canControlCanvas } from '../shared/agents/config'
import { shimDialectFor } from '../shared/agents/shim-invocation'
import type { Settings } from '../shared/types'
import { installManagedAgentHooks, removeManagedAgentHooks } from './agents/hooks'
import {
  claudeSystemConfigDir,
  ensureClaudeFullscreenTuiInto,
  installClaudeHooksInto,
  removeClaudeHooksFrom
} from './agents/hooks/claude'
import { ensureCodexHooksCurrent, ensureCodexHooksForAccounts } from './agents/hooks/codex'
import { copilotHomeDir } from './agents/hooks/copilot'
import { managedHookScriptPath } from './agents/hooks/install-helper'
import { opencodeConfigDir } from './agents/hooks/opencode'
import { grokHomeDir } from './agents/grok-paths'
import { buildCanvasSkillBody } from './canvas-control-core'
import { buildContextLinkSkillBody } from './context-link-core'
import { claudeConfigDirFor } from './claude-config-dir'
import { codexHomeForAccount, systemCodexHome } from './codex-accounts-core'
import { applySkillShare } from './claude-skill-share'
import {
  ReceiptStore,
  pushRetained,
  removeOwnedFile,
  stripLegacyBlocks,
  writeOwnedFile
} from './integration-files'

export const CANVAS_SKILL = 'manage-nodeterm-canvas'
export const CONTEXT_SKILL = 'get-linked-context'

/** Where our hook scripts live; its presence is the strongest evidence of an existing install. */
export function agentHooksDir(home: string = os.homedir()): string {
  return path.join(home, '.nodeterm', 'agent-hooks')
}

/**
 * Written to userData by the first boot that found no evidence of an existing install. Its
 * presence means "this install was new to nodeterm when it started", so no later boot may
 * grandfather it — whatever has appeared on disk since (issue #1149). A marker FILE rather than a
 * settings key: `SettingsStore.init` answers an unreadable settings.json with the defaults, and a
 * boot-time save of a "not answered yet" record would then overwrite the user's file on every such
 * boot.
 */
export const FRESH_INSTALL_MARKER = 'integration-consent-fresh-install'

/**
 * Did a build from before this feature already integrate with this machine's agents? Called once
 * per boot, before any install, and DECIDES that once: the first boot that finds no evidence
 * leaves `FRESH_INSTALL_MARKER` in userData, and every later boot of that install answers false.
 *
 * Evidence is our OWN files only (never a guess from the user's config): the managed hook scripts
 * dir, which every pre-consent install filled at boot and which nothing now writes without an
 * `'enabled'` choice. True ⇒ grandfather as enabled.
 *
 * NOT evidence: the canvas/context shims under userData (`canvas-control/nodeterm.sh`,
 * `context-links/context.sh`). Both shells write them on EVERY boot, consent or not, so counting
 * them grandfathered every fresh install on its second boot (issue #1149: a systemd restart, the
 * update timer, a desktop quit before the first-run question was answered). The marker also
 * covers hook scripts a SIBLING install (the desktop and the Server Edition share
 * `~/.nodeterm/agent-hooks`) wrote under its own consent after this install's first boot.
 */
export function detectExistingIntegrations(userDataDir: string, home: string = os.homedir()): boolean {
  const marker = path.join(userDataDir, FRESH_INSTALL_MARKER)
  let evidence = false
  try {
    evidence = readdirSync(agentHooksDir(home)).length > 0
  } catch {
    evidence = false
  }
  if (evidence) return !existsSync(marker)
  // No evidence: the answer is false whether or not an earlier boot already left the marker, so the
  // exclusive create is the only check needed (an existing marker is EEXIST).
  try {
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(
      marker,
      `First boot ${new Date().toISOString()}: no earlier nodeterm agent integration was found, so ` +
        'this install is never grandfathered into one. Agent integrations are enabled only from ' +
        'the first-run question or Settings → Agents (issue #1149).\n',
      { flag: 'wx', mode: 0o600 }
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      console.warn('[integrations] could not record the fresh-install marker', error)
    }
  }
  return false
}

/**
 * Resolve the consent record at boot, BEFORE any install and before the renderer loads settings.
 * Returns the settings to persist when the record had to be created (grandfathering), else null.
 * A new install (no evidence) gets no record: it is asked at first launch.
 */
export function resolveIntegrationConsentAtBoot(settings: Settings, existingInstall: boolean): Settings | null {
  const s = integrationsOf(settings)
  if (s.origin || Object.keys(s.agents ?? {}).length > 0) return null
  if (!existingInstall) return null
  return { ...settings, agentIntegrations: { ...grandfatheredIntegrations(), ...s, origin: 'grandfathered' } }
}

export interface IntegrationShims {
  /** The canvas-control shim the canvas skill points at; absent = canvas control is off here
   *  (Server Edition without `--canvas-control`), so no canvas skill is installed. */
  canvas?: string
  /** The context-link shim. */
  context: string
}

export interface IntegrationReport {
  enabled: IntegrationAgentId[]
  declined: IntegrationAgentId[]
  /** Files we kept because the user changed them since we wrote them (bounded). */
  retained: string[]
  vetoed: boolean
}

export interface IntegrationLifecycleDeps {
  settings: () => Settings
  userDataDir: () => string
  shims: () => IntegrationShims
  /** Server Edition `installHooks: false`: nothing global is ever written or removed. */
  veto?: boolean
  /** Test seams. */
  installHooks?: (agents: ReadonlySet<string>) => void
  removeHooks?: (agents: ReadonlySet<string>) => void
  ensureCodexHome?: (home: string) => void
  ensureCodexAccounts?: (userDataDir: string, accounts: ReadonlyArray<{ id: string }>) => void
  home?: () => string
}

/** The skills dirs one agent reads, for THIS machine. Measured 2026-10-03: codex 0.156.1 reads
 *  `$CODEX_HOME/skills`, gemini 0.62.0 `~/.gemini/skills` (`gemini skills list`), opencode 1.18.33
 *  `<config>/skills` (`opencode debug skill`), copilot 1.0.89 `~/.copilot/skills` (`copilot skill
 *  --help`), grok 1.0.44 `$GROK_HOME/skills` (binary strings), claude `<config dir>/skills`. */
export function skillRootsFor(
  agent: IntegrationAgentId,
  settings: Settings,
  userDataDir: string,
  home: string = os.homedir()
): string[] {
  switch (agent) {
    case 'claude': {
      const roots = [claudeSystemConfigDir()]
      for (const a of settings.claudeAccounts ?? []) {
        if (a.host || a.pending) continue
        try {
          roots.push(claudeConfigDirFor(a.id))
        } catch {
          /* an id outside the alphabet is skipped */
        }
      }
      return [...new Set(roots)].map((d) => path.join(d, 'skills'))
    }
    case 'codex': {
      const roots = [systemCodexHome()]
      for (const a of settings.codexAccounts ?? []) {
        if (a.host || a.pending) continue
        try {
          roots.push(codexHomeForAccount(userDataDir, a.id))
        } catch {
          /* skipped */
        }
      }
      return [...new Set(roots)].map((d) => path.join(d, 'skills'))
    }
    case 'gemini':
      return [path.join(process.env.GEMINI_CLI_HOME || home, '.gemini', 'skills')]
    case 'grok':
      return [path.join(grokHomeDir(), 'skills')]
    case 'copilot':
      return [path.join(copilotHomeDir(), 'skills')]
    case 'opencode':
      return [path.join(opencodeConfigDir(), 'skills')]
    default:
      return []
  }
}

/**
 * The skills one agent gets, as (file name → body). `hostPlatform` is THIS machine's — these skills
 * are written into its own config dirs and point at its own shims — and it picks the invocation:
 * on Windows every agent but claude is told to run the `.cmd` launcher (`shimDialectFor`). The SSH
 * installers build their bodies themselves, without a dialect, so a host always gets `sh`.
 */
export function skillsFor(
  agent: IntegrationAgentId,
  shims: IntegrationShims,
  hostPlatform: string = process.platform
): Map<string, string> {
  const out = new Map<string, string>()
  const dialect = shimDialectFor(agent, hostPlatform)
  if (shims.canvas && canControlCanvas(agent)) out.set(CANVAS_SKILL, buildCanvasSkillBody(shims.canvas, dialect))
  if (canContextLink(agent)) out.set(CONTEXT_SKILL, buildContextLinkSkillBody(shims.context, dialect))
  return out
}

/** The global instruction files older builds merged discovery blocks into, per agent. */
export function legacyInstructionFiles(agent: IntegrationAgentId, home: string = os.homedir()): string[] {
  switch (agent) {
    case 'codex':
      return [...new Set([path.join(home, '.codex', 'AGENTS.md'), path.join(systemCodexHome(), 'AGENTS.md')])]
    case 'gemini':
      return [path.join(home, '.gemini', 'GEMINI.md')]
    case 'copilot':
      return [path.join(copilotHomeDir(), 'copilot-instructions.md')]
    case 'opencode':
      return [path.join(opencodeConfigDir(), 'AGENTS.md')]
    default:
      return []
  }
}

// Every file a declined agent loses, Windows wrappers included (`windowsHookWrapperFile`: the
// `.cmd` that PowerShell-run hooks call). A wrapper left behind would outlive its script harmlessly
// (it drains and exits 0), but "remove exactly what we wrote" means all of it.
const HOOK_SCRIPTS: Partial<Record<IntegrationAgentId, string[]>> = {
  claude: ['claude.sh'],
  codex: ['codex.sh', 'codex-hook.cmd'],
  gemini: ['gemini.sh', 'gemini-hook.cmd'],
  grok: ['grok.sh', 'grok-hook.cmd'],
  copilot: ['copilot.sh', 'copilot-hook.cmd'],
  antigravity: ['antigravity.sh', 'antigravity-hook.cmd']
}

export interface IntegrationLifecycle {
  /** Bring this machine to the current consent. Idempotent; never throws. */
  reconcile(): IntegrationReport
  /** Re-reconcile only when the consent (or the local account list) changed. */
  onSettingsChanged(settings: Settings): void
  /** For a managed/linked Claude account dir just added: install there if claude is enabled. */
  installIntoClaudeAccount(configDir: string): void
  /** Right before a LOCAL Codex session spawns under `codexHome`: repair its hook install if it
   *  drifted — only when codex is enabled (never for a declined or undecided agent, never under the
   *  veto). Never throws. */
  ensureCodexHooksForLaunch(codexHome: string): void
  /** The last report (for Settings). */
  lastReport(): IntegrationReport | null
  /** The ownership receipts (also used for skills written on SSH hosts). */
  receipts: ReceiptStore
}

function accountSignature(s: Settings): string {
  const c = (s.claudeAccounts ?? []).filter((a) => !a.host && !a.pending).map((a) => a.id)
  const x = (s.codexAccounts ?? []).filter((a) => !a.host && !a.pending).map((a) => a.id)
  return `${c.join(',')}|${x.join(',')}`
}

export function createIntegrationLifecycle(deps: IntegrationLifecycleDeps): IntegrationLifecycle {
  const receipts = new ReceiptStore(() => deps.userDataDir())
  const installHooks = deps.installHooks ?? installManagedAgentHooks
  const removeHooks = deps.removeHooks ?? removeManagedAgentHooks
  const ensureCodexHome = deps.ensureCodexHome ?? ensureCodexHooksCurrent
  const ensureCodexAccounts = deps.ensureCodexAccounts ?? ensureCodexHooksForAccounts
  let last: IntegrationReport | null = null
  let lastSig = ''

  const reconcile = (): IntegrationReport => {
    const settings = deps.settings()
    const home = deps.home?.() ?? os.homedir()
    const s = integrationsOf(settings)
    const enabled = INTEGRATION_AGENT_IDS.filter((a) => s.agents?.[a] === 'enabled')
    const declined = INTEGRATION_AGENT_IDS.filter((a) => s.agents?.[a] === 'declined')
    const report: IntegrationReport = { enabled, declined, retained: [], vetoed: !!deps.veto }
    lastSig = `${localIntegrationSignature(settings)}|${accountSignature(settings)}`
    if (deps.veto) {
      last = report
      return report
    }
    let shims: IntegrationShims
    try {
      shims = deps.shims()
    } catch {
      shims = { context: '' }
    }
    // Hooks.
    try {
      if (enabled.length) installHooks(new Set(enabled))
    } catch (e) {
      console.warn('[integrations] hook install failed', e)
    }
    try {
      if (declined.length) removeHooks(new Set(declined))
    } catch (e) {
      console.warn('[integrations] hook removal failed', e)
    }
    // Claude accounts: every local managed/linked dir carries its own settings.json.
    for (const a of settings.claudeAccounts ?? []) {
      if (a.host || a.pending) continue
      let dir: string
      try {
        dir = claudeConfigDirFor(a.id)
      } catch {
        continue
      }
      try {
        if (enabled.includes('claude')) {
          installClaudeHooksInto(dir)
          void ensureClaudeFullscreenTuiInto(dir)
        } else if (declined.includes('claude')) {
          removeClaudeHooksFrom(dir)
        }
      } catch (e) {
        console.warn(`[integrations] claude account ${a.id} failed`, e)
      }
      // Shared system skills (issue #643) is its own explicit, per-account opt-in, independent of
      // this consent (it links INTO the account dir, never writes the user's skills).
      if (a.shareSystemSkills) void applySkillShare(dir, true)
    }
    // Codex accounts: each local managed home is its own CODEX_HOME. Its hooks.json/config.toml
    // normally symlink to the system ones (just installed above), but a link never made or since
    // replaced by a real file leaves that account's sessions with no trusted hooks. Drift-gated, so
    // a linked home costs reads only. Enabled only — a declined codex is cleaned in the system home
    // by `removeHooks`; a private copy inside an account home is the account's own file and is left.
    if (enabled.includes('codex')) {
      try {
        ensureCodexAccounts(
          deps.userDataDir(),
          (settings.codexAccounts ?? []).filter((a) => !a.host && !a.pending)
        )
      } catch (e) {
        console.warn('[integrations] codex account hook check failed', e)
      }
    }
    // A $CLAUDE_CONFIG_DIR that moved the system dir leaves the legacy ~/.claude behind.
    const legacyClaude = path.join(home, '.claude')
    if (declined.includes('claude') && legacyClaude !== claudeSystemConfigDir()) {
      try {
        removeClaudeHooksFrom(legacyClaude)
      } catch {
        /* fail open */
      }
    }
    // Skills + legacy blocks.
    for (const agent of [...enabled, ...declined]) {
      const on = enabled.includes(agent)
      const skills = skillsFor(agent, shims)
      for (const root of skillRootsFor(agent, settings, deps.userDataDir(), home)) {
        for (const name of [CANVAS_SKILL, CONTEXT_SKILL]) {
          const file = path.join(root, name, 'SKILL.md')
          const body = skills.get(name)
          if (on && body !== undefined) {
            if (writeOwnedFile(receipts, file, body) === 'retained') pushRetained(report.retained, file)
          } else if (!on) {
            const known = [...skills.values()]
            if (removeOwnedFile(receipts, file, known) === 'retained') pushRetained(report.retained, file)
          }
        }
      }
      for (const f of legacyInstructionFiles(agent, home)) {
        if (stripLegacyBlocks(f) === 'failed') console.warn('[integrations] could not clean', f)
      }
      if (!on) {
        for (const script of HOOK_SCRIPTS[agent] ?? []) {
          try {
            rmSync(managedHookScriptPath(script), { force: true })
          } catch {
            /* ours, but not removable right now */
          }
        }
      }
    }
    // A declined claude also loses its skills in the legacy ~/.claude (pre-$CLAUDE_CONFIG_DIR).
    if (declined.includes('claude') && legacyClaude !== claudeSystemConfigDir()) {
      for (const name of [CANVAS_SKILL, CONTEXT_SKILL]) {
        const file = path.join(legacyClaude, 'skills', name, 'SKILL.md')
        if (removeOwnedFile(receipts, file, [...skillsFor('claude', shims).values()]) === 'retained') {
          pushRetained(report.retained, file)
        }
      }
    }
    if (report.retained.length) {
      console.warn(`[integrations] kept ${report.retained.length} file(s) you changed: ${report.retained.join(', ')}`)
    }
    last = report
    return report
  }

  const safeReconcile = (): IntegrationReport => {
    try {
      return reconcile()
    } catch (e) {
      console.warn('[integrations] reconcile failed', e)
      return last ?? { enabled: [], declined: [], retained: [], vetoed: !!deps.veto }
    }
  }

  return {
    reconcile: safeReconcile,
    onSettingsChanged(settings) {
      const sig = `${localIntegrationSignature(settings)}|${accountSignature(settings)}`
      if (sig !== lastSig) safeReconcile()
    },
    installIntoClaudeAccount(configDir) {
      if (deps.veto) return
      if (integrationsOf(deps.settings()).agents?.claude !== 'enabled') return
      try {
        installClaudeHooksInto(configDir)
        void ensureClaudeFullscreenTuiInto(configDir)
        const shims = deps.shims()
        for (const [name, body] of skillsFor('claude', shims)) {
          writeOwnedFile(receipts, path.join(configDir, 'skills', name, 'SKILL.md'), body)
        }
      } catch (e) {
        console.warn('[integrations] account install failed', configDir, e)
      }
    },
    ensureCodexHooksForLaunch(codexHome) {
      if (deps.veto) return
      try {
        if (integrationsOf(deps.settings()).agents?.codex !== 'enabled') return
        ensureCodexHome(codexHome)
      } catch (e) {
        console.warn('[integrations] codex launch hook check failed', codexHome, e)
      }
    },
    lastReport: () => last,
    receipts
  }
}

// The lifecycle the running shell booted. Account add/link (core/claude-accounts-service.ts) asks
// it; with none registered (a test, a shell that has not booted it) NOTHING is written — the
// fail-closed direction.
let current: IntegrationLifecycle | null = null
export function registerIntegrationLifecycle(lc: IntegrationLifecycle | null): void {
  current = lc
}
export function currentIntegrationLifecycle(): IntegrationLifecycle | null {
  return current
}

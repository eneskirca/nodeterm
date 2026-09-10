// Context Link — lets two agent nodes on the canvas read each other's context on demand.
//
// Connecting two agent nodes means "these two may READ each other." No messages flow. The
// renderer pushes the current link map to main (context-link:set-links); main builds one link
// document per node (linked nodes' titles, transcript paths learned from hooks, cwds, tmux
// session names) and answers reads over the hook server's /context-link/ route. A POSIX-sh shim
// (context.sh) is the client; globally-installed agent skills (plus instruction blocks for the
// agents that do not scan the shared skill paths) tell the agent how + when to call it. The local
// shim is built with the shared-Codex thread resolver before its node-id gate; the SSH installer
// keeps the machine-neutral body because this machine's ownership-record path is meaningless on
// the host.
//
// The reading and parsing happen HERE, on the desktop, not in the CLI. That is what lets an SSH
// project's remote agent use the feature at all: its transcripts live on the host, reachable over
// the project's ControlMaster (injected as `deps`), and its terminal is captured by a PtyManager
// that already knows the difference. The link documents are also still written to
// <userData>/context-links/ as a debugging aid.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { platform } from './platform'
import { IPC } from '../shared/ipc'
import type { ContextLinkMap } from '../shared/types'
import { type PtyManager } from './pty-manager'
import { TMUX_SOCKET } from './tmux-naming'
import {
  buildContextShimScript,
  buildContextLinkSkillBody,
  buildLinkDoc,
  buildLinkedContextInstructions,
  mergeInstructionsBlock,
  resolveLinkTranscript,
  transcriptPathOf,
  type LinkDoc,
  type LinkDocEntry
} from './context-link-core'
import { codexThreadIdentityRoot } from './codex-identity-proxy'
import {
  CONTEXT_LINK_VERBS,
  renderContextLink,
  type ContextLinkFetch,
  type ContextLinkVerb
} from './context-link-render'
import { hookServer } from './agents/hook-server'
import { locateClaude, locateCodex, locateGemini, locateGrok } from './handoff/locate'
import { opencodeConfigDir } from './agents/hooks/opencode'

export { setNodeTranscript } from './context-link-core'

let dir = ''
export function contextLinkDir(): string {
  if (!dir) dir = path.join(platform().userDataDir, 'context-links')
  return dir
}
function cliShimPath(): string {
  return path.join(contextLinkDir(), 'context.sh')
}
function skillPaths(): Array<{ path: string; requiresParent?: string }> {
  const home = os.homedir()
  return [
    { path: path.join(home, '.claude', 'skills', 'get-linked-context', 'SKILL.md') },
    // Shared Agent Skills is intentionally visible to every tool that scans ~/.agents/skills.
    // Do not create that third-party root: install only when a user/tool already owns it.
    {
      path: path.join(home, '.agents', 'skills', 'get-linked-context', 'SKILL.md'),
      requiresParent: path.join(home, '.agents')
    },
    // AGY CLI global skills path (distinct from Gemini CLI's ~/.gemini/skills).
    {
      path: path.join(
        home,
        '.gemini',
        'antigravity-cli',
        'skills',
        'get-linked-context',
        'SKILL.md'
      ),
      requiresParent: path.join(home, '.gemini', 'antigravity-cli')
    }
  ]
}

function writeCliFiles(): void {
  const d = contextLinkDir()
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(cliShimPath(), buildContextShimScript(codexThreadIdentityRoot()))
  try {
    fs.chmodSync(cliShimPath(), 0o755)
  } catch {
    /* fail open */
  }
  // Sweep the retired Electron-as-Node CLI off upgraders' disks: the shim no longer execs it,
  // and it would sit there pointing at a binary path that moves with every app update.
  try {
    fs.rmSync(path.join(d, 'context-cli.mjs'), { force: true })
  } catch {
    /* fail open */
  }
}

function installSkill(): void {
  const body = buildContextLinkSkillBody(cliShimPath())
  for (const target of skillPaths()) {
    if (target.requiresParent && !fs.existsSync(target.requiresParent)) continue
    try {
      fs.mkdirSync(path.dirname(target.path), { recursive: true })
      fs.writeFileSync(target.path, body, 'utf8')
    } catch (e) {
      console.warn('[context-link] skill install failed', target.path, e)
    }
  }
}

// Codex/Gemini/opencode have no skill system — merge an instructions block into their global
// instruction files instead (marker-delimited, idempotent, other content preserved).
function installAgentInstructions(): void {
  const block = buildLinkedContextInstructions(cliShimPath())
  const targets = [
    path.join(os.homedir(), '.codex', 'AGENTS.md'),
    path.join(os.homedir(), '.gemini', 'GEMINI.md'),
    path.join(opencodeConfigDir(), 'AGENTS.md')
  ]
  for (const p of targets) {
    try {
      let existing = ''
      try {
        existing = fs.readFileSync(p, 'utf8')
      } catch {
        /* new file */
      }
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, mergeInstructionsBlock(existing, block), 'utf8')
    } catch (e) {
      console.warn('[context-link] instructions install failed', p, e)
    }
  }
}

let pty: PtyManager | undefined
let deps: ContextLinkDeps = {}

/**
 * The shell-specific reach the reads need. Everything here is about ONE question — is this node
 * on a remote host, and if so how do I reach it — which `src/core` must not answer for itself
 * (SshProjectManager and the ControlMaster wiring are desktop-only). The Server Edition passes
 * nothing and gets the local-only behavior it had before.
 */
export interface ContextLinkDeps {
  /** True when the node is a live session on an SSH project's remote host. */
  isRemoteNode?: (nodeId: string) => boolean
  /** Read (at most `maxBytes` of) a file on a remote node's host. null = unreadable. */
  readRemoteFile?: (nodeId: string, filePath: string, maxBytes: number) => Promise<string | null>
  /** Run one command on a remote node's host and return stdout. null = it failed. */
  runRemoteCommand?: (nodeId: string, command: string) => Promise<string | null>
}

// Remote transcripts are read from the END: a long-running session's file reaches tens of MB,
// and the whole thing would cross an ssh channel for a `summary` that shows 15 lines. A tail can
// start mid-line, which only costs that one line (it fails to parse and is dropped).
const REMOTE_TRANSCRIPT_MAX_BYTES = 2 * 1024 * 1024

const LINK_LOCATORS = { claude: locateClaude, codex: locateCodex, gemini: locateGemini, grok: locateGrok }

// The link documents, by node id — the same objects written to disk, kept in memory because they
// are what authorizes a read (a node may only ever name a link inside ITS OWN document).
const linkDocs = new Map<string, LinkDoc>()

// Write one enriched link file per node id present in the map. Removed links should not
// linger, so we clear stale per-node files first. Async fs throughout — this runs on edge
// changes and scales with node/link count, and sync I/O here sits on the main event loop.
async function writeLinkFiles(map: ContextLinkMap): Promise<void> {
  const d = contextLinkDir()
  const bin = pty?.getTmuxBin() ?? null
  try {
    for (const f of await fs.promises.readdir(d)) {
      if (f.endsWith('.json')) await fs.promises.rm(path.join(d, f), { force: true })
    }
  } catch {
    /* dir may not exist yet */
  }
  // Resolve each linked node's transcript once (hook-fed for claude, locator-by-sessionId
  // for codex/gemini), so buildLinkDoc stays pure and sync.
  const resolved = new Map<string, string>()
  for (const links of Object.values(map)) {
    for (const n of links) {
      if (n.note != null || resolved.has(n.id)) continue
      resolved.set(
        n.id,
        await resolveLinkTranscript(n, {
          hooked: transcriptPathOf,
          locators: LINK_LOCATORS,
          isRemote: deps.isRemoteNode
        })
      )
    }
  }
  linkDocs.clear()
  for (const [nodeId, links] of Object.entries(map)) {
    const doc = buildLinkDoc(nodeId, links, {
      transcriptOf: (id) => resolved.get(id) ?? '',
      tmuxBin: bin,
      tmuxSocket: TMUX_SOCKET
    })
    linkDocs.set(nodeId, doc)
    try {
      await fs.promises.writeFile(path.join(d, `${nodeId}.json`), JSON.stringify(doc, null, 2))
    } catch (e) {
      console.warn('[context-link] write link file failed', e)
    }
  }
}

/** Read a linked node's transcript bytes — from the remote host when it lives there, else from
 *  this machine's disk. null when there is no path yet or it could not be read. */
async function fetchTranscript(node: LinkDocEntry): Promise<string | null> {
  if (!node.transcriptPath) return null
  if (deps.isRemoteNode?.(node.id)) {
    // The path was jailed at ingest (isSafeRemoteTranscriptPath, where the hook payload arrives),
    // so what reaches here is already confined to the host's transcript roots.
    return deps.readRemoteFile
      ? await deps.readRemoteFile(node.id, node.transcriptPath, REMOTE_TRANSCRIPT_MAX_BYTES)
      : null
  }
  try {
    return await fs.promises.readFile(node.transcriptPath, 'utf-8')
  } catch {
    return null
  }
}

async function fetchOpencodeExport(node: LinkDocEntry): Promise<string | null> {
  if (!node.sessionId) return null
  if (deps.isRemoteNode?.(node.id)) {
    return deps.runRemoteCommand
      ? await deps.runRemoteCommand(node.id, `opencode export ${shellQuote(node.sessionId)}`)
      : null
  }
  try {
    const { execFile } = await import('node:child_process')
    return await new Promise<string | null>((resolve) => {
      execFile('opencode', ['export', node.sessionId ?? ''], { encoding: 'utf-8' }, (err, stdout) =>
        resolve(err ? null : stdout)
      )
    })
  } catch {
    return null
  }
}

/** Single-quote for a POSIX shell. The session id reaches a remote command line, and it is
 *  ultimately provider-supplied data — never interpolate it raw. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

const fetchers: ContextLinkFetch = {
  transcript: fetchTranscript,
  // captureSession already knows a remote node's tmux lives on the host, so this one call
  // covers both surfaces.
  terminal: async (node) => (pty ? await pty.captureSession(node.id) : ''),
  opencodeExport: fetchOpencodeExport
}

/**
 * Answer one /context-link/ request. AUTHORIZATION: the document is chosen by the REQUESTER's
 * node id and `pickLinkNode` (inside renderContextLink) will only ever return a node listed in
 * it — so a caller that holds the hook token still cannot read a node it was never linked to.
 * The token remains the outer boundary, exactly as it is for status hooks.
 */
export async function handleContextLinkRequest(req: {
  verb: string
  nodeId: string
  args: Record<string, string>
}): Promise<string> {
  if (!req.nodeId) return 'Not a nodeterm session — nothing to read.'
  if (!CONTEXT_LINK_VERBS.includes(req.verb as ContextLinkVerb)) {
    return 'Unknown command. Use: list | summary [--node X] [-n N] | transcript [--node X] | terminal [--node X]'
  }
  const doc = linkDocs.get(req.nodeId)
  if (!doc) {
    return 'No linked nodes. Draw a context-link edge from this node to another on the canvas.'
  }
  try {
    return await renderContextLink(doc, req.verb as ContextLinkVerb, req.args, fetchers)
  } catch (e) {
    console.warn('[context-link] read failed', e)
    return 'Could not read linked context.'
  }
}

// Serialize writes: writeLinkFiles is a multi-step async clear-then-write; two overlapping
// calls could interleave (B's clear runs before A's writes land) and leave a just-removed
// link file behind — which is a read-authorization leak, not just a perf nit.
let writeChain: Promise<void> = Promise.resolve()

/**
 * Replace the WHOLE link map (every project) and rewrite the per-node link files.
 *
 * The desktop reaches this over IPC, from the renderer that owns the canvas. The Server Edition
 * has no such renderer — it derives the map from persisted project files and calls this directly
 * (src/server/context-link.ts), which is why the map setter is a function and not only a handler.
 */
export function setContextLinks(map: ContextLinkMap): Promise<void> {
  writeChain = writeChain.then(() => writeLinkFiles(map && typeof map === 'object' ? map : {}))
  return writeChain
}

/**
 * Boot Context Link: register the hook-server read handler, (re)write the shim under `dataDir`,
 * and — only when `options.installAgentIntegrations` says so — install the discovery surface into
 * the machine's REAL agent configuration directories (`~/.claude/skills/get-linked-context`, plus
 * the marker block in `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md` and opencode's `AGENTS.md`).
 *
 * `options` is REQUIRED and its flag is a plain `boolean`, deliberately: those instruction files
 * belong to the user and are loaded by every agent session on the machine, ours or not, so
 * writing them is a decision each caller owes an answer to (issue #490). The previous shape —
 * an optional options bag whose flag was read as `!== false` — meant the WRITE was what you got
 * by saying nothing, which is the wrong default direction for a filesystem effect outside our own
 * data dir, and it is exactly how a unit test that never thought about `HOME` came to rewrite the
 * developer's own `~/.codex/AGENTS.md` on every run. Same asymmetry as
 * `session-memory-service.ts`'s required `remote.isRemoteProject`: acting-without-knowing is a
 * compile error. `platformDeps` lost its default with it — every caller already passes one, and a
 * defaulted parameter in front of a required one is unreachable anyway.
 */
export function initContextLink(
  ptyManager: PtyManager,
  platformDeps: ContextLinkDeps,
  options: { installAgentIntegrations: boolean }
): void {
  pty = ptyManager
  deps = platformDeps
  linkDocs.clear()
  hookServer.setContextLinkHandler(handleContextLinkRequest)
  try {
    const d = contextLinkDir()
    fs.mkdirSync(d, { recursive: true })
    for (const f of fs.readdirSync(d)) {
      if (f.endsWith('.json')) fs.rmSync(path.join(d, f), { force: true })
    }
    writeCliFiles()
    if (options.installAgentIntegrations) {
      installSkill()
      installAgentInstructions()
    }
  } catch (e) {
    console.error('[context-link] setup failed', e)
    return
  }
  platform().handle(IPC.contextLinkSetLinks, (map: ContextLinkMap) => setContextLinks(map))
  platform().handle(IPC.contextLinkInfo, () => ({ shimPath: cliShimPath() }))
}

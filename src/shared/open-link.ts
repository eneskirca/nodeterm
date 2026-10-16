// `nodeterm://` LINKS — the parser. Pure: no electron, no fs (main does the checks that need a disk).
//
// An app outside nodeterm (a review tool, a script, a bookmark) has no node identity, so canvas control
// refuses it by design. A link does not weaken that: it proves NOTHING about who sent it — any web
// page can build one. It only FILLS IN a form, and the human approves every `open` link in a confirm
// sheet before anything is created. So this parser is strict on shape and size, and every value it
// returns is treated as hostile text by everyone downstream:
//
//  - unknown params, a param given twice, an over-cap value, a relative path → the whole link is
//    refused (a typo in a link is a refusal the caller can see, never a silently dropped option);
//  - none of canvas control's power flags exist here (count, group, after, run-now, model, issue,
//    permission mode): a link opens ONE node in its project's default permission mode, and can never
//    ask for a looser one;
//  - `source` is a display label only. Nothing may branch on it.
//
// `nodeterm://pair?code=…` and `nodeterm://join?code=…` are recognised and handed back verbatim so
// the app can route them to its existing pairing / join flows, which have their own approval.
// Design: docs/superpowers/specs/2026-10-13-open-link-design.md.

import { BUILTIN_AGENT_IDS, type BuiltinAgentId } from './agents/config'

export const OPEN_LINK_SCHEME = 'nodeterm:'

/** The agents a link may open: the builtins, plus a plain terminal. */
export type OpenLinkAgent = BuiltinAgentId | 'terminal'

/** Caps, after decoding. Prompt and paths in UTF-8 bytes, labels in code points. */
export const OPEN_LINK_LIMITS = {
  /** The whole raw URL. Larger than every cap below combined after %-encoding, small enough that
   *  nothing pathological reaches the decoder. */
  url: 48 * 1024,
  prompt: 8 * 1024,
  /** `prompt-file` content, checked by main when the file is read. */
  promptFile: 64 * 1024,
  path: 4096,
  title: 80,
  source: 40,
  projectId: 200,
  /** A pairing offer / join code (base64url JSON). */
  code: 8 * 1024
} as const

export interface OpenLinkRequest {
  agent: OpenLinkAgent
  /** A project id from the workspace index. */
  project?: string
  /** Absolute path: the project whose cwd is exactly this. */
  projectCwd?: string
  /** Absolute path: where the node runs. Defaults to the chosen project's cwd. */
  cwd?: string
  /** The agent's first message (≤ 8 KB). */
  prompt?: string
  /** Absolute path to a file holding the first message, read by main on accept. */
  promptFile?: string
  title?: string
  /** UNVERIFIED display label. */
  source?: string
}

export type ParsedLink =
  | { kind: 'open'; request: OpenLinkRequest }
  | { kind: 'pair' | 'join'; url: string }

export type ParseLinkResult = { ok: true; link: ParsedLink } | { ok: false; reason: string }

const OPEN_PARAMS = ['agent', 'project', 'project-cwd', 'cwd', 'prompt', 'prompt-file', 'title', 'source'] as const
type OpenParam = (typeof OPEN_PARAMS)[number]

const refuse = (reason: string): ParseLinkResult => ({ ok: false, reason })

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length
const codePoints = (s: string): number => Array.from(s).length

// C0 (except tab/newline/CR), DEL and C1 — never legitimate in a link value. A prompt keeps tab and
// newlines (a multi-line brief); every other value refuses those too.
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_WS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/
// eslint-disable-next-line no-control-regex
const ANY_CONTROL = /[\u0000-\u001f\u007f-\u009f]/
// Bidi and zero-width formatting controls: a label must render as what it says.
const FORMAT_CONTROL = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/
// Text a human cannot see but a model reads: every format character (bidi overrides, zero-width
// characters, Unicode TAG characters U+E0000–E007F — "ASCII smuggling"), plus C1. ZWJ (U+200D) is
// allowed, so an emoji sequence in a prompt survives. One character class, no backtracking.
const HIDDEN_TEXT = /[\u0080-\u009f]|(?!\u200d)\p{Cf}/u

/** Would part of this text be invisible or reordered in the sheet? Shared with main's prompt-file
 *  check, so the inline prompt and a file's text follow one rule. */
export function hasHiddenText(s: string): boolean {
  return HIDDEN_TEXT.test(s)
}

/** A refusal echoes link text: keep it short (the whole link may be 48 KB). */
const clip = (s: string): string => {
  const cps = Array.from(s)
  return cps.length > 40 ? `${cps.slice(0, 40).join('')}…` : s
}

/** `+` is a space (form encoding: what `URLSearchParams` and most link builders emit), then %-decode.
 *  A malformed escape refuses rather than passing the raw text through. */
function decodeValue(raw: string): string | null {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '))
  } catch {
    return null
  }
}

/**
 * Absolute on THIS machine's dialects: POSIX `/…`, or a Windows drive path `C:\…` / `C:/…`.
 * Refused: relative paths, `~` (the shell's, not ours), UNC `\\server\share` (a read there reaches
 * another machine over SMB), and any `.`/`..` segment — an absolute path never needs one, and
 * refusing it keeps "the path the sheet shows" equal to "the path that is opened".
 *
 * A POSIX-form path may not contain a backslash: Windows reads `/\host\share` as the UNC path
 * `\\host\share`, and main stats a link's paths before the sheet appears, so that alone would
 * make Windows connect (and authenticate) to another machine. For the same reason the macOS
 * automount roots `/net` and `/Network` are refused. Hidden or reordering characters are refused so
 * the path on screen is the path opened.
 */
export function isAcceptableAbsolutePath(p: string): boolean {
  if (!p || utf8Bytes(p) > OPEN_LINK_LIMITS.path || ANY_CONTROL.test(p) || hasHiddenText(p)) return false
  if (/^\/(?:net|network)(?:\/|$)/i.test(p)) return false
  const posix = p.startsWith('/') && !p.startsWith('//') && !p.includes('\\')
  const win = /^[A-Za-z]:[\\/]/.test(p)
  if (!posix && !win) return false
  const segments = (win ? p.slice(3) : p.slice(1)).split(/[\\/]/)
  return !segments.some((s) => s === '.' || s === '..')
}

function isOpenLinkAgent(a: string): a is OpenLinkAgent {
  return a === 'terminal' || (BUILTIN_AGENT_IDS as readonly string[]).includes(a)
}

/** Split the query into decoded pairs. Refuses a duplicate key and a malformed escape. Empty
 *  segments (`a=1&&b=2`, a trailing `&`) are ignored. */
function readQuery(query: string): Map<string, string> | string {
  const out = new Map<string, string>()
  for (const part of query.split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const rawKey = eq === -1 ? part : part.slice(0, eq)
    const rawVal = eq === -1 ? '' : part.slice(eq + 1)
    const key = decodeValue(rawKey)
    const val = decodeValue(rawVal)
    if (key === null || val === null) return 'it is not correctly encoded'
    if (out.has(key)) return `"${key}" is given more than once`
    out.set(key, val)
  }
  return out
}

/** Parse a `nodeterm://` URL. Never throws. */
export function parseNodetermLink(input: unknown): ParseLinkResult {
  if (typeof input !== 'string') return refuse('the link is not text')
  const url = input.trim()
  if (url.length > OPEN_LINK_LIMITS.url) return refuse('the link is too long')
  if (url.slice(0, OPEN_LINK_SCHEME.length + 2).toLowerCase() !== `${OPEN_LINK_SCHEME}//`) {
    return refuse('it is not a nodeterm:// link')
  }
  if (url.includes('#')) return refuse('it has a fragment (#)')
  const rest = url.slice(OPEN_LINK_SCHEME.length + 2)
  const q = rest.indexOf('?')
  // `nodeterm://open?…` and `nodeterm://open/?…` both name the host `open`.
  const host = (q === -1 ? rest : rest.slice(0, q)).replace(/\/$/, '').toLowerCase()
  const query = q === -1 ? '' : rest.slice(q + 1)

  if (host === 'pair' || host === 'join') {
    const params = readQuery(query)
    if (typeof params === 'string') return refuse(`the ${host} link: ${params}`)
    for (const key of params.keys()) {
      if (key !== 'code') return refuse(`the ${host} link has an unknown parameter "${clip(key)}"`)
    }
    const code = params.get('code')
    if (!code) return refuse(`the ${host} link has no code`)
    if (code.length > OPEN_LINK_LIMITS.code || ANY_CONTROL.test(code)) return refuse(`the ${host} code is not valid`)
    // Rebuilt from the decoded code so the existing decoders see the canonical prefix form.
    return { ok: true, link: { kind: host, url: `nodeterm://${host}?code=${code}` } }
  }
  if (host !== 'open') return refuse(host ? `nodeterm://${host} is not a link nodeterm opens` : 'it names no action')

  const params = readQuery(query)
  if (typeof params === 'string') return refuse(params)
  for (const key of params.keys()) {
    if (!(OPEN_PARAMS as readonly string[]).includes(key)) return refuse(`unknown parameter "${clip(key)}"`)
  }
  const get = (k: OpenParam): string | undefined => params.get(k)

  const agent = get('agent')
  if (!agent) return refuse('it does not say which agent to open (agent=)')
  if (!isOpenLinkAgent(agent)) return refuse(`"${clip(agent)}" is not an agent nodeterm can open`)

  const request: OpenLinkRequest = { agent }

  const project = get('project')
  const projectCwd = get('project-cwd')
  if (project !== undefined && projectCwd !== undefined) {
    return refuse('"project" and "project-cwd" cannot be combined')
  }
  if (project !== undefined) {
    if (!project || project.length > OPEN_LINK_LIMITS.projectId || ANY_CONTROL.test(project) || FORMAT_CONTROL.test(project) || hasHiddenText(project)) {
      return refuse('"project" is not a valid project id')
    }
    request.project = project
  }
  if (projectCwd !== undefined) {
    if (!isAcceptableAbsolutePath(projectCwd)) return refuse('"project-cwd" must be an absolute path')
    request.projectCwd = projectCwd
  }

  const cwd = get('cwd')
  if (cwd !== undefined) {
    if (!isAcceptableAbsolutePath(cwd)) return refuse('"cwd" must be an absolute path')
    request.cwd = cwd
  }

  const prompt = get('prompt')
  const promptFile = get('prompt-file')
  if (prompt !== undefined && promptFile !== undefined) {
    return refuse('"prompt" and "prompt-file" cannot be combined')
  }
  if ((prompt !== undefined || promptFile !== undefined) && agent === 'terminal') {
    // Typing text into a shell is running a command, not sending a message.
    return refuse('a terminal link cannot carry a prompt')
  }
  if (prompt !== undefined) {
    if (utf8Bytes(prompt) > OPEN_LINK_LIMITS.prompt) return refuse('"prompt" is longer than 8 KB (use prompt-file)')
    if (CONTROL_EXCEPT_WS.test(prompt)) return refuse('"prompt" contains control characters')
    if (hasHiddenText(prompt)) return refuse('"prompt" contains invisible or direction-changing characters')
    if (prompt.trim()) request.prompt = prompt
  }
  if (promptFile !== undefined) {
    if (!isAcceptableAbsolutePath(promptFile)) return refuse('"prompt-file" must be an absolute path')
    request.promptFile = promptFile
  }

  const title = get('title')
  if (title !== undefined) {
    if (codePoints(title) > OPEN_LINK_LIMITS.title) return refuse('"title" is longer than 80 characters')
    if (ANY_CONTROL.test(title) || FORMAT_CONTROL.test(title) || hasHiddenText(title)) return refuse('"title" contains control characters')
    if (title.trim()) request.title = title.trim()
  }

  const source = get('source')
  if (source !== undefined) {
    if (codePoints(source) > OPEN_LINK_LIMITS.source) return refuse('"source" is longer than 40 characters')
    if (ANY_CONTROL.test(source) || FORMAT_CONTROL.test(source) || hasHiddenText(source)) return refuse('"source" contains control characters')
    if (source.trim()) request.source = source.trim()
  }

  return { ok: true, link: { kind: 'open', request } }
}

/** A title the human edited in the sheet, checked again by main: one line, ≤ 80, no controls.
 *  Empty / whitespace = no title. Returns null when it is not acceptable. */
export function normalizeLinkTitle(raw: unknown): string | undefined | null {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') return null
  const t = raw.trim()
  if (!t) return undefined
  if (codePoints(t) > OPEN_LINK_LIMITS.title || ANY_CONTROL.test(t) || FORMAT_CONTROL.test(t) || hasHiddenText(t)) return null
  return t
}

/** The first `nodeterm://` URL in a process argv (Windows/Linux deliver a clicked link that way:
 *  on first launch in `process.argv`, afterwards in `second-instance`'s argv). */
export function nodetermUrlFromArgv(argv: readonly string[]): string | null {
  for (const a of argv) {
    if (typeof a === 'string' && a.slice(0, OPEN_LINK_SCHEME.length + 2).toLowerCase() === `${OPEN_LINK_SCHEME}//`) {
      return a
    }
  }
  return null
}

// ─── Choosing the project ────────────────────────────────────────────────────────────────────────

/** A project as main's workspace index knows it — the only source of candidates (the renderer is
 *  the more attackable half and may only pick among what main offered). */
export interface LinkProjectEntry {
  id: string
  name: string
  cwd?: string
  closed?: boolean
  /** SSH projects are out of scope for v1. */
  ssh?: boolean
  /** Handed to a hosted team: reopening it asks first everywhere else, so a link never offers it. */
  handedOff?: boolean
}

export interface LinkProjectCandidate {
  id: string
  name: string
  cwd?: string
  closed: boolean
}

export type LinkProjectNote =
  /** `project=<id>` names nothing in the index. */
  | 'not-found'
  /** `project=<id>` names an SSH project (or one handed to a team). */
  | 'unsupported'
  /** `project-cwd=` matched no project. */
  | 'no-match'

export interface LinkProjectResolution {
  /** Every project the sheet may offer, preselected / matching ones first. */
  candidates: LinkProjectCandidate[]
  /** The suggestion; null = none (the sheet falls back to the active project if offerable). */
  preselectId: string | null
  note?: LinkProjectNote
  /** "Open <folder> as a new project", offered when no project owns that exact folder. */
  newProjectCwd?: string
}

/** Comparable form of a path: separators unified, no trailing separator (root kept). */
export function comparablePath(p: string): string {
  const s = p.replace(/\\/g, '/')
  // A scan, not /\/+$/: that regex is quadratic on a run of slashes.
  let end = s.length
  while (end > 1 && s.charCodeAt(end - 1) === 47) end--
  return s.slice(0, end)
}

/** Is `child` the folder `dir` or inside it — segment-wise, so `/repo-x` is not inside `/repo`. */
export function pathWithin(child: string, dir: string): boolean {
  const c = comparablePath(child)
  const d = comparablePath(dir)
  if (c === d) return true
  return c.startsWith(d.endsWith('/') ? d : `${d}/`)
}

export function resolveLinkProject(req: OpenLinkRequest, entries: readonly LinkProjectEntry[]): LinkProjectResolution {
  const offerable = entries.filter((e) => !e.ssh && !e.handedOff)
  const toCandidate = (e: LinkProjectEntry): LinkProjectCandidate => ({
    id: e.id,
    name: e.name,
    ...(e.cwd ? { cwd: e.cwd } : {}),
    closed: !!e.closed
  })
  // Open projects before closed ones; otherwise index order.
  const ordered = [...offerable.filter((e) => !e.closed), ...offerable.filter((e) => e.closed)]
  const front = (first: LinkProjectEntry[]): LinkProjectCandidate[] => {
    const ids = new Set(first.map((e) => e.id))
    return [...first, ...ordered.filter((e) => !ids.has(e.id))].map(toCandidate)
  }

  const folder = req.cwd ?? req.projectCwd
  const ownsFolder = folder
    ? offerable.some((e) => e.cwd && comparablePath(e.cwd) === comparablePath(folder))
    : true
  const newProjectCwd = folder && !ownsFolder ? folder : undefined
  const withNew = (r: LinkProjectResolution): LinkProjectResolution =>
    newProjectCwd ? { ...r, newProjectCwd } : r

  if (req.project !== undefined) {
    const hit = entries.find((e) => e.id === req.project)
    if (!hit) return withNew({ candidates: front([]), preselectId: null, note: 'not-found' })
    if (hit.ssh || hit.handedOff) return withNew({ candidates: front([]), preselectId: null, note: 'unsupported' })
    return withNew({ candidates: front([hit]), preselectId: hit.id })
  }

  if (req.projectCwd !== undefined) {
    const want = comparablePath(req.projectCwd)
    const matches = ordered.filter((e) => e.cwd && comparablePath(e.cwd) === want)
    if (!matches.length) return withNew({ candidates: front([]), preselectId: null, note: 'no-match' })
    return withNew({ candidates: front(matches), preselectId: matches[0].id })
  }

  if (req.cwd !== undefined) {
    let best: LinkProjectEntry | null = null
    for (const e of ordered) {
      if (!e.cwd || !pathWithin(req.cwd, e.cwd)) continue
      if (!best || comparablePath(e.cwd).length > comparablePath(best.cwd as string).length) best = e
    }
    if (best) return withNew({ candidates: front([best]), preselectId: best.id })
  }
  return withNew({ candidates: front([]), preselectId: null })
}

// ─── The wire between main and the sheet ─────────────────────────────────────────────────────────

/** What main sends the renderer for an `open` link, every path already checked by main. */
export interface OpenLinkPrompt {
  id: string
  agent: OpenLinkAgent
  cwd?: string
  prompt?: string
  /** The `prompt-file` path, and its content as main read it for display (re-read on accept). */
  promptFile?: string
  promptFileText?: string
  title?: string
  source?: string
  resolution: LinkProjectResolution
  /** The agent's command was not found on the login-shell PATH. A warning, not a refusal: a launch
   *  command override can make the bare binary irrelevant. */
  agentMissing?: boolean
}

/** The human's answer. Only a choice among what main offered: never a path, never a prompt. */
export interface OpenLinkChoice {
  /** One of `resolution.candidates`, or omitted with `newProject`. */
  projectId?: string
  /** Open `resolution.newProjectCwd` as a new project. */
  newProject?: boolean
  title?: string
}

/** Main's verdict on a choice: the final, re-checked open. */
export type OpenLinkAcceptResult =
  | {
      ok: true
      open: {
        agent: OpenLinkAgent
        projectId?: string
        newProjectCwd?: string
        cwd?: string
        prompt?: string
        /** A copy of the prompt file under nodeterm's own launch-prompt store. */
        promptFile?: string
        title?: string
      }
    }
  | { ok: false; reason: string }

// `nodeterm://` links — the main-process half. Electron-free (every effect is a dependency), so the
// whole delivery and re-check story is unit-tested without a window.
//
// The shape, and why each half is where it is:
//
//  1. RECEIVE. A URL arrives from `open-url` (macOS), `process.argv` on a cold start or
//     `second-instance`'s argv (Windows/Linux). Every arrival counts against a rate limit (5 a
//     minute): a page that spams links gets toasts, never a stack of sheets. URLs that arrive before
//     the renderer says it is listening are HELD (a link that cold-starts the app must not be lost)
//     and delivered once it does.
//  2. VALIDATE. The parser (@shared/open-link) checks shape; this checks what needs a disk: `cwd`
//     is an existing directory, `prompt-file` a regular file under the cap. The renderer never
//     receives a path this did not check.
//  3. ASK. The validated request, plus the project candidates resolved from THIS process's workspace
//     index, goes to the renderer, which shows the confirm sheet.
//  4. RE-CHECK. The renderer is the more attackable half, so its answer is only a CHOICE among what
//     was offered (a candidate id, or "open the link's folder as a new project", and a title). The
//     cwd and prompt in the final open come from here, not from the reply. The prompt file is read
//     again at accept and copied into nodeterm's own launch-prompt store, so the text the pane reads
//     is the text the human saw, whatever happens to the original afterwards.
//
// `pair` / `join` links are handed to the renderer's existing flows, which have their own approval.
// Everything here is desktop-only: the Server Edition has no URL scheme.

import {
  OPEN_LINK_LIMITS,
  comparablePath,
  hasHiddenText,
  normalizeLinkTitle,
  pathWithin,
  parseNodetermLink,
  resolveLinkProject,
  type LinkProjectEntry,
  type OpenLinkAcceptResult,
  type OpenLinkChoice,
  type OpenLinkPrompt,
  type OpenLinkRequest
} from '../shared/open-link'

/** At most this many links per window (every kind — a link is a link). */
export const OPEN_LINK_RATE = { max: 5, windowMs: 60_000 }
/** A pending request the human never answered is forgotten after this. */
export const OPEN_LINK_PENDING_TTL_MS = 10 * 60_000
/** Pending requests kept at once (the sheet shows one; the rest are replaced/dropped there). */
export const OPEN_LINK_PENDING_MAX = 4
/** Links held while the renderer is not listening yet. */
export const OPEN_LINK_HELD_MAX = 5

/** What a link says while the feature flag is off. Nothing is parsed or opened. */
export const OPEN_LINKS_OFF_NOTICE =
  'A nodeterm:// link was ignored: links from other apps are off. Turn on "Allow nodeterm:// links" in Settings → Behavior.'

export type ReadTextResult =
  | { kind: 'ok'; text: string }
  | { kind: 'missing' }
  | { kind: 'not-file' }
  | { kind: 'error' }

export type PathKind = 'dir' | 'file' | 'other' | 'missing'

export interface OpenLinkDeps {
  /** What a path is, following symlinks (a symlinked project folder is fine). Never throws. */
  statPath(p: string): Promise<{ kind: PathKind; size: number }>
  /** Read a regular file as UTF-8, at most `maxBytes + 1` bytes, from ONE open (no stat first:
   *  the handle that is read is the handle that is checked, and opening never blocks on a FIFO).
   *  Never throws. */
  readText(p: string, maxBytes: number): Promise<ReadTextResult>
  /** Copy a prompt into nodeterm's launch-prompt store; the stored absolute path, or null. */
  storePrompt(text: string): Promise<string | null>
  /** The workspace index's projects. */
  projects(): Promise<LinkProjectEntry[]>
  /** Is this agent's command on the login-shell PATH? `undefined` = could not tell. */
  agentInstalled(agent: string): Promise<boolean | undefined>
  /** Push to the renderer. */
  send(channel: OpenLinkChannel, payload: unknown): void
  /** Bring the window forward: the user just clicked a link. */
  raise(): void
  /** The feature flag (`settings.allowOpenLinks`), read on every link and again on accept. */
  enabled(): boolean
  /** This user's home folder: it and its ancestors are never offered as a new project. */
  homeDir(): string
  newId(): string
  now(): number
}

export type OpenLinkChannel = 'request' | 'pair' | 'notice'

interface Pending {
  prompt: OpenLinkPrompt
  request: OpenLinkRequest
  at: number
}

export interface OpenLinkService {
  /** A URL from the OS. */
  receive(url: string): void
  /** The renderer is listening: deliver what was held. */
  ready(): void
  /** The renderer went away (reload, window closed): hold again until it says ready. */
  notReady(): void
  accept(id: unknown, choice: unknown): Promise<OpenLinkAcceptResult>
  cancel(id: unknown): void
  /** Test seam. */
  pendingIds(): string[]
}

const isDir = async (deps: OpenLinkDeps, p: string): Promise<boolean> => (await deps.statPath(p)).kind === 'dir'

export function createOpenLinkService(deps: OpenLinkDeps): OpenLinkService {
  const arrivals: number[] = []
  let readyNow = false
  const held: string[] = []
  const pending = new Map<string, Pending>()

  const notice = (text: string): void => deps.send('notice', { text })

  const prune = (): void => {
    const now = deps.now()
    for (const [id, p] of pending) if (now - p.at > OPEN_LINK_PENDING_TTL_MS) pending.delete(id)
  }

  /** Validate an `open` request against the disk and the index, then hand it to the sheet. */
  const ask = async (request: OpenLinkRequest): Promise<void> => {
    if (request.cwd && !(await isDir(deps, request.cwd))) {
      notice(`Link refused: the folder ${request.cwd} does not exist.`)
      return
    }
    // project-cwd only has to exist when it would become a new project; a project's own cwd that
    // vanished is the project's problem, and the sheet still lets the human pick.
    let promptFileText: string | undefined
    if (request.promptFile) {
      const checked = await readPromptFile(deps, request.promptFile)
      if (!checked.ok) {
        notice(`Link refused: ${checked.reason}.`)
        return
      }
      promptFileText = checked.text
    }
    const entries = await deps.projects().catch(() => [] as LinkProjectEntry[])
    let resolution = resolveLinkProject(request, entries)
    // A new project is a folder the user works in: never `/`, the home folder or an ancestor of it
    // (a project's whole folder is readable by its agents, and Share-with-team refuses the same).
    if (resolution.newProjectCwd && tooBroadForProject(resolution.newProjectCwd, deps.homeDir())) {
      const { newProjectCwd: _broad, ...rest } = resolution
      resolution = rest
    }
    if (resolution.newProjectCwd && !(await isDir(deps, resolution.newProjectCwd))) {
      const { newProjectCwd: _drop, ...rest } = resolution
      resolution = rest
    }
    const agentMissing = request.agent === 'terminal' ? false : (await deps.agentInstalled(request.agent)) === false
    prune()
    // Bounded: the oldest unanswered request goes first.
    while (pending.size >= OPEN_LINK_PENDING_MAX) {
      const oldest = pending.keys().next().value as string
      pending.delete(oldest)
    }
    const id = deps.newId()
    const prompt: OpenLinkPrompt = {
      id,
      agent: request.agent,
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(request.prompt ? { prompt: request.prompt } : {}),
      ...(request.promptFile ? { promptFile: request.promptFile, promptFileText } : {}),
      ...(request.title ? { title: request.title } : {}),
      ...(request.source ? { source: request.source } : {}),
      resolution,
      ...(agentMissing ? { agentMissing: true } : {})
    }
    pending.set(id, { prompt, request, at: deps.now() })
    deps.send('request', prompt)
    deps.raise()
  }

  const dispatch = (url: string): void => {
    if (!deps.enabled()) {
      notice(OPEN_LINKS_OFF_NOTICE)
      // The user clicked something and must see why nothing opened (rate-limited like any link).
      deps.raise()
      return
    }
    const parsed = parseNodetermLink(url)
    if (!parsed.ok) {
      notice(`Link refused: ${parsed.reason}.`)
      return
    }
    const link = parsed.link
    if (link.kind !== 'open') {
      deps.send('pair', { kind: link.kind, url: link.url })
      deps.raise()
      return
    }
    void ask(link.request).catch((e) => notice(`Link refused: ${e instanceof Error ? e.message : String(e)}.`))
  }

  return {
    receive(url) {
      const now = deps.now()
      while (arrivals.length && now - arrivals[0] >= OPEN_LINK_RATE.windowMs) arrivals.shift()
      if (arrivals.length >= OPEN_LINK_RATE.max) {
        // Said once per burst would be nicer, but a toast per dropped link is still bounded by
        // the renderer's own notice slot (one strip, replaced).
        if (readyNow) notice('Too many nodeterm links in a minute — this one was ignored.')
        return
      }
      arrivals.push(now)
      if (!readyNow) {
        if (held.length < OPEN_LINK_HELD_MAX) held.push(url)
        return
      }
      dispatch(url)
    },
    ready() {
      readyNow = true
      const queued = held.splice(0)
      for (const url of queued) dispatch(url)
    },
    notReady() {
      readyNow = false
    },
    async accept(id, choice) {
      prune()
      if (typeof id !== 'string') return { ok: false, reason: 'Unknown link request.' }
      const p = pending.get(id)
      if (!p) return { ok: false, reason: 'This link request has expired. Click the link again.' }
      // Single use, whatever happens next.
      pending.delete(id)
      // Switched off while the sheet was up: the switch wins.
      if (!deps.enabled()) return { ok: false, reason: 'Links from other apps were turned off.' }
      const c = (choice ?? {}) as OpenLinkChoice
      if (typeof c !== 'object') return { ok: false, reason: 'Invalid choice.' }
      const title = normalizeLinkTitle(c.title)
      if (title === null) return { ok: false, reason: 'The title is not valid.' }
      const { resolution } = p.prompt

      let projectId: string | undefined
      let newProjectCwd: string | undefined
      let projectCwd: string | undefined
      if (c.newProject === true) {
        if (!resolution.newProjectCwd || c.projectId !== undefined) {
          return { ok: false, reason: 'That project was not offered.' }
        }
        newProjectCwd = resolution.newProjectCwd
        projectCwd = newProjectCwd
      } else {
        const hit = resolution.candidates.find((x) => x.id === c.projectId)
        if (!hit) return { ok: false, reason: 'That project was not offered.' }
        // Still in the index, still offerable (it may have been removed or handed off since).
        const now = (await deps.projects().catch(() => [] as LinkProjectEntry[])).find((e) => e.id === hit.id)
        if (!now || now.ssh || now.handedOff) return { ok: false, reason: 'That project is no longer available.' }
        // The sheet showed the folder from when the link arrived; a project moved since then would
        // run the node somewhere the human never saw.
        const shown = hit.cwd ? comparablePath(hit.cwd) : undefined
        const current = now.cwd ? comparablePath(now.cwd) : undefined
        if (shown !== current) {
          return { ok: false, reason: "That project's folder changed after the link arrived. Click the link again." }
        }
        projectId = hit.id
        projectCwd = now.cwd
      }

      const cwd = p.request.cwd ?? projectCwd
      if (cwd && !(await isDir(deps, cwd))) return { ok: false, reason: `The folder ${cwd} no longer exists.` }

      let promptFile: string | undefined
      if (p.request.promptFile) {
        const read = await readPromptFile(deps, p.request.promptFile)
        if (!read.ok) return { ok: false, reason: `Could not open: ${read.reason}.` }
        const text = read.text
        if (text !== p.prompt.promptFileText) {
          return { ok: false, reason: 'The prompt file changed after the link arrived. Click the link again to review it.' }
        }
        const stored = await deps.storePrompt(text)
        if (!stored) return { ok: false, reason: 'Could not store the prompt.' }
        promptFile = stored
      }

      return {
        ok: true,
        open: {
          agent: p.request.agent,
          ...(projectId ? { projectId } : {}),
          ...(newProjectCwd ? { newProjectCwd } : {}),
          ...(cwd ? { cwd } : {}),
          ...(p.request.prompt ? { prompt: p.request.prompt } : {}),
          ...(promptFile ? { promptFile } : {}),
          ...(title ? { title } : {})
        }
      }
    },
    cancel(id) {
      if (typeof id === 'string') pending.delete(id)
    },
    pendingIds: () => [...pending.keys()]
  }
}

/** The prompt file's text, or a sentence saying why not. */
async function readPromptFile(
  deps: OpenLinkDeps,
  path: string
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const no = (reason: string) => ({ ok: false as const, reason })
  const read = await deps.readText(path, OPEN_LINK_LIMITS.promptFile)
  if (read.kind === 'missing') return no(`the prompt file ${path} does not exist`)
  if (read.kind === 'not-file') return no(`the prompt file ${path} is not a regular file`)
  if (read.kind === 'error') return no(`the prompt file ${path} could not be read`)
  const text = read.text
  if (new TextEncoder().encode(text).length > OPEN_LINK_LIMITS.promptFile) {
    return no('the prompt file is larger than 64 KB')
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    return no('the prompt file contains control characters')
  }
  // The same rule as an inline prompt: nothing the sheet would not show (bidi overrides, zero-width
  // and TAG characters, C1).
  if (hasHiddenText(text)) return no('the prompt file contains invisible or direction-changing characters')
  if (!text.trim()) return no('the prompt file is empty')
  return { ok: true, text }
}

/** `/`, the home folder, or an ancestor of it. */
export function tooBroadForProject(folder: string, home: string): boolean {
  const f = comparablePath(folder)
  if (f === '/' || /^[A-Za-z]:\/?$/.test(f)) return true
  return !!home && pathWithin(home, f)
}

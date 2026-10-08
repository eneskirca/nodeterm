import { performance } from 'node:perf_hooks'
import { readManagedProcessBirth } from './managed-pane'
import { isSessionName, pasteBufferName } from './tmux-naming'
import { COMPOSED_ENTER_DELAY_MS, COMPOSED_INPUT_UNCERTAIN, normalizeComposedPaste, parseComposedInput,
  type ComposedInput, type ComposedInputResult } from '../shared/composed-input'

export const COMPOSED_VIEWER_FORMAT = '#{client_pid}|#{client_created}|#{session_name}|#{client_name}|#{pid}|#{session_created}|#{pane_id}|#{pane_pid}'
const DELIVERED = 'nt-composed-delivered'
const REFUSED = 'nt-composed-refused'
const STALE = 'This terminal viewer or its pane changed. Reattach before sending.'

export interface ComposedViewerReceipt {
  socket: string
  session: string
  viewerPid: number
  viewerCreated: string
  viewerName: string
  viewerBirth: string
  serverPid: number
  serverBirth: string
  sessionCreated: string
  paneId: string
  panePid: number
  paneBirth: string
}

export interface ComposedTmuxBoundary {
  current(): boolean
  run(args: string[], input?: string): Promise<string>
  readBirth?(pid: number): Promise<string>
  wait?(ms: number): Promise<void>
}

type ViewerFields = Omit<ComposedViewerReceipt, 'socket' | 'viewerBirth' | 'serverBirth' | 'paneBirth'>

function viewerFields(raw: string, session: string, pid: number): ViewerFields | null {
  const found: ViewerFields[] = []
  for (const row of raw.trim().split('\n')) {
    const [viewer, created, ownSession, name, server, sessionCreated, pane, panePid, ...extra] = row.split('|')
    if (extra.length || viewer !== String(pid) || ownSession !== session ||
        !/^[1-9][0-9]*$/.test(created) || !/^[1-9][0-9]*$/.test(server) ||
        !/^[1-9][0-9]*$/.test(sessionCreated) || !/^%[0-9]+$/.test(pane) ||
        !/^[1-9][0-9]*$/.test(panePid) || !/^(?:\/[A-Za-z0-9_./-]+|client-[0-9]+)$/.test(name)) continue
    if (!Number.isSafeInteger(Number(server)) || !Number.isSafeInteger(Number(panePid))) continue
    found.push({ session, viewerPid: pid, viewerCreated: created, viewerName: name,
      serverPid: Number(server), sessionCreated, paneId: pane, panePid: Number(panePid) })
  }
  return found.length === 1 ? found[0] : null
}

function sameFields(a: ViewerFields, b: ViewerFields): boolean {
  return a.session === b.session && a.viewerPid === b.viewerPid && a.viewerCreated === b.viewerCreated &&
    a.viewerName === b.viewerName && a.serverPid === b.serverPid && a.sessionCreated === b.sessionCreated &&
    a.paneId === b.paneId && a.panePid === b.panePid
}

function validBoundary(socket: string, session: string, pid: number): boolean {
  return /^[A-Za-z0-9_-]+$/.test(socket) && isSessionName(session) && Number.isSafeInteger(pid) && pid > 0
}

function list(r: Pick<ComposedViewerReceipt, 'socket' | 'session'>): string[] {
  return ['-L', r.socket, 'list-clients', '-t', `=${r.session}`, '-F', COMPOSED_VIEWER_FORMAT]
}

/** Pin the actual spawned local tmux client and its pane during attachment, never on first Send. */
export async function captureComposedViewer(
  socket: string, session: string, viewerPid: number, b: ComposedTmuxBoundary
): Promise<ComposedViewerReceipt | null> {
  if (!validBoundary(socket, session, viewerPid)) return null
  const readBirth = b.readBirth ?? readManagedProcessBirth
  const wait = b.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadline = performance.now() + 2000
  try {
    // node-pty returns before the new client has registered. Only registration may be waited for;
    // once a matching viewer is found, an inconsistent read refuses rather than choosing another.
    for (let attempt = 0; attempt < 40 && b.current() && performance.now() < deadline; attempt++) {
      let fields: ViewerFields | null = null
      try { fields = viewerFields(await b.run(list({ socket, session })), session, viewerPid) } catch { /* not attached yet */ }
      if (!b.current()) return null
      if (!fields) { await wait(25); continue }
      const [viewerBirth, serverBirth, paneBirth] = await Promise.all([
        readBirth(viewerPid), readBirth(fields.serverPid), readBirth(fields.panePid)
      ])
      if (!b.current()) return null
      const after = viewerFields(await b.run(list({ socket, session })), session, viewerPid)
      if (!after || !sameFields(fields, after) || !b.current()) return null
      return Object.freeze({ socket, ...fields, viewerBirth, serverBirth, paneBirth })
    }
  } catch { /* an unattested generation cannot be typed into */ }
  return null
}

function and(parts: string[]): string { return parts.reduce((a, b) => `#{&&:${a},${b}}`) }

/** Final gate is evaluated inside tmux's own queue, including the captured client's presence. */
export function composedSubmissionPlan(r: ComposedViewerReceipt, value: ComposedInput):
  { args: string[]; body: string; cleanup: string[] | null } {
  const input = parseComposedInput(value)
  if (!input || !validBoundary(r.socket, r.session, r.viewerPid) || !/^%[0-9]+$/.test(r.paneId) ||
      !Number.isSafeInteger(r.panePid) || r.panePid < 1 || !Number.isSafeInteger(r.serverPid) || r.serverPid < 1 ||
      !/^[1-9][0-9]*$/.test(r.sessionCreated) || !/^[1-9][0-9]*$/.test(r.viewerCreated) ||
      !/^(?:\/[A-Za-z0-9_./-]+|client-[0-9]+)$/.test(r.viewerName)) throw new Error('Invalid composed terminal identity')
  const viewer = and([
    `#{==:#{client_pid},${r.viewerPid}}`, `#{==:#{client_created},${r.viewerCreated}}`,
    `#{==:#{client_session},${r.session}}`, `#{==:#{client_name},${r.viewerName}}`,
    `#{==:#{pid},${r.serverPid}}`, `#{==:#{pane_id},${r.paneId}}`, `#{==:#{pane_pid},${r.panePid}}`
  ])
  const condition = and([
    `#{==:#{pid},${r.serverPid}}`, `#{==:#{session_name},${r.session}}`,
    `#{==:#{session_created},${r.sessionCreated}}`, `#{==:#{pane_id},${r.paneId}}`,
    `#{==:#{pane_pid},${r.panePid}}`, `#{L:#{?${viewer},1,}}`
  ])
  const body = input.kind === 'paste' ? normalizeComposedPaste(input.text) : ''
  if (body && input.enter) throw new Error('Composed paste and Enter require separate guarded dispatches')
  const buffer = body ? pasteBufferName() : null
  const yes: string[] = [`if-shell -F -t ${r.paneId} '#{pane_in_mode}' 'send-keys -t ${r.paneId} -X cancel'`]
  if (input.kind === 'control') yes.push(`send-keys -t ${r.paneId} -H ${input.text.charCodeAt(0).toString(16).padStart(2, '0')}`)
  else {
    if (buffer) yes.push(`paste-buffer -d -p -r -b ${buffer} -t ${r.paneId}`)
    if (input.enter) yes.push(`send-keys -t ${r.paneId} Enter`)
  }
  yes.push(`display-message -p ${DELIVERED}`)
  const no = `${buffer ? `delete-buffer -b ${buffer} ; ` : ''}display-message -p ${REFUSED}`
  const args = ['-L', r.socket]
  if (buffer) args.push('load-buffer', '-b', buffer, '-', ';')
  args.push('if-shell', '-F', '-t', r.paneId, condition, yes.join(' ; '), no)
  return { args, body, cleanup: buffer ? ['-L', r.socket, 'delete-buffer', '-b', buffer] : null }
}

/** One guarded dispatch. Payload loss is uncertain and never replayed. */
async function dispatchComposedTmux(
  r: ComposedViewerReceipt, input: ComposedInput, b: ComposedTmuxBoundary
): Promise<ComposedInputResult> {
  const refused = (): ComposedInputResult => ({ status: 'refused', message: STALE })
  const readBirth = b.readBirth ?? readManagedProcessBirth
  let plan: ReturnType<typeof composedSubmissionPlan>
  try {
    plan = composedSubmissionPlan(r, input)
    if (!b.current()) return refused()
    const actual = viewerFields(await b.run(list(r)), r.session, r.viewerPid)
    if (!actual || !sameFields(r, actual) || !b.current()) return refused()
    const births = await Promise.all([readBirth(r.viewerPid), readBirth(r.serverPid), readBirth(r.panePid)])
    if (births[0] !== r.viewerBirth || births[1] !== r.serverBirth || births[2] !== r.paneBirth || !b.current()) return refused()
  } catch { return refused() }
  try {
    // run consumes stdin and executes once. A lost response can follow completed input.
    const result = (await b.run(plan.args, plan.body)).trim()
    if (result === DELIVERED) return { status: 'delivered' }
    if (result === REFUSED) return refused()
  } catch { /* uncertain after dispatch */ }
  if (plan.cleanup) void Promise.resolve(b.run(plan.cleanup, '')).catch(() => {})
  return { status: 'uncertain', message: COMPOSED_INPUT_UNCERTAIN }
}

/** Paste and Enter are separated in time, with the exact captured generation gated at EACH write. */
export async function submitComposedTmux(
  r: ComposedViewerReceipt, value: ComposedInput, b: ComposedTmuxBoundary
): Promise<ComposedInputResult> {
  const input = parseComposedInput(value)
  if (!input) return { status: 'refused', message: 'Invalid composed terminal input.' }
  if (input.kind !== 'paste' || !input.enter || normalizeComposedPaste(input.text).length === 0)
    return dispatchComposedTmux(r, input, b)
  const pasted = await dispatchComposedTmux(r, { ...input, enter: false }, b)
  if (pasted.status !== 'delivered') return pasted
  // A successful paste alone is not a successful submit. An Enter coalesced into the paste was
  // the input bar's original false-success hazard, so retain its 150ms settling time. The queue
  // holds this action across the wait; a detach/replacement then prevents the second write.
  const wait = b.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  try {
    await wait(COMPOSED_ENTER_DELAY_MS)
    const submitted = await dispatchComposedTmux(r, { kind: 'paste', text: '', enter: true }, b)
    if (submitted.status === 'delivered') return submitted
  } catch { /* the paste has already landed, so every subsequent failure is uncertain */ }
  return { status: 'uncertain', message: COMPOSED_INPUT_UNCERTAIN }
}

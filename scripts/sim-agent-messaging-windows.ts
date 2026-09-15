// End-to-end SIMULATION of the coordinator ↔ architect ↔ coder messaging scenario on Windows.
//
// Real: the bundled session host over its named pipe, ConPTY, the OS console-identity probe, the
// status mirror reducer, the delivery decider, `deliverFromControl`, the deliver-on-idle queue, the
// settled paste-then-submit and the receipt watch. Simulated: the three agent CLIs (node.exe copies
// named claude.exe running a paste-aware composer) and the hook POST transport (each fake CLI
// appends its hook payloads to a file; this runner feeds them through `normalizeClaude` with the
// `verified`/`clientRevision` labels the hook server attaches). No model is called.
//
// The fake composer models the failure measured on Codex 0.154 (2026-09-14): a CR that arrives in
// the SAME input read as the paste-end marker is swallowed as pasted content; only a CR in a later
// read submits. Phases: three rounds of send/reply (idle, busy → queued → flushed), an app restart
// (new host client, mirror restored from disk), then controls — a single paste+CR write must be
// swallowed (so the model is not vacuous), and a "slow" reader that drains input every 150 ms
// compares the sendKeys plan (paste, then an immediate Enter write) with the settled envelope.
//
// Last phase, RELEASED session: a fourth node is spawned through a real `PtyManager` and messaged
// through the deps `src/main/index.ts` wires (`hasLiveSession` = `sessionExists`, the probes through
// `sessionHostOwns`). Every phase above talks to `SessionHostClient` directly, which cannot see a
// release at all. The node is released the way park expiry and the offscreen release do it (the last
// client's `kill`), then messaged idle and busy. Three controls keep that from passing vacuously:
// the pre-fix `hasLiveSession` must answer `targetGone`; with a tmux path set, only the release
// record may route the probes to the host; and a session killed in the host must be `targetGone`.
//
// Build + run (node-pty is Electron-built, so run under Electron's Node):
//   npx esbuild scripts/sim-agent-messaging-windows.ts --bundle --platform=node --format=cjs
//     --external:node-pty --tsconfig=tsconfig.node.json --outfile=out/sim-agent-messaging.cjs
//   npm run host:build
//   $env:ELECTRON_RUN_AS_NODE=1; $env:NODETERM_SMOKE_NODE_EXE=(Get-Command node).Source
//   node_modules\electron\dist\electron.exe out\sim-agent-messaging.cjs
import fs from 'fs'
import os from 'os'
import path from 'path'
import assert from 'assert/strict'
import { initPlatform } from '../src/core/platform'
import { SessionHostClient } from '../src/core/session-host-client'
import { PtyManager } from '../src/core/pty-manager'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import { writeNodeTokenFile } from '../src/core/agents/node-token-files'
import {
  initAgentStatusMirror,
  recordAgentEvent,
  mirrorEntry,
  flush as flushMirror,
  _resetForTest as resetMirror
} from '../src/core/agent-status-mirror'
import {
  createDeliveryQueue,
  deliverFromControl,
  onMessagingAgentEvent,
  type AgentMessagingDeps
} from '../src/core/agents/agent-messaging'
import { normalizeClaude } from '../src/shared/agents/normalize'
import { MIN_TOKEN_AWARE_REVISION } from '../src/core/agents/hooks/managed-script'
import type { AgentMessageOutcome } from '../src/core/agents/agent-message-decide'

const ROUNDS = Number(process.env.NODETERM_SIM_ROUNDS ?? 3)
const PROJECT = 'sim-project'
const NODES = {
  coord: { id: 'sim-coord', title: 'Coordinator' },
  arch: { id: 'sim-arch', title: 'Architect' },
  coder: { id: 'sim-coder', title: 'Coder' }
} as const
type Role = keyof typeof NODES
/** The node spawned and released through `PtyManager` (last phase). Not in `NODES`, because phase 0
 *  attaches every `NODES` entry straight through `SessionHostClient`. */
const REL = { id: 'sim-released', title: 'Released' } as const
const sessionName = (id: string): string => `nt-${id}`

// The fake agent CLI. argv: <hookFile>. Speaks only through its pane and the hook file.
const COMPOSER = String.raw`
const fs = require('fs')
const hookFile = process.argv[process.argv.length - 1]
const START = '\x1b[200~', END = '\x1b[201~'
const hook = (payload) => fs.appendFileSync(hookFile, JSON.stringify(payload) + '\n')
let inPaste = false, composer = '', busy = false
process.stdin.setRawMode(true)
process.stdin.resume()
process.stdout.write('\x1b[?2004h> ')
hook({ hook_event_name: 'SessionStart', session_id: 's1', source: 'startup' })
setTimeout(() => hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }), 150)
function submit() {
  const text = composer
  composer = ''
  if (!text.trim()) return
  busy = true
  const work = Number((text.match(/\[\[work:(\d+)\]\]/) || [])[1] || 900)
  hook({ hook_event_name: 'UserPromptSubmit', prompt: text.split('\n')[0] })
  hook({ sim: 'received', text })
  process.stdout.write('\r\n[turn] ' + text.split('\n')[0].slice(0, 60) + '\r\n')
  setTimeout(() => {
    busy = false
    hook({ hook_event_name: 'Stop', last_assistant_message: 'ok' })
    process.stdout.write('[done]\r\n> ')
  }, work)
}
// SLOW mode (a flag file next to the hook file): read input only every 150 ms, like a TUI busy
// painting. Bytes written between two reads reach the app as ONE read — the condition under which a
// separate-but-immediate Enter write lands in the same read as the paste it follows.
const slowFlag = hookFile + '.slow'
setInterval(() => {
  if (fs.existsSync(slowFlag)) { if (!process.stdin.isPaused()) process.stdin.pause(); process.stdin.resume() }
}, 150)
process.stdin.on('data', (chunk) => {
  if (fs.existsSync(slowFlag)) process.stdin.pause()
  hook({ sim: 'read', bytes: chunk.length })
  let s = chunk.toString()
  while (s.length) {
    if (inPaste) {
      const i = s.indexOf(END)
      if (i < 0) { composer += s; process.stdout.write(s.replace(/\n/g, '\r\n')); s = ''; break }
      const part = s.slice(0, i)
      composer += part
      process.stdout.write(part.replace(/\n/g, '\r\n'))
      inPaste = false
      s = s.slice(i + END.length)
      // The measured Codex behaviour: a CR in the same read as the close marker is pasted content.
      if (s.startsWith('\r')) { composer += '\n'; hook({ sim: 'absorbed-cr' }); s = s.slice(1) }
      continue
    }
    const j = s.indexOf(START)
    if (j === 0) { inPaste = true; s = s.slice(START.length); continue }
    const plain = j < 0 ? s : s.slice(0, j)
    for (const ch of plain) {
      if (ch === '\r') { if (!busy) submit(); else hook({ sim: 'cr-while-busy' }) }
      else { composer += ch; process.stdout.write(ch) }
    }
    s = j < 0 ? '' : s.slice(j)
  }
})
`

interface SimEvent {
  role: string
  payload: Record<string, unknown>
}

async function main(): Promise<void> {
  assert.equal(process.platform, 'win32', 'this simulation needs a real Windows console')
  const nodeExe = process.env.NODETERM_SMOKE_NODE_EXE
  assert.ok(nodeExe && fs.existsSync(nodeExe), 'set NODETERM_SMOKE_NODE_EXE to node.exe')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-sim-messaging-'))
  const noop = (): void => {}
  initPlatform({
    userDataDir: dir,
    appVersion: 'sim',
    isPackaged: false,
    handle: noop,
    on: noop,
    handleWithSender: noop,
    onWithSender: noop,
    sendTo: noop,
    broadcast: noop,
    clientIds: () => [],
    openExternal: async () => {}
  })
  const mirrorFile = path.join(dir, 'agent-status.json')
  initAgentStatusMirror(mirrorFile)

  const agentExe = path.join(dir, 'claude.exe')
  fs.copyFileSync(nodeExe, agentExe)
  const composerJs = path.join(dir, 'composer.js')
  fs.writeFileSync(composerJs, COMPOSER)
  const quote = (s: string): string => "'" + s.replace(/'/g, "''") + "'"
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k, v]) => v !== undefined && !k.startsWith('NODETERM_') && k !== 'ELECTRON_RUN_AS_NODE'
    )
  ) as Record<string, string>

  let client = new SessionHostClient({ userDataDir: dir, repoRoot: process.cwd() })
  const log: string[] = []
  const note = (line: string): void => {
    const stamp = new Date().toISOString().slice(11, 23)
    log.push(`${stamp} ${line}`)
    console.log(`${stamp} ${line}`)
  }

  // ── The simulated hook transport ──────────────────────────────────────────────────────────────
  const queue = { current: null as ReturnType<typeof createDeliveryQueue> | null }
  // The released node's deliveries go through their own queue (built on the PtyManager deps), so
  // its done edge must nudge that queue and not the direct-client one.
  const relQueue = { current: null as ReturnType<typeof createDeliveryQueue> | null }
  const hookFiles = new Map<string, { file: string; offset: number; nodeId: string }>()
  const events: SimEvent[] = []
  const pump = (): void => {
    for (const [role, h] of hookFiles) {
      if (!fs.existsSync(h.file)) continue
      const raw = fs.readFileSync(h.file, 'utf8')
      const fresh = raw.slice(h.offset)
      const complete = fresh.lastIndexOf('\n')
      if (complete < 0) continue
      h.offset += complete + 1
      for (const line of fresh.slice(0, complete).split('\n')) {
        if (!line.trim()) continue
        const payload = JSON.parse(line) as Record<string, unknown>
        events.push({ role, payload })
        if (payload.sim) {
          if (payload.sim !== 'read') note(`${role}: sim ${String(payload.sim)}`)
          continue
        }
        const normalized = normalizeClaude({ nodeId: h.nodeId, agentId: 'claude', payload })
        if (!normalized) continue
        const labelled = { ...normalized, verified: true, clientRevision: MIN_TOKEN_AWARE_REVISION }
        const broadcast = recordAgentEvent(labelled)
        onMessagingAgentEvent(broadcast, h.nodeId === REL.id ? relQueue.current : queue.current)
        note(`${role}: hook ${String(payload.hook_event_name)} → mirror ${String(mirrorEntry(h.nodeId)?.state)}`)
      }
    }
  }
  const pumpTimer = setInterval(pump, 40)

  // ── The messaging deps: exactly the seams the desktop shell wires, pointed at the sim ─────────
  let clockOffset = 0
  const deps: AgentMessagingDeps = {
    paneOwner: (id) => client.messageOwner(sessionName(id)),
    sendEnvelope: (id, envelope, expected) =>
      expected ? client.messageEnvelope(sessionName(id), envelope, expected) : Promise.resolve(false),
    envelopePasteReady: (id) => client.messagePasteReady(sessionName(id)),
    hasLiveSession: (id) => client.hasSession(sessionName(id)),
    projects: () => [
      {
        id: PROJECT,
        nodes: [...Object.values(NODES), REL].map((n) => ({ id: n.id, title: n.title, agentId: 'claude' }))
      }
    ],
    isRemoteNode: () => false,
    messagingEnabled: () => true,
    paneOwnerProject: () => PROJECT,
    customAgents: () => undefined,
    appendBoardLog: async () => true,
    // The pair limiter is real; the runner skips its 10 s window between rounds instead of sleeping.
    now: () => Date.now() + clockOffset
  }
  queue.current = createDeliveryQueue(deps)
  deps.queue = queue.current

  const waitFor = async (what: string, test: () => boolean, timeout = 20_000): Promise<void> => {
    const until = Date.now() + timeout
    while (!test()) {
      if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
      await new Promise((r) => setTimeout(r, 40))
    }
  }
  const received = (role: string, marker: string): boolean =>
    events.some((e) => e.role === role && e.payload.sim === 'received' && String(e.payload.text).includes(marker))
  const stateOf = (role: Role): string | undefined => mirrorEntry(NODES[role].id)?.state

  const results: { step: string; outcome: string; ok: boolean }[] = []
  const expectOutcome = (step: string, outcome: AgentMessageOutcome, allowed: string[]): void => {
    const detail = outcome.kind + ('receipt' in outcome && outcome.receipt ? `(${String(outcome.receipt)})` : '')
    const ok = allowed.includes(outcome.kind)
    results.push({ step, outcome: detail, ok })
    note(`${ok ? 'PASS' : 'FAIL'} ${step}: ${detail}`)
    assert.ok(ok, `${step}: expected ${allowed.join('|')}, got ${JSON.stringify(outcome)}`)
  }
  const send = async (
    from: Role,
    to: Role,
    verb: 'send' | 'reply',
    body: string
  ): Promise<AgentMessageOutcome> =>
    (await deliverFromControl({ verb, sourceNodeId: NODES[from].id, targetNodeId: NODES[to].id, body }, deps)).outcome
  /** A human typing a prompt: plain keystrokes, then Enter in its own write. */
  const typePrompt = async (role: Role, text: string): Promise<void> => {
    client.write(sessionName(NODES[role].id), subs.get(role)!, text)
    await new Promise((r) => setTimeout(r, 120))
    client.write(sessionName(NODES[role].id), subs.get(role)!, '\r')
  }

  const subs = new Map<Role, { onData: (d: string) => void; onExit: () => void }>()
  let ptyManager: PtyManager | undefined
  try {
    // ── Phase 0: three verified sessions that prove themselves idle without a turn (#760) ───────
    for (const role of Object.keys(NODES) as Role[]) {
      const id = NODES[role].id
      assert.ok(writeNodeTokenFile(id, `token-${id}`))
      const hookFile = path.join(dir, `hooks-${role}.jsonl`)
      hookFiles.set(role, { file: hookFile, offset: 0, nodeId: id })
      const sub = { onData: noop, onExit: noop }
      subs.set(role, sub)
      await client.attach(
        sessionName(id),
        {
          shell: 'powershell.exe',
          args: ['-NoLogo', '-NoProfile', '-NoExit', '-Command', `& ${quote(agentExe)} ${quote(composerJs)} ${quote(hookFile)}`],
          cwd: dir,
          env,
          cols: 140,
          rows: 40
        },
        500,
        sub
      )
    }
    for (const role of Object.keys(NODES) as Role[]) {
      await waitFor(`${role} verified idle after session start`, () => {
        const e = mirrorEntry(NODES[role].id)
        return e?.state === 'done' && e.stateVerified === true && !e.idleInferred
      })
      note(`PASS ${role}: verified idle straight after SessionStart (no turn needed)`)
    }
    results.push({ step: 'idle after SessionStart is a verified, non-inferred done', outcome: 'done', ok: true })

    // ── Rounds: coordinator → architect → coordinator → coder (busy → queued) → coordinator ────
    for (let r = 1; r <= ROUNDS; r++) {
      clockOffset += 11_000
      note(`── round ${r} ──`)
      await typePrompt('coord', `plan round ${r}`)
      await waitFor('coordinator turn', () => stateOf('coord') === 'working')

      // The coordinator, mid-turn, hands the task to the architect (idle target).
      expectOutcome(`r${r} coord→arch send`, await send('coord', 'arch', 'send', `DESIGN-${r} [[work:6000]]\nplease design round ${r}`), ['delivered'])
      await waitFor('architect received', () => received('arch', `DESIGN-${r}`))
      await waitFor('coordinator idle', () => stateOf('coord') === 'done')

      // The coder starts long work of its own, so the coordinator's hand-off must wait for it.
      await typePrompt('coder', `own work round ${r} [[work:15000]]`)
      await waitFor('coder busy', () => stateOf('coder') === 'working')

      // The architect replies while the coordinator is idle in round 1, busy afterwards.
      if (r > 1) {
        await typePrompt('coord', `side task round ${r} [[work:2500]]`)
        await waitFor('coordinator busy again', () => stateOf('coord') === 'working')
      }
      await waitFor('architect working', () => stateOf('arch') === 'working')
      const archReply = await send('arch', 'coord', 'reply', `ARCH-REPLY-${r} [[work:1200]]\nthe design for round ${r}`)
      expectOutcome(`r${r} arch→coord reply (coord ${r > 1 ? 'busy' : 'idle'})`, archReply, r > 1 ? ['queued'] : ['delivered'])
      await waitFor('coordinator got the design', () => received('coord', `ARCH-REPLY-${r}`), 30_000)

      // The coordinator, mid-turn on the reply, hands off to the still-busy coder.
      await waitFor('coordinator turn on the reply', () => stateOf('coord') === 'working')
      expectOutcome(`r${r} coord→coder send (coder busy)`, await send('coord', 'coder', 'send', `BUILD-${r} [[work:1200]]\nimplement round ${r}`), ['queued'])
      await waitFor('coder got the hand-off after its own work', () => received('coder', `BUILD-${r}`), 30_000)
      await waitFor('coder working on hand-off', () => stateOf('coder') === 'working')
      await waitFor('coordinator idle', () => stateOf('coord') === 'done', 30_000)
      expectOutcome(`r${r} coder→coord reply`, await send('coder', 'coord', 'reply', `BUILT-${r}\nround ${r} implemented`), ['delivered'])
      await waitFor('coordinator got the result', () => received('coord', `BUILT-${r}`))
      for (const role of Object.keys(NODES) as Role[]) await waitFor(`${role} idle`, () => stateOf(role) === 'done', 30_000)
    }

    // ── Phase R: the app restarts; the host keeps every session running ─────────────────────────
    note('── app restart: new host client, mirror restored from disk ──')
    for (const role of Object.keys(NODES) as Role[]) client.unsubscribe(sessionName(NODES[role].id), subs.get(role)!)
    await flushMirror()
    resetMirror()
    initAgentStatusMirror(mirrorFile)
    client = new SessionHostClient({ userDataDir: dir, repoRoot: process.cwd() })
    clockOffset += 11_000
    assert.equal(await client.hasSession(sessionName(NODES.arch.id)), true, 'a released session is still live')
    assert.equal(mirrorEntry(NODES.arch.id)?.restored, true, 'restored entries are not trusted')
    // A restored entry proves nothing about this run: the honest answer is the retryable `stale`,
    // which is not queued — the SENDER is told to retry.
    expectOutcome('restart: coord→arch, status only restored from disk',
      await send('coord', 'arch', 'send', 'POST-RESTART\nstill there?'), ['targetStatusStale'])
    // The CLI kept running inside the host and emits nothing on its own: a retry changes nothing.
    await new Promise((r) => setTimeout(r, 3000))
    expectOutcome('restart: retry with no new hook from the idle agent',
      await send('coord', 'arch', 'send', 'POST-RESTART\nstill there?'), ['targetStatusStale'])
    // Only a verified event from the pane brings it back. Here: the CLI announces a resume + idle,
    // the shape #760 lets commit a verified done without a turn.
    fs.appendFileSync(hookFiles.get('arch')!.file,
      JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's1', source: 'resume' }) + '\n' +
      JSON.stringify({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }) + '\n')
    await waitFor('architect verified idle after resume', () => {
      const e = mirrorEntry(NODES.arch.id)
      return e?.state === 'done' && e.stateVerified === true && !e.restored
    })
    expectOutcome('restart: retry after verified resume idle (released session, new client)',
      await send('coord', 'arch', 'send', 'POST-RESTART [[work:800]]\nstill there?'), ['delivered'])
    await waitFor('released session received the message', () => received('arch', 'POST-RESTART'))

    // ── Controls: which delivery shapes survive a reader that is not instantly draining input ────
    const archSub = { onData: noop, onExit: noop }
    await client.attachExisting(sessionName(NODES.arch.id), archSub)
    const count = (sim: string): number => events.filter((e) => e.role === 'arch' && e.payload.sim === sim).length
    /** Run one delivery shape, then report whether the CR was swallowed and whether a turn started. */
    const probe = async (label: string, run: () => Promise<unknown>): Promise<{ absorbed: boolean; submitted: boolean }> => {
      await waitFor('architect idle', () => stateOf('arch') === 'done', 30_000)
      // Reset: a swallowed CR leaves text in the composer; a bare Enter clears it with one turn.
      const a0 = count('absorbed-cr')
      const t0 = count('received')
      await run()
      await new Promise((r) => setTimeout(r, 3000))
      const absorbed = count('absorbed-cr') > a0
      const submitted = count('received') > t0
      note(`CONTROL ${label}: CR swallowed into the paste = ${absorbed}; turn submitted = ${submitted}`)
      results.push({ step: `control: ${label}`, outcome: `swallowed=${absorbed} submitted=${submitted}`, ok: true })
      if (!submitted) {
        client.write(sessionName(NODES.arch.id), archSub, '\r') // flush the stranded composer
        await waitFor('stranded composer cleared', () => count('received') > t0, 10_000)
      }
      return { absorbed, submitted }
    }
    const slowFlag = hookFiles.get('arch')!.file + '.slow'

    // C1 — the fake parser itself: paste + CR in ONE write must be swallowed (else the model is vacuous).
    const c1 = await probe('fast reader, paste+CR in a single write', async () => {
      client.write(sessionName(NODES.arch.id), archSub, '\x1b[200~CONTROL-1\x1b[201~\r')
    })
    assert.ok(c1.absorbed && !c1.submitted, 'the fake composer must swallow a same-read CR')

    fs.writeFileSync(slowFlag, '1')
    // C2 — #771's sendKeys plan (paste write, then an immediate Enter write) against a busy reader.
    await probe('slow reader, #771 sendKeys (framed paste + immediate Enter write)', () =>
      client.sendKeys(sessionName(NODES.arch.id), 'CONTROL-2 sendKeys', true))
    // C3 — #760's settled envelope against the same busy reader, through the full delivery path.
    clockOffset += 11_000
    const c3 = await probe('slow reader, #760 settled envelope via deliverFromControl', async () => {
      expectOutcome('slow reader: coord→arch settled envelope',
        await send('coord', 'arch', 'send', 'CONTROL-3 settled\nsubmit me'), ['delivered', 'stalled'])
    })
    assert.ok(c3.submitted, 'the settled envelope must submit even against a slow reader')
    fs.rmSync(slowFlag, { force: true })

    // ── Phase L: a RELEASED session, through PtyManager (park expiry / offscreen release) ──────
    note('── released session: spawned and released through PtyManager ──')
    // `PtyManager` reaches the host through the process-wide client in session-host-backend.ts,
    // which reads `platform().userDataDir` (the private root above) and finds the host bundle under
    // `process.cwd()`. So this is the same isolated host every phase above used.
    ptyManager = new PtyManager()
    ptyManager.init(() => ({ ...DEFAULT_SETTINGS, tmuxEnabled: true }))
    const pty = ptyManager
    // Test-only reach into two private fields, both named in the controls below. Neither is exposed
    // because no production caller has a reason to set a tmux path or drop a release record.
    const internals = pty as unknown as { released: Map<string, unknown>; tmuxPath: string | null }
    const relName = sessionName(REL.id)
    assert.ok(writeNodeTokenFile(REL.id, `token-${REL.id}`))
    const relHook = path.join(dir, 'hooks-rel.jsonl')
    hookFiles.set('rel', { file: relHook, offset: 0, nodeId: REL.id })
    const relSessionId = pty.createDetached(
      {
        cols: 140,
        rows: 40,
        cwd: dir,
        persistKey: REL.id,
        shell: 'powershell.exe',
        shellArgs: ['-NoLogo', '-NoProfile', '-NoExit', '-Command', `& ${quote(agentExe)} ${quote(composerJs)} ${quote(relHook)}`]
      },
      { onData: noop, onExit: noop }
    )
    await waitFor('released-node verified idle after session start', () => {
      const e = mirrorEntry(REL.id)
      return e?.state === 'done' && e.stateVerified === true && !e.idleInferred
    }, 30_000)
    const relState = (): string | undefined => mirrorEntry(REL.id)?.state

    // The seams `src/main/index.ts` wires for the desktop shell, over the real PtyManager.
    const ptyDeps: AgentMessagingDeps = {
      ...deps,
      paneOwner: (id) => pty.paneOwner(id),
      sendEnvelope: (id, envelope, expected) => pty.sendEnvelope(id, envelope, expected),
      envelopePasteReady: (id) => pty.envelopePasteReady(id),
      hasLiveSession: (id) => pty.sessionExists(id),
      queue: undefined
    }
    relQueue.current = createDeliveryQueue(ptyDeps)
    ptyDeps.queue = relQueue.current
    const coordHook = hookFiles.get('coord')!.file
    const sendRel = async (body: string, over: Partial<AgentMessagingDeps> = ptyDeps): Promise<AgentMessageOutcome> => {
      clockOffset += 11_000 // past the pair limiter's window, as in the rounds
      // Each message leaves from a fresh coordinator turn, as an orchestrator's would: the sender's
      // fan-out budget (FANOUT_PER_TURN) resets only on a new turn, and the phases above spent it.
      // The coordinator's subscription went with the restart phase, so the turn arrives through its
      // simulated hook transport rather than its keyboard.
      fs.appendFileSync(coordHook,
        JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'next hand-off' }) + '\n' +
        JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'ok' }) + '\n')
      const before = events.length
      await waitFor('coordinator fresh turn', () =>
        events.slice(before).some((e) => e.role === 'coord' && e.payload.hook_event_name === 'Stop'))
      const d = over === ptyDeps ? ptyDeps : { ...ptyDeps, ...over }
      return (await deliverFromControl({ verb: 'send', sourceNodeId: NODES.coord.id, targetNodeId: REL.id, body }, d)).outcome
    }

    // L1 — attached: the PtyManager wiring works before anything is released, so a later failure is
    // about the release and not about this harness.
    expectOutcome('released phase: coord→node while still attached', await sendRel('L-ATTACHED [[work:400]]\nattached'), ['delivered'])
    await waitFor('attached node received', () => received('rel', 'L-ATTACHED'))
    await waitFor('node idle after attached turn', () => relState() === 'done', 30_000)

    // L2 — release it the way park expiry and the offscreen release do: the last client leaves.
    pty.kill(null, relSessionId)
    assert.equal(pty.hasLiveSession(REL.id), false, 'no attached client is left after the release')
    assert.ok(internals.released.has(REL.id), 'the release left its record behind')
    assert.equal(await client.hasSession(relName), true, 'the host keeps the released session running')
    note('PASS released: no client attached, release record kept, host still runs the session')

    // A-C1 — the pre-fix wiring asked only for an attached client: a live agent reads as gone.
    expectOutcome('control: released node, pre-fix hasLiveSession (attached only)',
      await sendRel('L-PREFIX\nshould not arrive', { hasLiveSession: (id) => pty.hasLiveSession(id) }), ['targetGone'])

    // L3 — idle and released: delivered by name through the host.
    expectOutcome('released phase: coord→released idle node', await sendRel('L-RELEASED [[work:5000]]\nare you there?'), ['delivered'])
    await waitFor('released node received', () => received('rel', 'L-RELEASED'))
    await waitFor('released node working', () => relState() === 'working')

    // L4 — busy and released: queued, and flushed on its done edge (re-validated at flush time).
    expectOutcome('released phase: coord→released busy node', await sendRel('L-BUSY [[work:400]]\nafter your turn'), ['queued'])
    await waitFor('queued message reached the released node after its turn', () => received('rel', 'L-BUSY'), 30_000)
    await waitFor('released node idle again', () => relState() === 'done', 30_000)
    // The flushed delivery records its send (`noteSent`) only after its receipt watch returns, which
    // can outlast the turn it caused. Let it land before the next send moves the sim clock, or that
    // send is measured against a pair window stamped with the moved clock.
    await new Promise((r) => setTimeout(r, 3000))
    assert.equal(received('rel', 'L-PREFIX'), false, 'the pre-fix control must not have delivered anything')

    // A-C2 — with a tmux on PATH (MSYS2/Cygwin), "no record" no longer means "session host": only
    // the release record may route the probes there. The path does not exist, so any probe that
    // falls through to tmux fails instead of reaching a real server.
    internals.tmuxPath = path.join(dir, 'no-such-tmux', 'tmux.exe')
    expectOutcome('control: tmux on PATH, release record present', await sendRel('L-RECORD [[work:400]]\nrouted by the record'), ['delivered'])
    await waitFor('record-routed message received', () => received('rel', 'L-RECORD'))
    await waitFor('released node idle after record turn', () => relState() === 'done', 30_000)
    const record = internals.released.get(REL.id)
    internals.released.delete(REL.id)
    const noRecord = await sendRel('L-NORECORD\nshould not arrive')
    const noRecordOk = noRecord.kind !== 'delivered' && noRecord.kind !== 'queued'
    results.push({ step: 'control: tmux on PATH, release record removed', outcome: noRecord.kind, ok: noRecordOk })
    note(`${noRecordOk ? 'PASS' : 'FAIL'} control: tmux on PATH, release record removed: ${noRecord.kind}`)
    await new Promise((r) => setTimeout(r, 2000))
    assert.ok(noRecordOk && !received('rel', 'L-NORECORD'), `without the record the probes must not reach the host (got ${noRecord.kind})`)
    internals.released.set(REL.id, record)
    internals.tmuxPath = null

    // A-C3 — actually gone: the host no longer has the session, so `targetGone` is the true answer.
    await client.killSession(relName)
    assert.equal(await client.hasSession(relName), false, 'the killed session is gone')
    expectOutcome('control: released node whose session was killed in the host', await sendRel('L-GONE\nnobody home'), ['targetGone'])
  } finally {
    clearInterval(pumpTimer)
    for (const id of [...Object.values(NODES).map((n) => n.id), REL.id]) {
      try {
        await client.killSession(sessionName(id))
      } catch {
        /* already gone */
      }
    }
    // Detaches PtyManager's own host clients only; the sessions were killed above.
    await ptyManager?.killAll()
    // The scenario root is removed below, so the log gets its own private root to outlive it.
    // Never a fixed name in the shared temp dir: another account could pre-create it.
    const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-sim-messaging-log-')), 'run.log')
    fs.writeFileSync(logFile, log.join('\n'))
    console.log(`log: ${logFile}`)
    try {
      await waitFor('private host retirement', () => !fs.existsSync(path.join(dir, 'session-host.json')), 40_000)
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      console.warn(`left ${dir} behind`)
    }
  }
  console.log(JSON.stringify({ rounds: ROUNDS, results }, null, 2))
}

const keepAlive = setInterval(() => {}, 1000)
void main().then(
  () => {
    clearInterval(keepAlive)
    process.exit(0)
  },
  (error) => {
    clearInterval(keepAlive)
    console.error(error)
    process.exit(1)
  }
)

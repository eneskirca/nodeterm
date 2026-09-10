import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { randomBytes } from 'crypto'
import fs from 'fs'
import path from 'path'
import { writeFileAtomic } from '../fs-atomic'

export const TUI_SCRIPT_NAME = 'mesa-orchestrator.mjs'
export const TUI_ENDPOINT_NAME = 'tui-endpoint.env'

export interface TuiLineHandler {
  (missionId: string, line: string): Promise<{ reply: string }>
}

export interface TuiChannel {
  url: string
  scriptPath: string
  endpointPath: string
  launchCommand: () => string
  close: () => Promise<void>
  pushEvent: (missionId: string, text: string) => number
  eventsSince: (missionId: string, seq: number) => string[]
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function tuiDir(userDataDir: string): string {
  return path.join(userDataDir, 'swarm')
}

/** Self-contained Node TUI. Token rides the endpoint file, never argv. */
export const MESA_ORCHESTRATOR_SCRIPT = `'use strict'
import http from 'node:http'
import fs from 'node:fs'
import readline from 'node:readline'
import { stdin as input, stdout as output } from 'node:process'

const file = process.env.NODETERM_SWARM_ENDPOINT_FILE
if (!file) {
  console.log('Consola desconectada — falta NODETERM_SWARM_ENDPOINT_FILE')
  process.exit(1)
}

function readEndpoint() {
  const raw = fs.readFileSync(file, 'utf8')
  const url = (raw.match(/^NODETERM_SWARM_URL=(.*)$/m) || [])[1]?.trim()
  const token = (raw.match(/^NODETERM_SWARM_TOKEN=(.*)$/m) || [])[1]?.trim()
  const missionId = process.env.NODETERM_SWARM_MISSION || (raw.match(/^NODETERM_SWARM_MISSION=(.*)$/m) || [])[1]?.trim()
  return { url, token, missionId }
}

function post(pathname, body) {
  return new Promise((resolve, reject) => {
    let cfg
    try { cfg = readEndpoint() } catch (e) { reject(e); return }
    if (!cfg.url || !cfg.token) {
      reject(new Error('endpoint'))
      return
    }
    const u = new URL(cfg.url + pathname)
    const data = JSON.stringify({ ...body, missionId: body.missionId || cfg.missionId })
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
        authorization: 'Bearer ' + cfg.token
      }
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error('http ' + res.statusCode))
          return
        }
        try { resolve(JSON.parse(text)) } catch { resolve({ reply: text }) }
      })
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

let lastSeq = 0
console.log('mesa › Consola del orquestador.')
console.log('Escribí el objetivo o un comando. /help lista los comandos.')
console.log('')

const rl = readline.createInterface({ input, output, terminal: true })
rl.setPrompt('tú › ')

async function replay() {
  try {
    const out = await post('/sync', { lastSeq })
    if (typeof out.seq === 'number') lastSeq = out.seq
    for (const line of out.backlog || []) console.log(line)
  } catch {
    console.log('Consola desconectada — reintentando…')
  }
}

rl.on('line', async (line) => {
  try {
    const out = await post('/tui', { line, lastSeq })
    if (typeof out.seq === 'number') lastSeq = out.seq
    if (out.reply) console.log(out.reply)
  } catch {
    console.log('Consola desconectada — el host no responde. Reintentá o /help.')
  }
  rl.prompt()
})

rl.on('close', () => {
  console.log('Consola desconectada')
  process.exit(0)
})

// Listen before the first prompt. A command typed while /sync is in flight
// must not be dropped — that is the first thing a human does after launch.
rl.prompt()
await replay()
rl.prompt()
// Host ticks push /sync events. Without a poll the TUI only updates when the human types.
setInterval(() => { void replay() }, 2000)
`

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export async function startTuiChannel(opts: {
  userDataDir: string
  onLine: TuiLineHandler
  execPath?: string
}): Promise<TuiChannel> {
  const dir = tuiDir(opts.userDataDir)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const scriptPath = path.join(dir, TUI_SCRIPT_NAME)
  const endpointPath = path.join(dir, TUI_ENDPOINT_NAME)
  const token = randomBytes(24).toString('hex')
  await writeFileAtomic(scriptPath, MESA_ORCHESTRATOR_SCRIPT)
  fs.chmodSync(scriptPath, 0o755)

  const events = new Map<string, Array<{ seq: number; text: string }>>()
  let seq = 0
  const pushEvent = (missionId: string, text: string): number => {
    seq += 1
    const list = events.get(missionId) ?? []
    list.push({ seq, text })
    events.set(missionId, list.slice(-200))
    return seq
  }
  const eventsSince = (missionId: string, after: number): string[] =>
    (events.get(missionId) ?? []).filter((e) => e.seq > after).map((e) => e.text)

  const authorize = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization ?? ''
    return header === `Bearer ${token}`
  }

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    if (!authorize(req)) {
      res.writeHead(403)
      res.end('{"error":"forbidden"}')
      return
    }
    let body: { missionId?: string; line?: string; lastSeq?: number } = {}
    try {
      const raw = await readBody(req)
      if (raw) body = JSON.parse(raw) as typeof body
    } catch {
      res.writeHead(400)
      res.end('{"error":"bad-json"}')
      return
    }
    const missionId = typeof body.missionId === 'string' ? body.missionId : ''
    const lastSeq = typeof body.lastSeq === 'number' ? body.lastSeq : 0
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/sync') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ seq, backlog: eventsSince(missionId, lastSeq) }))
      return
    }
    if (url.pathname === '/tui') {
      const line = typeof body.line === 'string' ? body.line : ''
      const out = await opts.onLine(missionId, line)
      const next = pushEvent(missionId, out.reply)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ reply: out.reply, seq: next }))
      return
    }
    res.writeHead(404)
    res.end('{"error":"not-found"}')
  }

  const server: Server = createServer((req, res) => {
    void handler(req, res)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server.address()
  const port = addr && typeof addr === 'object' ? addr.port : 0
  const url = `http://127.0.0.1:${port}`
  await writeFileAtomic(
    endpointPath,
    `NODETERM_SWARM_URL=${url}\nNODETERM_SWARM_TOKEN=${token}\n`,
    { mode: 0o600 }
  )

  const execPath = opts.execPath ?? process.execPath
  const launchCommand = (): string => {
    const envFile = `NODETERM_SWARM_ENDPOINT_FILE=${shellQuote(endpointPath)}`
    const asNode = /electron/i.test(execPath) ? 'ELECTRON_RUN_AS_NODE=1 ' : ''
    // Assignments must precede `exec`. `exec VAR=val cmd` makes bash try to execute the
    // assignment as a path — the TUI never starts and the pane prints "cannot execute".
    return `${envFile} ${asNode}exec ${shellQuote(execPath)} ${shellQuote(scriptPath)}`
  }

  return {
    url,
    scriptPath,
    endpointPath,
    launchCommand,
    pushEvent,
    eventsSince,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
      })
  }
}

export function isShellPane(command: string | null): boolean | null {
  if (command == null) return null
  return /^(zsh|bash|sh|fish|pwsh|powershell|cmd|tmux)$/i.test(command)
}

/** null pane is not a shell. Launch only when the pane is a shell. */
export function tuiLaunchDecision(pane: string | null): 'running' | 'launch' | 'wait' {
  const shell = isShellPane(pane)
  if (shell === false) return 'running'
  if (shell === true) return 'launch'
  return 'wait'
}

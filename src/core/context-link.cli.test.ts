// The context-link read path, end to end: the REAL POSIX-sh shim, run by the real /bin/sh,
// against the real hook server and the real renderer. This replaces an identical suite that
// exercised the retired Node CLI — same fixtures and same expectations, so the rewrite answers
// for the behavior it inherited, plus the remote (SSH) case the old shape could not express.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { CONTEXT_SHIM_SCRIPT, type LinkDoc } from './context-link-core'
import { renderContextLink, type ContextLinkFetch, type ContextLinkVerb } from './context-link-render'
import { hookServer } from './agents/hook-server'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'

const run = promisify(execFile)

let dir = ''
let shim = ''
let doc: LinkDoc

/** What the fetchers were asked for — how the remote-routing assertions see the difference. */
const asked: { transcripts: string[]; terminals: string[]; exports: string[] } = {
  transcripts: [],
  terminals: [],
  exports: []
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ctxlink-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
  shim = join(dir, 'context.sh')
  writeFileSync(shim, CONTEXT_SHIM_SCRIPT, { mode: 0o755 })
  chmodSync(shim, 0o755)

  const claudeTranscript = [
    JSON.stringify({ type: 'user', message: { content: 'deploy the app' } }),
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'On it.' },
          { type: 'tool_use', name: 'Bash', input: { command: 'npm run build' } }
        ]
      }
    })
  ].join('\n')
  const codexTranscript = [
    JSON.stringify({ type: 'session_meta', payload: { id: 'sess-x' } }),
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the tests' }] }
    }),
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Sure, running them.' }] }
    }),
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'function_call', name: 'shell', arguments: '{"command":["npm","test"]}' }
    }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: '2 passed' } })
  ].join('\n')
  const geminiTranscript = [
    JSON.stringify({ sessionId: 'g-sess', projectHash: 'abc' }),
    JSON.stringify({ $set: { messages: [{ type: 'user', content: 'hello gemini' }] } }),
    JSON.stringify({ $push: { messages: { type: 'gemini', content: 'hello back' } } })
  ].join('\n')
  const opencodeExport = JSON.stringify({
    messages: [
      { role: 'user', parts: [{ type: 'text', text: 'add rerank' }] },
      {
        role: 'assistant',
        parts: [
          { type: 'text', text: 'done, added rerank.ts' },
          { type: 'tool', tool: 'bash', state: { input: { command: 'npm test' } } }
        ]
      }
    ]
  })

  const bodies: Record<string, string> = {
    'node-B': claudeTranscript,
    'node-X': codexTranscript,
    'node-G': geminiTranscript,
    // A REMOTE node: this fixture stands in for bytes fetched over the ControlMaster.
    'node-R': claudeTranscript
  }

  doc = {
    self: { id: 'node-A' },
    links: [
      { id: 'node-B', title: 'Builder', cwd: '', transcriptPath: join(dir, 'b.jsonl'), tmux: 'nt-node-B' },
      { id: 'node-X', title: 'Coder', cwd: '', transcriptPath: join(dir, 'codex.jsonl'), tmux: 'nt-node-X', agent: 'codex' },
      { id: 'node-G', title: 'Gem', cwd: '', transcriptPath: join(dir, 'gemini.jsonl'), tmux: 'nt-node-G', agent: 'gemini' },
      { id: 'node-Y', title: 'ColdCoder', cwd: '/nowhere', transcriptPath: '', tmux: 'nt-node-Y', agent: 'codex' },
      { id: 'node-O', title: 'OpenCoder', cwd: '', transcriptPath: '', tmux: 'nt-node-O', agent: 'opencode', sessionId: 'ses_abc' },
      { id: 'node-O2', title: 'NoSession', cwd: '', transcriptPath: '', tmux: 'nt-node-O2', agent: 'opencode' },
      { id: 'node-R', title: 'RemoteBuilder', cwd: '', transcriptPath: '/home/u/.claude/projects/x/r.jsonl', tmux: 'nt-node-R' },
      { id: 'note-1', title: 'Deploy notes', cwd: '', transcriptPath: '', tmux: '', note: 'use the staging key' }
    ],
    tmuxBin: null,
    tmuxSocket: 'node-terminal'
  }

  // Fetchers standing in for the real ones (local fs / ssh / tmux): what is under test here is
  // the shim ⇄ route ⇄ renderer path, not the filesystem.
  const fetchers: ContextLinkFetch = {
    transcript: async (node) => {
      asked.transcripts.push(node.id)
      return bodies[node.id] ?? null
    },
    terminal: async (node) => {
      asked.terminals.push(node.id)
      return node.id === 'node-B' ? 'last build ok\n' : ''
    },
    opencodeExport: async (node) => {
      asked.exports.push(node.id)
      return node.id === 'node-O' ? opencodeExport : null
    }
  }

  await hookServer.start()
  hookServer.setContextLinkHandler(async (req) => {
    // Mirrors handleContextLinkRequest's authorization: the document is chosen by the REQUESTER's
    // id, never by anything in the request body.
    if (req.nodeId !== 'node-A') {
      return 'No linked nodes. Draw a context-link edge from this node to another on the canvas.'
    }
    return renderContextLink(doc, req.verb as ContextLinkVerb, req.args, fetchers)
  })
})

afterAll(() => {
  hookServer.stop()
  rmSync(dir, { recursive: true, force: true })
})

async function shimRun(nodeId: string, args: string[]): Promise<string> {
  const { stdout } = await run('/bin/sh', [shim, ...args], {
    env: {
      PATH: process.env.PATH ?? '',
      NODETERM_NODE_ID: nodeId,
      NODETERM_HOOK_PORT: String(hookServer.getPort()),
      NODETERM_HOOK_TOKEN: hookServer.getToken()
    },
    maxBuffer: 10 * 1024 * 1024
  })
  return stdout
}

describe('context-link CLI', () => {
  it('list shows the linked node', async () => {
    const out = await shimRun('node-A', ['list'])
    expect(out).toContain('Builder')
    expect(out).toContain('node-B')
  })
  it('summary prints recent conversation lines', async () => {
    const out = await shimRun('node-A', ['summary', '-n', '10', '--node', 'node-B'])
    expect(out).toContain('deploy the app')
    expect(out).toContain('On it.')
    expect(out).toContain('npm run build')
  })
  it('transcript prints the full conversation', async () => {
    const out = await shimRun('node-A', ['transcript', '--node', 'node-B'])
    expect(out).toContain('full transcript')
    expect(out).toContain('deploy the app')
  })
  it('terminal prints the captured pane', async () => {
    const out = await shimRun('node-A', ['terminal', '--node', 'node-B'])
    expect(out).toContain('Builder — terminal')
    expect(out).toContain('last build ok')
  })
  it('terminal reports a session that is not running', async () => {
    const out = await shimRun('node-A', ['terminal', '--node', 'node-X'])
    expect(out).toContain('not running')
  })
  it('is a no-op without NODETERM_NODE_ID', async () => {
    const out = await shimRun('', ['list'])
    expect(out).toContain('Not a nodeterm session')
  })
  it('list marks sticky notes', async () => {
    const out = await shimRun('node-A', ['list'])
    expect(out).toContain('Deploy notes (note)')
  })
  it('summary of a note prints its text', async () => {
    const out = await shimRun('node-A', ['summary', '--node', 'note-1'])
    expect(out).toContain('Deploy notes — note')
    expect(out).toContain('use the staging key')
  })
  it('transcript of a note prints its text too', async () => {
    const out = await shimRun('node-A', ['transcript', '--node', 'Deploy notes'])
    expect(out).toContain('use the staging key')
  })
  it('terminal of a note explains there is no terminal', async () => {
    const out = await shimRun('node-A', ['terminal', '--node', 'note-1'])
    expect(out).toContain('sticky note')
    expect(out).toContain('no terminal')
  })
  it('renders a codex rollout transcript', async () => {
    const out = await shimRun('node-A', ['summary', '-n', '20', '--node', 'node-X'])
    expect(out).toContain('user: fix the tests')
    expect(out).toContain('assistant: Sure, running them.')
    expect(out).toContain('$ shell')
    expect(out).toContain('= 2 passed')
  })
  it('renders a gemini chat transcript (event-sourced replay)', async () => {
    const out = await shimRun('node-A', ['transcript', '--node', 'node-G'])
    expect(out).toContain('user: hello gemini')
    expect(out).toContain('assistant: hello back')
  })
  it('non-claude agent without a resolved path gets no cwd fallback', async () => {
    const out = await shimRun('node-A', ['summary', '--node', 'node-Y'])
    expect(out).toContain('no conversation transcript yet')
  })
  it('renders an opencode transcript via the export', async () => {
    const out = await shimRun('node-A', ['transcript', '--node', 'node-O'])
    expect(out).toContain('user: add rerank')
    expect(out).toContain('assistant: done, added rerank.ts')
    expect(out).toContain('$ bash npm test')
  })
  it('opencode without a session id reports friendly, does not throw', async () => {
    const out = await shimRun('node-A', ['summary', '--node', 'node-O2'])
    expect(out).toContain('has no session id yet')
  })

  // The whole point of Phase 2: the transcript is on another machine, and the desktop serves the
  // read over the project's ControlMaster. The command an agent types is unchanged.
  it('reads a REMOTE node through the same command', async () => {
    const out = await shimRun('node-A', ['summary', '--node', 'node-R'])
    expect(out).toContain('deploy the app')
    expect(asked.transcripts).toContain('node-R')
  })

  it('matches a node by title, case-insensitively', async () => {
    const out = await shimRun('node-A', ['summary', '--node', 'builder'])
    expect(out).toContain('deploy the app')
  })

  it('lists what IS linked when the target is unknown', async () => {
    const out = await shimRun('node-A', ['summary', '--node', 'nope'])
    expect(out).toContain('No linked node matches')
    expect(out).toContain('Builder')
  })

  // Authorization: a caller holding the hook token still only ever gets ITS OWN document.
  it('gives an unlinked node nothing, whatever it asks for', async () => {
    const out = await shimRun('node-Z', ['transcript', '--node', 'node-B'])
    expect(out).toContain('No linked nodes')
    expect(out).not.toContain('deploy the app')
  })
})

// The per-node token (task A10). Same shape as every other client: read the file the endpoint
// advertises, keyed by this node's id, present it on BOTH transports.
//
// curl DROPS a header whose value is empty (`-H "X: ${empty}"` sends nothing at all) — which is
// the contract we want, since the server reads absent and empty identically as `legacy`. So
// "empty token" below is read as `headers[...] ?? ''`.
describe('context-link shim presents the per-node token', () => {
  const seen: { path: string; nodeToken: string }[] = []
  let tcp: import('node:http').Server
  let unix: import('node:http').Server
  let tcpPort = 0
  let sock = ''
  let tokenDir = ''

  beforeAll(async () => {
    const http = await import('node:http')
    const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void => {
      req.resume()
      req.on('end', () => {
        seen.push({ path: req.url ?? '', nodeToken: String(req.headers['x-nodeterm-node-token'] ?? '') })
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('ok\n')
      })
    }
    tcp = http.createServer(handler)
    unix = http.createServer(handler)
    await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r))
    tcpPort = (tcp.address() as { port: number }).port
    sock = join(dir, 'ctx-token-probe.sock')
    await new Promise<void>((r) => unix.listen(sock, r))
    tokenDir = join(dir, 'node-tokens')
    mkdirSync(tokenDir, { recursive: true })
    writeFileSync(join(tokenDir, 'node-A'), 'CONTEXT-NODE-TOKEN\n', { mode: 0o600 })
  })

  afterAll(() => {
    tcp.close()
    unix.close()
  })

  function probe(nodeId: string, env: Record<string, string>): Promise<unknown> {
    return run('/bin/sh', [shim, 'list'], {
      env: { PATH: process.env.PATH ?? '', NODETERM_NODE_ID: nodeId, NODETERM_HOOK_TOKEN: 'x', ...env }
    })
  }

  it('sends it over the TCP branch when the file exists', async () => {
    seen.length = 0
    await probe('node-A', { NODETERM_HOOK_PORT: String(tcpPort), NODETERM_NODE_TOKEN_DIR: tokenDir })
    expect(seen).toEqual([{ path: '/context-link/list', nodeToken: 'CONTEXT-NODE-TOKEN' }])
  })

  it('sends it over the unix-socket branch too (the SSH path)', async () => {
    seen.length = 0
    await probe('node-A', { NODETERM_HOOK_SOCK: sock, NODETERM_NODE_TOKEN_DIR: tokenDir })
    expect(seen).toEqual([{ path: '/context-link/list', nodeToken: 'CONTEXT-NODE-TOKEN' }])
  })

  it('reads the dir out of the endpoint file, not only the env', async () => {
    seen.length = 0
    const endpoint = join(dir, 'ctx-token-endpoint.env')
    writeFileSync(
      endpoint,
      `NODETERM_HOOK_PORT=${tcpPort}\nNODETERM_HOOK_TOKEN=whatever\nNODETERM_HOOK_VERSION=2\nNODETERM_NODE_TOKEN_DIR=${tokenDir}\n`
    )
    await probe('node-A', { NODETERM_HOOK_ENDPOINT: endpoint })
    expect(seen).toEqual([{ path: '/context-link/list', nodeToken: 'CONTEXT-NODE-TOKEN' }])
  })

  it('still reads, with an empty token, when no token file exists', async () => {
    seen.length = 0
    await probe('node-A', { NODETERM_HOOK_PORT: String(tcpPort), NODETERM_NODE_TOKEN_DIR: join(dir, 'nope') })
    expect(seen).toEqual([{ path: '/context-link/list', nodeToken: '' }])
  })

  it('never presents ANOTHER node\'s token file — the path is keyed by $NODETERM_NODE_ID', async () => {
    seen.length = 0
    await probe('node-Z', { NODETERM_HOOK_PORT: String(tcpPort), NODETERM_NODE_TOKEN_DIR: tokenDir })
    expect(seen).toEqual([{ path: '/context-link/list', nodeToken: '' }])
  })
})

// `ps` and /proc/<pid>/cmdline are world-readable, so a credential passed as `curl -H …` is
// published to every other account on the host for the life of that curl — and this shim is
// installed on SSH hosts, where the other accounts are strangers. Both headers go in on stdin.
//
// The recording curl is a PASSTHROUGH (log argv + stdin, then run the real curl), so each case
// proves the credential left argv AND that it still reached the server. Checking only the server's
// headers would pass with the leak entirely intact.
describe('context-link shim keeps credentials off curl\'s command line', () => {
  const seen: { hookToken: string; nodeToken: string }[] = []
  let tcp: import('node:http').Server
  let unix: import('node:http').Server
  let tcpPort = 0
  let sock = ''
  let binDir = ''
  let tokenDir = ''
  let argvLog = ''
  let stdinLog = ''

  beforeAll(async () => {
    const http = await import('node:http')
    const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void => {
      req.resume()
      req.on('end', () => {
        seen.push({
          hookToken: String(req.headers['x-nodeterm-hook-token'] ?? ''),
          nodeToken: String(req.headers['x-nodeterm-node-token'] ?? '')
        })
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('ok\n')
      })
    }
    tcp = http.createServer(handler)
    unix = http.createServer(handler)
    await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r))
    tcpPort = (tcp.address() as { port: number }).port
    sock = join(dir, 'ctx-argv-probe.sock')
    await new Promise<void>((r) => unix.listen(sock, r))
    tokenDir = join(dir, 'ctx-argv-tokens')
    mkdirSync(tokenDir, { recursive: true })
    writeFileSync(join(tokenDir, 'node-A'), 'SECRET-NODE-TOKEN\n', { mode: 0o600 })
    binDir = join(dir, 'ctx-argv-bin')
    mkdirSync(binDir, { recursive: true })
    argvLog = join(binDir, 'argv.log')
    stdinLog = join(binDir, 'stdin.log')
    const realCurl = (await run('/bin/sh', ['-c', 'command -v curl'])).stdout.trim()
    writeFileSync(
      join(binDir, 'curl'),
      [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}`,
        // Only a curl told to read its config from stdin gets a reader. A regression that put the
        // headers back on argv would otherwise leave `tee` waiting on a stdin nobody ever closes,
        // and the failure would read as a timeout instead of the assertion it really is.
        'case "$*" in',
        `  *"--config -"*) tee -a ${JSON.stringify(stdinLog)} | ${JSON.stringify(realCurl)} "$@" ;;`,
        `  *) ${JSON.stringify(realCurl)} "$@" </dev/null ;;`,
        'esac',
        ''
      ].join('\n'),
      { mode: 0o755 }
    )
  })

  afterAll(() => {
    tcp.close()
    unix.close()
  })

  async function record(env: Record<string, string>): Promise<{ argv: string; stdin: string }> {
    // Truncated, not deleted: a regression must fail on the assertion below, not on a missing file.
    writeFileSync(argvLog, '')
    writeFileSync(stdinLog, '')
    seen.length = 0
    await run('/bin/sh', [shim, 'list'], {
      env: {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        NODETERM_NODE_ID: 'node-A',
        NODETERM_HOOK_TOKEN: 'SECRET-BEARER',
        NODETERM_NODE_TOKEN_DIR: tokenDir,
        ...env
      }
    })
    return { argv: readFileSync(argvLog, 'utf8'), stdin: readFileSync(stdinLog, 'utf8') }
  }

  it('names no credential header in the generated source at all', () => {
    expect(CONTEXT_SHIM_SCRIPT).not.toContain('-H "X-Nodeterm-Hook-Token')
    expect(CONTEXT_SHIM_SCRIPT).not.toContain('-H "X-Nodeterm-Node-Token')
    expect((CONTEXT_SHIM_SCRIPT.match(/--config -/g) ?? []).length).toBe(2)
  })

  it('over TCP: neither token is in argv, both arrive on stdin and reach the server', async () => {
    const { argv, stdin } = await record({ NODETERM_HOOK_PORT: String(tcpPort) })
    expect(seen).toEqual([{ hookToken: 'SECRET-BEARER', nodeToken: 'SECRET-NODE-TOKEN' }])
    expect(argv).not.toContain('SECRET-BEARER')
    expect(argv).not.toContain('SECRET-NODE-TOKEN')
    expect(argv).not.toContain('X-Nodeterm-Hook-Token')
    expect(argv).not.toContain('X-Nodeterm-Node-Token')
    expect(stdin).toContain('header = "X-Nodeterm-Hook-Token: SECRET-BEARER"')
    expect(stdin).toContain('header = "X-Nodeterm-Node-Token: SECRET-NODE-TOKEN"')
  })

  // The SSH transport — the one where the process table belongs to somebody else.
  it('over the unix socket: neither token is in argv, both arrive on stdin', async () => {
    const { argv, stdin } = await record({ NODETERM_HOOK_PORT: '', NODETERM_HOOK_SOCK: sock })
    expect(seen).toEqual([{ hookToken: 'SECRET-BEARER', nodeToken: 'SECRET-NODE-TOKEN' }])
    expect(argv).toContain('--unix-socket')
    expect(argv).not.toContain('SECRET-BEARER')
    expect(argv).not.toContain('SECRET-NODE-TOKEN')
    expect(stdin).toContain('header = "X-Nodeterm-Hook-Token: SECRET-BEARER"')
    expect(stdin).toContain('header = "X-Nodeterm-Node-Token: SECRET-NODE-TOKEN"')
  })

  // "No token" still means legacy: curl sends no header at all when there is nothing after the
  // colon, exactly as the `-H` form behaved, and the server reads absent and empty alike.
  it('still calls with no node token at all when the file is missing', async () => {
    const { argv, stdin } = await record({
      NODETERM_HOOK_PORT: String(tcpPort),
      NODETERM_NODE_TOKEN_DIR: join(dir, 'ctx-argv-none')
    })
    expect(seen).toEqual([{ hookToken: 'SECRET-BEARER', nodeToken: '' }])
    expect(stdin).toContain('header = "X-Nodeterm-Node-Token: "')
    expect(argv).not.toContain('X-Nodeterm-Node-Token')
  })
})

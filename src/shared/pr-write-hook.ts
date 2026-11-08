// An agent's own shell writes to a pull request (`gh pr merge|review|comment|close`, `gh api` writes to
// a PR's merge, reviews or comments): read off its PreToolUse / PostToolUse hook. Before the command
// runs, nodeterm turns it into the pull node's Confirm bar (the hook denies it and names `pr-propose`);
// after one ran anyway (another repository, or a gate that failed open), the PR's pull nodes refresh.
// Pure: nothing here reaches GitHub. docs/github-issues-kanban.md, "Agent writes go through Confirm".
import type { PullMergeMethod } from './github-pull-detail'

export interface PrWrite {
  /** `review` = a `gh api` review whose event this matcher does not read. */
  action: 'merge' | 'approve' | 'request-changes' | 'comment' | 'review' | 'close'
  /** Undefined when the command names no number (gh's current-branch PR, or a branch name). */
  pullNumber?: number
  /** The repository the command names (`-R`, `--repo`, `GH_REPO`, a URL). Undefined = the shell's own. */
  repository?: string
  method?: PullMergeMethod
  /** `issues/<n>/comments`: n may be a plain issue, so only an existing pull node makes it a PR write. */
  viaIssue?: true
}

const SEPARATORS = new Set(['&&', '||', ';', '|', '&', '\n', '(', ')'])

/** Split a shell line into simple commands of words. Quotes and backslashes are honored, so a
 *  separator or a `gh` inside a quoted string is text. `$(...)` splits on its parentheses, so a `gh`
 *  inside it is read; backticks, `env`/`sudo` prefixes and `sh -c` strings are not (they run: fail open). */
function simpleCommands(line: string): string[][] {
  const out: string[][] = [[]]
  let word: string | null = null
  const end = () => {
    if (word !== null) out[out.length - 1].push(word)
    word = null
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === "'") {
      const close = line.indexOf("'", i + 1)
      const stop = close < 0 ? line.length : close
      word = (word ?? '') + line.slice(i + 1, stop)
      i = stop
    } else if (c === '"') {
      word ??= ''
      for (i++; i < line.length && line[i] !== '"'; i++) {
        if (line[i] === '\\' && i + 1 < line.length) i++
        word += line[i]
      }
    } else if (c === '\\' && i + 1 < line.length) {
      if (line[i + 1] !== '\n') word = (word ?? '') + line[i + 1]
      i++
    } else if (c === ' ' || c === '\t') {
      end()
    } else {
      const op = ['&&', '||'].includes(line.slice(i, i + 2)) ? line.slice(i, i + 2) : c
      if (SEPARATORS.has(op)) {
        end()
        out.push([])
        i += op.length - 1
      } else {
        word = (word ?? '') + c
      }
    }
  }
  end()
  return out.filter((words) => words.length > 0)
}

/** `owner/repo`, `host/owner/repo` or a github.com URL: the last two path segments. */
function repoOf(value: string): string | undefined {
  const parts = value.replace(/^https?:\/\//, '').replace(/\/+$/, '').split('/')
  return parts.length >= 2 ? `${parts.at(-2)}/${parts.at(-1)}` : undefined
}

const PULL_URL = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/([1-9]\d{0,9})(?:[/?#]|$)/
const NUMBER = /^#?([1-9]\d{0,9})$/

/** Flags that take a value, per subcommand (gh 2.x help). Everything else is a boolean. */
const PR_VALUE_FLAGS: Record<string, readonly string[]> = {
  merge: ['A', 'author-email', 'b', 'body', 'F', 'body-file', 'match-head-commit', 't', 'subject'],
  review: ['b', 'body', 'F', 'body-file'],
  comment: ['b', 'body', 'F', 'body-file'],
  close: ['c', 'comment']
}
const API_VALUE_FLAGS = ['X', 'method', 'f', 'raw-field', 'F', 'field', 'input', 'H', 'header', 'q', 'jq', 't', 'template',
  'hostname', 'cache', 'p', 'preview']

interface Args { positional: string[]; flags: Map<string, string | true> }

/** pflag-style: `--name value`, `--name=value`, `-x value`, `-xvalue`, clustered booleans `-sd`. */
function readArgs(words: string[], valueFlags: readonly string[]): Args {
  const positional: string[] = []
  const flags = new Map<string, string | true>()
  const takes = (name: string) => valueFlags.includes(name) || name === 'R' || name === 'repo'
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (w === '--') {
      positional.push(...words.slice(i + 1))
      break
    }
    if (w.startsWith('--')) {
      const eq = w.indexOf('=')
      const name = w.slice(2, eq < 0 ? undefined : eq)
      flags.set(name, eq >= 0 ? w.slice(eq + 1) : takes(name) ? (words[++i] ?? '') : true)
    } else if (w.startsWith('-') && w.length > 1) {
      for (let j = 1; j < w.length; j++) {
        const name = w[j]
        if (takes(name)) {
          flags.set(name, j + 1 < w.length ? w.slice(j + 1) : (words[++i] ?? ''))
          break
        }
        flags.set(name, true)
      }
    } else {
      positional.push(w)
    }
  }
  return { positional, flags }
}

const has = (a: Args, ...names: string[]) => names.some((n) => a.flags.has(n))
const value = (a: Args, ...names: string[]) => {
  for (const n of names) {
    const v = a.flags.get(n)
    if (typeof v === 'string') return v
  }
  return undefined
}

function prWrite(sub: string, rest: string[], envRepo: string | undefined): PrWrite | undefined {
  const flagsFor = PR_VALUE_FLAGS[sub]
  if (!flagsFor) return undefined
  const a = readArgs(rest, flagsFor)
  if (has(a, 'w', 'web')) return undefined
  let action: PrWrite['action']
  if (sub === 'review') {
    if (has(a, 'a', 'approve')) action = 'approve'
    else if (has(a, 'r', 'request-changes')) action = 'request-changes'
    else if (has(a, 'c', 'comment')) action = 'comment'
    else return undefined
  } else {
    action = sub as PrWrite['action']
  }
  const write: PrWrite = { action }
  const target = a.positional[0] ?? ''
  const url = PULL_URL.exec(target)
  const num = url?.[2] ?? NUMBER.exec(target)?.[1]
  if (num) write.pullNumber = Number(num)
  const named = url?.[1] ?? value(a, 'R', 'repo') ?? envRepo
  const repository = named ? (url ? named : repoOf(named)) : undefined
  if (repository) write.repository = repository
  if (sub === 'merge') {
    const method = has(a, 's', 'squash') ? 'squash' : has(a, 'r', 'rebase') ? 'rebase' : has(a, 'm', 'merge') ? 'merge' : undefined
    if (method) write.method = method
  }
  return write
}

const API_PATH = /^repos\/([^/]+)\/([^/]+)\/(pulls|issues)\/([1-9]\d{0,9})\/(merge|reviews|comments)(?:[/?]|$)/
const CURRENT_REPO = new Set(['{owner}/{repo}', ':owner/:repo'])

function apiWrite(rest: string[]): PrWrite | undefined {
  const a = readArgs(rest, API_VALUE_FLAGS)
  // gh api sends GET unless a method is named, or a field or body makes it a POST.
  const fields = has(a, 'f', 'raw-field', 'F', 'field', 'input')
  const method = (value(a, 'X', 'method') ?? (fields ? 'POST' : 'GET')).toUpperCase()
  if (!['POST', 'PUT', 'PATCH'].includes(method)) return undefined
  const path = (a.positional[0] ?? '').replace(/^https?:\/\/[^/]+\//, '').replace(/^\//, '')
  const m = API_PATH.exec(path)
  if (!m) return undefined
  const [, owner, repo, kind, num, what] = m
  if (kind === 'issues' && what !== 'comments') return undefined
  const write: PrWrite = { action: what === 'merge' ? 'merge' : what === 'reviews' ? 'review' : 'comment', pullNumber: Number(num) }
  if (!CURRENT_REPO.has(`${owner}/${repo}`)) write.repository = `${owner}/${repo}`
  if (kind === 'issues') write.viaIssue = true
  return write
}

/** Every PR write in a shell command line, in order. */
export function parsePrWrites(command: string): PrWrite[] {
  const writes: PrWrite[] = []
  for (const words of simpleCommands(command)) {
    let i = 0
    let envRepo: string | undefined
    for (; i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]); i++) {
      if (words[i].startsWith('GH_REPO=')) envRepo = words[i].slice('GH_REPO='.length)
    }
    if (words[i]?.split('/').at(-1) !== 'gh') continue
    const rest = words.slice(i + 1)
    let write: PrWrite | undefined
    if (rest[0] === 'pr') {
      // `gh pr -R x merge`: flags may sit before the subcommand; they join its own.
      let j = 1
      const lead: string[] = []
      for (; j < rest.length && rest[j].startsWith('-'); j++) {
        lead.push(rest[j])
        if (rest[j] === '-R' || rest[j] === '--repo') lead.push(rest[++j] ?? '')
      }
      write = prWrite(rest[j] ?? '', [...lead, ...rest.slice(j + 1)], envRepo)
    } else if (rest[0] === 'api') {
      write = apiWrite(rest.slice(1))
    }
    if (write) writes.push(write)
  }
  return writes
}

/** What main reads off a verified hook: the node, before (`pre`) or after (`post`) the command ran. */
export interface PrWriteEvent {
  nodeId: string
  phase: 'pre' | 'post'
  writes: PrWrite[]
}

/** The PR writes in a verified Claude Code / Codex Bash PreToolUse or PostToolUse, else undefined. */
export function prWriteEvent(
  agentId: string,
  nodeId: string,
  payload: Record<string, unknown>,
  meta: { verified: boolean }
): PrWriteEvent | undefined {
  if (!meta.verified || !nodeId || (agentId !== 'claude' && agentId !== 'codex') || payload.tool_name !== 'Bash') return undefined
  const phase = payload.hook_event_name === 'PreToolUse' ? 'pre' : payload.hook_event_name === 'PostToolUse' ? 'post' : undefined
  const command = (payload.tool_input as { command?: unknown } | undefined)?.command
  if (!phase || typeof command !== 'string') return undefined
  const writes = parsePrWrites(command)
  return writes.length ? { nodeId, phase, writes } : undefined
}

/** A pull node of the agent's project, and whether it is joined to that agent (rope or context link). */
export interface GatePullNode {
  id: string
  repository: string
  pullNumber: number
  linked: boolean
}

interface GateInput {
  writes: PrWrite[]
  /** The project's resolved GitHub repository (open-pr's rule), undefined when it has none. */
  repo: string | undefined
  pullNodes: GatePullNode[]
}

const same = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase()

/** The project's own-repo writes, each with the pull nodes of its PR (linked first). */
function ownWrites({ writes, repo, pullNodes }: GateInput): { write: PrWrite; nodes: GatePullNode[] }[] {
  const mine = pullNodes.filter((n) => same(n.repository, repo))
  return writes
    .filter((w) => same(w.repository ?? repo, repo))
    .map((write) => {
      const linked = mine.filter((n) => n.linked)
      // A write naming no PR is gh's current-branch PR: the one linked pull node, when there is one.
      // ponytail: the agent's shell repo is taken to be the project's when the command names none.
      const nodes = write.pullNumber === undefined
        ? (linked.length === 1 ? linked : [])
        : mine.filter((n) => n.pullNumber === write.pullNumber)
      return { write, nodes: [...nodes].sort((a, b) => Number(b.linked) - Number(a.linked)) }
    })
    // An issue comment is a PR write only when that number has a pull node (no read to tell them apart).
    .filter(({ write, nodes }) => !write.viaIssue || nodes.length > 0)
}

function proposeArgs(write: PrWrite): string | undefined {
  switch (write.action) {
    case 'merge': return `--action merge${write.method ? ` --method ${write.method}` : ''}`
    case 'review': return '--action approve|request-changes|comment --message <text>'
    case 'close': return undefined
    default: return `--action ${write.action} --message <text>`
  }
}

/** Deny an own-repo PR write with the reason the agent reads; allow everything else. */
export function prWriteGateDecision(input: GateInput): { deny?: string } {
  const [hit] = ownWrites(input)
  if (!hit) return {}
  const { write, nodes: [node] } = hit
  const pr = write.pullNumber ? `PR #${write.pullNumber}` : 'this PR'
  const lead = 'nodeterm: Do not write to GitHub yourself.'
  const args = proposeArgs(write)
  const tail = 'from the manage-nodeterm-canvas skill; the user confirms on the node.'
  if (!args) {
    return { deny: `${lead} Closing ${pr} is the user's call: tell them, and they close it on GitHub.` }
  }
  if (node?.linked) {
    return { deny: `${lead} ${pr} has pull node ${node.id}. Run \`pr-propose --node ${node.id} ${args}\` ${tail}` }
  }
  if (node) {
    return {
      deny: `${lead} ${pr} has pull node ${node.id}. Run \`open-pr --pr ${node.pullNumber}\` first (it links you to it), ` +
        `then \`pr-propose --node ${node.id} ${args}\` ${tail}`
    }
  }
  const open = write.pullNumber ? `open-pr --pr ${write.pullNumber}` : 'open-pr --pr <number>'
  return {
    deny: `${lead} Run \`${open}\` first (it opens ${pr} as a pull node beside you), ` +
      `then \`pr-propose --node <the id it prints> ${args}\` ${tail}`
  }
}

/** The pull nodes to refresh after own-repo PR writes ran (PULL_REFRESH_EVENT). */
export function prRefreshTargets(input: GateInput): string[] {
  return [...new Set(ownWrites(input).flatMap(({ nodes }) => nodes.map((n) => n.id)))].sort((a, b) =>
    input.pullNodes.findIndex((n) => n.id === a) - input.pullNodes.findIndex((n) => n.id === b))
}

/** What the managed hook script prints verbatim for a gate deny (Claude Code and Codex read the same
 *  PreToolUse JSON). The script checks this prefix before it prints a byte. */
export const PRE_TOOL_DENY_PREFIX = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":'

export function preToolDenyAnswer(reason: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })
}

/** Largest gate answer the script prints, in UTF-8 bytes (managed-script.ts PR_GATE_POLL_SH). */
export const PR_GATE_ANSWER_MAX_BYTES = 4096

/** The TS twin of the gate poll's check: what the script would print (or `allow`), nothing else. */
export function isPrGateAnswer(content: string): boolean {
  if (content === 'allow') return true
  // eslint-disable-next-line no-control-regex
  return content.startsWith(PRE_TOOL_DENY_PREFIX) && content.endsWith('}') && !/[\u0000-\u001f]/.test(content) &&
    new TextEncoder().encode(content).length <= PR_GATE_ANSWER_MAX_BYTES
}

/** Gate tickets only (`gate-<node>-<ms>-<pid>`, PR_GATE_ARM_SH): a held permission's id never gets a gate answer. */
export function isPrGateId(id: unknown): id is string {
  return typeof id === 'string' && id.length <= 256 && /^gate-[A-Za-z0-9_-]+$/.test(id)
}

/** How long desktop main waits for the canvas's decision before it allows (the hook holds 5 s). The
 *  canvas resolves the repository with the same status call open-pr makes, which can be slow cold. */
export const PR_GATE_ASK_MS = 3_000
/** A deny reason longer than this is cut (it comes from the renderer; ours are a few hundred). */
const PR_GATE_REASON_MAX = 1_500

/**
 * Answer one gate ticket: the canvas's decision for a verified PreToolUse PR write, `allow` for
 * anything else. FAILS OPEN: a timeout, a thrown ask or a missing canvas allows and logs, because
 * a broken gate must not wedge an agent. `write` puts the answer file on the agent's host.
 */
export async function answerPrWriteGate(input: {
  event: PrWriteEvent | undefined
  ask: (event: PrWriteEvent) => Promise<{ deny?: string }>
  write: (content: string) => Promise<boolean>
  log: (message: string) => void
  timeoutMs?: number
}): Promise<void> {
  const { event, log } = input
  let content = 'allow'
  if (event?.phase === 'pre') {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), input.timeoutMs ?? PR_GATE_ASK_MS) })
    try {
      const answer = await Promise.race([input.ask(event), timeout])
      if (answer === 'timeout') log(`node ${event.nodeId}: the canvas did not answer; timed out, allowed`)
      else if (answer.deny) content = preToolDenyAnswer(answer.deny.slice(0, PR_GATE_REASON_MAX))
    } catch (e) {
      log(`node ${event.nodeId}: ${String(e)}; allowed`)
    } finally {
      clearTimeout(timer)
    }
  }
  if (!(await input.write(content).catch(() => false))) log(`could not write the answer for node ${event?.nodeId ?? '?'}`)
}

import { execFile, spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import type { GitResult, Settings } from '../shared/types'
import { directExecutableInvocation, findInPathString, shellPathNow } from './exec-path'
import { resolveGitRemote, runRemoteGit } from './remote-ssh/remote-git'

const run = promisify(execFile)

const STAGED_DIFF_BYTE_BUDGET = 200_000
const OUTPUT_LIMIT = 64_000
const TIMEOUT_MS = 120_000

const bytes = (s: string) => Buffer.byteLength(s, 'utf-8')

/** Resolve a CLI binary to an absolute path (GUI apps don't inherit the shell PATH).
 *  Exported for tests only — every caller is in this module. */
export function resolveBinary(name: string): string | null {
  // `path.isAbsolute`, not `startsWith('/')`. A Windows absolute path (`C:\Tools\agent.exe`, or a
  // UNC `\\server\share\agent.exe`) does not start with `/`, so it missed this branch, fell
  // through to the bare-name path below, and was then rejected by that branch's charset gate for
  // containing `:` and `\`. The effect was that a custom commit agent could not be given as a full
  // path on Windows at all.
  if (path.isAbsolute(name)) return fs.existsSync(name) ? name : null
  // `name` comes from a user setting (the custom commit agent), so anything that is not a bare
  // binary name is refused here — BEFORE it is interpolated into the paths below. It used to be
  // checked only after that loop, which let a name like `../../evil` normalize out of the
  // directories the loop is meant to confine it to (`~/.local/bin/../../evil` is `~/evil`). Same
  // rule as before, applied where it actually confines.
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null
  // GUI apps inherit a minimal PATH, so these user-install locations are checked BEFORE the PATH
  // walk — deliberately, and left in that order here. They are POSIX paths without a file
  // extension, which on Windows can only ever match an extensionless file: never the real
  // `<name>.exe`/`<name>.cmd`, and possibly something `spawn()` cannot execute at all (a shell
  // script, say). Skipped there rather than left to misfire; the PATH walk below is the one that
  // can actually answer on Windows.
  const candidates =
    os.platform() === 'win32'
      ? []
      : [
          `${os.homedir()}/.local/bin/${name}`,
          `${os.homedir()}/.claude/local/${name}`,
          `/opt/homebrew/bin/${name}`,
          `/usr/local/bin/${name}`,
          `/usr/bin/${name}`
        ]
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch {
      // ignore
    }
  }
  // Resolve via PATH without a shell OR a subprocess: walk the cached login-shell PATH from
  // exec-path.ts (the inherited GUI PATH misses user-installed bins).
  return findInPathString(name, shellPathNow() ?? process.env.PATH)
}

async function git(cwd: string, args: string[]): Promise<string> {
  // SSH projects read the staged diff over the project's ControlMaster (the agent spawn stays
  // local). Local path is untouched when no remote owns this cwd.
  const ref = resolveGitRemote(cwd)
  if (ref) {
    const r = await runRemoteGit(ref, cwd, args, 50 * 1024 * 1024)
    return r.ok ? r.out : ''
  }
  try {
    const { stdout } = await run('git', args, { cwd, maxBuffer: 50 * 1024 * 1024 })
    return stdout
  } catch {
    return ''
  }
}

/**
 * Split a unified diff into per-file chunks (each starting at a `diff --git` header) and
 * fairly distribute a byte budget across them ("water-filling"), so one giant generated
 * file (lockfile etc.) can't starve the human-written changes. Each cut is on a line
 * boundary with a marker; the agent never sees a half line.
 */
function truncateDiffForPrompt(diff: string, budget: number): string {
  if (bytes(diff) <= budget) return diff

  const chunks: string[] = []
  const re = /(^|\n)(diff --git )/g
  let lastIndex = 0
  let m: RegExpExecArray | null
  const starts: number[] = []
  while ((m = re.exec(diff))) starts.push(m.index + (m[1] ? 1 : 0))
  if (starts.length === 0) return capAtLine(diff, budget)
  for (let i = 0; i < starts.length; i++) {
    chunks.push(diff.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : diff.length))
  }
  lastIndex = starts[0]
  const preamble = diff.slice(0, lastIndex)

  // Water-fill: smallest files first take their full size; the rest share what remains.
  let remaining = budget - bytes(preamble)
  let left = chunks.length
  const caps = new Array<number>(chunks.length)
  chunks
    .map((c, i) => ({ i, size: bytes(c) }))
    .sort((a, b) => a.size - b.size)
    .forEach(({ i, size }) => {
      const share = Math.max(0, Math.floor(remaining / Math.max(1, left)))
      const take = Math.min(size, share)
      caps[i] = take
      remaining -= take
      left--
    })

  return preamble + chunks.map((c, i) => capAtLine(c, caps[i])).join('')
}

function capAtLine(text: string, cap: number): string {
  if (bytes(text) <= cap) return text
  let cut = Buffer.from(text, 'utf-8').slice(0, Math.max(0, cap)).toString('utf-8')
  const nl = cut.lastIndexOf('\n')
  if (nl > 0) cut = cut.slice(0, nl)
  const omitted = bytes(text) - bytes(cut)
  return `${cut}\n...(diff truncated, ${omitted} bytes omitted)\n`
}

function buildPrompt(diff: string, files: string, extra: string): string {
  const base = `Write a git commit message for the staged changes below.
Output ONLY the commit message - no preamble, no code fences, no quotes.
Use a concise subject line of at most 72 characters; if useful, add a blank line then a short body.
Do not include "Co-authored-by" trailers.`
  const body = diff
    ? `\n\nStaged diff:\n\`\`\`diff\n${diff}\n\`\`\``
    : `\n\nStaged files (diff omitted due to size):\n${files}`
  const suffix = extra.trim() ? `\n\nAdditional user prompt:\n${extra.trim()}` : ''
  return base + body + suffix
}

/** Split a command template into tokens (quote-aware, NO shell expansion). */
function tokenize(cmd: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

interface Plan {
  bin: string
  args: string[]
  stdin: string | null
}

function planAgent(settings: Settings, prompt: string): Plan | { error: string } {
  if (settings.commitAgent === 'custom') {
    const tokens = tokenize(settings.commitAgentCommand)
    if (tokens.length === 0) return { error: 'No custom commit command set (Settings → Commit messages).' }
    const bin = resolveBinary(tokens[0])
    if (!bin) return { error: `Command "${tokens[0]}" not found.` }
    const rest = tokens.slice(1)
    if (rest.includes('{prompt}')) {
      return { bin, args: rest.map((t) => (t === '{prompt}' ? prompt : t)), stdin: null }
    }
    return { bin, args: rest, stdin: prompt }
  }
  if (settings.commitAgent === 'codex') {
    const bin = resolveBinary('codex')
    if (!bin) return { error: 'codex CLI not found.' }
    return { bin, args: ['exec', '--sandbox', 'read-only'], stdin: prompt }
  }
  const bin = resolveBinary('claude')
  if (!bin) return { error: 'claude CLI not found. Install Claude Code or pick another agent in Settings.' }
  return { bin, args: ['-p', '--permission-mode', 'plan'], stdin: prompt }
}

function spawnAgent(
  bin: string,
  args: string[],
  cwd: string,
  stdin: string | null
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const invocation = directExecutableInvocation(bin, args)
    if (!invocation) {
      resolve({ code: 1, stdout: '', stderr: `Cannot safely execute Windows script: ${bin}` })
      return
    }

    const child = spawn(invocation.executable, invocation.args, {
      ...invocation.options,
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS)
    child.stdout.on('data', (d) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += d.toString()
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: 1, stdout, stderr: stderr || String(e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr })
    })
    if (stdin !== null) {
      // The agent CLI can exit before draining the prompt (bad flag, instant auth failure, crash
      // on boot) — the resulting EPIPE is NOT a throw at the write below but an async 'error'
      // EVENT on the pipe, and unhandled it takes the whole main process down (issue #382's
      // class). The close handler above already owns the outcome; log it and let the exit code
      // plus stderr tell the real story.
      child.stdin.on('error', (e: NodeJS.ErrnoException) => {
        console.warn(`[commit-message] agent stdin write failed (${e.code ?? e})`)
      })
      child.stdin.write(stdin)
      child.stdin.end()
    }
  })
}

// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g

/** Strip CLI noise (ANSI, status lines, wrapping fence, quotes) to leave the message. */
function cleanMessage(raw: string): string {
  let s = raw.replace(ANSI, '').trim()
  const fence = s.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/)
  if (fence) s = fence[1].trim()
  const noise = /^(generating|thinking|loading|analyzing|working|reading|here'?s|sure[,.!]?|okay|certainly|i'?ll|let me)\b/i
  const lines = s.split('\n')
  while (lines.length && noise.test(lines[0].trim())) lines.shift()
  s = lines.join('\n').trim()
  s = s.replace(/^["'`]+/, '').replace(/["'`]+$/, '').trim()
  return s
}

function extractError(text: string): string {
  const lines = text
    .replace(ANSI, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const meaningful = lines.reverse().find((l) => /error|fail|denied|not found|429|unauthor/i.test(l))
  return meaningful || lines[0] || 'Agent produced no output.'
}

/** Orchestrates: staged diff -> budget -> prompt -> read-only agent spawn -> clean message. */
export async function generateCommitMessage(cwd: string, settings: Settings): Promise<GitResult> {
  if (!cwd) return { ok: false, message: 'No project folder set.' }

  const names = (await git(cwd, ['diff', '--cached', '--name-status'])).trim()
  if (!names) return { ok: false, message: 'No staged changes. Stage files first.' }

  const rawDiff = await git(cwd, ['diff', '--cached', '--patch', '--minimal'])
  const diff = rawDiff ? truncateDiffForPrompt(rawDiff, STAGED_DIFF_BYTE_BUDGET) : ''
  const prompt = buildPrompt(diff, names, settings.commitExtraPrompt)

  return runAgent(prompt, cwd, settings)
}

/**
 * The working directory to give the LOCAL agent spawn.
 *
 * The agent always runs on THIS machine — only the git reads route over an SSH project's
 * ControlMaster (see `git` above), and by the time we spawn, the diff is already inside the prompt.
 * So a REMOTE project's cwd is a path on the server, and handing it to a local `spawn` is asking
 * macOS to chdir into a directory that does not exist here.
 *
 * That failed in the most misleading way possible: Node reports a missing CWD as `spawn <command>
 * ENOENT`, naming the BINARY. The 2026-08-05 report was "Error: spawn
 * /Users/enes/.local/bin/claude ENOENT" on SSH servers — which reads as "claude is not installed"
 * and sent the hunt to the CLI, while claude was sitting exactly where the path said and the
 * unreachable thing was `/root/<project>` on a Mac.
 *
 * Home is the right substitute rather than, say, a temp dir: it is where every other read-only
 * agent invocation without a project runs (`cwd || os.homedir()` has always been the fallback for
 * a project with no folder), and the agent needs no repo — it is given a prompt on stdin.
 */
export function localAgentCwd(cwd: string, isRemote: boolean, home: string): string {
  return !cwd || isRemote ? home : cwd
}

/** Plan + spawn the configured agent on a prompt and return its cleaned output. */
export async function runAgent(prompt: string, cwd: string, settings: Settings): Promise<GitResult> {
  const plan = planAgent(settings, prompt)
  if ('error' in plan) return { ok: false, message: plan.error }

  const spawnCwd = localAgentCwd(cwd, !!resolveGitRemote(cwd), os.homedir())
  const res = await spawnAgent(plan.bin, plan.args, spawnCwd, plan.stdin)
  const message = cleanMessage(res.stdout)
  if (res.code !== 0 && !message) {
    return { ok: false, message: extractError(res.stderr || res.stdout) }
  }
  if (!message) return { ok: false, message: 'Agent produced no output.' }
  return { ok: true, message }
}

/** Suggest a short terminal title from its recent output. */
export async function generateTerminalName(
  content: string,
  cwd: string,
  settings: Settings
): Promise<GitResult> {
  const trimmed = content.trim()
  if (!trimmed) return { ok: false, message: 'No terminal output to read yet.' }
  const clip = trimmed.split('\n').slice(-150).join('\n').slice(-8000)
  const prompt = `Below is the recent output of a terminal session. Suggest a very short title (2-4 words, Title Case, no surrounding quotes, no trailing punctuation) describing what this terminal is used for. Output ONLY the title.

Terminal output:
\`\`\`
${clip}
\`\`\``
  const r = await runAgent(prompt, cwd, settings)
  if (!r.ok) return r
  const name = r.message
    .split('\n')[0]
    .replace(/["'`.]+$/g, '')
    .trim()
    .slice(0, 40)
  return name ? { ok: true, message: name } : { ok: false, message: 'No name produced.' }
}

/** Suggest a short group title from the recent output of its member terminals. */
export async function generateGroupName(
  contents: string[],
  cwd: string,
  settings: Settings
): Promise<GitResult> {
  const blocks = contents
    .map((c, i) => {
      const clip = c.trim().split('\n').slice(-50).join('\n').slice(-2500)
      return clip ? `Terminal ${i + 1}:\n\`\`\`\n${clip}\n\`\`\`` : ''
    })
    .filter(Boolean)
  if (!blocks.length) return { ok: false, message: 'No terminal output to read yet.' }
  const prompt = `Below are the recent outputs of several terminal sessions that belong to one group. Suggest a very short group title (2-4 words, Title Case, no surrounding quotes, no trailing punctuation) describing the group's shared purpose. Output ONLY the title.

${blocks.join('\n\n')}`
  const r = await runAgent(prompt, cwd, settings)
  if (!r.ok) return r
  const name = r.message
    .split('\n')[0]
    .replace(/["'`.]+$/g, '')
    .trim()
    .slice(0, 40)
  return name ? { ok: true, message: name } : { ok: false, message: 'No name produced.' }
}

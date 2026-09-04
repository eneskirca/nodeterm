// The Codex launcher's supervisor loop (`nt_run_shared` in codex-identity-proxy.ts) must never be
// the pane's FOREGROUND process group while a Codex client is alive under it. PR #652's maintainer
// review measured, on a real tty, that without job control `codex --remote unix:// resume ...`
// inherits the supervisor shell's own process group — so the kernel-truth read this repo actually
// gates on (src/core/agents/pane-owner.ts's ps-based foreground-group lookup, and tmux's shallower
// #{pane_current_command}) answers "sh" instead of "codex"/"node" for as long as the client runs.
// Six call sites key off that answer and every one misreads a live, supervised Codex pane as
// shell-owned without the fix: agent-restart.ts's exit/resume phases, TerminalNode.tsx's
// hibernation wake, core/trigger-delivery.ts's shell-owned-pane gate,
// core/remote-ssh/agent-resync-decide.ts, core/pane-process.ts, core/pty-manager.ts.
//
// The fix is 'set -m' at the very top of the generated script (codex-identity-proxy.ts), so job
// control is on before the first launch, not only a post-reset resume. This is a real pty (via
// node-pty), not a string assertion on the shell's own text — the same discipline as
// sessionRename.realtty.test.ts and paste-injection.realtty.test.ts, because the claim is about
// what the KERNEL says owns the terminal and only a real terminal can answer that. It reads the
// foreground group through pane-owner.ts's own `ps` call — the module the production gates actually
// use — rather than re-deriving a second parser here.
//
// The CONTROL test is the mutation check, run rather than described: the exact same shape MINUS
// 'set -m' must still show the OLD, broken answer. If it ever stops, the fix test below is vacuous.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { buildCodexLauncherScript } from './codex-identity-proxy'
import { foregroundArgvArgs, foregroundPgid, parseForegroundArgv, parseForegroundPids } from './agents/pane-owner'

const run = promisify(execFile)

let pty: typeof import('node-pty') | null = null
try {
  pty = await import('node-pty')
} catch {
  pty = null
}

let work = ''

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-fg-group-'))
})

afterAll(() => {
  if (work) fs.rmSync(work, { recursive: true, force: true })
})

interface ForegroundSnapshot {
  pgid: number | null
  argv: string[]
  pids: number[]
}

/** Who the tty says is in its foreground process group right now — the production read. */
async function readForeground(pid: number): Promise<ForegroundSnapshot> {
  const { stdout: ttyOut } = await run('ps', ['-o', 'tty=', '-p', String(pid)]).catch(() => ({
    stdout: ''
  }))
  const tty = ttyOut.trim()
  const args = foregroundArgvArgs(tty)
  if (!args) return { pgid: null, argv: [], pids: [] }
  const { stdout } = await run(args.bin, args.args).catch(() => ({ stdout: '' }))
  const pgid = foregroundPgid(stdout)
  if (pgid === null) return { pgid: null, argv: [], pids: [] }
  return { pgid, argv: parseForegroundArgv(stdout, pgid), pids: parseForegroundPids(stdout, pgid) }
}

/** Polls until the `sleep 30` stand-in for the Codex client shows up in SOME foreground reading. */
async function waitForClientInForeground(shellPid: number, timeoutMs = 5000): Promise<ForegroundSnapshot> {
  const start = Date.now()
  for (;;) {
    const snap = await readForeground(shellPid)
    if (snap.argv.some((a) => a.includes('sleep 30'))) return snap
    if (Date.now() - start > timeoutMs) return snap // let the assertion below fail on the real snapshot
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** Runs `scriptBody` (a shebang-less sh fragment) under a real pty and reports who ends up owning
 *  the terminal's foreground group, then kills everything it started. */
async function runUnderPty(
  scriptBody: string
): Promise<ForegroundSnapshot & { supervisorPid: number }> {
  const dir = fs.mkdtempSync(path.join(work, 'run-'))
  const script = path.join(dir, 'run.sh')
  fs.writeFileSync(script, `#!/bin/sh\n${scriptBody}\n`, { mode: 0o755 })
  const term = (pty as typeof import('node-pty')).spawn('/bin/sh', [script], {
    name: 'xterm-256color',
    cols: 200,
    rows: 40,
    cwd: dir,
    env: { ...process.env, TERM: 'xterm-256color' }
  })
  try {
    const snap = await waitForClientInForeground(term.pid)
    return { supervisorPid: term.pid, ...snap }
  } finally {
    // The client may now sit in ITS OWN process group — that is the entire point of the fix — so a
    // kill aimed only at the shell's pid would orphan it. Take whichever group currently owns the
    // tty first, then the shell's own pid, then the pty itself, each best-effort.
    try {
      const { pgid } = await readForeground(term.pid)
      if (pgid !== null) process.kill(-pgid, 'SIGKILL')
    } catch {
      /* already gone */
    }
    try {
      process.kill(term.pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
    try {
      term.kill()
    } catch {
      /* already gone */
    }
  }
}

const suite = pty ? describe : describe.skip

suite('Codex launcher: the supervisor is never the pane foreground group', () => {
  it(
    "CONTROL — without job control, the supervisor stays the pane's foreground group",
    async () => {
      const { supervisorPid, pgid, argv } = await runUnderPty('sleep 30')
      expect(pgid).toBe(supervisorPid)
      expect(argv[0]).not.toContain('sleep 30')
    },
    15_000
  )

  it(
    "the fix — 'set -m' hands the client its own process group and the tty's foreground group",
    async () => {
      const { supervisorPid, pgid, argv, pids } = await runUnderPty('set -m\nsleep 30')
      expect(pgid).not.toBe(supervisorPid)
      expect(argv[0]).toContain('sleep 30')
      expect(pids).toHaveLength(1)
    },
    15_000
  )
})

// Unconditional (no pty needed): the generator must still EMIT the fix, and early enough that the
// very first launch has job control on, not only a resume issued after a daemon reset.
describe('generated Codex launcher script', () => {
  it("sets 'set -m' before nt_run_shared can ever be defined or called", () => {
    const script = buildCodexLauncherScript()
    const setM = script.indexOf('\nset -m\n')
    expect(setM).toBeGreaterThan(-1)
    const definition = script.indexOf('nt_run_shared() {')
    expect(definition).toBeGreaterThan(-1)
    expect(setM).toBeLessThan(definition)
  })
})

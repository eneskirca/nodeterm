# Tmux Control-Mode Shadow Clients Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Background (zero-subscriber) tmux sessions keep observability and input without holding any pty device, dropping nodeterm's floor cost to 1 pty per session (the unavoidable pane pty) and ending `kern.tty.ptmx_max` exhaustion as a failure class.

**Architecture:** Visible sessions keep today's design untouched: one node-pty client running `tmux new-session -A -D` (the "painter" — see the hard-won warning at `src/core/pty-manager.ts:101-107`; we never re-derive screen state from `capture-pane`). What changes is only the *unwatched* side: when the idle-reaper (branch `fix/pty-limit-detection-reap`) releases a session's client pty, a session that still has a background consumer (relay `onData` sink, background write) gets a **shadow client** instead of nothing — a `tmux -C attach-session` child over plain pipes (control mode allocates **no pty device**). The shadow streams the pane's raw bytes via `%output` events and executes `send-keys` for input. First human subscriber ⇒ shadow is killed and the existing cold-attach path spawns the real pty client, exactly as after an app restart.

**Tech Stack:** tmux control mode (`-C`, protocol stable since tmux 1.8; we require the repo's existing floor, tmux ≥ 3.2 — same floor `terminal-features` already imposes, `src/core/pty-manager.ts:109-115`), Node `child_process.spawn` with pipes, vitest.

## Global Constraints

- NEVER kill tmux *sessions*: closed-project sessions run forever BY DESIGN (`src/core/pty-manager.ts:465-468` region; reclaim path is the user's "Recently closed" delete). Shadow lifecycle may only kill its own *client*.
- Never suggest or use `tmux kill-server`.
- Any real-pty detach goes through `releasePty()` (`src/core/pty-release.ts`) — never bare `proc.kill()`.
- The visible-terminal path (node-pty client, `-A -D` attach flags, alternate screen, mouse copy via OSC 52) is untouchable in this plan. No control-mode rendering for visible terminals — `pty-manager.ts:101-107` documents why the painter stays.
- `src/core/` stays Electron-free (it is shared with the server edition — see the `platform()` seam).
- Worktree setup for implementers: fresh worktrees have no node_modules; run `ln -s /Users/enes/projects/nodebasedterminal/node_modules node_modules` and NEVER run npm install / rebuild / postinstall (arch-sensitive native builds).
- Plan file itself: `docs/superpowers/plans/` is gitignored; commit this file with `git add -f`, as prior plans did.
- All commits end with the repo's `Co-Authored-By:` convention.

## Revision Points (named assumptions — re-check before executing)

1. **Reap-branch seam — RESOLVED 2026-08-11, and it reshapes Task 3.** `fix/pty-limit-detection-reap` merged (through main `02d3ec17`). Actual seams: `releaseClient()` (extracted final-snapshot + `releasePty` + index cleanup, shared with `kill()`), `forget()` (drops `byPersistKey`; next `pty:create` warm-reattaches via `tmux new-session -A`, `fresh:false`), sweep in `src/core/pty-reap.ts` (`REAP_IDLE_MS` 10min / `REAP_SWEEP_MS` 60s, pure `shouldReap`), `Session.tmuxBacked`, attachment decided against `platform().clientIds()`.
   **Timer-interaction check item (added 2026-08-11 after PR #118 merged):** three lifecycles now run side by side — renderer park (`TERM_PARK_MS` 5min), offscreen dispose (`offscreenTerminalMinutes` default 10min, `src/renderer/terminal/offscreen-policy.ts`), and the reap sweep (`REAP_IDLE_MS` 10min). Before executing Tasks 3-4, verify with the merged code: (a) an offscreen-disposed node drops its subscription, so its session releases IMMEDIATELY via the zero-subscriber path — the reap never sees it; confirm a shadow attached to such a session is disposed by the same `create()` swap-out when the node scrolls back into view; (b) the reap threshold must stay ≥ 2× park (documented in pty-reap.ts) and any shadow linger must stay well under all three so it never keeps a session looking "watched"; (c) none of the three may treat a live shadow as a subscriber (a shadow must be invisible to `platform().clientIds()`-based attachment checks).
   **Finding that invalidates Task 3's original trigger:** a session at literal zero subscribers is released *immediately* by `kill()`/`dropClient` — the reaper's population is *stranded* subscribers (client ids that no longer exist). And a relay `onData` sink **counts as a watcher — relay-served ptys are never reaped**. So the planned trigger "reaper releases a session that still has an onData sink" cannot occur. Task 3's premise is rewritten below (see the task); net effect: the shadow's near-term value concentrates in Task 4 (background writes without spawning a pty client) and in *optionally* letting relay-lite viewers ride `%output` later; the pty-pressure emergency itself is already handled by the reap. Execute this plan as capacity/product need dictates, not as a fire.
2. **Competitor research — RESOLVED 2026-08-11.** Findings that bind this plan:
   - **`-C`, never `-CC`** — verified in tmux source (`client.c`: `-CC` calls `tcgetattr(STDIN)` and exits on failure) and empirically on this machine (tmux 3.6a: `-CC` over a fifo dies `tcgetattr failed`; `-C` over the same fifo streams cleanly, holds **0 ptys**, `send-keys` and `refresh-client -C` both work pty-free). This plan already specifies `-C` throughout — do not "upgrade" it.
   - **Commands are server-wide; streams are per-attached-session.** A single shared `-C` client can `send-keys -t <any-session>` — so **Task 4 needs exactly ONE shared control client for the whole server**, not one per session. Only `%output` *streaming* is scoped to the attached session (nodeterm = one session per node), so Task 3's observability shadow stays per-session (or uses `link-window` into a monitor session — decide at execution).
   - **Sizing correctness:** with only a control client attached, the pane's size follows `refresh-client -C <cols>x<rows>` — a shadow MUST push the session's last-known effective size on attach, or the pane may reflow to a default. Add this to Task 3's swap-in step (read the size the released painter last enforced).
   - **Wire-cost gate:** control-mode output escapes control bytes to octal (~4× inflation on TUI-heavy output). Before executing Task 3, run a load probe (the research harness pattern: fifo + `-C attach` + a chatty TUI in ~60 panes) and record CPU; if unacceptable, restrict shadows to `Snapshots`-style polling (`capture-pane`) instead of live `%output`.
   - **Prior art:** cmux ships `-CC`-based remote mirroring (their client owns a tty, hence `-CC`); no mature Node control-mode library exists — Task 1's codec is the parser, as planned. Adjacent ideas recorded in the backlog (not this plan): cmux Agent Hibernation (cap + SIGTERM idle background agents + native `--resume`), VibeTunnel per-session subscription flags (Stdout|Snapshots|Events over one socket), cmux child-exit policy + restore spawn pacing, herdr `pane.read` text API for zoomed-out cards.
3. **Consumer inventory.** The only in-main background consumers of live output found today are the relay host sink (`session.onData`, `pty-manager.ts:1031`, `:1516`) and renderer forwarding (moot at zero subscribers). If at execution time `grep -n "onData" src/core/pty-manager.ts` shows new consumers, list them in Task 3's swap conditions.

## File Structure

- Create: `src/core/tmux-control.ts` — pure control-mode protocol codec (no I/O).
- Create: `src/core/tmux-control.test.ts`
- Create: `src/core/tmux-control-client.ts` — `ControlModeClient`: child-process lifecycle + command/reply correlation, injectable spawn.
- Create: `src/core/tmux-control-client.test.ts`
- Modify: `src/core/pty-manager.ts` — shadow registry + swap logic at the release/attach seams.
- Modify (tests): `src/core/pty-coattach.test.ts` conventions reused in a new `src/core/pty-shadow.test.ts`.

---

### Task 1: Control-mode protocol codec (pure)

Control mode is line-oriented: notifications start with `%`; command replies are bracketed by `%begin <ts> <num> <flags>` … `%end <ts> <num> <flags>` (or `%error`). `%output %<pane-id> <data>` carries the pane's raw bytes with `\ooo` octal escapes. This task builds the pure codec; no process, no fs.

**Files:**
- Create: `src/core/tmux-control.ts`
- Test: `src/core/tmux-control.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ControlEvent =
    | { kind: 'output'; paneId: string; data: string }        // octal-decoded
    | { kind: 'reply'; num: number; ok: boolean; body: string[] }
    | { kind: 'exited' }                                       // %exit
    | { kind: 'other'; line: string }                          // %session-changed etc.
  export function createControlDecoder(): { push(chunk: string): ControlEvent[] }
  export function decodeOctal(s: string): string
  export function encodeSendKeysHex(target: string, data: string): string
  ```
  `encodeSendKeysHex('nt-term-1', 'ls\n')` → `send-keys -t nt-term-1 -H 6c 73 0a` — hex bytes, because control-mode commands are one text line and `-H` sidesteps every quoting/UTF-8 hazard (`-l` literal mode would need shell-grade escaping).

- [ ] **Step 1: Write the failing tests**

```ts
// src/core/tmux-control.test.ts
import { describe, it, expect } from 'vitest'
import { createControlDecoder, decodeOctal, encodeSendKeysHex } from './tmux-control'

describe('decodeOctal', () => {
  it('decodes tmux %output octal escapes back to bytes', () => {
    expect(decodeOctal('hello\\012world\\033[31m')).toBe('hello\nworld\x1b[31m')
  })
  it('passes plain text through untouched', () => {
    expect(decodeOctal('just text')).toBe('just text')
  })
  it('keeps a literal backslash that is not an octal escape', () => {
    expect(decodeOctal('a\\\\b')).toBe('a\\b')
  })
})

describe('createControlDecoder', () => {
  it('emits an output event per %output line, pane id preserved', () => {
    const d = createControlDecoder()
    const ev = d.push('%output %3 abc\\012\n')
    expect(ev).toEqual([{ kind: 'output', paneId: '%3', data: 'abc\n' }])
  })
  it('buffers partial lines across pushes', () => {
    const d = createControlDecoder()
    expect(d.push('%output %3 ab')).toEqual([])
    expect(d.push('c\n')).toEqual([{ kind: 'output', paneId: '%3', data: 'abc' }])
  })
  it('collects a %begin/%end block into one ok reply with its body', () => {
    const d = createControlDecoder()
    const ev = d.push('%begin 100 7 0\nline1\nline2\n%end 100 7 0\n')
    expect(ev).toEqual([{ kind: 'reply', num: 7, ok: true, body: ['line1', 'line2'] }])
  })
  it('collects a %begin/%error block into one failed reply', () => {
    const d = createControlDecoder()
    const ev = d.push('%begin 100 8 0\nno such session\n%error 100 8 0\n')
    expect(ev).toEqual([{ kind: 'reply', num: 8, ok: false, body: ['no such session'] }])
  })
  it('reports %exit as exited', () => {
    expect(createControlDecoder().push('%exit\n')).toEqual([{ kind: 'exited' }])
  })
  it('passes unknown notifications through as other', () => {
    expect(createControlDecoder().push('%session-changed $1 nt-x\n'))
      .toEqual([{ kind: 'other', line: '%session-changed $1 nt-x' }])
  })
})

describe('encodeSendKeysHex', () => {
  it('encodes bytes as hex send-keys arguments', () => {
    expect(encodeSendKeysHex('nt-term-1', 'ls\n')).toBe('send-keys -t nt-term-1 -H 6c 73 0a')
  })
  it('encodes multi-byte UTF-8 per byte', () => {
    expect(encodeSendKeysHex('s', 'ç')).toBe('send-keys -t s -H c3 a7')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/core/tmux-control.test.ts`
Expected: FAIL — module `./tmux-control` not found.

- [ ] **Step 3: Implement the codec**

```ts
// src/core/tmux-control.ts
/** Pure tmux control-mode (-C) protocol codec. No I/O here — the client (tmux-control-client.ts)
 *  owns the process; this file owns the line protocol, so every parsing rule is unit-testable.
 *  Protocol: notifications are %-prefixed lines; command replies arrive as a
 *  `%begin <ts> <num> <flags>` … body … `%end|%error <ts> <num> <flags>` block; `%output %<pane> <data>`
 *  carries raw pane bytes with non-printables as \ooo octal escapes. */

export type ControlEvent =
  | { kind: 'output'; paneId: string; data: string }
  | { kind: 'reply'; num: number; ok: boolean; body: string[] }
  | { kind: 'exited' }
  | { kind: 'other'; line: string }

export function decodeOctal(s: string): string {
  return s.replace(/\\(\d{3}|\\)/g, (_, esc: string) =>
    esc === '\\' ? '\\' : String.fromCharCode(parseInt(esc, 8))
  )
}

export function encodeSendKeysHex(target: string, data: string): string {
  const bytes = [...Buffer.from(data, 'utf8')].map((b) => b.toString(16).padStart(2, '0'))
  return `send-keys -t ${target} -H ${bytes.join(' ')}`
}

export function createControlDecoder(): { push(chunk: string): ControlEvent[] } {
  let buf = ''
  let block: { num: number; body: string[] } | null = null
  return {
    push(chunk: string): ControlEvent[] {
      buf += chunk
      const out: ControlEvent[] = []
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (block) {
          const done = line.match(/^%(end|error) \d+ (\d+) \d+$/)
          if (done) {
            out.push({ kind: 'reply', num: block.num, ok: done[1] === 'end', body: block.body })
            block = null
          } else {
            block.body.push(line)
          }
          continue
        }
        const begin = line.match(/^%begin \d+ (\d+) \d+$/)
        if (begin) {
          block = { num: Number(begin[1]), body: [] }
        } else if (line.startsWith('%output ')) {
          const m = line.match(/^%output (%\d+) (.*)$/s)
          if (m) out.push({ kind: 'output', paneId: m[1], data: decodeOctal(m[2]) })
        } else if (line === '%exit' || line.startsWith('%exit ')) {
          out.push({ kind: 'exited' })
        } else if (line.startsWith('%')) {
          out.push({ kind: 'other', line })
        }
        // Non-% lines outside a block: tmux sends none in -C; drop silently.
      }
      return out
    }
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/core/tmux-control.test.ts` — Expected: PASS (all 11).

- [ ] **Step 5: Commit**

```bash
git add src/core/tmux-control.ts src/core/tmux-control.test.ts
git commit -m "feat(pty): tmux control-mode protocol codec

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: ControlModeClient (process wrapper, injectable spawn)

**Files:**
- Create: `src/core/tmux-control-client.ts`
- Test: `src/core/tmux-control-client.test.ts`

**Interfaces:**
- Consumes: Task 1's `createControlDecoder`, `encodeSendKeysHex`, `ControlEvent`.
- Produces:
  ```ts
  export interface ControlSpawn {  // injectable child_process seam (tests pass a fake)
    spawn(bin: string, args: string[]): {
      stdin: { write(s: string): void }
      stdout: { on(ev: 'data', cb: (b: Buffer) => void): void }
      on(ev: 'exit', cb: (code: number | null) => void): void
      kill(): void
    }
  }
  export class ControlModeClient {
    constructor(opts: {
      tmuxBin: string; socket: string; sessionName: string
      onOutput: (data: string) => void
      onExit: () => void
      spawner?: ControlSpawn                       // default: real child_process
    })
    start(): void                                   // spawn `tmux -L <socket> -C attach-session -t <name>`
    sendKeys(data: string): Promise<boolean>        // hex send-keys, resolves on %end/%error
    command(line: string): Promise<{ ok: boolean; body: string[] }>
    dispose(): void                                 // detach command then kill; idempotent
    readonly alive: boolean
  }
  ```
  Command/reply correlation: control mode answers commands **in order** — a FIFO of pending resolvers matched to `reply` events by arrival order (the `num` field is asserted monotonic only in tests; ordering is the contract).

- [ ] **Step 1: Write the failing tests** — with a `FakeControlSpawn` capturing stdin writes and letting tests feed stdout. Cover: spawn args are exactly `['-L', socket, '-C', 'attach-session', '-t', sessionName]`; `%output` events reach `onOutput` decoded; `sendKeys('ls\n')` writes the Task-1 hex line + newline to stdin and resolves `true` on an ok reply, `false` on `%error`; two overlapping `command()` calls resolve in FIFO order; process exit fires `onExit` once, rejects pending commands, `alive` flips false; `dispose()` writes `detach-client\n` then kills, and a second `dispose()` is a no-op.
- [ ] **Step 2: Run to verify failure** — `npx vitest run src/core/tmux-control-client.test.ts` fails on missing module.
- [ ] **Step 3: Implement** — thin: pipe stdout chunks into the decoder, dispatch events; `command()` pushes `{resolve}` onto a FIFO and writes the line; `reply` shifts the FIFO. No timers in v1 (the reaper swap in Task 3 owns timeouts).
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** (`feat(pty): control-mode client over pipes — zero pty devices`).

---

### Task 3: Shadow swap in PtyManager

The behavior seam — premise REVISED per Revision Point 1: the reap never releases a session that still has an `onData` sink (a sink is a watcher), so the shadow is NOT a reap-time swap. Instead: a **released** session (reaped-stranded or plain-killed, `byPersistKey` forgotten) that a background feature later needs — Task 4's write path today; an opt-in lightweight observer API tomorrow — gets a `ControlModeClient` shadow attached ON DEMAND rather than a full painter respawn. First real subscriber still wins: the `create()` path disposes any live shadow BEFORE the normal warm-reattach (`tmux new-session -A`) spawns the painter client, order asserted in tests. Sessions nobody asks about keep costing zero.

**Files:**
- Modify: `src/core/pty-manager.ts` (fields on `Session`: `shadow?: ControlModeClient`; swap-in at the reaper's release site; swap-out at the top of the attach path; both guarded `this.tmuxPath !== null`)
- Test: `src/core/pty-shadow.test.ts` (conventions from `src/core/pty-coattach.test.ts` — fake pty factory + fake platform; add a `FakeControlSpawn` injection point via a new optional `PtyManager` constructor dep, defaulting to real)

**Interfaces:**
- Consumes: Task 2's `ControlModeClient`; the reap branch's release seam (Revision Point 1); `sessionName(persistKey)` and `TMUX_SOCKET` (existing, `pty-manager.ts`).
- Produces: `Session.shadow` invariant — **a session never has both a live `proc` client and a live shadow**; asserted in tests.

- [ ] Steps follow the same red-green-commit cycle: (1) failing tests — reap with sink ⇒ shadow attached + onData still streams; reap without sink ⇒ no shadow; subscriber arrival ⇒ shadow disposed before pty spawn (order asserted via call log); shadow process death ⇒ session survives, flagged for lazy re-shadow on next sweep; app quit ⇒ all shadows disposed. (2) verify RED, (3) implement, (4) verify GREEN + full `npx vitest run` + `npm run -s typecheck`, (5) commit.

---

### Task 4: Background input (`send-keys`) for shadowed sessions

Canvas-control's `write --node` verb (and the relay host's write path) currently require the client pty. Per Revision Point 2: `send-keys` is server-wide, so this task uses **one shared `ControlModeClient` for the whole tmux server** (attached to any session; lazily started on first background write, disposed after a 10s linger so bursts don't churn processes — constant documented in code). Route writes to any released session through `shared.sendKeys(target, data)` — extend Task 2's `sendKeys` with an explicit target parameter (`encodeSendKeysHex` already takes one).

**Files:**
- Modify: `src/core/pty-manager.ts` (`write()` fallthrough: real client → shadow → temporary shadow)
- Test: extend `src/core/pty-shadow.test.ts`

Steps: red-green-commit as above; tests assert the exact `send-keys -H` line hits the fake spawner's stdin and that the temporary shadow disposes after the linger (fake timers).

---

### Task 5: Flag, observability, smoke list

- Settings flag `ptyShadowClients` (default ON; kill-switch honesty — one release of soak time), read at the two swap sites only.
- One log line per swap direction (`[pty] shadow attach <session>` / `[pty] painter attach <session>`) — greppable in field reports.
- Update the spawn-failure diagnostic from branch `fix/pty-limit-detection-reap` to mention shadows in its exhaustion hint copy only if that branch's copy names a session count.
- GUI smoke list (manual, goes in the final report, not code): (1) open 2 projects, background one, confirm `ls /dev/ttys* | wc -l` drops by ~1 per backgrounded terminal after the reap threshold; (2) phone/relay viewer on a backgrounded session still streams; (3) `nodeterm.sh write` into a background node lands (visible after switching); (4) switching back to the project shows the painter attach with intact alternate-screen TUI (run `htop` before backgrounding); (5) `tmux -L node-terminal list-clients` during background shows the `-C` client, no pty path.

Steps: red-green-commit for the flag gate (pure decision helper + test), then wire, then full suite + typecheck, commit.

---

## Self-Review Notes

- Spec coverage: pty elimination for unwatched sessions (Tasks 2-3), input without pty (Task 4), painter path untouched (Global Constraints + Task 3 swap-out ordering), rollback (Task 5 flag). Gap accepted consciously: no control-mode rendering for visible terminals — out of scope by design, documented at the top.
- Types: `ControlEvent`/`ControlModeClient` names match across Tasks 1-4; `Session.shadow` introduced once (Task 3) and reused (Task 4).
- Placeholders: Tasks 3-5 compress the five TDD steps into cycle descriptions with named assertions instead of full listings — deliberate, because their exact diffs depend on Revision Point 1 (the reap branch's merged seams). Tasks 1-2 are fully concrete and safe to execute today.

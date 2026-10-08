// Explicit native/process boundary recorder for managed-session-fixture.ts. No terminal, shell,
// CLI or tmux server runs. Receipt process birth is read from this recorder process by the actual
// managed-pane implementation; the surrounding planner/coordinator/PtyManager are production.
import { EventEmitter } from 'node:events'
import { promisify } from 'node:util'
// Preserve the actual pure env selector; the manager-only ./exec-path alias cannot match this
// full relative path. Native process execution and executable discovery remain explicit recorders.
export { envPathKey } from '../../../../../src/core/exec-path'

interface Pane { session: string; creationId: string; paneId: string; tty: string; created: string;
  cwd: string; shell: string; projectEnv: string | null; accountDir: string | null }
const panes = new Map<string, Pane>()
const created: Array<Record<string, unknown>> = []
const launched: Array<Record<string, unknown>> = []
const emit = (value: unknown): void => { process.stdout.write(JSON.stringify(value) + '\n') }
export function nativeProof(): { created: typeof created; launched: typeof launched } { return { created, launched } }
export function findExecutableSync(): null { return null }
export function findInPathString(program: string): string | null { return program === 'tmux' ? '/fixture/tmux' : null }
export function shellPathNow(): string { return '/usr/bin:/bin' }
export async function resolveShellPath(): Promise<string> { return shellPathNow() }
export function findFixedTmux(): string { return '/fixture/tmux' }
export function bundledTmuxPath(): null { return null }
export function findCommand(): false { return false }
export function tmuxInstall(): null { return null }

function target(args: readonly string[]): Pane {
  const raw = args[args.indexOf('-t') + 1]
  const pane = raw?.startsWith('%') ? [...panes.values()].find((p) => p.paneId === raw)
    : panes.get(raw?.replace(/^=/, '').replace(/:$/, ''))
  if (!pane) throw new Error('managed native recorder has no such pane')
  return pane
}
function output(file: string, args: readonly string[], body?: string): string {
  if (file === 'ps') {
    const pane = [...panes.values()].find((p) => p.tty === args[args.indexOf('-t') + 1])
    if (!pane) throw new Error('managed native recorder has no such tty')
    return `${process.pid} ${process.pid} Ss+ ${pane.shell}\n`
  }
  if (file !== '/fixture/tmux' || args[0] !== '-L' || args[1] !== 'node-terminal')
    throw new Error('managed native recorder refused an unexpected subprocess')
  if (args.includes('source-file') || args.includes('set-option') || args.includes('delete-buffer')) return ''
  if (args.includes('show-options')) return ''
  if (args.includes('has-session')) {
    try { target(args); return '' }
    catch { throw Object.assign(new Error('managed native recorder has no such session'), { code: 1 }) }
  }
  if (args.includes('list-panes')) {
    const p = target(args)
    return `${p.session}|${p.created}|${p.paneId}|${process.pid}|${p.creationId}\n`
  }
  if (args.includes('display-message')) {
    const p = target(args)
    if (args.at(-1) === '#{pane_pid}|#{pane_tty}|#{pane_current_command}|#{pane_id}')
      return `${process.pid}|${p.tty}|${p.shell.split('/').at(-1)}|${p.paneId}\n`
  }
  if (args.includes('load-buffer')) {
    const p = target(args), at = args.indexOf('if-shell'), condition = args[at + 4]
    if (typeof body !== 'string' || !condition ||
        ![p.session, p.created, p.creationId, String(process.pid)].every((part) => condition.includes(part)))
      return 'nt-managed-refused\n'
    const proof = { event: 'managed-launch', body, nodeId: p.session.slice(3), cwd: p.cwd,
      shell: p.shell, projectEnv: p.projectEnv, accountDir: p.accountDir, textOnStdin: args.every((arg) => !arg.includes(body)) }
    launched.push(proof); emit(proof)
    return 'nt-managed-delivered\n'
  }
  if (args.includes('capture-pane')) return ''
  throw new Error('managed native recorder refused unexpected tmux arguments')
}

// Both callback and Node's custom promisify contract are supported. Promise.child.stdin is the
// real PtyManager runWithStdin seam; no implementation method is replaced after construction.
export function execFile(file: string, args: readonly string[], options?: unknown, callback?: (...args: unknown[]) => void): unknown {
  const cb = typeof options === 'function' ? options as (...args: unknown[]) => void : callback
  queueMicrotask(() => { try { cb?.(null, output(file, args), '') } catch (error) { cb?.(error, '', '') } })
  return { stdin: new EventEmitter(), kill() {} }
}
Object.defineProperty(execFile, promisify.custom, { value: (file: string, args: readonly string[]) => {
  let resolve!: (value: { stdout: string; stderr: string }) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<{ stdout: string; stderr: string }>((yes, no) => { resolve = yes; reject = no })
  let settled = false
  const stdin = new EventEmitter() as EventEmitter & { end(body: string): void }
  const settle = (body?: string): void => {
    if (settled) return
    settled = true
    try { resolve({ stdout: output(file, args, body), stderr: '' }) } catch (error) { reject(error) }
  }
  stdin.end = (body) => settle(body)
  Object.assign(promise, { child: { stdin } })
  if (!args.includes('load-buffer')) queueMicrotask(() => settle())
  return promise
} })
export function execFileSync(file: string, args: readonly string[], options?: { encoding?: string }): string | Buffer {
  const result = output(file, args)
  return options?.encoding ? result : Buffer.from(result)
}

export function spawn(file: string, args: string[], options: { cwd: string; env: Record<string, string> }) {
  if (file !== '/fixture/tmux' || !args.includes('new-session') || args.includes('-A') || args.includes('-D'))
    throw new Error('managed native recorder requires exclusive create-only tmux')
  const session = args[args.indexOf('-s') + 1]
  if (!session || panes.has(session)) throw new Error('managed native recorder refuses a occupied session')
  const marker = args.find((arg) => arg.startsWith('NODETERM_MANAGED_CREATION_ID='))
  if (!marker) throw new Error('managed native recorder requires the creation marker')
  const p: Pane = { session, creationId: marker.split('=')[1], paneId: '%' + panes.size,
    tty: '/dev/pts/' + panes.size, created: String(Math.floor(Date.now() / 1000)), cwd: options.cwd,
    shell: args.at(-1)!, projectEnv: options.env.MANAGED_TEST_ENV ?? null, accountDir: options.env.CLAUDE_CONFIG_DIR ?? null }
  panes.set(session, p)
  const proof = { event: 'managed-spawn', nodeId: session.slice(3), creationId: p.creationId,
    cwd: p.cwd, shell: p.shell, projectEnv: p.projectEnv, accountDir: p.accountDir, createOnly: true }
  created.push(proof); emit(proof)
  let exit: ((event: { exitCode: number }) => void) | undefined
  return { pid: process.pid, onData() {}, onExit(fn: typeof exit) { exit = fn },
    write(): never { throw new Error('managed launch must use the attested tmux stdin path') },
    resize() {}, pause() {}, resume() {}, kill() { exit?.({ exitCode: 0 }) } }
}

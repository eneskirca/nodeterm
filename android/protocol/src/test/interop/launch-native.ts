// Native PTY boundary recorder. The real manager constructs the shell/env; the Kotlin client sees
// the resulting output and sends its launch line through the real host stream. No shell runs.
// This pure env selector remains the production helper. Only executable discovery is recorded;
// the full relative import avoids the manager-only ./exec-path alias redirecting back here.
export { envPathKey } from '../../../../../src/core/exec-path'
export function findExecutableSync(): null { return null }
export function findInPathString(): null { return null }
export function findInLoginPath(): null { return null }
export function shellPathNow(): string { return '/usr/bin:/bin' }
export async function resolveShellPath(): Promise<string> { return shellPathNow() }
// Disabling tmux in Settings does not suppress init's discovery/source-file side-call. The fixture
// must replace discovery too, and reject any unexpected manager subprocess rather than reach a
// developer's running tmux server. These are process boundaries, not settings/trust substitutes.
export function findFixedTmux(): null { return null }
export function bundledTmuxPath(): null { return null }
export function findCommand(): false { return false }
export function tmuxInstall(): null { return null }
export function execFile(): never { throw new Error('managed launch fixture refused a subprocess') }
export function execFileSync(): never { throw new Error('managed launch fixture refused a subprocess') }

export function spawn(file: string, args: string[], options: { env: Record<string, string>; cwd: string }) {
  let data: ((text: string) => void) | undefined
  let exit: ((event: { exitCode: number }) => void) | undefined
  return {
    pid: 1,
    onData(callback: (text: string) => void) {
      data = callback
      setTimeout(() => callback(`launch-env:${options.env.A72_PROJECT_ENV ?? 'absent'} shell:${file}\r\n`), 10)
    },
    onExit(callback: (event: { exitCode: number }) => void) { exit = callback },
    write(text: string) {
      process.stdout.write(JSON.stringify({ event: 'launch-write', text, cwd: options.cwd,
        projectEnv: options.env.A72_PROJECT_ENV ?? null, shell: file }) + '\n')
      data?.(`echo:${text}`)
    },
    resize() {}, pause() {}, resume() {}, kill() { exit?.({ exitCode: 0 }) }
  }
}

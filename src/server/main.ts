import { resolveConfig, resolveDataDir } from './config'
import { startServer } from './index'
import { runTeamCli, teamArgv } from './team-cli'

/**
 * Script entry point for the headless server. Kept separate from index.ts so that
 * `index.ts` stays side-effect-free (importable by tests without booting a server).
 */
// Last-resort loggers: a stray throw/rejection anywhere in the process should be
// logged, not silently exit the server (which would tear down every session's pty).
process.on('uncaughtException', (e) => console.error('[nodeterm-server] uncaughtException', e))
process.on('unhandledRejection', (e) => console.error('[nodeterm-server] unhandledRejection', e))

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const team = teamArgv(argv)
  if (team) {
    // `main.cjs [server flags] team <command>`: the hosted team's admin CLI, not a server boot —
    // including with server flags before `team` (`--data-dir X team status` must not boot a second
    // server on X). It talks to the RUNNING server over <dataDir>/relay/admin.sock, so it needs the
    // data dir and nothing else: `resolveDataDir`, not `resolveConfig`, whose serving-only refusals
    // do not apply here. A `--data-dir` on the line overrides it (runTeamCli reads that itself).
    const code = await runTeamCli(team, resolveDataDir(process.env, []), (s) => console.log(s), (s) => console.error(s))
    // Let buffered output reach a pipe before exiting (stdout to a pipe is asynchronous on macOS).
    await new Promise<void>((resolve) => process.stdout.write('', () => resolve()))
    await new Promise<void>((resolve) => process.stderr.write('', () => resolve()))
    process.exit(code)
  }
  const config = resolveConfig(process.env, argv)
  const { port, close } = await startServer(config)
  // Headless binds no listener, so there is nothing to announce as "listening" (startServer already
  // logged the headless line). Only print the address in normal serving mode.
  if (!config.headless) {
    const scheme = config.insecureHttp ? 'http (insecure)' : 'http'
    console.log(`nodeterm-server listening on ${scheme} ${config.host}:${port}`)
  }

  const shutdown = (signal: string): void => {
    console.log(`\nReceived ${signal}, shutting down…`)
    void close().then(
      () => process.exit(0),
      (err) => {
        console.error('Error during shutdown:', err)
        process.exit(1)
      }
    )
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})

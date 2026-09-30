import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// Electron's `app.name` — and with it the user-data dir, the Keychain "Safe Storage" entry and
// electron-updater's cache dir — comes from package.json's top-level `name`. `build.productName`
// ("nodeterm") names only the bundle and the installer: electron-builder strips `build` from the
// packaged package.json, so it never reaches the running app. The uninstaller looked under
// `…/nodeterm` and so never found the desktop's data. Deriving the expectation from package.json
// (not a literal) is the point: a rename of `name` must move the uninstaller with it.
const APP_NAME: string = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).name
const SCRIPT = join(__dirname, 'uninstall.sh')

let root: string
let home: string
let shims: string

function shim(name: string, body: string): void {
  const p = join(shims, name)
  writeFileSync(p, `#!/bin/sh\n${body}\n`)
  chmodSync(p, 0o755)
}

/** Plan-only run against a fixture HOME. Every tool that could reach the REAL machine (a running
 *  app, the tmux servers this box hosts nodeterm on, systemd, the Keychain, brew) is shimmed to
 *  answer "nothing here", and the env is built from scratch so no XDG_* / *_HOME leaks in. */
function dryRun(): string {
  return execFileSync('bash', [SCRIPT, '--dry-run'], {
    encoding: 'utf8',
    env: { HOME: home, PATH: `${shims}:${dirname(process.execPath)}:/usr/bin:/bin` },
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nt-uninstall-'))
  home = join(root, 'home')
  shims = join(root, 'shims')
  mkdirSync(home)
  mkdirSync(shims)
  for (const t of ['tmux', 'pgrep', 'systemctl', 'brew', 'security']) shim(t, 'exit 1')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// `uname` is shimmed too, so BOTH branches run on any POSIX runner — the macOS paths (Library,
// Keychain) would otherwise only ever be exercised on a Mac.
describe.skipIf(process.platform === 'win32').each([
  {
    os: 'Linux',
    userData: () => join(home, '.config', APP_NAME),
    updaterCache: () => join(home, '.cache', `${APP_NAME}-updater`)
  },
  {
    os: 'Darwin',
    userData: () => join(home, 'Library', 'Application Support', APP_NAME),
    updaterCache: () => join(home, 'Library', 'Caches', `${APP_NAME}-updater`)
  }
])('uninstall.sh on $os finds what the desktop app writes', ({ os, userData, updaterCache }) => {
  beforeEach(() => shim('uname', `echo ${os}`))

  it('plans to delete the Electron user-data dir named after package.json `name`', () => {
    mkdirSync(userData(), { recursive: true })
    writeFileSync(join(userData(), 'settings.json'), '{}')

    expect(dryRun()).toContain(`Delete ${userData()}`)
  })

  it('enumerates project .nodeterm folders from that dir’s workspace.json (kept, not deleted)', () => {
    const project = join(root, 'repo')
    mkdirSync(join(project, '.nodeterm'), { recursive: true })
    mkdirSync(userData(), { recursive: true })
    writeFileSync(
      join(userData(), 'workspace.json'),
      JSON.stringify({ version: 3, entries: [{ kind: 'local', cwd: project }] })
    )

    const out = dryRun()
    expect(out).toContain('Would be KEPT')
    expect(out).toContain(join(project, '.nodeterm'))
  })

  it('plans to delete the electron-updater cache (`<name>-updater`)', () => {
    mkdirSync(updaterCache(), { recursive: true })

    expect(dryRun()).toContain(`Delete ${updaterCache()}`)
  })

  it.runIf(os === 'Darwin')('looks up the Keychain entry Electron actually creates', () => {
    shim('security', `[ "$3" = "${APP_NAME} Safe Storage" ] && exit 0; exit 1`)

    expect(dryRun()).toContain(`Delete the '${APP_NAME} Safe Storage' Keychain entry`)
  })
})

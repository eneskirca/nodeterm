import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  codexCliSupportsRemote,
  codexIdentityCaps,
  codexManagedRuntimeInstalled,
  codexManagedRuntimePath,
  probeCodexRemoteFlagAt,
  refreshCodexIdentityCaps,
  resetCodexIdentityCapsForTests
} from './codex-identity-caps'

/** Stand-in for the `codex --help` probe. Every test says explicitly what the CLI answered. */
const remote = (yes: boolean) => () => Promise.resolve(yes)
/** Stand-in for the managed-runtime stat — "can this INSTALL run an app-server at all?". */
const appServer = (yes: boolean) => () => yes
import {
  resetCodexThreadIdentityAuthSecret,
  setCodexThreadIdentityAuthSecret
} from './codex-identity-proxy'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'

let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-codex-caps-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
  resetCodexIdentityCapsForTests()
  resetCodexThreadIdentityAuthSecret()
})

afterEach(() => {
  resetCodexThreadIdentityAuthSecret()
  resetCodexIdentityCapsForTests()
  resetPlatformForTests()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('codexIdentityCaps', () => {
  it('says yes, and installs the launcher, once the secret is in and the CLI has --remote', async () => {
    setCodexThreadIdentityAuthSecret(randomBytes(32))
    const caps = await refreshCodexIdentityCaps(remote(true), appServer(true))
    expect(caps.shared).toBe(true)
    expect(fs.existsSync(caps.launcherPath as string)).toBe(true)
  })

  it('says no without the secret, and installs nothing', () => {
    // Half-armed is the state to avoid: a launcher on PATH with no capability to present would
    // reach the routes, be refused, and fall back one process later. Better to never name it.
    return refreshCodexIdentityCaps(remote(true), appServer(true)).then((caps) => {
      expect(caps).toEqual({
        shared: false,
        launcherPath: null,
        remoteFlag: true,
        appServer: true
      })
      expect(fs.existsSync(path.join(dir, 'codex-bin', 'nodeterm-codex'))).toBe(false)
    })
  })

  it('says no when the installed codex has no --remote, however armed everything else is', async () => {
    // The one precondition with no runtime recovery: the launcher execs, and a CLI with an
    // app-server but no --remote dies on a usage error where nothing can fall back. Answering it
    // here turns a dead node into a plain-codex node on every machine, not just the tester's.
    setCodexThreadIdentityAuthSecret(randomBytes(32))
    const caps = await refreshCodexIdentityCaps(remote(false), appServer(true))
    expect(caps).toEqual({
      shared: false,
      launcherPath: null,
      remoteFlag: false,
      appServer: true
    })
    expect(fs.existsSync(path.join(dir, 'codex-bin', 'nodeterm-codex'))).toBe(false)
  })

  // THE MEASURED CASE. codex-cli 0.146.0 installed via npm — the mainstream channel, and the one
  // docs/troubleshooting-codex-snap.md steers users toward — advertises `--remote` in `codex --help`
  // and in `codex resume --help`, and then answers `codex app-server daemon start` with
  //   Error: managed standalone Codex install not found at ~/.codex/packages/standalone/current/codex
  // Gating on the help text alone wrote `nodeterm-codex` into the launch line of every Codex node on
  // such a machine: a wasted curl round trip, a `plain codex` chip, and the first-fallback warning
  // banner, per node, forever, for a feature that cannot work there. Inert is fine; noisily inert is
  // not, and this row is what keeps it inert.
  it('says no on an npm install — `--remote` in help, no standalone runtime — and writes no launcher', async () => {
    setCodexThreadIdentityAuthSecret(randomBytes(32))
    const caps = await refreshCodexIdentityCaps(remote(true), appServer(false))
    expect(caps).toEqual({
      shared: false,
      launcherPath: null,
      // Not probed: with no app-server to reach there is nothing to learn from a help page about a
      // flag we will never use, and "unknown" is false here like everywhere else in this file.
      remoteFlag: false,
      appServer: false
    })
    expect(fs.existsSync(path.join(dir, 'codex-bin', 'nodeterm-codex'))).toBe(false)
  })

  it('does not even spawn the help probe when the install cannot run an app-server', async () => {
    setCodexThreadIdentityAuthSecret(randomBytes(32))
    let asked = 0
    await refreshCodexIdentityCaps(() => {
      asked += 1
      return Promise.resolve(true)
    }, appServer(false))
    expect(asked).toBe(0)
  })

  it('says no when the install probe itself fails or times out', async () => {
    // Fail-closed is the whole contract: anything we could not establish means the bare `codex`
    // this feature degrades to everywhere else, never an optimistic launcher path.
    setCodexThreadIdentityAuthSecret(randomBytes(32))
    const threw = await refreshCodexIdentityCaps(remote(true), () => {
      throw new Error('stat failed')
    })
    expect(threw).toEqual({
      shared: false,
      launcherPath: null,
      remoteFlag: false,
      appServer: false
    })
    resetCodexIdentityCapsForTests()
    const rejected = await refreshCodexIdentityCaps(remote(true), () =>
      Promise.reject(new Error('probe timed out'))
    )
    expect(rejected.shared).toBe(false)
    expect(fs.existsSync(path.join(dir, 'codex-bin', 'nodeterm-codex'))).toBe(false)
  })

  it('makes an early caller WAIT rather than answering no', async () => {
    // The ordering trap this exists for: a sync getter would answer `false` to anything that asked
    // before the shell refreshed, and a `false` pins the feature off for the whole run — with no
    // launcher run there is no chip, no toast and no log line to say it happened.
    const asked = codexIdentityCaps()
    let settled = false
    void asked.then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    setCodexThreadIdentityAuthSecret(randomBytes(32))
    await refreshCodexIdentityCaps(remote(true), appServer(true))
    expect((await asked).shared).toBe(true)
  })

  it('answers immediately once refreshed', async () => {
    await refreshCodexIdentityCaps(remote(false), appServer(true))
    expect(await codexIdentityCaps()).toEqual({
      shared: false,
      launcherPath: null,
      remoteFlag: false,
      appServer: true
    })
  })
})

describe('codexManagedRuntimeInstalled', () => {
  // The path is not inferred: `codex app-server daemon start` names it verbatim in its refusal, and
  // `codex app-server daemon stop` reports it as `managedCodexPath` in JSON.
  it('is the fixed path the CLI itself names, under CODEX_HOME', () => {
    expect(codexManagedRuntimePath('/somewhere/.codex')).toBe(
      path.join('/somewhere/.codex', 'packages', 'standalone', 'current', 'codex')
    )
  })

  it.skipIf(process.platform === 'win32')(
    'answers yes only for an executable runtime at that path',
    () => {
      // An npm install has ~/.codex (auth, config, sessions) and no `packages/` at all — which is
      // exactly the shape measured on the machine this fix was written on.
      // Windows ignores the executable bit, so `X_OK` cannot distinguish the two fixture modes.
      expect(codexManagedRuntimeInstalled(dir)).toBe(false)
      const runtime = codexManagedRuntimePath(dir)
      fs.mkdirSync(path.dirname(runtime), { recursive: true })
      fs.writeFileSync(runtime, '#!/bin/sh\nexit 0\n', { mode: 0o644 })
      // Present but not executable is not a runtime the daemon can exec, so it is still no.
      expect(codexManagedRuntimeInstalled(dir)).toBe(false)
      fs.chmodSync(runtime, 0o755)
      expect(codexManagedRuntimeInstalled(dir)).toBe(true)
    }
  )
})

describe('codexCliSupportsRemote', () => {
  it('reads the flag out of help text, and is not fooled by a longer flag or by prose', () => {
    expect(codexCliSupportsRemote('  --remote <URL>   connect to an app-server')).toBe(true)
    expect(codexCliSupportsRemote('  --remote=<URL>')).toBe(true)
    // `--remote-auth-token-env` exists and is NOT the flag we need; nor is a mention of it.
    expect(codexCliSupportsRemote('  --remote-auth-token-env <VAR>')).toBe(false)
    expect(codexCliSupportsRemote('use with --remotely-hosted servers')).toBe(false)
    expect(codexCliSupportsRemote(null, undefined, '')).toBe(false)
  })

  it('accepts an answer from either help page', () => {
    // Some CLIs list a global flag only under the subcommand that takes it.
    expect(codexCliSupportsRemote('no flags here', '  --remote <URL>')).toBe(true)
  })
})

describe.skipIf(process.platform !== 'win32')('probeCodexRemoteFlagAt — Windows npm shim', () => {
  it('uses the sibling PowerShell shim for both help probes', async () => {
    const cmd = path.join(dir, 'codex.cmd')
    fs.writeFileSync(cmd, '@echo off\r\nexit /b 91\r\n')
    fs.writeFileSync(
      path.join(dir, 'codex.ps1'),
      [
        "if ($args.Count -eq 1 -and $args[0] -eq '--help') { Write-Output 'no flag'; exit 0 }",
        "if ($args[0] -eq 'resume' -and $args[1] -eq '--help') { Write-Output '  --remote <URL>'; exit 0 }",
        'exit 92'
      ].join('\r\n')
    )

    await expect(probeCodexRemoteFlagAt(cmd)).resolves.toBe(true)
  })
})

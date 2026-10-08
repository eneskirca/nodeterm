// The Android companion's interop fixture (android/protocol/src/test/interop/host-fixture.ts) runs
// this directory's real host code against the Kotlin client: `connectHostSession` over a local relay
// broker and `createPairingService` for the pairing tests. To do that it implements the interfaces
// host-service.ts takes from its callers — HostPtyManager and the kanban / inbox / nodeActions bridge.
//
// Nothing checked it against them (audit A67). InteropHarness.kt bundles the fixture with esbuild,
// which strips types without checking them; no tsconfig included the file; and the Android workflow's
// path filter then skipped most of src/ (audit A63), so a desktop change could break the fixture's fit
// to an interface without any check noticing until an interop test failed at run time, or never, where
// the broken member is one no test exercises. It passed tsc when the audit tried it, but nothing kept
// it so.
//
// tsconfig.node.json now includes the fixture, so `npm run typecheck` (every CI run, every platform)
// checks it. These two guards keep that true: the file stays in the project, and it hands the desktop
// code nothing through a cast, which would switch the check off for exactly the value it exists for.
// The fixture used to pass its fake pty `as unknown as PtyManager` (HostSessionOptions demanded the
// whole class) and its settings `as never`; the option now names the slice the session uses.

import { describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

const REPO_ROOT = join(__dirname, '..', '..', '..')
const INTEROP_DIR = join(REPO_ROOT, 'android', 'protocol', 'src', 'test', 'interop')

/** Repo-relative, `/`-separated, whatever the host running Vitest. */
function repoPath(file: string): string {
  return relative(REPO_ROOT, file).replace(/\\/g, '/')
}

function interopSources(dir: string = INTEROP_DIR, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) interopSources(p, out)
    else if (/\.ts$/.test(entry)) out.push(p)
  }
  return out
}

describe('the Android interop fixture is type-checked against the desktop interfaces (audit A67)', () => {
  it('every .ts file under the interop dir is in the project `npm run typecheck` checks', () => {
    const sources = interopSources().map(repoPath)
    // Not vacuous: a moved or renamed fixture must fail here, not pass over an empty directory.
    expect(sources).toEqual(
      expect.arrayContaining([
        'android/protocol/src/test/interop/host-fixture.ts',
        'android/protocol/src/test/interop/electron-stub.ts'
      ])
    )

    // Ask the compiler, not the include globs: an `exclude`, a narrower glob or a moved file all
    // show up here. `--listFilesOnly` resolves the project without type-checking it (that is
    // `npm run typecheck`'s job), and runs the package's own bin script, so no npm shim is involved.
    const tsc = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
    const listed = execFileSync(process.execPath, [tsc, '-p', 'tsconfig.node.json', '--listFilesOnly'], {
      cwd: REPO_ROOT,
      encoding: 'utf8'
    })
      .split('\n')
      .map((line) => line.trim().replace(/\\/g, '/'))
      .filter(Boolean)
    // Matched by suffix: tsc may print a realpath where the checkout sits behind a symlink.
    const missing = sources.filter((rel) => !listed.some((abs) => abs.endsWith('/' + rel)))
    expect(missing, 'add these to tsconfig.node.json\'s include (see the comment there)').toEqual([])
  }, 60_000)

  it('serves projects.list from the desktop\'s own assembly, never a hand-written blob or mirror (audit A64)', () => {
    // The fixture used to serve a blob it wrote by hand, markers and agent-status mirror included, so a
    // desktop change to either could not fail an Android test. Now both it and `listProjectsOutput`
    // call core's `buildProjectsListBlob`, and the fixture's mirror file comes out of the mirror.
    const code = (file: string): string =>
      readFileSync(file, 'utf8')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n')
    const fixture = code(join(INTEROP_DIR, 'host-fixture.ts'))
    const index = code(join(REPO_ROOT, 'src', 'main', 'index.ts'))
    for (const [name, src] of [['host-fixture.ts', fixture], ['src/main/index.ts', index]]) {
      expect(src, `${name} spells a projects.list marker; import it from src/core/projects-list-blob.ts`).not.toMatch(
        /--NT-(PROJECTS|STATUS)-SPLIT--/
      )
      expect(src, `${name} must build the blob with buildProjectsListBlob`).toMatch(/\bbuildProjectsListBlob\(/)
    }
    expect(fixture).toMatch(/\blistProjects:\s*\(\)\s*=>\s*buildProjectsListBlob\(/)
    // A mirror document written by hand carries its version key; the real one comes from the writer.
    expect(fixture, 'write agent-status.json with the mirror (recordAgentEvent + flush), not by hand').not.toMatch(/\bv:\s*1\b/)
    expect(fixture).toMatch(/\brecordAgentEvent\(/)
  })

  it('serves git.* from the desktop\'s real GitService behind the production jail, never a fake (audit A29)', () => {
    // The phone's Source Control is checked against what the git bridge really answers: the same
    // class `hostBridge.git` hands both phone hosts, jailed to the same roots production passes (every
    // local project folder, `workspaceRoots`). A recording fake here would pass whatever the phone
    // parses, and a wider jail would hide a refusal the phone has to show.
    const code = (file: string): string =>
      readFileSync(file, 'utf8')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n')
    const fixture = code(join(INTEROP_DIR, 'host-fixture.ts'))
    const index = code(join(REPO_ROOT, 'src', 'main', 'index.ts'))
    expect(index).toMatch(/\bconst gitService = new GitService\(\)/)
    expect(index).toMatch(/\bgit: gitService\b/)
    expect(index).toMatch(/\bworkspaceRoots: \(\) => workspaceStore\.localProjectCwds\(\)/)
    expect(fixture).toMatch(/\{ git: new GitService\(\) \}/)
    expect(fixture).toMatch(/\bextraRoots: \(\) => store\.localProjectCwds\(\)/)
    expect(fixture).toMatch(/from '\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/src\/core\/git-service'/)
  })

  it('serves the `lan` field from the desktop\'s own reporter, never a hand-written one (audit A74-refresh)', () => {
    // The phone refreshes the LAN address it dials and the SSH keys it trusts from this field, so the
    // Kotlin client must be checked against what the desktop's reporter really sends: the QR's address
    // pick and the sealed answer's host-key reader, over the test's interfaces and host-key dir.
    const code = (file: string): string =>
      readFileSync(file, 'utf8')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n')
    const fixture = code(join(INTEROP_DIR, 'host-fixture.ts'))
    const index = code(join(REPO_ROOT, 'src', 'main', 'index.ts'))
    expect(index).toMatch(/\blanReport: createHostLanReporter\(\{ getPairingInterface: \(\) => settingsStore\.get\(\)\.phonePairingInterface \}\)/)
    expect(index).toMatch(/createPairingService\([\s\S]+?\}, \{\s+getPairingInterface: \(\) => settingsStore\.get\(\)\.phonePairingInterface,\s+revokePhoneRelayTrust: revokeAllPhones\s+\}\)/)
    expect(fixture).toMatch(/\blanReport: createHostLanReporter\(\{/)
    expect(fixture).toMatch(/from '\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/src\/main\/remote\/host-lan-report'/)
    expect(fixture, 'the fixture must not read this machine\'s /etc/ssh').toMatch(/\bsshHostKeyDirs: \[process\.env\.FIXTURE_SSH_HOST_KEY_DIR \|\|/)
  })

  it('hands the desktop code nothing through a cast that would switch the type check off', () => {
    const CAST = /\bas\s+(?:unknown\s+as|never|any)\b/
    const offenders: string[] = []
    for (const file of interopSources()) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return // comments may name the casts they forbid
          if (CAST.test(line)) offenders.push(`${repoPath(file)}:${i + 1}: ${line.trim()}`)
        })
    }
    expect(
      offenders,
      'type the value as the interface the desktop code takes (widen that interface if it demands more than it uses)'
    ).toEqual([])
  })
})

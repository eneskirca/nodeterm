// No remote file is written with a bare `cat > <file>`.
//
// `cat > file` truncates the file the moment the remote shell starts, before a byte of the body has
// arrived, and `cat` cannot tell "the body ended" from "the ssh channel ended": when the channel
// dies first (the ControlMaster killed or rebuilt on a reconnect, the runner's timeout SIGTERMing
// the child, a dropped link) it reads EOF and exits 0. On 2026-09-28 that left a host's canvas
// shims at 0 bytes, and every agent's canvas call exited 0 with no output. Measured against
// OpenSSH 9.6, and reproduced under /bin/sh in `remote-write-truncation.test.ts`.
//
// Every one of those writers read as correct, because on a healthy link it IS correct — which is
// the argument for a scan rather than a comment. Remote writes go through `remoteAtomicWrite` /
// `runRemoteAtomicWrite` (sibling temp, exact byte count, rename) or, for the user's own files,
// `updateRemoteTextFile` / `updateRemoteSettingsFile` (the same, plus lock, link and mode).

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

const SOURCE_ROOT = join(__dirname, '..', '..')
const ROOTS = ['core', 'main', 'server'].map((d) => join(SOURCE_ROOT, d))

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      if (entry !== 'node_modules') sources(p, out)
    } else if (/\.ts$/.test(entry) && !/\.test\.ts$/.test(entry)) {
      out.push(p)
    }
  }
  return out
}

/**
 * Files allowed to spell `cat >` into a real file, each with the reason. Every entry stages into a
 * temp it owns and checks the byte count before anything is published — or is not a remote write.
 */
const ALLOWED = new Map<string, string>([
  ['main/remote-atomic-write.ts', 'the helper: `cat` into its own temp, byte count checked, then rename'],
  [
    'core/agents/hooks/remote-settings-file.ts',
    "the user-file transaction: `cat` into its own stage dir, byte count checked, then rename"
  ],
  [
    'main/remote-ssh/legacy-hook-endpoint.ts',
    'the endpoint migration: `cat` into its own stage, byte count and digest checked, then rename'
  ],
  ['main/ptmx-limit.ts', 'a LOCAL heredoc under the admin prompt; the body is in the command, not on stdin']
])

/** `cat >` into something other than /dev/null; `cat >>` appends and never truncates. */
const BARE_CAT_WRITE = /\bcat\s*>(?!>)(?!\s*\/dev\/null)/

function isComment(line: string): boolean {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

describe('no remote file is written with a bare `cat >`', () => {
  const files = ROOTS.flatMap((r) => sources(r))

  it('finds the source tree (a zero-file scan would pass silently)', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it('every `cat >` into a file is in the allowlist', () => {
    const offenders: string[] = []
    for (const file of files) {
      const rel = relative(SOURCE_ROOT, file).replace(/\\/g, '/')
      if (ALLOWED.has(rel)) continue
      readFileSync(file, 'utf8')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .forEach((line, i) => {
          if (!isComment(line) && BARE_CAT_WRITE.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
        })
    }
    expect(offenders).toEqual([])
  })

  it('the pattern catches the shapes that shipped, and not the drains', () => {
    // The writer that truncated the shims, and its siblings, exactly as they were spelled.
    expect(BARE_CAT_WRITE.test("mkdir -p ${dir} && cat > ${q} && chmod 755 ${q}")).toBe(true)
    expect(BARE_CAT_WRITE.test('`${prelude}mkdir -p "$(dirname ${pathExpr})" && cat > ${pathExpr}`')).toBe(true)
    expect(BARE_CAT_WRITE.test('umask 077; cat >${posixQuote(launcher)}')).toBe(true)
    // The hook commands drain stdin into /dev/null on purpose; an append never truncates.
    expect(BARE_CAT_WRITE.test("else cat >/dev/null 2>&1 || :; fi")).toBe(false)
    expect(BARE_CAT_WRITE.test("cat > /dev/null")).toBe(false)
    expect(BARE_CAT_WRITE.test('cat >> "$log"')).toBe(false)
  })

  it('every allowlisted file still exists (a stale entry would hide the next offender by name)', () => {
    const rels = new Set(files.map((f) => relative(SOURCE_ROOT, f).replace(/\\/g, '/')))
    expect([...ALLOWED.keys()].filter((k) => !rels.has(k))).toEqual([])
  })
})

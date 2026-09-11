import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, sep } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * No user-visible string may call the local machine a Mac.
 *
 * Issue #563 was not one slip: ~30 strings across 15 files said "this Mac", and a grep is the only
 * thing that found them. The helper (`machineName.ts`) fixes the ones that existed; this test is
 * what stops the next string from bringing the assumption back — the same posture as
 * `fs-atomic.guard.test.ts`, and for the same reason: nothing else in the toolchain can see it,
 * because on the platform most of this was written on the sentence is true.
 *
 * COMMENTS ARE NOT SCANNED. They are not shown to anyone, they carry real history ("a Mac→SSH
 * node"), and rewriting them would bury the actual copy change in noise.
 */
const ROOTS = ['src/renderer', 'src/shared']

/** Files where naming a Mac is the CORRECT answer, each with the reason it is exempt. */
const ALLOWED = new Map<string, string>([
  [
    'src/renderer/lib/machineName.ts',
    'the helper itself — its doc comment and examples name all three nouns'
  ],
  [
    'src/renderer/components/PtyPressureBanner.tsx',
    'genuinely macOS: kern.tty.ptmx_max and the macOS password prompt'
  ],
  [
    'src/renderer/components/onboarding/OnboardingFlow.tsx',
    'the notch step exists on macOS only (see the isMac step list in that file)'
  ]
])

const BANNED = /\b(this|This|your|Your|a|another) Macs?\b|\bMacs\b/

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out)
      continue
    }
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue
    out.push(full)
  }
  return out
}

/** Drop line comments and JSDoc/block-comment continuation lines — see the module doc. */
function isComment(line: string): boolean {
  const t = line.trimStart()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

describe('no user-visible copy calls this machine a Mac', () => {
  it('finds none outside the documented exemptions', () => {
    const offenders: string[] = []
    for (const root of ROOTS) {
      for (const file of sourceFiles(join(process.cwd(), root))) {
        // ALLOWED is keyed with forward slashes; on Windows `relative` returns backslashes.
        const rel = relative(process.cwd(), file).split(sep).join('/')
        if (ALLOWED.has(rel)) continue
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (isComment(line) || !BANNED.test(line)) return
            offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
          })
      }
    }
    expect(offenders, 'use thisMachine()/thisMachineCap()/machineNoun() from lib/machineName').toEqual(
      []
    )
  })

  it('keeps the exemption list honest — every entry still exists and still says Mac', () => {
    for (const [rel, why] of ALLOWED) {
      const src = readFileSync(join(process.cwd(), rel), 'utf8')
      expect(BANNED.test(src), `${rel} no longer needs its exemption (${why})`).toBe(true)
    }
  })
})

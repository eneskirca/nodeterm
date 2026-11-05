// The shim scripts copied onto an SSH host must stay MACHINE-NEUTRAL: no path that only means
// something on the desktop/server that generated them.
//
// Since the local shims gained the shared-Codex identity prelude, the two builders take an
// `identityRoot` — this machine's `<userDataDir>/codex-thread-nodes`. The LOCAL installers pass it;
// the SSH installer must not use that local builder, because a record root under one machine's user-data dir is not a
// path on somebody else's server. The rule is stated in three places (CLAUDE.md, CONTRIBUTING.md,
// docs/shared-codex-node-identity.md) and was enforced by none of them.
//
// WHY IT NEEDS A GUARD RATHER THAN A REVIEWER: the failure is SILENT AND ONE-SIDED. A remote shim
// carrying the prelude still works — the outer `[ -n "$CODEX_THREAD_ID" ]` guard is false in a
// remote pane, and even if it were true the baked root does not exist there, so every candidate
// read fails and the block changes nothing. Nothing breaks, no test goes red, no user reports a
// bug. The only symptom is that this machine's user-data layout is now sitting in a file on
// someone else's server, written there by us, and refreshed on every connect.
//
// Two legs, because they catch the mistake at different moments:
//   1. the VALUE — the neutral exports carry no profile path; the remote builders use only the target home;
//   2. the IMPORT — `remote-hooks.ts` cannot even reach a builder that would produce one.
// Leg 2 is the one that survives a refactor: a future author who reaches for the parameterised
// builder "so the remote shim gets the fix too" is stopped at the import, before there is a value
// to assert about.
//
// Every assertion has a POSITIVE CONTROL beside it. A guard whose subject has been renamed or
// removed matches nothing and reports clean — the same failure mode `fs-atomic.guard.test.ts`
// opens with — and a silent pass here would restore exactly the blindness this file exists to end.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

import { CONTROL_SHIM_SCRIPT, buildControlShimScript, buildRemoteControlShimScript } from '../../core/canvas-control-core'
import { CONTEXT_SHIM_SCRIPT, buildContextShimScript, buildRemoteContextShimScript } from '../../core/context-link-core'

/** A root no real machine would produce, so a hit is unambiguously the one we baked in. */
const SENTINEL_ROOT = '/nodeterm-guard-sentinel/codex-thread-nodes'

const REMOTE_HOOKS = join(__dirname, 'remote-hooks.ts')

/**
 * Identifiers `remote-hooks.ts` must never name. Each one is a way to obtain a shim body carrying
 * a local path, or the local path itself.
 */
const BANNED_IN_REMOTE_HOOKS = [
  'buildControlShimScript',
  'buildContextShimScript',
  'codexThreadIdentityResolverSh',
  'codexThreadIdentityRoot'
] as const

/**
 * Identifiers `remote-hooks.ts` must still name — the explicit target-home-only builders it writes to the host. If
 * these disappear the file has been restructured and leg 2's scan is no longer looking at the
 * thing it was written to look at, so it must go red rather than pass over an empty subject.
 */
const REQUIRED_IN_REMOTE_HOOKS = ['buildRemoteControlShimScript', 'buildRemoteContextShimScript', 'remoteCodexIdentityRoot'] as const

/**
 * Strip comments before scanning, so this file's own rule can be EXPLAINED at the call site in
 * `remote-hooks.ts` without the explanation tripping the scan. Only comments are removed; a string
 * literal naming a banned identifier is still a hit, which is the conservative direction.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

describe('SSH-installed shims stay machine-neutral', () => {
  describe('leg 1 — the exported neutral bodies carry no local path', () => {
    for (const [name, neutral, build] of [
      ['canvas control', CONTROL_SHIM_SCRIPT, buildControlShimScript],
      ['linked context', CONTEXT_SHIM_SCRIPT, buildContextShimScript]
    ] as const) {
      it(`${name}: the builder DOES bake a root when given one (positive control)`, () => {
        // Without this, the two assertions below would also pass if the prelude had been dropped
        // from the local shims altogether — a regression, reported as compliance.
        const local = build(SENTINEL_ROOT)
        expect(local).toContain(SENTINEL_ROOT)
        expect(local).toContain('CODEX_THREAD_ID')
      })

      it(`${name}: the neutral export names no record root`, () => {
        expect(neutral).not.toContain('codex-thread-nodes')
      })

      it(`${name}: the neutral export carries no identity prelude at all`, () => {
        // Broader than the path check on purpose. The path is what leaks today; the prelude is the
        // only thing that can carry one, so refusing the whole block refuses the next spelling of
        // the leak too (a root read from an env var, a relative path, a default argument).
        expect(neutral).not.toContain('CODEX_THREAD_ID')
        expect(build()).toBe(neutral)
      })
    }
  })

  describe('explicit target-host variants', () => {
    for (const build of [buildRemoteControlShimScript, buildRemoteContextShimScript]) {
      it('carries only the selected target home and refuses unsafe homes', () => {
        const remote = build('/synthetic-remote/home');
        expect(remote).toContain('/synthetic-remote/home/.nodeterm/codex-thread-nodes');
        expect(remote).not.toContain(SENTINEL_ROOT);
        expect(() => build('relative')).toThrow();
        expect(() => build('/synthetic/../escape')).toThrow();
      });
    }
  });

  describe('leg 2 — remote-hooks.ts cannot reach a local-path builder', () => {
    const source = code(readFileSync(REMOTE_HOOKS, 'utf8'))

    it('is reading the real remote installer (positive control)', () => {
      for (const required of REQUIRED_IN_REMOTE_HOOKS) expect(source).toContain(required)
    })

    for (const banned of BANNED_IN_REMOTE_HOOKS) {
      it(`never names ${banned}`, () => {
        expect(source).not.toContain(banned)
      })
    }
  })
})

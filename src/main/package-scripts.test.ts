import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * Release guard: every packaging script builds EVERYTHING the app loads at runtime before it hands
 * `out/` to electron-builder.
 *
 * `npm run build` is the one definition of "everything": the electron-vite bundles, the session
 * host (`host:build`) and the standalone Codex relay (`build:codex-relay` →
 * `out/main/codex-relay.js`, which `loadCodexRelayBundle` in src/main/index.ts uploads to an SSH
 * host for managed Codex accounts). The packaging scripts used to spell the steps out themselves,
 * and the list drifted: `dist`, `dist:linux`, `dist:win` and `release` all ran
 * `electron-vite build && npm run host:build` and never built the relay. MEASURED on the published
 * v0.3.7 artifacts: the macOS and Windows `app.asar` carry no `out/main/codex-relay.js` at all,
 * while the Linux `.deb` — built by release.yml with `npm run build` — does. Nothing reported it:
 * a missing bundle reads as "no managed Codex runtime" (`''`), by design, so the feature was
 * simply absent on two of three platforms.
 *
 * So packaging calls `npm run build` and adds nothing of its own, and a step added to `build`
 * reaches every package with no second list to update.
 */
const PKG = path.resolve(__dirname, '../../package.json')

describe('packaging scripts', () => {
  const scripts: Record<string, string> = JSON.parse(fs.readFileSync(PKG, 'utf8')).scripts ?? {}
  const packaging = Object.entries(scripts).filter(([, cmd]) => cmd.includes('electron-builder'))

  it('finds the packaging scripts it is guarding', () => {
    // An empty list would make every assertion below vacuously green.
    expect(packaging.map(([name]) => name).sort()).toEqual(
      expect.arrayContaining(['dist', 'dist:linux', 'dist:win', 'release'])
    )
  })

  it('`build` produces every runtime bundle, the Codex relay included', () => {
    expect(scripts.build).toContain('electron-vite build')
    expect(scripts.build).toContain('npm run host:build')
    expect(scripts.build).toContain('npm run build:codex-relay')
  })

  it.each(packaging)('%s runs the full `npm run build` before electron-builder', (name, cmd) => {
    const build = cmd.indexOf('npm run build ')
    expect(
      build,
      `${name} must run \`npm run build\`, not its own list of build steps — a hand-written list ` +
        'is how the Codex relay went missing from the macOS and Windows packages.'
    ).toBeGreaterThanOrEqual(0)
    expect(build).toBeLessThan(cmd.indexOf('electron-builder'))
    expect(cmd, `${name} repeats a step \`npm run build\` already runs`).not.toContain('electron-vite build')
    expect(cmd).not.toContain('npm run host:build')
  })
})

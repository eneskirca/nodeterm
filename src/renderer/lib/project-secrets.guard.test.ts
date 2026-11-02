// Project secrets (docs/project-secrets.md): only a person, in this app, may start a fetch. These
// scans pin the facts that rule rests on and that no type checker can see:
//  - the renderer calls `projectSecrets.authorize` from exactly ONE place, the Secrets dialog's
//    button (main then raises its own native confirmation);
//  - every request channel is host-only, so no relay peer can reach it;
//  - no canvas-control verb names the feature (an agent cannot fetch, reveal, set or clear);
//  - the core holder never logs.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HOST_ONLY_CHANNELS } from '@shared/host-control'
import { IPC } from '@shared/ipc'

const SRC = join(__dirname, '..', '..')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return files(p)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : []
  })
}

const read = (p: string): string => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
const codeLines = (text: string): string[] => text.split('\n').filter((l) => !/^\s*(\/\/|\/?\*)/.test(l))

describe('project secrets guard', () => {
  it('the renderer starts a fetch from ONE place: the Secrets dialog', () => {
    // Any `.authorize(` (also split over lines: `api\n  .authorize(`) in a file that touches the
    // projectSecrets API counts — the bridges declare the member but never call it.
    const sites = files(join(SRC, 'renderer')).filter((p) => {
      const text = read(p)
      if (!/projectSecrets/.test(text) || /[\\/]bridge[\\/]/.test(p)) return false
      return codeLines(text).some((l) => /(^|[^\w])\.\s*authorize\s*\(/.test(l) || /^\s*authorize\s*\(/.test(l))
    })
    expect(sites.map((p) => p.slice(SRC.length + 1).replace(/\\/g, '/'))).toEqual([
      'renderer/components/ProjectSecretsDialog.tsx'
    ])
  })

  it('the renderer opens the paste window from ONE place: the Secrets dialog', () => {
    const sites = files(join(SRC, 'renderer')).filter((p) => {
      const text = read(p)
      if (!/projectSecrets/.test(text) || /[\\/]bridge[\\/]/.test(p)) return false
      return codeLines(text).some((l) => /(^|[^\w])\.\s*paste\s*\(/.test(l))
    })
    expect(sites.map((p) => p.slice(SRC.length + 1).replace(/\\/g, '/'))).toEqual([
      'renderer/components/ProjectSecretsDialog.tsx'
    ])
  })

  it('the paste window\'s page imports no app code (only its stylesheet)', () => {
    const page = read(join(SRC, 'renderer', 'secret-entry', 'main.ts'))
    const imports = codeLines(page).filter((l) => /^\s*import\s/.test(l))
    expect(imports).toEqual(["import './secret-entry.css'"])
  })

  it('every request channel is host-only', () => {
    for (const ch of [
      IPC.projectSecretsStatus,
      IPC.projectSecretsAuthorize,
      IPC.projectSecretsPaste,
      IPC.secretEntrySubmit,
      IPC.secretEntryCancel,
      IPC.projectSecretsClear,
      IPC.projectSecretsCrossGate,
      IPC.projectSecretsCrossDecide
    ]) {
      expect(HOST_ONLY_CHANNELS.has(ch), ch).toBe(true)
    }
  })

  it('no canvas-control or hook code reaches the holder', () => {
    const forbidden = [
      ...files(join(SRC, 'core', 'agents')),
      join(SRC, 'core', 'canvas-control-core.ts'),
      join(SRC, 'core', 'hook-server.ts')
    ].filter((p) => {
      try {
        return /ProjectSecretsService|projectSecrets\.(authorize|status|clear)|project-secrets:/.test(read(p))
      } catch {
        return false
      }
    })
    expect(forbidden).toEqual([])
  })

  it('the core holder and the main leg never log', () => {
    for (const p of [
      join(SRC, 'core', 'project-secrets.ts'),
      join(SRC, 'main', 'project-secrets-ipc.ts'),
      join(SRC, 'main', 'secret-entry-window.ts'),
      join(SRC, 'preload', 'secret-entry.ts'),
      join(SRC, 'renderer', 'secret-entry', 'main.ts')
    ]) {
      expect(codeLines(read(p)).filter((l) => /console\.|\blog\(/.test(l)), p).toEqual([])
    }
  })
})

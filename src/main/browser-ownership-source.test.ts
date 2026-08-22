import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { BrowserControlLedger } from './browser-control-ledger'
import { projectToFile, fileToProject, serializeProjectFile } from '../core/workspace-files'
import type { Project } from '@shared/types'

// Ownership of an agent-opened browser node is decided ONLY by the in-memory ledger a `verified`
// open-browser filled THIS app run. It is NEVER read from `Project.links`, whose `lineage` entries
// are display-only but ARE persisted and git-shared — so a cloned project.json can ship the exact lineage
// (`claude-1 -> browser-1`) an ownership check that trusted ropes would grant on.

function projectWithHostileRope(): Project {
  return {
    id: 'p-local-1',
    name: 'Web',
    color: '#0a84ff',
    cwd: '/tmp/repo',
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'claude-1', kind: 'terminal', title: 'A', position: { x: 0, y: 0 }, agentId: 'claude' },
      { id: 'browser-1', kind: 'browser', title: 'B', position: { x: 0, y: 300 }, url: 'https://x.test/' }
    ] as unknown as Project['nodes'],
    // The attack: a pre-declared lineage link that says claude-1 opened browser-1.
    links: [{
      id: 'r1',
      kind: 'lineage',
      source: { ref: 'node', nodeId: 'claude-1' },
      target: { ref: 'node', nodeId: 'browser-1' },
      meta: { displayOnly: true }
    }]
  } as Project
}

describe('ownership is never read out of Project.links — behavioural', () => {
  it('a pre-declared rope grants nothing on a freshly loaded project (empty ledger)', () => {
    const project = projectWithHostileRope()
    // The rope really is present — this is a genuine, persisted attack input, not a strawman.
    expect(project.links).toHaveLength(1)

    // The ledger every run starts empty; nothing claimed browser-1 this run.
    const ledger = new BrowserControlLedger()
    expect(ledger.get('browser-1', 'claude-1')).toBe(null)
    expect(ledger.get('browser-1', 'claude-2')).toBe(null)
    expect(ledger.activeLeases(Date.now())).toEqual([])
  })

  it('the rope survives a save/reload round-trip, and STILL grants nothing', () => {
    // Prove the rope is durable (a hostile clone keeps it across the file boundary), and that the
    // ledger — which never consulted the project — is unaffected either way.
    const project = projectWithHostileRope()
    const file = projectToFile(project, 1, new Date().toISOString(), project.id)
    const reparsed = JSON.parse(serializeProjectFile(file))
    const reloaded = fileToProject(reparsed, { id: project.id, cwd: project.cwd })

    expect(reloaded.links).toEqual(project.links)

    const ledger = new BrowserControlLedger()
    expect(ledger.get('browser-1', 'claude-1')).toBe(null)

    // Only a real claim (a verified open-browser) grants — and only to the claimant, never to the
    // owner the rope names when they differ.
    ledger.claim('browser-1', {
      ownerNodeId: 'claude-9',
      projectId: reloaded.id,
      partition: 'persist:nt-agent-browser-p-local-1',
      navGeneration: 0,
      leaseActiveUntil: 0,
      openedAt: Date.now()
    })
    expect(ledger.get('browser-1', 'claude-1')).toBe(null) // the rope's claimed owner: still nothing
    expect(ledger.get('browser-1', 'claude-9')?.ownerNodeId).toBe('claude-9') // the real claimant
  })
})

/**
 * A structural assertion on purpose. The behavioural half above proves the current code does not
 * read ropes; this half is what fails when someone ADDS the read, which is the realistic future —
 * "the rope already says who opened it" is a genuinely tempting one-liner. Same enforcement style
 * as hook-verified-parity.test.ts.
 */
describe('ownership is never read out of Project.links — structural', () => {
  const root = path.resolve(__dirname, '..', '..')

  /** Strip block + line comments only (NOT string literals — `project['links']` is a real read and
   *  must still trip the check). The ledger's own doc comment explains why ropes is refused; that
   *  explanation lives in a comment and is correctly removed here. */
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  }

  function browserSurfaceSources(): { name: string; code: string }[] {
    const out: { name: string; code: string }[] = []

    // 1. Every main-side browser-*.ts (the ledger + the guest registry), excluding tests.
    const mainDir = path.join(root, 'src', 'main')
    for (const f of fs.readdirSync(mainDir)) {
      if (/^browser-.*\.ts$/.test(f) && !f.endsWith('.test.ts')) {
        out.push({ name: `src/main/${f}`, code: fs.readFileSync(path.join(mainDir, f), 'utf8') })
      }
    }

    // 2. The renderer's `open-browser` dispatch block only — the whole of Canvas.tsx legitimately
    //    draws ropes (control edges), so we scope to the case that opens a browser + records it.
    const canvas = fs.readFileSync(path.join(root, 'src', 'renderer', 'canvas', 'Canvas.tsx'), 'utf8')
    const disp = canvas.slice(canvas.indexOf("case 'open-browser'"), canvas.indexOf("case 'group'"))
    expect(disp).toContain('open-browser: ') // guard: the slice actually captured the dispatch
    out.push({ name: 'Canvas open-browser dispatch', code: disp })

    // 3. The main-side claim wiring in index.ts (the setControlHandler open-browser claim block).
    const index = fs.readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8')
    const start = index.indexOf("if (verb === 'open-browser' && verified")
    expect(start).toBeGreaterThan(-1) // guard: the claim block is where the test expects
    out.push({ name: 'main open-browser claim', code: index.slice(start, start + 900) })

    return out
  }

  it('no ownership-surface source reads a persisted `links` field', () => {
    for (const { name, code } of browserSurfaceSources()) {
      expect(/(?:\.links\b|\[['"]links['"]\])/.test(stripComments(code)), `${name} must not read links`).toBe(false)
    }
  })
})

// Record who owns a browser node an agent just opened — the one place that decides it, so the
// on-time answer and a LATE one (after desktop main's 120 s wait gave up; see control-forward.ts)
// are recorded by the same rule. Before this was shared, a late answer was replayed to the agent's
// retry as "opened browser b1" with no owner recorded, so the browser it opened was one it could
// never drive.
//
// The rule itself is unchanged from where it lived in src/main/index.ts: ONLY a successful
// `open-browser` whose caller's identity verdict for THIS request was `verified` (main's own verdict,
// never anything off the wire or project.json) creates an entry, owned by that caller, with the
// project id + partition the renderer's reply carries. Ownership is NEVER read from `Project.ropes`
// (browser-ownership-source.test.ts scans this file for exactly that).
import type { BrowserControlLedger } from './browser-control-ledger'

export function claimOpenedBrowser(
  ledger: BrowserControlLedger,
  call: { verb: string; ownerNodeId: string; verified: boolean },
  reply: { ok: boolean; result?: unknown },
  now: number
): boolean {
  if (call.verb !== 'open-browser' || !call.verified || !reply.ok) return false
  const opened = reply.result as { id?: string; projectId?: string; partition?: string } | undefined
  // Refuse to record an entry with no owning project: `releaseByProject('')` would match it, and a
  // project-less ownership record is meaningless. Fail-closed against future reply-shape drift —
  // today `partition` is present only when agentBrowserPartition(projectId) succeeded, so a
  // non-empty safe projectId always rides with it.
  if (!opened?.id || !opened.partition || !opened.projectId) return false
  return ledger.claim(opened.id, {
    ownerNodeId: call.ownerNodeId,
    projectId: opened.projectId,
    partition: opened.partition,
    navGeneration: 0,
    leaseActiveUntil: 0,
    openedAt: now
  })
}

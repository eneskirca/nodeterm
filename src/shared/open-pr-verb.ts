// `open-pr --pr <n>`: the agent that ran `gh pr create` opens that PR as a pull request node beside
// itself, joined by a context link. Open-only: nothing here, or in either shell's handler, can reach
// a GitHub write. The repository is the project's approved one, resolved by the host; the agent
// cannot name one, so the core's repository-mismatch refusal stays the guard. One plan, shared by
// the desktop dispatch (Canvas.tsx) and the Server Edition (headless-node-factory.ts).
import { normalizePullRef, type PullNodeRef } from './pull-node'

/** The only flag the verb reads. Anything else (`--repository` above all) is refused by name. */
export const OPEN_PR_FLAGS: ReadonlySet<string> = new Set(['pr'])

export type OpenPrPlan =
  | { kind: 'refuse'; error: string }
  /** The project already has this PR's node: link it (and, on screen, frame it). */
  | { kind: 'reuse'; nodeId: string }
  | { kind: 'create'; ref: PullNodeRef }

export function planOpenPr(input: {
  args: Record<string, string | undefined>
  /** The host's answer for the caller's project (`githubControl.status(...).project`). */
  repo: { repository?: string; approved: boolean } | undefined
  pullNodes: readonly { id: string; pull?: { repository: string; pullNumber: number } }[]
  /** A relay peer or scoped guest: refused like the other opening verbs. */
  relayGuest?: boolean
}): OpenPrPlan {
  const refuse = (error: string): OpenPrPlan => ({ kind: 'refuse', error })
  if (input.relayGuest) return refuse('open-pr-relay-refused: a relay guest cannot open nodes on this canvas')
  const unknown = Object.keys(input.args).find((k) => !OPEN_PR_FLAGS.has(k))
  if (unknown) return refuse(`open-pr: unknown flag --${unknown}`)
  const raw = (input.args.pr ?? '').trim().replace(/^#/, '')
  const pullNumber = /^\d+$/.test(raw) ? Number(raw) : NaN
  if (!(pullNumber >= 1 && pullNumber <= 2_147_483_647)) {
    return refuse('open-pr requires --pr <number> (the number `gh pr create` printed)')
  }
  const ref = normalizePullRef({ repository: input.repo?.repository, pullNumber, tab: 'overview' })
  if (!input.repo?.approved || !ref) {
    return refuse('open-pr-no-repo: this project has no approved GitHub repository; ask the user to connect its board')
  }
  const key = ref.repository.toLowerCase()
  const existing = input.pullNodes.find((n) =>
    n.pull?.pullNumber === ref.pullNumber && n.pull.repository.toLowerCase() === key)
  return existing ? { kind: 'reuse', nodeId: existing.id } : { kind: 'create', ref }
}

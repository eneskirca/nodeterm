// `open-pr --pr <n>`: the agent that ran `gh pr create` opens that PR as a pull request node beside
// itself, joined by a context link. Open-only: nothing here, or in either shell's handler, can reach
// a GitHub write. The repository is the project's approved one, resolved by the host; the agent
// cannot name one, so the core's repository-mismatch refusal stays the guard. One plan, shared by
// the desktop dispatch (Canvas.tsx) and the Server Edition (headless-node-factory.ts).
import { normalizePullRef, type PullNodeRef } from './pull-node'

/** The only flag the verb reads. Anything else (`--repository` above all) is refused by name. */
export const OPEN_PR_FLAGS: ReadonlySet<string> = new Set(['pr'])

/** The flag-and-number half of the plan: the shape gate the Server Edition parser runs too. */
export function openPrArgsRefusal(args: Record<string, string | undefined>): string | null {
  const unknown = Object.keys(args).find((k) => !OPEN_PR_FLAGS.has(k))
  if (unknown) return `open-pr: unknown flag --${unknown}`
  return pullNumberArg(args.pr) ? null : 'open-pr requires --pr <number> (the number `gh pr create` printed)'
}

export function pullNumberArg(value: string | undefined): number | undefined {
  const raw = (value ?? '').trim().replace(/^#/, '')
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN
  return n >= 1 && n <= 2_147_483_647 ? n : undefined
}

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
  const shape = openPrArgsRefusal(input.args)
  if (shape) return refuse(shape)
  const ref = normalizePullRef({ repository: input.repo?.repository, pullNumber: pullNumberArg(input.args.pr), tab: 'overview' })
  if (!input.repo?.approved || !ref) {
    return refuse('open-pr-no-repo: this project has no approved GitHub repository; ask the user to connect its board')
  }
  const key = ref.repository.toLowerCase()
  const existing = input.pullNodes.find((n) =>
    n.pull?.pullNumber === ref.pullNumber && n.pull.repository.toLowerCase() === key)
  return existing ? { kind: 'reuse', nodeId: existing.id } : { kind: 'create', ref }
}

// The pull node sidebar's one GraphQL read (shared/github-pull-sidebar.ts): requested reviewers,
// each reviewer's latest review, assignees, labels, closing issues and participants of one PR.
// Decoded LENIENTLY per part: the sidebar is display only, so a malformed entry is dropped, and a
// part GitHub did not answer (null, or an error on its path) is left out, never read as empty.
import type { GitHubIssueUser } from '../../shared/github-issues'
import type { PullReviewVerdict } from '../../shared/github-pull-detail'
import type { PullClosingIssue, PullLabel, PullSidebarRead } from '../../shared/github-pull-sidebar'
import { GraphQLShapeError, graphQLErrors } from './graphql-pulls'

const MAX = 100
const USER = 'login avatarUrl ... on User{ databaseId } ... on Bot{ databaseId }'

export const PULL_SIDEBAR_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviewRequests(first:${MAX}){ nodes{ requestedReviewer{ __typename ... on User{ ${USER} } } } }
      latestReviews(first:${MAX}){ nodes{ state author{ ${USER} } } }
      assignees(first:${MAX}){ nodes{ ${USER} } }
      labels(first:${MAX}){ nodes{ name color } }
      closingIssuesReferences(first:50){ nodes{ number title state repository{ nameWithOwner } } }
      participants(first:${MAX}){ nodes{ ${USER} } }
    }
  }
}`

const VERDICTS: Record<string, PullReviewVerdict> = {
  APPROVED: 'approved', CHANGES_REQUESTED: 'changes-requested', COMMENTED: 'commented', DISMISSED: 'dismissed'
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** The REST user shape, with the same avatar host rule as the REST decoder. */
function user(value: unknown): GitHubIssueUser | null {
  const item = object(value)
  const id = item?.databaseId
  if (!item || typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 ||
      typeof item.login !== 'string' || !item.login || item.login.length > 128 || typeof item.avatarUrl !== 'string') return null
  try {
    const avatar = new URL(item.avatarUrl)
    if (avatar.protocol !== 'https:' || avatar.hostname !== 'avatars.githubusercontent.com') return null
    return { id, login: item.login, avatarUrl: avatar.toString() }
  } catch { return null }
}

export function parsePullSidebar(body: unknown): PullSidebarRead {
  const pull = object(object(object(object(body)?.data)?.repository)?.pullRequest)
  if (!pull) throw new GraphQLShapeError()
  // A part with an error on its path is unknown, even if GitHub also sent a value for it.
  const failed = new Set(graphQLErrors(body).map((error) => error.path?.[2]).filter((part) => typeof part === 'string'))
  const part = <T>(field: string, decode: (node: Record<string, unknown>) => T | null): T[] | undefined => {
    const nodes = object(pull[field])?.nodes
    if (failed.has(field) || !Array.isArray(nodes)) return undefined
    return nodes.flatMap((node) => { const value = object(node) && decode(node as Record<string, unknown>); return value ? [value] : [] })
  }
  const requested = part('reviewRequests', (node) => user(node.requestedReviewer))
  const reviews = part('latestReviews', (node) => {
    const author = user(node.author)
    const verdict = typeof node.state === 'string' ? VERDICTS[node.state] : undefined
    return author && verdict ? { user: author, verdict } : null
  })
  const assignees = part('assignees', user)
  const labels = part('labels', (node): PullLabel | null =>
    typeof node.name === 'string' && node.name && typeof node.color === 'string' && /^[0-9a-f]{6}$/i.test(node.color)
      ? { name: node.name, color: node.color.toLowerCase() } : null)
  const closingIssues = part('closingIssuesReferences', (node): PullClosingIssue | null => {
    const repository = object(node.repository)?.nameWithOwner
    return typeof node.number === 'number' && Number.isSafeInteger(node.number) && node.number > 0 &&
      typeof node.title === 'string' && typeof repository === 'string' && (node.state === 'OPEN' || node.state === 'CLOSED')
      ? { repository, number: node.number, title: node.title, state: node.state === 'OPEN' ? 'open' : 'closed' } : null
  })
  const participants = part('participants', user)
  return {
    ...(requested && reviews ? { requested, reviews } : {}),
    ...(assignees ? { assignees } : {}),
    ...(labels ? { labels } : {}),
    ...(closingIssues ? { closingIssues } : {}),
    ...(participants ? { participants } : {})
  }
}

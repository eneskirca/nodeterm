// The Commits tab's read: one page of a PR's commits (GraphQL `pullRequest.commits`), oldest first.
import type { GitHubIssueUser } from '../../shared/github-issues'
import { isCommitSha, type PullCommit, type PullCommitsPage } from '../../shared/github-pull-commits'
import { GraphQLShapeError, graphQLErrors } from './graphql-pulls'

export const PULL_COMMITS_PER_PAGE = 100

export const PULL_COMMITS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      commits(first:${PULL_COMMITS_PER_PAGE},after:$after){
        pageInfo{ hasNextPage endCursor }
        nodes{ commit{ oid messageHeadline committedDate signature{ isValid } author{ name user{ databaseId login avatarUrl } } authors(first:4){ nodes{ name user{ login } } } statusCheckRollup{ state } } }
      }
    }
  }
}`

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

const text = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length <= maximum

/** A linked account, the client's REST rules (avatars only from avatars.githubusercontent.com).
 *  ponytail: display only, so an odd one reads as no account rather than failing the list. */
function commitUser(value: unknown): GitHubIssueUser | null {
  const user = object(value)
  const id = user?.databaseId
  if (!user || typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || !text(user.login, 128) || !user.login ||
      !text(user.avatarUrl, 2_048)) return null
  let avatar: URL
  try { avatar = new URL(user.avatarUrl) } catch { return null }
  if (avatar.protocol !== 'https:' || avatar.hostname !== 'avatars.githubusercontent.com') return null
  return { id, login: user.login, avatarUrl: avatar.toString() }
}

const ROLLUP_CI: Record<string, PullCommit['ci']> = {
  SUCCESS: 'passed', FAILURE: 'failed', ERROR: 'failed', PENDING: 'pending', EXPECTED: 'pending'
}

/** The co-authors after the first (login, else name) and the commit's CI state. Lenient: display only. */
function commitExtras(commit: Record<string, unknown>): Pick<PullCommit, 'coAuthors' | 'ci'> {
  const nodes = object(commit.authors)?.nodes
  const coAuthors = (Array.isArray(nodes) ? nodes.slice(1) : []).flatMap((entry) => {
    const author = object(entry)
    const login = object(author?.user)?.login
    const name = text(login, 128) && login ? login : author?.name
    return text(name, 256) && name ? [name] : []
  })
  const state = object(commit.statusCheckRollup)?.state
  const ci = typeof state === 'string' ? ROLLUP_CI[state] : undefined
  return { ...(coAuthors.length ? { coAuthors } : {}), ...(ci ? { ci } : {}) }
}

/** Decodes one page. Throws `GraphQLShapeError` for a malformed body or any error. */
export function parsePullCommits(body: unknown): PullCommitsPage {
  if (graphQLErrors(body).length) throw new GraphQLShapeError()
  const connection = object(object(object(object(object(body)?.data)?.repository)?.pullRequest)?.commits)
  const page = object(connection?.pageInfo)
  if (!connection || !page || !Array.isArray(connection.nodes) || connection.nodes.length > PULL_COMMITS_PER_PAGE ||
      typeof page.hasNextPage !== 'boolean') throw new GraphQLShapeError()
  const commits = connection.nodes.map((entry): PullCommit => {
    const commit = object(object(entry)?.commit)
    if (!commit || !isCommitSha(commit.oid) || !text(commit.messageHeadline, 4_096) ||
        !text(commit.committedDate, 64) || Number.isNaN(Date.parse(commit.committedDate))) throw new GraphQLShapeError()
    const author = object(commit.author)
    return {
      oid: commit.oid,
      headline: commit.messageHeadline,
      author: commitUser(author?.user),
      authorName: text(author?.name, 256) ? author.name : '',
      committedAt: commit.committedDate,
      verified: object(commit.signature)?.isValid === true,
      ...commitExtras(commit)
    }
  })
  if (!page.hasNextPage) return { commits }
  if (!text(page.endCursor, 1_024) || !page.endCursor) throw new GraphQLShapeError()
  return { commits, after: page.endCursor }
}

// "Since my last review" (F-10): the viewer's latest submitted review on one PR, from GraphQL
// `latestReviews` (one per author) matched to `viewer.login`.
import { isCommitSha } from '../../shared/github-pull-commits'
import type { PullViewerReview } from '../../shared/github-pull-since-review'
import { GraphQLShapeError, graphQLErrors } from './graphql-pulls'

export const PULL_VIEWER_REVIEW_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  viewer{ login }
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      latestReviews(first:100){ nodes{ author{ login } submittedAt commit{ oid } } }
    }
  }
}`

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** The viewer's latest submitted review, or null when there is none. A pending review (no
 *  `submittedAt`) and one whose commit GitHub no longer names count as none. Throws
 *  `GraphQLShapeError` for a malformed body or any error. */
export function parsePullViewerReview(body: unknown): PullViewerReview | null {
  if (graphQLErrors(body).length) throw new GraphQLShapeError()
  const data = object(object(body)?.data)
  const login = object(data?.viewer)?.login
  const nodes = object(object(object(data?.repository)?.pullRequest)?.latestReviews)?.nodes
  if (typeof login !== 'string' || !login || !Array.isArray(nodes)) throw new GraphQLShapeError()
  let latest: PullViewerReview | null = null
  for (const entry of nodes) {
    const review = object(entry)
    if (object(review?.author)?.login !== login) continue
    const submittedAt = review?.submittedAt
    const oid = object(review?.commit)?.oid
    // ponytail: a review on a commit GitHub dropped reads as none; the Files tab still has All changes.
    if (typeof submittedAt !== 'string' || Number.isNaN(Date.parse(submittedAt)) || !isCommitSha(oid)) continue
    if (!latest || Date.parse(submittedAt) > Date.parse(latest.submittedAt)) latest = { submittedAt, commitOid: oid }
  }
  return latest
}

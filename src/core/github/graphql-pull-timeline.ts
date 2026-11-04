// The pull node's Conversation timeline: one GraphQL `timelineItems` page per read, with a fixed
// item type list. Checked against cli/cli#9000 on 2026-11-03 (schema accepted every field below).
// The envelope is strict (any error or a malformed page rejects the read); one item this build
// cannot decode, or an item type it does not know, is dropped so a new GitHub event never breaks the node.
import type { GitHubIssueUser } from '../../shared/github-issues'
import type { PullReviewVerdict } from '../../shared/github-pull-detail'
import { isPullTimelineCursor, type PullTimelineItem, type PullTimelinePage } from '../../shared/github-pull-timeline'
import { GraphQLShapeError, graphQLErrors } from './graphql-pulls'

export const PULL_TIMELINE_PAGE = 50

export const ACTOR = 'login avatarUrl ... on User{ databaseId } ... on Bot{ databaseId }'
export const EVENT = `id createdAt actor{ ${ACTOR} }`

export const PULL_TIMELINE_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      createdAt
      timelineItems(first:${PULL_TIMELINE_PAGE}, after:$after, itemTypes:[ISSUE_COMMENT,PULL_REQUEST_REVIEW,PULL_REQUEST_COMMIT,HEAD_REF_FORCE_PUSHED_EVENT,LABELED_EVENT,UNLABELED_EVENT,REVIEW_REQUESTED_EVENT,ASSIGNED_EVENT,UNASSIGNED_EVENT,CLOSED_EVENT,REOPENED_EVENT,MERGED_EVENT,READY_FOR_REVIEW_EVENT,CONVERT_TO_DRAFT_EVENT,CROSS_REFERENCED_EVENT]){
        pageInfo{ hasNextPage endCursor }
        nodes{
          __typename
          ... on IssueComment{ id databaseId body createdAt url author{ ${ACTOR} } }
          ... on PullRequestReview{ id databaseId body state submittedAt createdAt url author{ ${ACTOR} } }
          ... on PullRequestCommit{ id commit{ oid messageHeadline committedDate author{ user{ login avatarUrl databaseId } } } }
          ... on HeadRefForcePushedEvent{ ${EVENT} beforeCommit{ oid } afterCommit{ oid } }
          ... on LabeledEvent{ ${EVENT} label{ name color } }
          ... on UnlabeledEvent{ ${EVENT} label{ name color } }
          ... on ReviewRequestedEvent{ ${EVENT} requestedReviewer{ __typename ... on User{ login } ... on Team{ name } } }
          ... on AssignedEvent{ ${EVENT} assignee{ ... on User{ login avatarUrl databaseId } ... on Bot{ login avatarUrl databaseId } } }
          ... on UnassignedEvent{ ${EVENT} assignee{ ... on User{ login avatarUrl databaseId } ... on Bot{ login avatarUrl databaseId } } }
          ... on ClosedEvent{ ${EVENT} }
          ... on ReopenedEvent{ ${EVENT} }
          ... on MergedEvent{ ${EVENT} commit{ oid } mergeRefName }
          ... on ReadyForReviewEvent{ ${EVENT} }
          ... on ConvertToDraftEvent{ ${EVENT} }
          ... on CrossReferencedEvent{ ${EVENT} source{ __typename ... on Issue{ number title url repository{ nameWithOwner } } ... on PullRequest{ number title url repository{ nameWithOwner } } } }
        }
      }
    }
  }
}`

type Obj = Record<string, unknown>
const object = (value: unknown): Obj | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : null
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
const sha = (value: unknown): string | null => {
  const oid = object(value)?.oid
  return typeof oid === 'string' && /^[0-9a-f]{40}$/.test(oid) ? oid : null
}
const githubUrl = (value: unknown): value is string => typeof value === 'string' && value.startsWith('https://github.com/')

/** A user as the REST decoder names one, or null (a ghost, or an actor this build cannot name). */
function user(value: unknown): GitHubIssueUser | null {
  const item = object(value)
  const id = item?.databaseId
  if (!item || typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || !text(item.login, 128) ||
      !item.login || !text(item.avatarUrl, 2_048)) return null
  let avatar: URL
  try { avatar = new URL(item.avatarUrl) } catch { return null }
  if (avatar.protocol !== 'https:' || avatar.hostname !== 'avatars.githubusercontent.com') return null
  return { id, login: item.login, avatarUrl: avatar.toString() }
}

const VERDICTS: Record<string, PullReviewVerdict> = {
  APPROVED: 'approved', CHANGES_REQUESTED: 'changes-requested', COMMENTED: 'commented', DISMISSED: 'dismissed'
}
const PLAIN: Record<string, 'closed' | 'reopened' | 'ready-for-review' | 'converted-to-draft'> = {
  ClosedEvent: 'closed', ReopenedEvent: 'reopened', ReadyForReviewEvent: 'ready-for-review', ConvertToDraftEvent: 'converted-to-draft'
}

/** One node, or null when its type is unknown, it is a pending review, or it does not decode. */
function item(node: Obj): PullTimelineItem | null {
  const type = node.__typename
  if (!text(node.id, 200) || !node.id) return null
  const id = node.id
  if (type === 'PullRequestCommit') {
    const commit = object(node.commit)
    const oid = sha(commit)
    if (!commit || !oid || !text(commit.messageHeadline, 1_000) || !date(commit.committedDate)) return null
    return { kind: 'commit', id, actor: user(object(commit.author)?.user), at: commit.committedDate, oid, headline: commit.messageHeadline }
  }
  if (type === 'IssueComment' || type === 'PullRequestReview') {
    const databaseId = node.databaseId
    const at = type === 'PullRequestReview' ? node.submittedAt : node.createdAt
    if (typeof databaseId !== 'number' || !Number.isSafeInteger(databaseId) || databaseId < 1 ||
        !text(node.body, 70_000) || !date(at) || !githubUrl(node.url)) return null
    const base = { id, actor: user(node.author), at, databaseId, body: node.body, url: node.url }
    if (type === 'IssueComment') return { kind: 'comment', ...base }
    const verdict = typeof node.state === 'string' ? VERDICTS[node.state] : undefined
    return verdict ? { kind: 'review', ...base, verdict } : null
  }
  if (!date(node.createdAt)) return null
  const event = { id, actor: user(node.actor), at: node.createdAt }
  if (typeof type === 'string' && PLAIN[type]) return { kind: PLAIN[type], ...event }
  switch (type) {
    case 'HeadRefForcePushedEvent':
      return { kind: 'force-push', ...event, before: sha(node.beforeCommit), after: sha(node.afterCommit) }
    case 'LabeledEvent':
    case 'UnlabeledEvent': {
      const label = object(node.label)
      if (!label || !text(label.name, 100) || !text(label.color, 6) || !/^[0-9a-fA-F]{6}$/.test(label.color)) return null
      return { kind: type === 'LabeledEvent' ? 'labeled' : 'unlabeled', ...event, label: { name: label.name, color: label.color.toLowerCase() } }
    }
    case 'ReviewRequestedEvent': {
      const reviewer = object(node.requestedReviewer)
      const name = reviewer?.login ?? reviewer?.name
      return { kind: 'review-requested', ...event, reviewer: text(name, 128) && name ? name : null }
    }
    case 'AssignedEvent':
    case 'UnassignedEvent':
      return { kind: type === 'AssignedEvent' ? 'assigned' : 'unassigned', ...event, assignee: user(node.assignee) }
    case 'MergedEvent':
      if (!text(node.mergeRefName, 255)) return null
      return { kind: 'merged', ...event, oid: sha(node.commit), base: node.mergeRefName }
    case 'CrossReferencedEvent': {
      const source = object(node.source)
      const repository = object(source?.repository)?.nameWithOwner
      const number = source?.number
      if (!source || (source.__typename !== 'Issue' && source.__typename !== 'PullRequest') || typeof number !== 'number' ||
          !Number.isSafeInteger(number) || number < 1 || !text(source.title, 1_000) || !githubUrl(source.url) ||
          !text(repository, 200)) return null
      return {
        kind: 'cross-referenced', ...event,
        source: { pull: source.__typename === 'PullRequest', number, title: source.title, repository, url: source.url }
      }
    }
    default:
      return null
  }
}

/** Decodes one timeline page. Throws `GraphQLShapeError` for any error or a malformed envelope. */
export function parsePullTimelineResponse(body: unknown): PullTimelinePage {
  if (graphQLErrors(body).length) throw new GraphQLShapeError()
  const pull = object(object(object(object(body)?.data)?.repository)?.pullRequest)
  const timeline = object(pull?.timelineItems)
  const page = object(timeline?.pageInfo)
  if (!pull || !date(pull.createdAt) || !timeline || !Array.isArray(timeline.nodes) ||
      timeline.nodes.length > PULL_TIMELINE_PAGE || !page || typeof page.hasNextPage !== 'boolean') throw new GraphQLShapeError()
  const next = page.hasNextPage && isPullTimelineCursor(page.endCursor) ? page.endCursor : undefined
  if (page.hasNextPage && !next) throw new GraphQLShapeError()
  const items = timeline.nodes.flatMap((node) => {
    const value = object(node)
    const decoded = value ? item(value) : null
    return decoded ? [decoded] : []
  })
  return { items, openedAt: pull.createdAt, ...(next ? { next } : {}) }
}

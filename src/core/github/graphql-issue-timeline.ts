// The issues node's timeline: one GraphQL `timelineItems` page of an issue, with the item types an
// issue has (comments, labels, assignees, close and reopen, cross-references). The page has the pull
// timeline's shape, so the pull parser decodes it and drops what it does not know.
// Checked against cli/cli#8900 on 2026-11-03 (schema accepted every field below).
import type { PullTimelinePage } from '../../shared/github-pull-timeline'
import { ACTOR, EVENT, PULL_TIMELINE_PAGE, parsePullTimelineResponse } from './graphql-pull-timeline'
import { GraphQLShapeError, graphQLErrors } from './graphql-pulls'

export const ISSUE_TIMELINE_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$name){
    issue(number:$number){
      createdAt
      timelineItems(first:${PULL_TIMELINE_PAGE}, after:$after, itemTypes:[ISSUE_COMMENT,LABELED_EVENT,UNLABELED_EVENT,ASSIGNED_EVENT,UNASSIGNED_EVENT,CLOSED_EVENT,REOPENED_EVENT,CROSS_REFERENCED_EVENT]){
        pageInfo{ hasNextPage endCursor }
        nodes{
          __typename
          ... on IssueComment{ id databaseId body createdAt url author{ ${ACTOR} } }
          ... on LabeledEvent{ ${EVENT} label{ name color } }
          ... on UnlabeledEvent{ ${EVENT} label{ name color } }
          ... on AssignedEvent{ ${EVENT} assignee{ ... on User{ login avatarUrl databaseId } ... on Bot{ login avatarUrl databaseId } } }
          ... on UnassignedEvent{ ${EVENT} assignee{ ... on User{ login avatarUrl databaseId } ... on Bot{ login avatarUrl databaseId } } }
          ... on ClosedEvent{ ${EVENT} }
          ... on ReopenedEvent{ ${EVENT} }
          ... on CrossReferencedEvent{ ${EVENT} source{ __typename ... on Issue{ number title url repository{ nameWithOwner } } ... on PullRequest{ number title url repository{ nameWithOwner } } } }
        }
      }
    }
  }
}`

/** Decodes one issue timeline page. `openedAt` = when the issue was opened. Throws `GraphQLShapeError`. */
export function parseIssueTimelineResponse(body: unknown): PullTimelinePage {
  if (graphQLErrors(body).length) throw new GraphQLShapeError()
  const data = (body as { data?: { repository?: { issue?: unknown } | null } | null } | null)?.data
  // ponytail: rewrap as a pull page so one parser checks the envelope and every item.
  return parsePullTimelineResponse({ data: { repository: { pullRequest: data?.repository?.issue ?? null } } })
}

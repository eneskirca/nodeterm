// MOVED to `@shared/pull-card-links` so core's read-only `prs` / `issues` control verbs join pull
// requests to session cards by the SAME rule the board draws. Re-exported so renderer call sites are
// unchanged.
export {
  pullsForCard,
  pullsClosingIssue,
  pullStatusByNumber,
  type CardPullLinks
} from '@shared/pull-card-links'

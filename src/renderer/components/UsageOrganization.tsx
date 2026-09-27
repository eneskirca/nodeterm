import type { ClaudeUsageOrganization } from '@shared/types'

/**
 * Optional identity detail: old snapshots and unreadable metadata keep the email-only view.
 * A personal organization is named after the account's email ("<email>'s Organization"), so
 * beside that email the line only repeats it — it stays (it is the real name), just quieter.
 */
export function UsageOrganization({
  organization,
  email
}: {
  organization?: ClaudeUsageOrganization
  email?: string | null
}) {
  if (!organization?.name) return null
  const detail = [
    organization.type && `Type: ${organization.type}`,
    organization.rateLimitTier && `Rate limit tier: ${organization.rateLimitTier}`,
    organization.uuid && `Organization ID: ${organization.uuid}`
  ].filter(Boolean).join('\n')
  const derived = !!email && organization.name === `${email}'s Organization`
  return (
    <div
      className={`usage-account__organization${derived ? ' usage-account__organization--derived' : ''}`}
      title={detail || undefined}
    >
      Organization: {organization.name}
    </div>
  )
}

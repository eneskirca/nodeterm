import type { ClaudeUsageOrganization } from '@shared/types'

/** Optional identity detail: old snapshots and unreadable metadata keep the email-only view. */
export function UsageOrganization({ organization }: { organization?: ClaudeUsageOrganization }) {
  if (!organization?.name) return null
  const detail = [
    organization.type && `Type: ${organization.type}`,
    organization.rateLimitTier && `Rate limit tier: ${organization.rateLimitTier}`,
    organization.uuid && `Organization ID: ${organization.uuid}`
  ].filter(Boolean).join('\n')
  return (
    <div className="usage-account__organization" title={detail || undefined}>
      Organization: {organization.name}
    </div>
  )
}

import { useEffect, useState, type MouseEvent } from 'react'
import type { GitHubLink } from '@shared/github-issues'
import { githubLinkUrl } from '@shared/github-link'
import { useSession } from '../../session/session'
import { useProjects } from '../../state/projects'
import { useGitHubLinks } from '../../state/githubLinks'
import {
  linkChipLabel,
  linkKey,
  linkRepository,
  linkState,
  linkToBoardTitle,
  linkTooltip
} from '../../lib/githubLinks'
import {
  detachGitHubLink,
  openGitHubLinkDetails,
  openGitHubLinkPicker
} from '../../canvas/githubLinkActions'
import { ContextMenu, type MenuItem } from '../ContextMenu'

/** Beyond this many links the per-link rows move into one submenu each: a flat menu of twenty
 *  detach rows is not a menu. */
const FLAT_MENU_MAX = 3

interface Props {
  nodeId: string
  links: GitHubLink[]
  /** Where the chip is rendered — styling only; every variant carries the same actions. */
  variant: 'node' | 'card' | 'modal' | 'group'
}

/**
 * The `#12 +2` chip a linked node wears on the canvas and on its board card.
 *
 * It resolves each link's card itself (`ensureCard`), because the chip has no host subscription:
 * a canvas full of chips must not each hold one. Renders nothing when the node has no links or
 * the project has no repository — an unconfigured project shows no GitHub surface at all.
 */
export function GitHubLinkChip({ nodeId, links, variant }: Props) {
  const repository = useProjects((s) =>
    linkRepository(s.projects.find((p) => p.id === s.activeProjectId)?.kanban))
  // The body is a separate component so the session is only required by a chip that renders:
  // every node mounts one of these, and a link-less node must not depend on a session provider.
  if (!links.length || !repository) return null
  return <ChipBody nodeId={nodeId} links={links} variant={variant} repository={repository} />
}

function ChipBody({ nodeId, links, variant, repository }: Props & { repository: string }) {
  const { api } = useSession()
  const projectId = useProjects((s) => s.activeProjectId)
  const cards = useGitHubLinks((s) => s.cards[projectId])
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    for (const link of links) void useGitHubLinks.getState().ensureCard(api.githubIssues, projectId, link)
  }, [api, projectId, links])

  const cardFor = (link: GitHubLink) => cards?.[linkKey(link)]?.card
  const first = links[0]
  const open = (event: MouseEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({ x: event.clientX, y: event.clientY })
  }

  const linkRows = (link: GitHubLink): MenuItem[] => [
    { label: `Open #${link.number} details`, onClick: () => openGitHubLinkDetails(link) },
    {
      label: `Open #${link.number} on GitHub`,
      onClick: () => api.shell.openExternal(githubLinkUrl(repository, link))
    },
    {
      label: `Detach #${link.number}`,
      danger: true,
      onClick: () => detachGitHubLink(nodeId, link)
    }
  ]

  const items: MenuItem[] = [
    ...(links.length <= FLAT_MENU_MAX
      ? links.flatMap((link, index): MenuItem[] => [
          ...(index ? [{ type: 'separator' } as MenuItem] : []),
          { type: 'label', label: linkToBoardTitle(link, cardFor(link)) },
          ...linkRows(link)
        ])
      : links.map((link): MenuItem => ({
          type: 'submenu',
          label: linkToBoardTitle(link, cardFor(link)),
          children: linkRows(link)
        }))),
    { type: 'separator' },
    {
      label: 'Attach another…',
      onClick: () => menu && openGitHubLinkPicker(nodeId, menu)
    }
  ]

  return (
    <>
      <span
        className={`github-link-chip github-link-chip--${variant} nodrag`}
        title={linkTooltip(links, Object.fromEntries(
          links.map((link) => [linkKey(link), cardFor(link)])
        ))}
        onClick={open}
        onContextMenu={open}
      >
        <i className={`github-link-chip__dot github-link-chip__dot--${linkState(first, cardFor(first))}`} />
        {linkChipLabel(links)}
      </span>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={items}
          zIndex={variant === 'modal' ? 60 : undefined}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  )
}

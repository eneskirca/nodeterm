import type { SettingsSectionId } from './nav'

/** One small line glyph per settings section, used in the sidebar nav.
 *  16×16, currentColor stroke — color is driven by the parent (active = accent). */
const PATHS: Record<SettingsSectionId, React.JSX.Element> = {
  terminal: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M4.8 6.2 6.6 8l-1.8 1.8M8.4 10h2.8" />
    </>
  ),
  shell: <path d="M3 4.5 6 8l-3 3.5M8 11.5h5" />,
  // A screen with the notch bitten out of its top edge.
  notch: (
    <>
      <path d="M2 5V4.5A1.5 1.5 0 0 1 3.5 3h2v1.2a1 1 0 0 0 1 1h2.6a1 1 0 0 0 1-1V3h2.4A1.5 1.5 0 0 1 14 4.5V11a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11V5Z" />
      <path d="M5.5 9.2h1.2M9.3 9.2h1.2" />
    </>
  ),
  behavior: (
    <>
      <path d="M2.5 5.5h6M10.5 5.5h3M2.5 10.5h3M7.5 10.5h6" />
      <circle cx="9.3" cy="5.5" r="1.4" />
      <circle cx="6.3" cy="10.5" r="1.4" />
    </>
  ),
  appearance: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5a5.5 5.5 0 0 0 0 11z" fill="currentColor" stroke="none" />
    </>
  ),
  phone: (
    <>
      <rect x="4.5" y="2" width="7" height="12" rx="1.6" />
      <path d="M7 12h2" />
    </>
  ),
  speech: (
    <>
      <rect x="6" y="2.2" width="4" height="7" rx="2" />
      <path d="M4 8.2a4 4 0 0 0 8 0M8 12.2v1.6M6.2 13.8h3.6" />
    </>
  ),
  // A keycap — the obvious glyph for configurable keyboard shortcuts.
  shortcuts: (
    <>
      <rect x="2.2" y="4" width="11.6" height="8" rx="1.8" />
      <path d="M5.4 8h.01M8 8h.01M10.6 8h.01" />
    </>
  ),
  agents: (
    <path d="M8 2.3 9.4 5.9 13 7.3 9.4 8.7 8 12.3 6.6 8.7 3 7.3 6.6 5.9z" />
  ),
  usage: (
    <>
      <path d="M2.5 12.5a5.5 5.5 0 1 1 11 0" />
      <path d="M8 12.5 10.8 8" />
    </>
  ),
  accounts: (
    <>
      <circle cx="8" cy="5.5" r="2.6" />
      <path d="M3.4 13c0-2.5 2.1-4 4.6-4s4.6 1.5 4.6 4" />
    </>
  ),
  'custom-agents': (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" />
      <path d="M8 5.5v5M5.5 8h5" />
    </>
  ),
  notifications: (
    <>
      <path d="M4.8 7a3.2 3.2 0 0 1 6.4 0c0 3 1.1 3.9 1.1 3.9H3.7S4.8 10 4.8 7Z" />
      <path d="M6.7 12.8a1.4 1.4 0 0 0 2.6 0" />
    </>
  ),
  commit: (
    <>
      <circle cx="8" cy="8" r="2.4" />
      <path d="M2.6 8h3M10.4 8h3" />
    </>
  ),
  tmux: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="2" />
      <path d="M8 3v10" />
    </>
  ),
  'github-issues': (
    <>
      <path d="M8 2.2a5.8 5.8 0 0 0-1.8 11.3c.3.1.4-.1.4-.3v-1.1c-1.7.4-2.1-.7-2.1-.7-.3-.8-.8-1-1-1.1-.7-.4.1-.4.1-.4.8.1 1.2.8 1.2.8.7 1.2 1.8.8 2.2.6.1-.5.3-.8.5-1-1.4-.2-2.8-.7-2.8-3a2.4 2.4 0 0 1 .6-1.6 2.2 2.2 0 0 1 .1-1.6s.5-.2 1.7.6a5.7 5.7 0 0 1 3.1 0c1.2-.8 1.7-.6 1.7-.6a2.2 2.2 0 0 1 .1 1.6 2.4 2.4 0 0 1 .6 1.6c0 2.3-1.4 2.8-2.8 3 .2.2.4.6.4 1.2v1.7c0 .2.1.4.4.3A5.8 5.8 0 0 0 8 2.2Z" />
    </>
  ),
  license: (
    <>
      <circle cx="5.6" cy="5.6" r="2.6" />
      <path d="M7.4 7.4 13 13M10.8 10.8l1.4-1.4M9.4 9.4l1.2-1.2" />
    </>
  ),
  presence: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="2" />
      <circle cx="6" cy="6.6" r="1.5" />
      <path d="M3.8 11c.2-1.3 1.2-2 2.2-2s2 .7 2.2 2M9.6 6.5h2.4M9.6 9h2" />
    </>
  ),
  remote: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M2.5 8h11M8 2.5c1.9 1.7 1.9 9.3 0 11M8 2.5c-1.9 1.7-1.9 9.3 0 11" />
    </>
  ),
  'team-access': (
    <>
      <circle cx="6" cy="5.5" r="2.2" />
      <path d="M2.2 12.5c0-2.1 1.7-3.4 3.8-3.4s3.8 1.3 3.8 3.4" />
      <path d="M10.6 3.6a2.2 2.2 0 0 1 0 4.2M11.4 9.3c1.5.4 2.4 1.6 2.4 3.2" />
    </>
  ),
  ssh: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M4.6 6.2 6.4 8l-1.8 1.8M8 10h3" />
    </>
  ),
  updates: <path d="M8 2.6v7M5 6.6 8 9.6l3-3M3.6 12.6h8.8" />,
  privacy: <path d="M8 2.4 12.4 4.2V8c0 3-2 4.8-4.4 5.6C5.6 12.8 3.6 11 3.6 8V4.2Z" />
}

export function SectionIcon({ id }: { id: SettingsSectionId }): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[id]}
    </svg>
  )
}

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
  license: (
    <>
      <circle cx="5.6" cy="5.6" r="2.6" />
      <path d="M7.4 7.4 13 13M10.8 10.8l1.4-1.4M9.4 9.4l1.2-1.2" />
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

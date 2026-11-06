// The pull and issues nodes' drawn icons: one 16 px grid, one 1.5 px stroke, round caps (the
// f-boards mockups). Color comes from `currentColor`, so state color is the caller's class.

const PATHS = {
  pr: <><circle cx="4" cy="3.5" r="1.6" /><circle cx="4" cy="12.5" r="1.6" /><circle cx="12" cy="12.5" r="1.6" /><path d="M4 5.1v5.8M12 10.9V7a2.5 2.5 0 0 0-2.5-2.5H7M8.5 2.5 7 4.5l1.5 2" /></>,
  draft: <><circle cx="4" cy="3.5" r="1.6" /><circle cx="4" cy="12.5" r="1.6" /><path d="M4 5.1v5.8M12 4v1M12 7.5v1M12 11v1.5" /></>,
  merged: <><circle cx="4" cy="3.5" r="1.6" /><circle cx="4" cy="12.5" r="1.6" /><circle cx="12" cy="8" r="1.6" /><path d="M4 5.1v5.8M5.4 4.4c1.5 2.3 3.2 3.4 5 3.6" /></>,
  closed: <><circle cx="4" cy="3.5" r="1.6" /><circle cx="4" cy="12.5" r="1.6" /><path d="M4 5.1v5.8M10 3l4 4M14 3l-4 4M12 9.5v1.5" /></>,
  check: <path d="m3.5 8.5 3 3 6-7" />,
  x: <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />,
  thread: <path d="M2.5 3.5h11v7H8l-3 2.5v-2.5H2.5z" />,
  agent: <path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l2 2M10 10l2 2M12 4l-2 2M6 10l-2 2" />,
  commit: <><circle cx="8" cy="8" r="2.5" /><path d="M1.5 8h4M10.5 8h4" /></>,
  tag: <><path d="M2.5 2.5h5l6 6-5 5-6-6z" /><circle cx="5.5" cy="5.5" r=".8" /></>,
  chevron: <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />,
  'chevron-right': <path d="m6.5 4.5 3.5 3.5-3.5 3.5" />,
  more: <><circle cx="3.5" cy="8" r=".9" /><circle cx="8" cy="8" r=".9" /><circle cx="12.5" cy="8" r=".9" /></>,
  copy: <><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 3.5v-1h-8v8h1" /></>,
  refresh: <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />,
  external: <path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v4h-9v-9h4" />,
  search: <><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></>,
  note: <path d="M3.5 2.5h9v11h-9zM6 6h4M6 8.5h4" />,
  eye: <><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></>,
  trash: <path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.7 9h5.6l.7-9" />,
  link: <path d="M7 9a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.7.7M9 7a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.7-.7" />,
  terminal: <><rect x="1.5" y="2.5" width="13" height="11" rx="2" /><path d="m4.5 6 2 2-2 2M8.5 10.5h3" /></>,
  conflict: <><path d="M8 2.5 14 13H2z" /><path d="M8 6.5v3M8 11.2v.1" /></>,
  issue: <><circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="1" /></>,
  code: <path d="m5.5 4.5-3.5 3.5 3.5 3.5M10.5 4.5 14 8l-3.5 3.5" />
} satisfies Record<string, React.JSX.Element>

/** Names that draw another icon's path. */
const ALIAS = { merge: 'merged', sync: 'refresh' } as const satisfies Record<string, keyof typeof PATHS>

export type IconName = keyof typeof PATHS | keyof typeof ALIAS

/** One drawn icon. Decorative (aria-hidden) unless `label` names it. */
export function Icon({ name, size = 16, className, label }: {
  name: IconName; size?: number; className?: string; label?: string
}): React.JSX.Element {
  return (
    <svg className={className ? `pr-icon ${className}` : 'pr-icon'} width={size} height={size} viewBox="0 0 16 16"
      fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"
      role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {PATHS[name in ALIAS ? ALIAS[name as keyof typeof ALIAS] : name as keyof typeof PATHS]}
    </svg>
  )
}

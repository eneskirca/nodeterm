/** Small line icons (stroke = currentColor), shared across menus and the palette. */
const S = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
}

export const IconTerminal = () => (
  <svg {...S}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 9l3 3-3 3M13 15h4" />
  </svg>
)

export const IconExplorer = () => (
  <svg {...S}>
    {/* Folder — the Explorer drawer (file tree of the project cwd). */}
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
)

export const IconGear = () => (
  <svg {...S}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
  </svg>
)

export const IconNote = () => (
  <svg {...S}>
    <path d="M4 4h16v11l-5 5H4z" />
    <path d="M20 15h-5v5" />
  </svg>
)

export const IconDino = () => (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor" stroke="none">
    {/* Blocky right-facing T-Rex silhouette (tail, body, head+snout, arm, legs). */}
    <rect x="3" y="11" width="6" height="3" />
    <rect x="8" y="9" width="11" height="7" />
    <rect x="14" y="3" width="7" height="7" />
    <rect x="21" y="7" width="2" height="2" />
    <rect x="18" y="12" width="2" height="3" />
    <rect x="9" y="16" width="2" height="5" />
    <rect x="14" y="16" width="2" height="5" />
  </svg>
)

export const IconChat = () => (
  <svg {...S}>
    <path d="M4 5h16v11H9l-4 3v-3H4z" />
    <path d="M8 10h8M8 13h5" />
  </svg>
)

export const IconPlus = () => (
  <svg {...S}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)

export const IconSelectAll = () => (
  <svg {...S}>
    <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
  </svg>
)

export const IconFit = () => (
  <svg {...S}>
    <path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" />
  </svg>
)

export const IconColor = () => (
  <svg {...S}>
    <circle cx="12" cy="12" r="8" />
    <circle cx="9" cy="10" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="15" cy="10" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="12" cy="15" r="1.2" fill="currentColor" stroke="none" />
  </svg>
)

export const IconGrid = () => (
  <svg {...S}>
    <path d="M4 9h16M4 15h16M9 4v16M15 4v16" />
  </svg>
)

export const IconCollapse = () => (
  <svg {...S}>
    <path d="M8 4v4H4M16 4v4h4M8 20v-4H4M16 20v-4h4" />
  </svg>
)

export const IconGroup = () => (
  <svg {...S}>
    <rect x="3" y="3" width="18" height="18" rx="2" strokeDasharray="3 3" />
    <rect x="7" y="7" width="4" height="4" rx="1" />
    <rect x="13" y="13" width="4" height="4" rx="1" />
  </svg>
)

export const IconUngroup = () => (
  <svg {...S}>
    <rect x="4" y="4" width="9" height="9" rx="1.5" />
    <rect x="12" y="12" width="8" height="8" rx="1.5" strokeDasharray="3 3" />
  </svg>
)

export const IconTrash = () => (
  <svg {...S}>
    <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13h10l1-13" />
  </svg>
)

export const IconProject = () => (
  <svg {...S}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
)

export const IconRemote = () => (
  <svg {...S}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18" />
  </svg>
)

export const IconSwitch = () => (
  <svg {...S}>
    <path d="M7 7h11l-3-3M17 17H6l3 3" />
  </svg>
)

export const IconJump = () => (
  <svg {...S}>
    <circle cx="11" cy="11" r="7" />
    <path d="M11 8v6M8 11h6" />
  </svg>
)

export const IconSettings = () => (
  <svg {...S}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
  </svg>
)

export const IconReload = () => (
  <svg {...S}>
    <path d="M20 12a8 8 0 1 1-2.34-5.66" />
    <path d="M20 4v4h-4" />
  </svg>
)

/** Power symbol — restarting a PROCESS (the agent CLI), as opposed to IconReload's
 *  circular arrow, which reloads a VIEW. The two restart actions must not share a glyph. */
export const IconPower = () => (
  <svg {...S}>
    <path d="M12 3v9" />
    <path d="M7.5 6.3a7.5 7.5 0 1 0 9 0" />
  </svg>
)

export const IconBranch = () => (
  <svg {...S}>
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="6" cy="18" r="2.5" />
    <circle cx="18" cy="8" r="2.5" />
    <path d="M6 8.5v7M6 13a6 6 0 0 0 6-6h3.5" />
  </svg>
)

export const IconEye = () => (
  <svg {...S}>
    <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)

export const IconEyeOff = () => (
  <svg {...S}>
    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a13.16 13.16 0 0 1-1.67 2.68M6.61 6.61A13.53 13.53 0 0 0 1 11s4 7 11 7a9.26 9.26 0 0 0 5.39-1.61M14.12 14.12a3 3 0 1 1-4.24-4.24" />
    <path d="M1 1l22 22" />
  </svg>
)

export const IconEditor = () => (
  <svg {...S}>
    <path d="M9 8l-4 4 4 4M15 8l4 4-4 4" />
  </svg>
)

export const IconMarkdown = () => (
  <svg {...S}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M6 15V9l3 3 3-3v6M16.5 9v5M14.5 12l2 2 2-2" />
  </svg>
)

export const IconDuplicate = () => (
  <svg {...S}>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </svg>
)

export const IconSave = () => (
  <svg {...S}>
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
    <path d="M17 21v-8H7v8M7 3v5h8" />
  </svg>
)

export const IconSearch = () => (
  <svg {...S}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.35-4.35" />
  </svg>
)

/** Memory/resource glyph: a chip with pins. Used by the system-resource pill, whose collapsed
 *  state is icon-only — the numbers appear on hover. */
export const IconResource = () => (
  <svg {...S}>
    <rect x="7" y="7" width="10" height="10" rx="1.5" />
    <path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4" />
  </svg>
)

export const IconWeb = () => (
  <svg {...S}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
  </svg>
)

export const IconExternal = () => (
  <svg {...S}>
    <path d="M9 5h10v10M19 5 8 16M5 9v10h10" />
  </svg>
)

export const IconAgent = () => (
  <svg {...S}>
    <path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z" />
    <path d="M18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z" />
  </svg>
)

export const IconMic = () => (
  <svg {...S}>
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v4M8 22h8" />
  </svg>
)

export const IconSessions = () => (
  <svg {...S}>
    <rect x="3" y="4" width="18" height="5" rx="1.5" />
    <rect x="3" y="11" width="18" height="5" rx="1.5" />
    <line x1="6" y1="6.5" x2="6" y2="6.5" />
    <line x1="6" y1="13.5" x2="6" y2="13.5" />
  </svg>
)

export const IconPin = () => (
  <svg {...S}>
    <path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6z" />
    <line x1="12" y1="14" x2="12" y2="21" />
  </svg>
)

export const IconCircleCheck = () => (
  <svg {...S}>
    <circle cx="12" cy="12" r="10" />
    <path d="M9 12.5l2.2 2.2L15.5 10" />
  </svg>
)

/* Filled padlocks (like the bell below): they live in the React Flow controls, whose
   default icons are filled glyphs capped at 12px — a stroked lock collapses there. */
export const IconLock = () => (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <path
      fillRule="evenodd"
      d="M6 10V7a6 6 0 0 1 12 0v3h.5A2.5 2.5 0 0 1 21 12.5v7A2.5 2.5 0 0 1 18.5 22h-13A2.5 2.5 0 0 1 3 19.5v-7A2.5 2.5 0 0 1 5.5 10H6zm2.4 0h7.2V7a3.6 3.6 0 0 0-7.2 0v3zM12 14.2a1.8 1.8 0 0 0-.9 3.36V19a.9.9 0 0 0 1.8 0v-1.44a1.8 1.8 0 0 0-.9-3.36z"
    />
  </svg>
)

export const IconUnlock = () => (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <path
      fillRule="evenodd"
      d="M6 10V7a6 6 0 0 1 11.7-1.9l-2.3.8A3.6 3.6 0 0 0 8.4 7v3h10.1A2.5 2.5 0 0 1 21 12.5v7A2.5 2.5 0 0 1 18.5 22h-13A2.5 2.5 0 0 1 3 19.5v-7A2.5 2.5 0 0 1 5.5 10H6zM12 14.2a1.8 1.8 0 0 0-.9 3.36V19a.9.9 0 0 0 1.8 0v-1.44a1.8 1.8 0 0 0-.9-3.36z"
    />
  </svg>
)

/* Filled bell (attention/needs-you) — filled on purpose, so it reads at 12px where a
   stroked bell would collapse into noise. */
export const IconBellFilled = () => (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2a6.5 6.5 0 0 0-6.5 6.5v3.6l-1.6 3.2a1 1 0 0 0 .9 1.45h14.4a1 1 0 0 0 .9-1.45l-1.6-3.2V8.5A6.5 6.5 0 0 0 12 2z" />
    <path d="M9.7 18.7a2.4 2.4 0 0 0 4.6 0z" />
  </svg>
)

/* Smartphone outline — the quick phone-pairing button in the top-right cluster. */
export const IconPhone = () => (
  <svg {...S}>
    <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
    <path d="M10.5 5h3" />
    <circle cx="12" cy="18" r="0.9" fill="currentColor" stroke="none" />
  </svg>
)

export const IconKanban = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
    <rect x="1.5" y="2.5" width="3.6" height="11" rx="1" />
    <rect x="6.2" y="2.5" width="3.6" height="7.5" rx="1" />
    <rect x="10.9" y="2.5" width="3.6" height="5" rx="1" />
  </svg>
)

export const IconCanvasView = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
    <rect x="1.5" y="1.5" width="6" height="5" rx="1" />
    <rect x="9" y="4" width="5.5" height="4.5" rx="1" />
    <rect x="3.5" y="9.5" width="5.5" height="5" rx="1" />
  </svg>
)

/** Fullscreen expand — outward diagonal arrows: the maximize toggle's "will fill the viewport"
 *  state (issue #399). Pairs with IconRestoreSize; the two states must not share a glyph. */
export const IconMaximize = () => (
  <svg {...S}>
    <path d="M14 4h6v6" />
    <path d="M20 4l-6 6" />
    <path d="M10 20H4v-6" />
    <path d="M4 20l6-6" />
  </svg>
)

/** Fullscreen restore — the same arrows pointing back inward: the maximize toggle's second click. */
export const IconRestoreSize = () => (
  <svg {...S}>
    <path d="M20 10h-6V4" />
    <path d="M20 4l-6 6" />
    <path d="M4 14h6v6" />
    <path d="M4 20l6-6" />
  </svg>
)

/** Maximize/focus — matches the group ⤢ "drill into" glyph (ticket 10 F11 focus). */
export const IconFocus = () => (
  <svg {...S}>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </svg>
)

/** Chain link — the off-canvas link authoring surface (ticket 06): picker/inspector entry points. */
export const IconLink = () => (
  <svg {...S}>
    <path d="M9 12a3.5 3.5 0 0 0 5 0l2.5-2.5a3.5 3.5 0 0 0-5-5L10 6" />
    <path d="M15 12a3.5 3.5 0 0 0-5 0L7.5 14.5a3.5 3.5 0 0 0 5 5L14 18" />
  </svg>
)

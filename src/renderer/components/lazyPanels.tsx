import {
  Suspense,
  lazy,
  type ComponentType,
  type LazyExoticComponent,
  type ReactElement
} from 'react'

// Overlay surfaces, code-split out of the startup chunk.
//
// Every one of these is rendered behind a flag (`{settingsOpen && <SettingsPage …>}`) and most of
// them are never opened in a given session — yet importing them statically put all of them, and
// everything they pull in (the whole Settings tree, the kanban board, the speech capture pipeline,
// `qrcode`), into the bundle the app parses before it can paint a single terminal. The canvas, its
// nodes and the tab bar are the startup path; a panel is not.
//
// Same trick as `nodes/lazyMonacoNodes.tsx`, one layer up: these wrappers keep the exact prop types
// of the components they stand in for, so Canvas's JSX does not change at all — only where the
// names are imported from.
//
// The fallback is `null` deliberately: these are modals and drawers opened by a click, they animate
// in anyway, and a spinner that appears for one frame on a local chunk load is worse than nothing.

/** Wrap a lazily-loaded component so callers can use it exactly like the original. */
function withSuspense<P extends object>(
  Inner: LazyExoticComponent<ComponentType<P>>
): (props: P) => ReactElement {
  // Spreading a still-generic `P` into JSX is what TypeScript will not check (it cannot know P has
  // no `ref`/`key` conflict until it is instantiated), so the cast is confined to this one line.
  // The RETURNED signature is exact — every call site is fully type-checked against the real
  // component's props.
  const Component = Inner as unknown as ComponentType<Record<string, unknown>>
  return function Lazy(props: P) {
    return (
      <Suspense fallback={null}>
        <Component {...(props as Record<string, unknown>)} />
      </Suspense>
    )
  }
}

export const SettingsPage = withSuspense(
  lazy(() => import('./settings/SettingsPage').then((m) => ({ default: m.SettingsPage })))
)
export const SourceControlPanel = withSuspense(
  lazy(() => import('./SourceControlPanel').then((m) => ({ default: m.SourceControlPanel })))
)
export const ExplorerPanel = withSuspense(
  lazy(() => import('./ExplorerPanel').then((m) => ({ default: m.ExplorerPanel })))
)
export const ShortcutsPanel = withSuspense(
  lazy(() => import('./ShortcutsPanel').then((m) => ({ default: m.ShortcutsPanel })))
)
export const OnboardingFlow = withSuspense(
  lazy(() => import('./onboarding/OnboardingFlow').then((m) => ({ default: m.OnboardingFlow })))
)
export const DictationOverlay = withSuspense(
  lazy(() => import('./DictationOverlay').then((m) => ({ default: m.DictationOverlay })))
)
export const BugReportDialog = withSuspense(
  lazy(() => import('./BugReportDialog').then((m) => ({ default: m.BugReportDialog })))
)
export const MobileLaunchCard = withSuspense(
  lazy(() => import('./MobileLaunchCard').then((m) => ({ default: m.MobileLaunchCard })))
)
// Pulls `qrcode` (the live pairing QR) — a whole encoder in the startup chunk for a popover most
// launches never open.
export const PhonePairPopover = withSuspense(
  lazy(() => import('./PhonePairPopover').then((m) => ({ default: m.PhonePairPopover })))
)
export const LogPanel = withSuspense(
  lazy(() => import('./LogPanel').then((m) => ({ default: m.LogPanel })))
)
export const KanbanView = withSuspense(
  lazy(() => import('./kanban/KanbanView').then((m) => ({ default: m.KanbanView })))
)

import { useEffect, useRef, useState } from 'react'
import { Github, Image as ImageIcon, RotateCcw, Shapes, Smile } from 'lucide-react'
import {
  LUCIDE_ICON_IDS,
  sanitizeProjectIcon,
  type ProjectIcon
} from '@shared/project-icon'
import { cn } from '@renderer/ui/cn'
import { ProjectGlyph } from '../ProjectGlyph'
import EmojiPickerLazy from './EmojiPickerLazy'

/**
 * The project-icon picker: a live preview + Reset over four tabs (Avatar — a disabled stub Task 5
 * fills in — / Emoji / Lucide / Upload) plus the project's colour swatches. Every choice is run
 * through `sanitizeProjectIcon` before it leaves — the same boundary the stored value crosses on
 * load — so the picker can only ever emit a value the rest of the app will accept, and Reset emits
 * `undefined` (back to the colour monogram).
 *
 * Visually this mirrors Orca's RepositoryIconPicker: a bordered glyph box beside a two-line
 * label (name of the source + a Reset), rounded-square colour swatches, and underline (line) tabs
 * that each carry a small lucide glyph. The markup is nodeterm's own design vocabulary (CSS-var
 * tokens, `cn`), not shadcn primitives.
 *
 * The component is presentational: it owns only which tab is open and the upload error. Persistence
 * (setProjectIcon / setProjectColor + the workspace-dirty commit) lives in the caller via `onIcon`
 * / `onColor`, exactly like the identity rows around it.
 */
export interface ProjectIconPickerProps {
  projectId: string
  name: string
  icon?: ProjectIcon
  color?: string
  colors: readonly string[]
  /** App's resolved appearance — forced onto the emoji picker rather than its own auto. */
  dark: boolean
  /**
   * Whether this project's section is the one the user is actively viewing. The GitHub-avatar probe
   * is gated on this: a settings SEARCH mounts every matching project's picker (`sectionVisible`),
   * but only ONE is active — probing on bare mount would fire an uncached live API call per project.
   * Defaults to true so a standalone picker (no search shell) still probes on open.
   */
  active?: boolean
  onIcon: (icon: ProjectIcon | undefined) => void
  onColor: (color: string) => void
}

type Tab = 'avatar' | 'emoji' | 'lucide' | 'upload'

/** Human label for whatever the project currently wears — the header subtitle, à la Orca. */
function currentIconLabel(icon: ProjectIcon | undefined): string {
  if (!icon) return 'Default (colour monogram)'
  if (icon.type === 'emoji') return `${icon.emoji} emoji`
  if (icon.type === 'lucide') {
    const pretty = icon.name.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    return `${pretty} glyph`
  }
  if (icon.source === 'github') return 'GitHub avatar'
  if (icon.source === 'favicon') return 'Website icon'
  return 'Uploaded image'
}

export function ProjectIconPicker({
  projectId,
  name,
  icon,
  color,
  colors,
  dark,
  active = true,
  onIcon,
  onColor
}: ProjectIconPickerProps): React.JSX.Element {
  // Default to a functional, non-lazy tab: never Emoji (that would pull the ~500 KB chunk the
  // moment the picker mounts, defeating the whole lazy split).
  const [tab, setTab] = useState<Tab>('lucide')
  const [uploadError, setUploadError] = useState<string | undefined>(undefined)
  // Whether this project resolves a GitHub avatar (origin + auth) — the Avatar tab shows only then.
  const [avatarAvailable, setAvatarAvailable] = useState(false)
  const [avatarError, setAvatarError] = useState<string | undefined>(undefined)

  // A choice is sanitized before it leaves — and if sanitize REJECTS it (undefined), we BAIL rather
  // than emit undefined: an emit would clear+persist the icon, the opposite of a picker action.
  // Reset stays the only explicit clear. (A sanitized picker value is always defined today, so this
  // is a guard against a latent destructive edge, not a reachable path.)
  const commit = (raw: ProjectIcon): void => {
    const sanitized = sanitizeProjectIcon(raw)
    if (sanitized) onIcon(sanitized)
  }

  // Latest icon/onIcon read from the open-time probe without making them effect deps (which would
  // re-fire the probe on every icon edit).
  const iconRef = useRef(icon)
  iconRef.current = icon
  const onIconRef = useRef(onIcon)
  onIconRef.current = onIcon

  const fetchAvatar = async (): Promise<{ dataUrl: string } | null> => {
    try {
      return (await window.nodeTerminal?.githubIssues?.projectAvatar(projectId)) ?? null
    } catch {
      return null
    }
  }

  // Lazy refresh, once per open (per project): probe the GitHub avatar. A non-null result means the
  // origin resolves → reveal the Avatar tab; if the stored icon is a github avatar whose bytes have
  // drifted, quietly re-commit the fresh src. ANTI-CLOBBER: a null/failed resolve touches nothing —
  // it must never blank an already-set github icon, and a no-origin project simply keeps the tab
  // hidden. Gated on `active`: during a settings SEARCH every matching project's picker mounts, but
  // only the ACTIVE section is the real "open" — probing on bare mount would fire one uncached live
  // API call (credential resolve + repo detect + api.github.com + avatar fetch) PER project. So the
  // probe fires when the section becomes active, not on mount — never on a timer or every render.
  useEffect(() => {
    if (!active) return
    let cancelled = false
    void (async () => {
      const res = await fetchAvatar()
      if (cancelled || !res) return
      setAvatarAvailable(true)
      const cur = iconRef.current
      if (cur?.type === 'image' && cur.source === 'github' && cur.src !== res.dataUrl) {
        // Same no-op guard as `commit`: only re-commit if the fresh src survives sanitize; a reject
        // must NOT blank the already-set github icon (that would be the opposite of anti-clobber).
        const sanitized = sanitizeProjectIcon({ type: 'image', src: res.dataUrl, source: 'github' })
        if (sanitized) onIconRef.current(sanitized)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, active])

  const onUseGithubAvatar = async (): Promise<void> => {
    setAvatarError(undefined)
    const res = await fetchAvatar()
    if (!res) {
      // Anti-clobber: leave the stored icon untouched on a failed resolve.
      setAvatarError('Could not fetch the GitHub avatar right now. Try again in a moment.')
      return
    }
    setAvatarAvailable(true)
    commit({ type: 'image', src: res.dataUrl, source: 'github' })
  }

  const hasGithubIcon = icon?.type === 'image' && icon.source === 'github'
  // Show the Avatar tab when the origin resolves, or when the project already wears a github avatar
  // (so a transient resolve failure never strands the user without the tab).
  const showAvatar = avatarAvailable || hasGithubIcon

  const TABS: { id: Tab; label: string; icon: typeof Github; disabled?: boolean }[] = [
    { id: 'avatar', label: 'Avatar', icon: Github, disabled: !showAvatar },
    { id: 'emoji', label: 'Emoji', icon: Smile },
    { id: 'lucide', label: 'Lucide', icon: Shapes },
    { id: 'upload', label: 'Upload', icon: ImageIcon }
  ]

  const onUpload = async (): Promise<void> => {
    setUploadError(undefined)
    const res = await window.nodeTerminal.shell.pickProjectIcon()
    if (!res) return // cancelled
    if ('error' in res) {
      setUploadError(res.error)
      return
    }
    commit({ type: 'image', src: res.dataUrl, source: 'upload' })
  }

  return (
    <div className="flex w-full flex-col gap-4" data-project-icon-picker={projectId}>
      {/* Header: glyph box + source label + Reset (Orca's identity row). */}
      <div className="flex items-center gap-3">
        <span
          className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-white/12 bg-white/5"
          aria-label="Current icon"
        >
          <ProjectGlyph icon={icon} color={color} name={name} size={26} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-text">Icon</div>
          <div className="mt-0.5 truncate text-[12px] text-muted" title={currentIconLabel(icon)}>
            {currentIconLabel(icon)}
          </div>
        </div>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-lg border border-white/15 px-2.5 py-1 text-[13px] text-muted transition-colors hover:text-text disabled:opacity-40"
          onClick={() => {
            setUploadError(undefined)
            onIcon(undefined)
          }}
          disabled={!icon}
          aria-label="Remove icon"
        >
          <RotateCcw className="size-3.5" />
          Reset
        </button>
      </div>

      {/* Colour swatches — the accent for this project's tab and monogram. Rounded squares (Orca). */}
      <div className="flex flex-col gap-1.5">
        <div className="text-[13px] font-semibold text-text">Color</div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Color">
          {colors.map((c) => (
            <button
              key={c}
              type="button"
              data-project-color={c}
              aria-label={`Color ${c}`}
              aria-pressed={color === c}
              style={{ background: c }}
              className={cn(
                'size-7 rounded-[6px] border-0 outline-none transition-transform',
                color === c
                  ? 'ring-2 ring-white/85 ring-offset-2 ring-offset-transparent'
                  : 'hover:scale-110'
              )}
              onClick={() => onColor(c)}
            />
          ))}
        </div>
      </div>

      {/* Tabs — underline (line) style with a per-source glyph. */}
      <div className="flex flex-col gap-3">
        <div
          className="flex items-center gap-1 border-b border-white/10"
          role="tablist"
          aria-label="Icon source"
        >
          {TABS.map((t) => {
            const Icon = t.icon
            const selected = tab === t.id
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={selected}
                disabled={t.disabled}
                className={cn(
                  'flex items-center gap-1.5 border-b-2 px-2.5 pb-1.5 text-[13px] transition-colors disabled:opacity-40',
                  selected
                    ? 'border-[color:var(--accent)] text-text'
                    : 'border-transparent text-muted hover:text-text'
                )}
                onClick={() => t.disabled || setTab(t.id)}
              >
                <Icon className="size-3.5" />
                {t.label}
              </button>
            )
          })}
        </div>

        {/* Panel */}
        <div role="tabpanel">
          {tab === 'avatar' ? (
            <div className="flex flex-col gap-2">
              <button
                type="button"
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-transparent bg-[color:var(--accent)] px-3 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
                onClick={() => void onUseGithubAvatar()}
              >
                <Github className="size-4" />
                Use GitHub avatar
              </button>
              <p className="text-[12px] leading-relaxed text-muted">
                Uses the avatar of the GitHub owner this project&apos;s remote points to, shared with
                the repo like the name and colour. It refreshes each time you open this panel.
              </p>
              {avatarError ? (
                <p role="alert" className="text-[12px] text-[color:var(--warn)]">
                  {avatarError}
                </p>
              ) : null}
            </div>
          ) : null}

          {tab === 'emoji' ? (
            <EmojiPickerLazy dark={dark} onEmoji={(emoji) => commit({ type: 'emoji', emoji })} />
          ) : null}

          {tab === 'lucide' ? (
            <div
              className="grid gap-1.5"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(2.25rem, 1fr))' }}
            >
              {LUCIDE_ICON_IDS.map((n) => {
                const selected = icon?.type === 'lucide' && icon.name === n
                return (
                  <button
                    key={n}
                    type="button"
                    data-lucide-id={n}
                    aria-label={n}
                    aria-pressed={selected}
                    title={n}
                    className={cn(
                      'flex size-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-white/10 hover:text-text',
                      selected && 'bg-white/15 text-text ring-1 ring-[color:var(--accent)]'
                    )}
                    onClick={() => commit({ type: 'lucide', name: n })}
                  >
                    <span className="flex size-5 items-center justify-center">
                      <ProjectGlyph icon={{ type: 'lucide', name: n }} color={color} name={name} size={20} />
                    </span>
                  </button>
                )
              })}
            </div>
          ) : null}

          {tab === 'upload' ? (
            <div className="flex flex-col gap-2">
              <button
                type="button"
                className="flex w-fit items-center gap-2 rounded-lg border border-white/15 px-3 py-1.5 text-[13px] text-text transition-colors hover:bg-white/10"
                onClick={() => void onUpload()}
              >
                <ImageIcon className="size-4" />
                Choose image…
              </button>
              <p className="text-[12px] leading-relaxed text-muted">
                The image is resized and re-encoded as a small PNG, then shared with the repo like the
                name and colour.
              </p>
              {uploadError ? (
                <p role="alert" className="text-[12px] text-[color:var(--warn)]">
                  {uploadError}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

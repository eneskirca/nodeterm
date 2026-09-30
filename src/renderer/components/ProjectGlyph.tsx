import type { ProjectIcon } from '@shared/project-icon'
import {
  Folder,
  FolderGit,
  Code,
  Terminal,
  Rocket,
  Box,
  Package,
  Database,
  Server,
  Cloud,
  Globe,
  Star,
  Heart,
  Flag,
  Bookmark,
  Zap,
  Flame,
  Cpu,
  Layers,
  LayoutGrid,
  Hash,
  Braces,
  Bug,
  Wrench,
  Hammer,
  Beaker,
  Palette,
  Paintbrush,
  Camera,
  Image as ImageIcon,
  Music,
  Video,
  Book,
  FileText,
  Shield,
  Key,
  Lock,
  Users,
  Bot,
  Sparkles,
  type LucideIcon
} from 'lucide-react'

/**
 * The curated lucide map (Task 4's swap-in for the former placeholder). One named import per icon
 * so the bundler tree-shakes the rest of lucide's ~1k glyphs out; keyed by the same kebab ids as
 * `LUCIDE_ICON_IDS` (@shared/project-icon), which is the closed allowlist `sanitizeProjectIcon`
 * enforces AND the picker grid. An `icon.name` that isn't a key here degrades to the fallback
 * (belt-and-braces — a sanitized icon's name is always a key). Also what `NodeIconView` draws a
 * node glyph from (`NODE_GLYPHS` is a subset of these ids) — one lucide table, not two.
 */
export const LUCIDE_ICONS: Record<string, LucideIcon> = {
  folder: Folder,
  'folder-git': FolderGit,
  code: Code,
  terminal: Terminal,
  rocket: Rocket,
  box: Box,
  package: Package,
  database: Database,
  server: Server,
  cloud: Cloud,
  globe: Globe,
  star: Star,
  heart: Heart,
  flag: Flag,
  bookmark: Bookmark,
  zap: Zap,
  flame: Flame,
  cpu: Cpu,
  layers: Layers,
  'layout-grid': LayoutGrid,
  hash: Hash,
  braces: Braces,
  bug: Bug,
  wrench: Wrench,
  hammer: Hammer,
  beaker: Beaker,
  palette: Palette,
  paintbrush: Paintbrush,
  camera: Camera,
  image: ImageIcon,
  music: Music,
  video: Video,
  book: Book,
  'file-text': FileText,
  shield: Shield,
  key: Key,
  lock: Lock,
  users: Users,
  bot: Bot,
  sparkles: Sparkles
}

/**
 * The lucide component for an allowlisted id, or undefined. OWN entries only: `LUCIDE_ICONS` is a
 * plain object, so `LUCIDE_ICONS['__proto__']` / `['constructor']` / `['toString']` answer with an
 * inherited value — truthy, not a component — and React throws rendering it. The name comes from a
 * persisted file, so the lookup itself has to be safe, not just the validator in front of it.
 */
export function lucideIcon(name: string): LucideIcon | undefined {
  return Object.prototype.hasOwnProperty.call(LUCIDE_ICONS, name) ? LUCIDE_ICONS[name] : undefined
}

export interface ProjectGlyphProps {
  /** The project's icon, when it has one. Absent → render the site's pre-icon fallback. */
  icon?: ProjectIcon
  /** The project's own color — tints the lucide placeholder and drives both fallbacks. Optional
   *  so a caller can suppress the fallback tint entirely (TabBar's inactive-tab dot only colors
   *  the active tab; passing `undefined` there reproduces that exactly). */
  color?: string
  /** Project display name — the monogram fallback's first initial, and the image's empty alt. */
  name: string
  /** Content sizing (emoji font-size). Fallback/icon box size comes from `className`'s own CSS,
   *  same as every render site did before this component existed — this only sizes the glyph
   *  drawn inside that box. */
  size?: number
  /** Fallback shape when `icon` is absent: a plain colored dot, or a colored circle with the
   *  name's first initial. Default 'monogram' — the more common site. */
  variant?: 'dot' | 'monogram'
  /** The render site's own class — keeps that site's existing box size/position CSS in charge, so
   *  swapping in `ProjectGlyph` doesn't move or resize anything when `icon` is absent. */
  className?: string
  title?: string
}

const DEFAULT_SIZE = 16

/**
 * A project's small badge, used wherever the UI shows one beside a project's name: its custom
 * icon when it has one (emoji, a curated lucide glyph, or an image — GitHub avatar/upload/
 * favicon), else the fallback that render site already showed before project icons existed — a
 * plain colored dot or a colored-circle monogram of the name's first letter. Every wired call
 * site passes its own `className`, so an absent `icon` reproduces that site's pre-icon markup
 * exactly: same element, same class, same conditional style.
 */
export function ProjectGlyph({
  icon,
  color,
  name,
  size = DEFAULT_SIZE,
  variant = 'monogram',
  className,
  title
}: ProjectGlyphProps): JSX.Element {
  if (icon?.type === 'emoji') {
    return (
      <span
        className={className}
        title={title}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: Math.round(size * 0.8),
          lineHeight: 1
        }}
      >
        {icon.emoji}
      </span>
    )
  }

  if (icon?.type === 'lucide') {
    const Icon = lucideIcon(icon.name)
    if (Icon) {
      return (
        <span
          className={className}
          title={title}
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <Icon color={color || 'currentColor'} width="100%" height="100%" aria-hidden="true" />
        </span>
      )
    }
    // Unknown name (never happens for a sanitized icon) → fall through to the fallback below.
  }

  if (icon?.type === 'image') {
    return (
      <span className={className} title={title} style={{ display: 'inline-flex', overflow: 'hidden' }}>
        <img src={icon.src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      </span>
    )
  }

  if (variant === 'dot') {
    return <span className={className} style={color ? { background: color } : undefined} title={title} />
  }

  return (
    <span className={className} style={{ background: color }} title={title}>
      {(name.trim() || '?').charAt(0).toUpperCase()}
    </span>
  )
}

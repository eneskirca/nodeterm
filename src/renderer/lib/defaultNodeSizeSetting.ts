import { DEFAULT_SETTINGS, type Settings } from '@shared/types'
import {
  NODE_SIZE_MAX,
  SIZABLE_NODE_KINDS,
  TERMINAL_NODE_SIZE_MIN,
  defaultNodeSizesRecord,
  storedDefaultNodeSize,
  type NodeSize,
  type SizableNodeKind
} from '@shared/default-node-size'
import { BUILTIN_NODE_SIZES } from '../state/workspace'
import { NODE_MIN_SIZES } from './nodeSizing'

/**
 * The model behind Settings → Behavior → Default node size: one width × height pair, with a
 * picker choosing which kind it edits. `terminal` stands for terminal AND agent nodes and is
 * backed by the long-standing `defaultNodeWidth`/`defaultNodeHeight` pair, so nothing a user set
 * before per-kind sizes existed moves; every other kind lives in `defaultNodeSizes`.
 */
export type NodeSizeChoice = 'terminal' | SizableNodeKind

export const NODE_SIZE_CHOICES: readonly NodeSizeChoice[] = ['terminal', ...SIZABLE_NODE_KINDS]

export const NODE_SIZE_CHOICE_LABELS: Record<NodeSizeChoice, string> = {
  terminal: 'Terminal & agent',
  sticky: 'Sticky note',
  whiteboard: 'Whiteboard',
  pull: 'Pull request',
  issues: 'Issues',
  browser: 'Browser',
  web: 'Web view',
  editor: 'Editor',
  diff: 'Diff',
  files: 'File manager',
  video: 'Video',
  simulator: 'Simulator',
  trigger: 'Trigger',
  dino: 'Dino game'
}

export interface NodeSizeField {
  size: NodeSize
  min: NodeSize
  max: NodeSize
  /** Whether this kind differs from its shipped default (drives the per-kind reset). Terminal's
   *  pair is a plain setting with a default, so it counts as custom when it moved off it. */
  isCustom: boolean
}

/**
 * What the two number fields show for `choice`: the STORED numbers, not the clamped size a node
 * would open at. `NumberField` writes on every keystroke, so showing the clamped value would snap
 * the "3" of "300" to the minimum before the rest is typed. Creation clamps (`terminalNodeSize`,
 * `defaultNodeSize`), which is where a hand-edited 0 or 99999 is made safe.
 */
export function nodeSizeField(settings: Settings, choice: NodeSizeChoice): NodeSizeField {
  if (choice === 'terminal') {
    const isCustom =
      settings.defaultNodeWidth !== DEFAULT_SETTINGS.defaultNodeWidth ||
      settings.defaultNodeHeight !== DEFAULT_SETTINGS.defaultNodeHeight
    const size = storedDefaultNodeSize(
      { width: settings.defaultNodeWidth, height: settings.defaultNodeHeight },
      { width: DEFAULT_SETTINGS.defaultNodeWidth, height: DEFAULT_SETTINGS.defaultNodeHeight }
    )
    return { size, min: TERMINAL_NODE_SIZE_MIN, max: NODE_SIZE_MAX, isCustom }
  }
  const stored = defaultNodeSizesRecord(settings.defaultNodeSizes)[choice]
  return {
    size: storedDefaultNodeSize(stored, BUILTIN_NODE_SIZES[choice]),
    min: NODE_MIN_SIZES[choice],
    max: NODE_SIZE_MAX,
    isCustom: stored !== undefined
  }
}

/** The settings patch that makes `choice` open at `size`. */
export function nodeSizePatch(settings: Settings, choice: NodeSizeChoice, size: NodeSize): Partial<Settings> {
  if (choice === 'terminal') return { defaultNodeWidth: size.width, defaultNodeHeight: size.height }
  return {
    defaultNodeSizes: {
      ...defaultNodeSizesRecord(settings.defaultNodeSizes),
      [choice]: { width: size.width, height: size.height }
    }
  }
}

/** The settings patch that puts `choice` back to its built-in size. */
export function nodeSizeResetPatch(settings: Settings, choice: NodeSizeChoice): Partial<Settings> {
  if (choice === 'terminal') {
    return { defaultNodeWidth: DEFAULT_SETTINGS.defaultNodeWidth, defaultNodeHeight: DEFAULT_SETTINGS.defaultNodeHeight }
  }
  const next = { ...defaultNodeSizesRecord(settings.defaultNodeSizes) }
  delete next[choice]
  return { defaultNodeSizes: next }
}

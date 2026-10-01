/**
 * The `arrange` canvas-control verb's vocabulary, in the one place all three of its readers can
 * import: the renderer's layout transforms (`renderer/state/workspace.ts`), the request parser and
 * the generated agent docs (`core/canvas-control-core.ts`). Core cannot import the renderer, and a
 * layout list typed once per reader is how the docs come to advertise a word the parser refuses.
 */

/** How a set of sibling nodes is packed. */
export const ARRANGE_LAYOUTS = ['grid', 'row', 'column'] as const
export type ArrangeLayout = (typeof ARRANGE_LAYOUTS)[number]

/**
 * What a group frame's own contents can be laid out as: the three packs, or lineage bands. Lineage
 * exists only here because it is a question about a CONTAINER ("who opened whom, among the things
 * in this frame"), which an id list cannot ask.
 */
export const GROUP_ARRANGE_LAYOUTS = [...ARRANGE_LAYOUTS, 'lineage'] as const
export type GroupArrangeLayout = (typeof GROUP_ARRANGE_LAYOUTS)[number]

/**
 * The shape gate for `arrange`'s flags, or `null` when the request is well-formed. Whether the
 * frame exists, has children or has any lineage is the canvas's to answer (`groupArrangeRefusal`);
 * this refuses only what no canvas could act on.
 *
 * The two forms are exclusive on purpose: `--group` names a frame and means "its direct children",
 * so a request carrying both has two answers to "which nodes", and picking one silently is the
 * kind of half-honoured flag an agent cannot detect from the reply.
 *
 * Strictness differs by form, deliberately. `--group` is new, so an unknown `--layout` is refused
 * by name. `--nodes` has always fallen back to `grid` on an unknown word, and callers in the field
 * may lean on that — it stays, with ONE exception: `lineage`, which would otherwise be accepted
 * and quietly delivered as a grid.
 */
export function arrangeArgsRefusal(args: Record<string, string>): string | null {
  const hasNodes = !!args.nodes
  const hasGroup = !!args.group
  if (!hasNodes && !hasGroup) return 'arrange requires --nodes <id,id> or --group <frameId>'
  if (hasNodes && hasGroup) {
    return 'arrange takes --nodes <id,id> or --group <frameId>, not both — name the frame to arrange its own items, or list sibling nodes'
  }
  const layout = args.layout
  if (hasGroup && layout && !(GROUP_ARRANGE_LAYOUTS as readonly string[]).includes(layout)) {
    return `arrange --group: --layout must be ${GROUP_ARRANGE_LAYOUTS.join('|')}`
  }
  if (hasNodes && layout === 'lineage') {
    return 'arrange: --layout lineage needs --group <frameId> — it lays out one frame\'s own items by who opened whom'
  }
  return null
}

/**
 * The agent-facing description of `arrange --group`, rendered into BOTH generated bodies (the
 * SKILL.md and the marker block) so the two cannot describe different products, with the layout
 * list taken from the constant the parser checks.
 */
export function arrangeGroupGuidanceLines(): string[] {
  return [
    `- \`arrange --group <frameId> [--layout ${GROUP_ARRANGE_LAYOUTS.join('|')}] [--cols N]\` — organize a frame by`,
    '  naming IT instead of listing its children: lays out the frame\'s direct children (a frame nested',
    '  inside moves as one unit), then resizes the frame — and every frame around it — to hold them, so',
    '  nothing overflows. The frame\'s top-left stays where it is. `--layout lineage` stacks one row per',
    '  level of who opened whom among those children; it is refused, with the reason, when no opened-by',
    '  or `--after` connection joins two of them. Pass `--nodes` or `--group`, never both. This is the',
    '  one call to make after `group`, or after opening stations into a frame.'
  ]
}

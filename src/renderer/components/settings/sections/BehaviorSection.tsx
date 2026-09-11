import { useSettings } from '../../../state/settings'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Switch } from '@renderer/ui/Switch'
import { NumberField } from '@renderer/ui/NumberField'
import { Select } from '@renderer/ui/Select'
import { SegmentedPill } from '@renderer/ui/SegmentedPill'
import { Input } from '@renderer/ui/Input'
import { hintLabel } from '@shared/platform-utils'
import { clampWheelZoomSpeed } from '@renderer/canvas/wheel-zoom'
import { DEFAULT_WORKTREE_PATH_TEMPLATE } from '@shared/worktree'

const ROWS = {
  defaultView: {
    title: 'Default view',
    keywords: ['default', 'view', 'kanban', 'board', 'canvas', 'project']
  },
  omniKanban: {
    title: 'Omni Kanban (global swimlanes)',
    keywords: ['omni', 'kanban', 'swimlane', 'global', 'overview', 'board', 'project']
  },
  omniKanbanDefault: {
    title: 'Omni as default for Cmd+Shift+B',
    keywords: ['omni', 'kanban', 'global', 'default', 'shortcut', 'cmd', 'shift', 'b']
  },
  gridSize: { title: 'Grid size', keywords: ['grid', 'size', 'snap'] },
  nodeSize: {
    title: 'Default node size',
    keywords: ['node', 'size', 'width', 'height', 'terminal', 'default']
  },
  snap: { title: 'Snap to grid', keywords: ['snap', 'grid', 'align'] },
  autoAlign: {
    title: 'Snap to grid mode (auto-arrange)',
    keywords: ['snap', 'grid', 'align', 'arrange', 'auto', 'mode']
  },
  panHover: { title: 'Pan-hover delay (ms)', keywords: ['pan', 'hover', 'delay', 'focus', 'guard'] },
  doubleClick: { title: 'Double-click to focus', keywords: ['double', 'click', 'focus'] },
  focusZoom: {
    title: 'Zoom when going to a node',
    keywords: ['zoom', 'focus', 'go to', 'node', 'jump', 'camera', 'session', 'sidebar']
  },
  rememberLock: {
    title: 'Remember the canvas lock',
    keywords: ['lock', 'canvas', 'view', 'pan', 'zoom', 'freeze', 'remember', 'restart', 'persist']
  },
  mdPreview: {
    title: 'Open Markdown in preview',
    keywords: ['markdown', 'md', 'preview', 'render', 'editor', 'docs', 'readme', 'file']
  },
  sidebarCollapse: {
    title: 'Sidebar: collapse inactive by default',
    keywords: ['sidebar', 'sessions', 'collapse', 'expand', 'project', 'switch', 'group', 'tree']
  },
  sidebarGrouping: {
    title: 'Sidebar: group by',
    keywords: ['sidebar', 'sessions', 'group', 'status', 'project', 'attention']
  },
  worktreePath: {
    title: 'Worktree path template',
    keywords: ['worktree', 'git', 'path', 'folder', 'repo', 'branch', 'template']
  },
  wheelZoom: { title: 'Scroll wheel zooms', keywords: ['zoom', 'wheel', 'scroll', 'mouse', 'pan'] },
  wheelZoomSpeed: {
    title: 'Wheel zoom speed',
    keywords: ['zoom', 'wheel', 'speed', 'sensitivity', 'step', 'jump', 'mouse', 'scroll']
  },
  trackpadPan: {
    title: 'Trackpad scroll pans',
    keywords: ['trackpad', 'pan', 'scroll', 'zoom', 'magic', 'mouse', 'two-finger', 'macos']
  },
  dragMode: {
    title: 'Canvas left-drag',
    keywords: ['pan', 'drag', 'select', 'canvas', 'mouse', 'grab', 'figma', 'miro']
  },
  browserSaver: {
    title: 'Browser memory saver',
    keywords: ['browser', 'memory', 'saver', 'ram', 'webview', 'discard', 'page', 'web']
  },
  keepAwake: {
    title: 'Keep awake while agents work',
    keywords: ['sleep', 'awake', 'power', 'battery', 'suspend', 'run']
  },
  confirmQuit: {
    title: 'Confirm before quitting',
    keywords: ['quit', 'exit', 'close', 'confirm', 'dialog', 'ask']
  }
}
const ENTRIES = Object.values(ROWS)

export function BehaviorSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)
  return (
    <SettingsSection id="behavior" title="Behavior" isActive={isActive} searchEntries={ENTRIES}>
      <SearchableRow {...ROWS.defaultView}>
        <FieldRow
          label="Default view"
          description="How a project opens when you haven't switched it. Projects you toggle keep their own choice."
          control={
            <Select
              aria-label="Default view"
              value={settings.defaultProjectView === 'kanban' ? 'kanban' : 'canvas'}
              onChange={(e) => update({ defaultProjectView: e.target.value as 'canvas' | 'kanban' })}
            >
              <option value="canvas">Canvas</option>
              <option value="kanban">Kanban board</option>
            </Select>
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.omniKanban}>
        <FieldRow
          label="Omni Kanban (global swimlanes)"
          description="When enabled, the global Kanban overview is available via its dedicated shortcut (Settings → Keyboard Shortcuts → Toggle global kanban). Default OFF — existing users see no change."
          control={
            <Switch
              checked={settings.omniKanbanEnabled === true}
              onChange={(v) => update({ omniKanbanEnabled: v })}
              ariaLabel="Omni Kanban"
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.omniKanbanDefault}>
        <FieldRow
          label="Make Omni the default for Cmd+Shift+B"
          description="When enabled, Cmd+Shift+B opens the global overview instead of the per-project board. The dedicated global shortcut always opens Omni regardless. Opt-in, per user."
          control={
            <Switch
              checked={settings.omniKanbanAsDefault === true}
              onChange={(v) => update({ omniKanbanAsDefault: v })}
              ariaLabel="Omni as default"
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.gridSize}>
        <FieldRow
          label="Grid size"
          control={
            <NumberField
              value={settings.gridSize}
              min={8}
              max={96}
              onChange={(v) => update({ gridSize: v || 24 })}
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.nodeSize}>
        <FieldRow
          label="Default node size (px)"
          description="Size new terminal and agent nodes open at. Existing nodes keep their size."
          control={
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <NumberField
                value={settings.defaultNodeWidth}
                min={280}
                max={2400}
                step={20}
                onChange={(v) => update({ defaultNodeWidth: v || 640 })}
              />
              <span style={{ opacity: 0.6 }}>×</span>
              <NumberField
                value={settings.defaultNodeHeight}
                min={160}
                max={1600}
                step={20}
                onChange={(v) => update({ defaultNodeHeight: v || 440 })}
              />
            </div>
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.snap}>
        <FieldRow
          label="Snap to grid"
          control={
            <Switch
              checked={settings.snapToGrid}
              onChange={(v) => update({ snapToGrid: v })}
              ariaLabel="Snap to grid"
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.autoAlign}>
        <FieldRow
          label="Snap to grid mode"
          description="Arranges every node to the grid at the moment you turn it on — like a desktop “Auto arrange”. Distinct from the drag-snap toggle above, which only constrains dragging."
          control={
            <Switch
              checked={settings.autoAlignGrid}
              onChange={(v) => update({ autoAlignGrid: v })}
              ariaLabel="Snap to grid mode"
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.panHover}>
        <FieldRow
          label="Pan-hover delay (ms)"
          control={
            <NumberField
              value={settings.panHoverDelay}
              min={0}
              max={2000}
              step={50}
              onChange={(v) => update({ panHoverDelay: v || 0 })}
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.doubleClick}>
        <FieldRow
          label="Double-click to focus"
          control={
            <Switch
              checked={settings.doubleClickFocus}
              onChange={(v) => update({ doubleClickFocus: v })}
              ariaLabel="Double-click to focus"
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.focusZoom}>
        <FieldRow
          label="Zoom when going to a node"
          description="Off: going to a node keeps your current zoom and only pans to it."
          control={
            <Switch
              checked={settings.focusZoomToNode}
              onChange={(v) => update({ focusZoomToNode: v })}
              ariaLabel="Zoom when going to a node"
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.rememberLock}>
        <FieldRow
          label="Remember the canvas lock"
          description="The bottom-left lock stays on across restarts until you turn it off. Off: every launch starts unlocked."
          control={
            <Switch
              checked={settings.rememberCanvasLock}
              onChange={(v) => update({ rememberCanvasLock: v })}
              ariaLabel="Remember the canvas lock"
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.mdPreview}>
        <FieldRow
          label="Open Markdown in preview"
          description="Markdown files open rendered instead of as editable text. The node's Preview/Edit toggle still switches either way."
          control={
            <Switch
              checked={settings.openMarkdownPreview}
              onChange={(v) => update({ openMarkdownPreview: v })}
              ariaLabel="Open Markdown in preview"
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.sidebarCollapse}>
        <FieldRow
          label="Sidebar: collapse inactive by default"
          description="Projects without an explicit choice start collapsed when inactive. Your project and group chevron choices are remembered."
          control={
            <Switch
              checked={settings.sidebarAutoCollapse}
              onChange={(v) => update({ sidebarAutoCollapse: v })}
              ariaLabel="Sidebar: collapse inactive by default"
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.sidebarGrouping}>
        <FieldRow
          label="Sidebar: group sessions by"
          description="Group the sessions sidebar by project (the default) or by live status, so sessions needing attention float to the top across all projects. Status reflects local-core sessions; remote sessions show as idle."
          control={
            <SegmentedPill<'project' | 'status'>
              value={settings.sidebarGrouping}
              ariaLabel="Group sessions by"
              options={[
                { value: 'project', label: 'Project' },
                { value: 'status', label: 'Status' }
              ]}
              onChange={(v) => update({ sidebarGrouping: v })}
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.worktreePath}>
        <FieldRow
          label="Worktree path template"
          description={
            'Resolved from the repository root. Supports $repoName (also $reponame or $defaultFolderName) and $branch; a missing branch is appended automatically.'
          }
          control={
            <Input
              className="w-80 font-mono"
              aria-label="Worktree path template"
              placeholder={DEFAULT_WORKTREE_PATH_TEMPLATE}
              value={settings.worktreePathTemplate}
              onChange={(e) => update({ worktreePathTemplate: e.target.value })}
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.wheelZoom}>
        <FieldRow
          label="Scroll wheel zooms"
          description={hintLabel('Zoom with a plain mouse wheel (no ⌘). Turns off scroll-to-pan — pan by dragging.')}
          control={
            <Switch
              checked={settings.wheelZoom}
              onChange={(v) => update({ wheelZoom: v })}
              ariaLabel="Scroll wheel zooms"
            />
          }
        />
      </SearchableRow>
      <div
        className={
          'mt-3 space-y-3 border-l border-border pl-4' +
          (settings.wheelZoom ? '' : ' pointer-events-none opacity-40')
        }
        aria-disabled={!settings.wheelZoom}
      >
        <SearchableRow {...ROWS.wheelZoomSpeed}>
          <FieldRow
            label="Wheel zoom speed"
            description="How far one wheel click zooms. Turn it down if a single click jumps too far (common on high-resolution wheels like the MX Master)."
            control={
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={0.2}
                  max={2}
                  step={0.1}
                  value={clampWheelZoomSpeed(settings.wheelZoomSpeed)}
                  aria-label="Wheel zoom speed"
                  onChange={(e) => update({ wheelZoomSpeed: Number(e.target.value) })}
                  className="w-40 accent-[var(--accent)]"
                />
                <span className="w-12 text-right text-[12px] text-muted tabular-nums">
                  {clampWheelZoomSpeed(settings.wheelZoomSpeed).toFixed(1)}×
                </span>
              </div>
            }
          />
        </SearchableRow>
      </div>
      <SearchableRow {...ROWS.trackpadPan}>
        <FieldRow
          label="Trackpad scroll pans"
          description={hintLabel(
            'macOS: a two-finger trackpad scroll pans the canvas even with wheel zoom on. The desktop app tells mouse and trackpad apart directly, so a wheel mouse still zooms; in the browser (Server Edition) detection is heuristic — turn off there if a precise-pixel mouse (Magic Mouse, MX) pans when you meant to zoom.'
          )}
          control={
            <Switch
              checked={settings.trackpadPan}
              onChange={(v) => update({ trackpadPan: v })}
              ariaLabel="Trackpad scroll pans"
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.dragMode}>
        <FieldRow
          label="Canvas left-drag"
          description="What dragging empty canvas does. Pan moves the map directly (box-select moves to Shift+drag); Select rubber-band selects, panning stays on middle-drag / two-finger scroll."
          control={
            <Select
              aria-label="Canvas left-drag"
              value={settings.canvasDragMode}
              onChange={(e) => update({ canvasDragMode: e.target.value as 'select' | 'pan' })}
            >
              <option value="select">Select (default)</option>
              <option value="pan">Pan the canvas</option>
            </Select>
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.browserSaver}>
        <FieldRow
          label="Browser memory saver"
          description="Free a hidden browser page's memory after 5 minutes; it reloads when shown. Each page is a whole Chromium process."
          control={
            <Switch
              checked={settings.browserMemorySaver}
              onChange={(v) => update({ browserMemorySaver: v })}
              ariaLabel="Browser memory saver"
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.keepAwake}>
        <FieldRow
          label="Keep awake while agents work"
          description="Holds off idle sleep while a local agent is running. A closed lid still sleeps the machine."
          control={
            <Switch
              checked={settings.keepAwakeWhileAgentsWork}
              onChange={(v) => update({ keepAwakeWhileAgentsWork: v })}
              ariaLabel="Keep awake while agents work"
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.confirmQuit}>
        <FieldRow
          label="Confirm before quitting"
          description="Ask before the app quits (⌘Q / Ctrl+Q or the title-bar close). Terminal sessions survive a quit either way."
          control={
            <Switch
              checked={settings.confirmBeforeQuit}
              onChange={(v) => update({ confirmBeforeQuit: v })}
              ariaLabel="Confirm before quitting"
            />
          }
        />
      </SearchableRow>
    </SettingsSection>
  )
}

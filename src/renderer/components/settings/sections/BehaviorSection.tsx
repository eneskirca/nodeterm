import { useSettings } from '../../../state/settings'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Switch } from '@renderer/ui/Switch'
import { NumberField } from '@renderer/ui/NumberField'
import { Select } from '@renderer/ui/Select'
import { hintLabel } from '@shared/platform-utils'

const ROWS = {
  defaultView: {
    title: 'Default view',
    keywords: ['default', 'view', 'kanban', 'board', 'canvas', 'project']
  },
  gridSize: { title: 'Grid size', keywords: ['grid', 'size', 'snap'] },
  nodeSize: {
    title: 'Default node size',
    keywords: ['node', 'size', 'width', 'height', 'terminal', 'default']
  },
  snap: { title: 'Snap to grid', keywords: ['snap', 'grid', 'align'] },
  panHover: { title: 'Pan-hover delay (ms)', keywords: ['pan', 'hover', 'delay', 'focus', 'guard'] },
  doubleClick: { title: 'Double-click to focus', keywords: ['double', 'click', 'focus'] },
  sidebarCollapse: {
    title: 'Sidebar: collapse inactive by default',
    keywords: ['sidebar', 'sessions', 'collapse', 'expand', 'project', 'switch', 'group', 'tree']
  },
  wheelZoom: { title: 'Scroll wheel zooms', keywords: ['zoom', 'wheel', 'scroll', 'mouse', 'pan'] },
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
      <SearchableRow {...ROWS.trackpadPan}>
        <FieldRow
          label="Trackpad scroll pans"
          description={hintLabel(
            'macOS: a two-finger trackpad scroll pans the canvas even with wheel zoom on. Turn off if a precise-pixel mouse (Magic Mouse, MX) pans when you meant to zoom.'
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
    </SettingsSection>
  )
}

import { useSettings } from '../../../state/settings'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Select } from '@renderer/ui/Select'
import { Input } from '@renderer/ui/Input'
import { Switch } from '@renderer/ui/Switch'

const ROWS = {
  autoFetch: {
    title: 'Auto-fetch git status',
    keywords: ['git', 'fetch', 'source control', 'ahead', 'behind', 'sync', 'remote']
  },
  agent: {
    title: 'Commit agent',
    keywords: ['commit', 'message', 'ai', 'claude', 'codex', 'generate']
  },
  command: { title: 'Custom command', keywords: ['commit', 'custom', 'command', 'prompt', 'promptFile'] },
  extra: { title: 'Extra prompt', keywords: ['commit', 'prompt', 'conventional', 'gitmoji'] }
}
const ENTRIES = Object.values(ROWS)

export function CommitSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)
  return (
    <SettingsSection
      id="commit"
      title="Commit messages (AI)"
      description="Runs a local coding-agent CLI read-only on your staged diff (no built-in model)."
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.autoFetch}>
        <FieldRow
          label="Auto-fetch git status"
          description="Periodically refresh ahead/behind from the remote while Source Control is open."
          control={
            <Switch
              checked={settings.gitAutoFetch}
              ariaLabel="Auto-fetch git status"
              onChange={(on) => update({ gitAutoFetch: on })}
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.agent}>
        <FieldRow
          label="Agent"
          control={
            <Select
              value={settings.commitAgent}
              onChange={(e) =>
                update({ commitAgent: e.target.value as 'claude' | 'codex' | 'custom' })
              }
            >
              <option value="claude">Claude Code</option>
              <option value="codex">Codex</option>
              <option value="custom">Custom command…</option>
            </Select>
          }
        />
      </SearchableRow>
      {settings.commitAgent === 'custom' && (
        <SearchableRow {...ROWS.command}>
          <FieldRow
            label="Command"
            description="The prompt goes to the command's stdin by default. {prompt} passes it inline as one argument instead (not for npm .cmd shims on Windows, nor for diffs past the Windows command-line limit); {promptFile} passes the path of a private temp file holding it."
            control={
              <Input
                className="w-72"
                placeholder="mycli --flag {prompt}"
                value={settings.commitAgentCommand}
                onChange={(e) => update({ commitAgentCommand: e.target.value })}
              />
            }
          />
        </SearchableRow>
      )}
      <SearchableRow {...ROWS.extra}>
        <div className="py-2.5">
          <label className="block text-[13px] text-text">Extra prompt (optional)</label>
          <textarea
            value={settings.commitExtraPrompt}
            placeholder="e.g. Use Conventional Commits with gitmoji"
            onChange={(e) => update({ commitExtraPrompt: e.target.value })}
            className="mt-2 min-h-20 w-full rounded-md border border-border bg-bg px-2.5 py-2 text-[13px] text-text outline-none focus:border-accent"
          />
        </div>
      </SearchableRow>
    </SettingsSection>
  )
}

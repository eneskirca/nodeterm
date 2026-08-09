import { useSettings } from '../../../state/settings'
import type { CustomAgent } from '@shared/types'
import type { PromptInjectionMode } from '@shared/agents/config'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Button } from '@renderer/ui/Button'
import { Input } from '@renderer/ui/Input'
import { Select } from '@renderer/ui/Select'
import { uuid } from '@renderer/lib/uuid'

const ROWS = {
  custom: { title: 'Custom agents', keywords: ['custom', 'agent', 'cli', 'byo', 'aider'] }
}
const ENTRIES = Object.values(ROWS)

export function CustomAgentsSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const customAgents = useSettings((s) => s.settings.customAgents)
  const update = useSettings((s) => s.update)
  const patchAgent = (id: string, patch: Partial<CustomAgent>) =>
    update({ customAgents: customAgents.map((a) => (a.id === id ? { ...a, ...patch } : a)) })
  const removeAgent = (id: string) =>
    update({ customAgents: customAgents.filter((a) => a.id !== id) })
  const addAgent = () =>
    update({
      customAgents: [
        ...customAgents,
        {
          id: 'custom:' + uuid(),
          label: 'Custom agent',
          launchCmd: '',
          promptInjectionMode: 'argv'
        }
      ]
    })
  return (
    <SettingsSection
      id="custom-agents"
      title="Custom agents"
      description="Bring your own agent CLI. Custom agents launch in a terminal and show process / title status only (no hooks, branch, or loop)."
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.custom}>
        <div className="space-y-4">
          {customAgents.map((agent) => (
            <div key={agent.id} className="space-y-2 rounded-md border border-border p-3">
              <FieldRow
                label="Label"
                control={
                  <Input
                    className="w-56"
                    placeholder="e.g. Aider"
                    value={agent.label}
                    onChange={(e) => patchAgent(agent.id, { label: e.target.value })}
                  />
                }
              />
              <FieldRow
                label="Launch command"
                control={
                  <Input
                    className="w-56"
                    placeholder="e.g. aider"
                    value={agent.launchCmd}
                    onChange={(e) => patchAgent(agent.id, { launchCmd: e.target.value })}
                  />
                }
              />
              <FieldRow
                label="Prompt injection"
                control={
                  <Select
                    value={agent.promptInjectionMode}
                    onChange={(e) =>
                      patchAgent(agent.id, {
                        promptInjectionMode: e.target.value as PromptInjectionMode
                      })
                    }
                  >
                    <option value="argv">argv</option>
                    <option value="flag-prompt">flag-prompt</option>
                    <option value="stdin-after-start">stdin-after-start</option>
                  </Select>
                }
              />
              <Button onClick={() => removeAgent(agent.id)}>Remove</Button>
            </div>
          ))}
          <Button onClick={addAgent}>Add agent</Button>
        </div>
      </SearchableRow>
    </SettingsSection>
  )
}

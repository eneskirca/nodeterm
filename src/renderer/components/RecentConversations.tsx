import { useMemo, useState } from 'react'
import type { RecentConversation } from '@shared/recent-conversations'
import { AgentIcon } from '../lib/agentIcons'
import { relativeTime } from '../lib/relativeTime'
import { folderLabel, groupRecentByFolder, recentTitle } from '../lib/recentConversations'

/** Rows the start screen shows before "Show all" — the list is a door back into work, not an archive. */
export const RECENT_CONVERSATIONS_VISIBLE = 8

export interface RecentConversationsProps {
  items: readonly RecentConversation[]
  /** What clicking a row does, in words; `disabled` is the reason it cannot. */
  actionFor: (conv: RecentConversation) => { label: string; disabled?: string }
  onResume: (conv: RecentConversation) => void
  /** Injected for tests; the render-time clock otherwise. */
  now?: number
}

/**
 * "Recent conversations" on the start screen: past agent conversations from this machine's CLI
 * histories, grouped by the folder they ran in. A row resumes the conversation in the project that
 * owns that folder (or opens the folder as one); a conversation a node already holds says "Go to
 * node" instead. A row that cannot be resumed stays visible, disabled, with its reason — a row that
 * silently vanished would take the reason with it.
 */
export function RecentConversations({ items, actionFor, onResume, now }: RecentConversationsProps) {
  const [showAll, setShowAll] = useState(false)
  const at = now ?? Date.now()
  const shown = showAll ? items : items.slice(0, RECENT_CONVERSATIONS_VISIBLE)
  const groups = useMemo(() => groupRecentByFolder(shown), [shown])
  if (items.length === 0) return null
  return (
    <div className="welcome__recent welcome__recent--convs">
      <div className="welcome__recent-title">Recent conversations</div>
      <div className="welcome__recent-list welcome__convs-list">
        {groups.map((g) => (
          <div key={g.cwd ?? '\0'} className="welcome__convs-group">
            <div className="welcome__convs-folder" title={g.cwd ?? 'The history does not name a folder'}>
              {folderLabel(g.cwd)}
              {g.cwd && <span className="welcome__recent-path">{g.cwd}</span>}
            </div>
            {g.items.map((conv) => {
              const action = actionFor(conv)
              const disabled = !!action.disabled
              const run = (): void => {
                if (!disabled) onResume(conv)
              }
              return (
                <div
                  key={`${conv.agentId}:${conv.sessionId}`}
                  className={`welcome__recent-item welcome__conv${disabled ? ' welcome__conv--disabled' : ''}`}
                  role="button"
                  tabIndex={0}
                  aria-disabled={disabled || undefined}
                  title={action.disabled ?? `${action.label} — ${conv.agentId} ${conv.sessionId}`}
                  onClick={run}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      run()
                    }
                  }}
                >
                  <AgentIcon agentId={conv.agentId} />
                  <span className="welcome__conv-title">{recentTitle(conv)}</span>
                  <span className="welcome__conv-age">{relativeTime(conv.lastActiveAt, at)}</span>
                  <span className="welcome__conv-action">{action.label}</span>
                </div>
              )
            })}
          </div>
        ))}
      </div>
      {items.length > RECENT_CONVERSATIONS_VISIBLE && (
        <button className="welcome__convs-more" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      )}
    </div>
  )
}

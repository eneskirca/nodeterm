export type KanbanSource = 'all' | 'github' | 'sessions'

export function KanbanSourceFilter({
  value,
  onChange
}: {
  value: KanbanSource
  onChange: (value: KanbanSource) => void
}): React.JSX.Element {
  return (
    <div className="kanban-source-filter" role="group" aria-label="Card source">
      {(['all', 'github', 'sessions'] as const).map((source) => (
        <button
          key={source}
          type="button"
          className={value === source ? 'kanban-source-filter__button is-active' : 'kanban-source-filter__button'}
          aria-pressed={value === source}
          onClick={() => onChange(source)}
        >
          {source === 'all' ? 'All' : source === 'github' ? 'GitHub' : 'Sessions'}
        </button>
      ))}
    </div>
  )
}

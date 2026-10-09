import { useMemo, useState } from 'react'
import { searchOrUrl } from './browserUrl'
import { SHORTCUTS, SiteIcon } from './browserIcons'
import { useBrowserHistory } from '../state/browserHistory'

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** The Chrome-like new-tab page shown inside a blank browser node. */
export function BrowserStartPage({ onNavigate }: { onNavigate: (url: string) => void }): JSX.Element {
  const [q, setQ] = useState('')
  // Select the stored list itself and slice it here: a selector that returns a NEW array on every
  // read (`s.recent(8)`) never compares equal, and zustand 5 re-renders on it forever — "Maximum
  // update depth exceeded" the moment a blank browser shows this page.
  const entries = useBrowserHistory((s) => s.entries)
  const recent = useMemo(() => entries.slice(0, 8), [entries])
  const submit = (): void => {
    const u = searchOrUrl(q)
    if (u) onNavigate(u)
  }
  return (
    <div className="startpage nodrag nowheel">
      <div className="startpage__inner">
        <div className="startpage__searchbar">
          <span className="startpage__search-icon">⌕</span>
          <input
            className="startpage__search"
            spellCheck={false}
            value={q}
            placeholder="Search Google or type a URL"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
          />
        </div>

        <div className="startpage__grid">
          {SHORTCUTS.map((s) => (
            <button
              key={s.url}
              className="startpage__tile"
              title={s.label}
              onClick={() => onNavigate(s.url)}
            >
              <SiteIcon url={s.url} label={s.label} />
              <span className="startpage__tile-label">{s.label}</span>
            </button>
          ))}
        </div>

        {recent.length > 0 && (
          <div className="startpage__recent">
            <div className="startpage__recent-title">Recent</div>
            {recent.map((e) => (
              <button
                key={`${e.url}-${e.ts}`}
                className="startpage__recent-item"
                onClick={() => onNavigate(e.url)}
              >
                <SiteIcon url={e.url} size={22} />
                <span className="startpage__recent-name">{e.title}</span>
                <span className="startpage__recent-host">{hostLabel(e.url)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

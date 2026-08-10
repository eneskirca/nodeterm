/**
 * What stands in for a page whose Chromium process was released while the node sat off-screen
 * ({@link useDiscardWhenHidden}). One component so the two surfaces that host a `<webview>` cannot
 * drift into two different wordings for the same state.
 *
 * Deliberately quiet: this is an ambient state that heals itself on view, not an error.
 */
export function DiscardedPlate({ restoring = false }: { restoring?: boolean }): React.JSX.Element {
  return (
    <div className="browser-node__discarded">
      <span>{restoring ? 'Reopening…' : 'Page released to save memory — reopens on view'}</span>
    </div>
  )
}

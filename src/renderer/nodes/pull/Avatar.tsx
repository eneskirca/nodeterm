// One person's round avatar, shared by the pull node and (later) the issues node. The image is
// always a data URL a read carried in `avatarDataUrls` (main's hardened fetcher); no remote URL is
// ever rendered, so the renderer CSP stays `img-src 'self' data:`.
import { useState } from 'react'
import type { GitHubIssueUser } from '@shared/github-issues'
import type { PullAvatarDataUrls } from '@shared/github-pull-detail'

/** `avatars` is the read's `avatarDataUrls`. No entry, a non-data URL, or an image that fails to
 *  decode renders the login's first letter instead. `user` null = a deleted account ("ghost"). */
export function Avatar({ user, avatars, size = 20 }: {
  user: GitHubIssueUser | null; avatars?: PullAvatarDataUrls; size?: number
}): React.JSX.Element {
  const [broken, setBroken] = useState<string | null>(null)
  const login = user?.login ?? 'ghost'
  const found = user ? avatars?.[String(user.id)] : undefined
  const src = found?.startsWith('data:image/') ? found : undefined
  // ponytail: inline size so each caller picks one number; no per-size CSS classes.
  const box = { width: size, height: size, fontSize: Math.round(size * 0.5) }
  return src && broken !== src
    ? <img className="pull-avatar" src={src} alt={login} title={login} style={box} onError={() => setBroken(src)} />
    : <span className="pull-avatar pull-avatar--letter" role="img" aria-label={login} title={login} style={box}>
      {(login[0] ?? '?').toUpperCase()}
    </span>
}

// The pull node's refusal and failure sentences, apart from shared.tsx so the startup add menu
// (lib/openPullMenu.ts) reads them without pulling the node's React code into boot.
import type { PullReadFailure, PullRefusal } from '@shared/github-pull-detail'

/** Each refusal names what is wrong and the one step that fixes it. No request was made. */
export const REFUSAL_TEXT: Record<PullRefusal, (repository: string) => string> = {
  'not-approved': () =>
    'This repository is not approved on this machine. Open the board, then approve the repository in its GitHub settings.',
  'signed-out': () => 'You are not signed in to GitHub. Open the board, then sign in from its GitHub settings.',
  'repository-mismatch': (repository) =>
    `This node points at ${repository}, which is not this project's repository. Open the pull request again from this project's board.`,
  'not-configured': () =>
    "This project has no GitHub repository connected. Connect one in the board's GitHub settings."
}

export const FAILURE_TEXT: Record<PullReadFailure, string> = {
  throttled: 'GitHub is throttling requests. Refresh again in a minute.',
  unreachable: 'GitHub could not be reached. Check the connection, then refresh.',
  'signed-out': 'GitHub refused the token. Sign in again from the board\'s GitHub settings.',
  'not-found': 'GitHub could not find it. It was deleted, or this token can no longer see it.'
}

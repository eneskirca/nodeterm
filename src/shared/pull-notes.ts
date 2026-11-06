// Notes for agents (F-07): the user's private line notes on a pull request, kept on THIS machine
// (userData/pull-notes.json, keyed `<repository>#<number>`). Never git-shared, never in project.json,
// never posted to GitHub unless the user clicks "Post to GitHub" on one.
import type { PullDiffSide } from './github-pull-detail'

export interface PullNote {
  id: string
  path: string
  side: PullDiffSide
  line: number
  text: string
  createdAt: number
}

export type PullNoteInput = {
  repository: string; pullNumber: number; path: string; side: PullDiffSide; line: number; text: string
}

export interface PullNotesApi {
  /** The PR's notes, oldest first. */
  pullNotes(repository: string, pullNumber: number): Promise<PullNote[]>
  /** Each write answers the PR's notes after it. */
  addPullNote(input: PullNoteInput): Promise<PullNote[]>
  deletePullNote(request: { repository: string; pullNumber: number; id: string }): Promise<PullNote[]>
  /** Removes the notes named by `ids`, or every note of the PR when `ids` is absent. */
  clearPullNotes(request: { repository: string; pullNumber: number; ids?: string[] }): Promise<PullNote[]>
}

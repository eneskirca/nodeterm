import { describe, it, expect } from 'vitest'
import { canCommitCanvas, canClearDirty } from './persistGuards'

describe('canCommitCanvas', () => {
  it('commits while the nodes in hand belong to the active project', () => {
    expect(canCommitCanvas('a', 'a')).toBe(true)
  })

  // The field bug (2026-08-10): the 800ms autosave timer is armed under project A, the user
  // switches to B (zustand updates synchronously), and the timer fires BEFORE the load effect has
  // installed B's nodes — so A's nodes would be committed under B's id, wiping B.
  it('refuses to commit one project canvas under another project id', () => {
    expect(canCommitCanvas('a', 'b')).toBe(false)
  })

  // Before the first load effect runs, React Flow holds the initial `useNodesState([])` — an empty
  // array that belongs to NO project. Committing it is the "both canvases went blank" wipe.
  it('refuses to commit nodes that belong to no project yet', () => {
    expect(canCommitCanvas(null, 'a')).toBe(false)
  })

  // No project open (welcome screen): there is no id to write under.
  it('refuses to commit with no active project', () => {
    expect(canCommitCanvas('a', '')).toBe(false)
    expect(canCommitCanvas(null, '')).toBe(false)
    expect(canCommitCanvas('', '')).toBe(false)
  })
})

describe('canClearDirty', () => {
  it('clears dirty when nothing changed while the save was in flight', () => {
    expect(canClearDirty(7, 7)).toBe(true)
  })

  // Field bug 2026-08-10: a save can take seconds (SSH mirror write). Edits made DURING the await
  // are not in the snapshot handed to the store, so clearing dirty marks them saved — and the
  // watcher's not-dirty branch then clobbers them with a replaceProject + reload. Keep dirty set;
  // the debounce re-saves.
  it('keeps dirty set when an edit landed during the save', () => {
    expect(canClearDirty(7, 8)).toBe(false)
  })

  it('keeps dirty set for a burst of edits during one save', () => {
    expect(canClearDirty(0, 12)).toBe(false)
  })
})

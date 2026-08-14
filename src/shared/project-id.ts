/**
 * The ONE rule for keeping project ids unique.
 *
 * A project id is machine-local identity, and `<cwd>/.nodeterm/project.json` is a GIT-SHARED
 * document (the migration banner tells users to commit it so the canvas travels with the repo).
 * While that file CARRIED an id, `git worktree add`, a branch checkout, `reset --hard` or a
 * `stash pop` re-materialised one committed id into a SECOND folder, and two tabs then answered
 * to one id. Everything downstream is keyed by that id — the canvas commit, tmux session names,
 * delete/close, ssh control paths, board-log + approval routing — so a collision is not a render
 * glitch, it is cross-folder data loss.
 *
 * The cause is gone: the shared file no longer carries identity at all (see `projectToFile` —
 * only a machine-INDEPENDENT legacy `id` remains, for one release, so an older build can still
 * read the file). What stays here is the repair for stores already corrupted by it, which needs
 * the same derivation in two runtimes (main's store repairs the on-disk index, the renderer's
 * store defends its own array), so it lives in `shared` and uses no crypto: identical input must
 * give an identical id in every process, on every boot.
 */

/** 32-bit FNV-1a, base36 — short, deterministic, and inside the `[A-Za-z0-9._-]` charset that node
 *  ids (tmux session names) and project ids are allowed to use. */
export function shortHash(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    // FNV prime 16777619, in 32-bit arithmetic that survives JS doubles.
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

/**
 * The replacement id for a project that LOST an id collision (the first holder keeps the id).
 *
 * Deterministic in `(baseId, seed)` — never random — because the repair is written to the user's
 * disk: a repeated load must converge on the id it already wrote instead of churning
 * `project.json` (and every teammate's git diff) on every boot. `seed` is the thing that actually
 * distinguishes the two projects: the folder for a local ref, the endpoint for an ssh one.
 *
 * `isTaken` closes the last gap — a derived id that itself collides (two folders hashing the
 * same, or a third copy) is re-derived with a salt, still deterministically.
 */
export function derivedProjectId(
  baseId: string,
  seed: string,
  isTaken: (id: string) => boolean
): string {
  let candidate = `${baseId}-${shortHash(seed)}`
  for (let salt = 1; isTaken(candidate) && salt < 1000; salt++) {
    candidate = `${baseId}-${shortHash(`${seed}#${salt}`)}`
  }
  return candidate
}

/**
 * What actually distinguishes two projects that ended up sharing an id: the folder, the server
 * folder, or — inline canvases have neither — the name.
 *
 * Every re-keying site derives from THIS one function (the store's load-time repair, the index
 * writer in `splitWorkspace`, the renderer's `hydrate` guard, `adoptProject`), so when two of them
 * see the same collision they land on the same id instead of fighting over it across a save.
 */
export function collisionSeed(p: {
  cwd?: string
  ssh?: { remoteCwd?: string }
  name: string
}): string {
  return p.cwd ?? p.ssh?.remoteCwd ?? p.name
}

/**
 * The `id` a git-shared project.json is written with — COMPATIBILITY ONLY, and deliberately not
 * this machine's project id.
 *
 * A build that predates this change refuses a project.json without a string `id` and sidelines it
 * to `.corrupt-<ts>` — a rename inside the user's own repo, and a canvas that vanishes for a
 * teammate still on the App Store build. So the field stays for one release. It is derived from
 * the canvas's own NAME, which means every machine that holds this file writes the same value:
 * committing the file produces no per-machine churn, and a worktree copy carries no identity
 * anything can adopt (this build ignores the field entirely).
 *
 * Drop this — and the field — one release after the version that introduced it.
 */
export function legacyFileId(name: string): string {
  return `project-${shortHash(name)}`
}

/**
 * A brand-new project id, minted where nothing else can supply one: the ADOPTION path (a folder
 * whose project.json we just read but which has no index entry yet). Random, not derived — two
 * folders that share a canvas byte-for-byte must still become two projects.
 *
 * Same shape/alphabet as the renderer's `nextId('project')`, so ids from both minters are
 * interchangeable everywhere they are interpolated (control paths, log routing).
 */
export function freshProjectId(): string {
  const c = globalThis.crypto as Crypto | undefined
  const token = c?.getRandomValues
    ? Array.from(c.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('')
    : Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0')
  return `project-${Date.now().toString(36)}-${token}`
}

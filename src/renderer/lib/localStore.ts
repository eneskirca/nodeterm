/**
 * The one way this codebase touches `localStorage`.
 *
 * `typeof localStorage === 'undefined'` was the guard at five sites, and it is not enough. Recent
 * Node exposes a `localStorage` GLOBAL THAT IS METHOD-LESS unless `--localstorage-file` is passed:
 * `typeof localStorage` answers `'object'`, the guard lets the call through, and `.getItem` throws
 * `TypeError: localStorage.getItem is not a function`. Three of those sites read at MODULE level to
 * seed a zustand store, so the throw happens on import and takes down every suite that transitively
 * imports them — twelve renderer test files on Node 25, none of them named after the store that
 * failed. See #412.
 *
 * Two properties, both load-bearing:
 *
 * 1. The feature check asks whether the METHOD is callable, not whether the object exists. That is
 *    the distinction the old guard could not make.
 * 2. It sits inside the try/catch with the call. `typeof localStorage?.getItem` looks like it
 *    cannot throw, but `typeof` only shields a BARE identifier — the operand here is a member
 *    expression, so an environment with no `localStorage` binding at all raises ReferenceError
 *    before `typeof` sees anything. The catch is what makes the optional chain safe, not decoration
 *    around it. Storage can also throw once it exists (Safari private mode, a locked-down embedder,
 *    quota on write), and both failures want the same answer.
 *
 * Everything persisted through here is a nicety — a remembered panel, a view choice, a hint already
 * shown. None of it may fail the UI, so a read that cannot happen is `null` and a write that cannot
 * happen is silence.
 */

/**
 * The stored string, or `whenUnreadable` when storage is absent, method-less, or throws.
 *
 * The default collapses "storage is broken" into "no value", which is what every caller that just
 * wants a remembered nicety means. One caller needs them apart: the copy hint passes its own
 * fallback so that UNREADABLE storage counts as "already seen" — a hint that can never be
 * remembered would otherwise reappear on every single copy — while an UNSET key still means not
 * seen. Keeping that distinction in the argument rather than in a second predicate is what stops
 * the two cases drifting apart at the call site.
 */
export function readLocal(key: string, whenUnreadable: string | null = null): string | null {
  try {
    if (typeof localStorage?.getItem !== 'function') return whenUnreadable
    return localStorage.getItem(key)
  } catch {
    return whenUnreadable
  }
}

/** Persist a string, or do nothing when storage is absent, method-less, full, or throws. */
export function writeLocal(key: string, value: string): void {
  try {
    if (typeof localStorage?.setItem !== 'function') return
    localStorage.setItem(key, value)
  } catch {
    /* quota, private mode, disabled storage — never fail the UI over a remembered nicety */
  }
}

/** Remove a key, or do nothing when storage is absent, method-less, or throws. */
export function removeLocal(key: string): void {
  try {
    if (typeof localStorage?.removeItem !== 'function') return
    localStorage.removeItem(key)
  } catch {
    /* a blocked origin or a locked-down embedder — removing a nicety may fail quietly */
  }
}

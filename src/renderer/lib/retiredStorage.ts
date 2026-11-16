// Live links were retired in 2026-11. These localStorage keys held their per-viewer conveniences
// (link defaults, the pinned and last-open Live chat); nothing reads them any more. Removed once at
// renderer boot. Each removal is its own try/catch: a storage that throws (private mode, a blocked
// origin) costs that key, never the boot.
export const RETIRED_STORAGE_KEYS = ['nodeterm.liveLinkDefaults', 'nodeterm.liveChatPinned', 'nodeterm.liveChatLink'] as const

export function removeRetiredStorageKeys(storage: Pick<Storage, 'removeItem'> | null | undefined): void {
  if (!storage) return
  for (const key of RETIRED_STORAGE_KEYS) {
    try {
      storage.removeItem(key)
    } catch {
      // A storage that refuses one key may still take the next.
    }
  }
}

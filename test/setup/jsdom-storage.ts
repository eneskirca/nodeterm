// TEST-ONLY — give jsdom suites jsdom's Web Storage, not Node's.
//
// Node 25+ ships its own global `localStorage` / `sessionStorage` (Web Storage enabled by
// default). Without `--localstorage-file` the getter answers `undefined` (and prints an
// ExperimentalWarning). vitest's jsdom environment copies a window key onto the global only when
// the global does NOT already have it (`getWindowKeys`: `if (k in global) return KEYS.includes(k)`),
// and the storage keys are not in that list — so under Node 25+ every `// @vitest-environment
// jsdom` suite saw Node's `undefined` instead of jsdom's working Storage, and
// `localStorage.clear()` threw. On Node 22/24 (CI) the key is absent and jsdom's copy lands
// normally, which is why it only failed on a newer local Node.
//
// Only acts in a jsdom environment (vitest sets `globalThis.jsdom` there). Node-environment
// suites keep stubbing storage themselves, exactly as before.
type JsdomGlobal = { jsdom?: { window: Window } }

const dom = (globalThis as JsdomGlobal).jsdom
if (dom) {
  for (const key of ['localStorage', 'sessionStorage'] as const) {
    const storage = dom.window[key]
    if (globalThis[key] === storage) continue
    // Configurable + writable so a suite can still `vi.stubGlobal` / redefine it.
    Object.defineProperty(globalThis, key, { value: storage, configurable: true, writable: true })
  }
}

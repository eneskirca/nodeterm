/**
 * Move a node root to a new parent without losing the keyboard (focus mode, #78 / #757).
 *
 * MEASURED in Electron 42 (built-in display): Blink blurs a focused descendant SYNCHRONOUSLY inside
 * `appendChild` — `focusout` with `relatedTarget` null, the root still connected, `activeElement`
 * already `<body>` — and nothing re-focuses it, so entering or leaving focus mode dropped the
 * keyboard on the floor in BOTH focus modes. An immediate `focus()` after the move takes.
 *
 * `setMoving(true/false)` brackets exactly the move, so a focus listener can tell this blur from the
 * user going elsewhere (click to focus would otherwise read it as `release`). It is lowered even when
 * the move throws.
 */
export function reparentKeepingFocus(
  root: HTMLElement,
  parent: HTMLElement,
  setMoving: (moving: boolean) => void
): void {
  const active = document.activeElement
  const held = active instanceof HTMLElement && root.contains(active) ? active : null
  setMoving(true)
  try {
    parent.appendChild(root)
  } finally {
    setMoving(false)
  }
  if (held && held.isConnected && root.contains(held)) held.focus({ preventScroll: true })
}

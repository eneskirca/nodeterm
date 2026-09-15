/** Publishing pending canvas edits is not authorization: main still resolves the pair from its
 * own store and checks runtime ownership, consent and verified pane identity. Never publish over
 * an unresolved external-edit conflict merely because an agent asked to send a message. */
export async function syncMessageScope(options: {
  needed: boolean
  conflict: boolean
  save: () => Promise<boolean>
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!options.needed) return { ok: true }
  if (options.conflict) {
    return {
      ok: false,
      error: 'Message not sent: resolve the canvas file conflict and save before trying again.'
    }
  }
  try {
    if (await options.save()) return { ok: true }
  } catch {
    // Serialization can fail before the workspace IPC. Neither failure may forward a message
    // against the old scope, and neither is evidence that the target belongs to another project.
  }
  return {
    ok: false,
    error: 'Message not sent: pending canvas changes could not be saved. Save successfully before trying again.'
  }
}

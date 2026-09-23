// Cleanup knows commands we generated, not merely a substring a user may have mentioned.
// A custom handler beside ours survives; an edited command is deliberately retained.
export function removeExactHooks(config: Record<string, unknown>, commands: string[]): Record<string, unknown> {
  if (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks)) return config
  const hooks = { ...config.hooks } as Record<string, unknown>
  for (const [event, defs] of Object.entries(hooks)) {
    if (!Array.isArray(defs)) continue
    const next = defs.flatMap((d) => {
      if (!d || typeof d !== 'object') return [d]
      if (commands.includes(d.bash)) return [] // Copilot's flat grammar
      if (!Array.isArray(d.hooks)) return [d]
      const kept = d.hooks.filter((h: { command?: string } | null) => !h || !commands.includes(h.command ?? ''))
      if (kept.length === d.hooks.length) return [d]
      return kept.length ? [{ ...d, hooks: kept }] : []
    })
    if (next.length) hooks[event] = next
    else if (defs.length) delete hooks[event]
  }
  return { ...config, hooks }
}

// Renderer-side registration of the custom-agent → baseAgent resolver.
//
// The capability predicates in `@shared/agents/config` (hasHooks, canResume, mintsSessionId,
// hasPermissionMode, canControlCanvas, …) take only an `AgentId` and resolve custom inheritance
// through an injected registry (config.ts cannot import the settings store without a cycle). The
// main process registers its own resolver in pty-manager.init; the RENDERER needs one too, because
// it calls those same predicates 60+ times to gate UI (status badges, hibernation, canvas control,
// resume, restart menus). This reads the live Zustand settings store, so registering once at boot
// is enough — a settings update is reflected on the next predicate call.

import { setCustomAgentBaseResolver } from '@shared/agents/config'
import { useSettings } from './settings'

/** Register once at boot (called from boot.tsx). Idempotent. */
export function initAgentResolver(): void {
  setCustomAgentBaseResolver(
    (id) => useSettings.getState().settings.customAgents.find((c) => c.id === id)?.baseAgent
  )
}

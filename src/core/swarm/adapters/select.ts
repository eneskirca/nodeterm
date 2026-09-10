import type { AgentAdapter } from './types'
import { createCliLaunchAdapter } from './cli-launch'
import { createMockAdapter } from './mock'

export function swarmAdapterMode(env: NodeJS.ProcessEnv = process.env): 'mock' | 'live' {
  return env.NODETERM_SWARM_ADAPTER === 'live' ? 'live' : 'mock'
}

export function createSwarmAdapter(opts: {
  userDataDir: string
  sendText?: (nodeId: string, text: string, flags?: { enter?: boolean }) => Promise<boolean>
  paneCommand?: (nodeId: string) => Promise<string | null>
  env?: NodeJS.ProcessEnv
  resolveLaunch?: Parameters<typeof createCliLaunchAdapter>[0]['resolveLaunch']
}): AgentAdapter {
  if (swarmAdapterMode(opts.env) === 'live') {
    return createCliLaunchAdapter({
      userDataDir: opts.userDataDir,
      sendText: opts.sendText,
      paneCommand: opts.paneCommand,
      env: opts.env,
      resolveLaunch: opts.resolveLaunch
    })
  }
  return createMockAdapter()
}

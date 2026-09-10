import fs from 'fs'
import path from 'path'
import { parseSwarmMission } from '../../shared/swarm/schemas'
import type { SwarmMission } from '../../shared/swarm/types'
import { writeFileAtomic } from '../fs-atomic'

export function swarmDir(userDataDir: string): string {
  return path.join(userDataDir, 'swarm-missions')
}

export function missionPath(userDataDir: string, missionId: string): string {
  return path.join(swarmDir(userDataDir), `${missionId}.json`)
}

export async function saveMission(userDataDir: string, mission: SwarmMission): Promise<void> {
  const dir = swarmDir(userDataDir)
  fs.mkdirSync(dir, { recursive: true })
  await writeFileAtomic(missionPath(userDataDir, mission.id), JSON.stringify(mission, null, 2))
}

export function loadMission(userDataDir: string, missionId: string): SwarmMission | null {
  try {
    const raw = fs.readFileSync(missionPath(userDataDir, missionId), 'utf8').replace(/\r\n/g, '\n')
    return parseSwarmMission(JSON.parse(raw))
  } catch {
    return null
  }
}

export function listMissions(userDataDir: string, projectId?: string): SwarmMission[] {
  const dir = swarmDir(userDataDir)
  if (!fs.existsSync(dir)) return []
  const out: SwarmMission[] = []
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const m = loadMission(userDataDir, name.slice(0, -5))
    if (!m) continue
    if (projectId && m.projectId !== projectId) continue
    out.push(m)
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

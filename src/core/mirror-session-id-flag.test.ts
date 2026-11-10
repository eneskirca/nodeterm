// `MirrorSettings.claudeSessionIdFlag` — what lets a PHONE launch `claude --session-id <uuid>`.
//
// The phone starts the session itself and cannot probe the host's CLI, so it adds the flag only
// when the status file it reads says the host's claude takes it. Three writers publish that file
// (the desktop's local mirror, the Server Edition's, and the per-project slice the desktop pushes
// onto an SSH host), each from an inline closure in a shell's boot code. A writer that forgets the
// field costs nothing visible — the phone just keeps launching bare, and its nodes go on having no
// persisted session id on that surface only. So the three sites are pinned at source level, the
// same guard `hook-verified-parity.test.ts` uses for the two raw listeners.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mirrorClaudeSessionIdFlag } from './agent-status-mirror'

describe('mirrorClaudeSessionIdFlag', () => {
  it('publishes the field only for a SEEN true', () => {
    expect(mirrorClaudeSessionIdFlag(true)).toEqual({ claudeSessionIdFlag: true })
  })

  it('publishes nothing when the CLI lacks the flag or was not probed', () => {
    // Absent, never `false`: a reader must treat "old host file" and "CLI without the flag" the
    // same way (no flag), and an explicit false invites one that does not.
    expect(mirrorClaudeSessionIdFlag(false)).toEqual({})
    expect(mirrorClaudeSessionIdFlag(undefined)).toEqual({})
  })
})

describe('every status-file writer publishes it from the right CLI', () => {
  const src = (rel: string): string => readFileSync(resolve(__dirname, '..', rel), 'utf-8')

  it('desktop: the local mirror answers with the LOCAL claude probe', () => {
    expect(src('main/index.ts')).toContain('...mirrorClaudeSessionIdFlag(localClaudeCaps?.sessionIdFlag)')
  })

  it('Server Edition: same field from its own local probe', () => {
    expect(src('server/index.ts')).toContain('...mirrorClaudeSessionIdFlag(localClaudeCaps?.sessionIdFlag)')
  })

  it('SSH slice: the HOST\'s own probe, never this machine\'s', () => {
    expect(src('main/index.ts')).toContain(
      '...mirrorClaudeSessionIdFlag(sshProjectManager?.remoteClaudeSessionIdFlagFor(projectId))'
    )
  })
})

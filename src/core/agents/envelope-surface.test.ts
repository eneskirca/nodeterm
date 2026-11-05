import { expect, it } from 'vitest'
import { envelopeSurfaceReady, ownerEnvelopeSurfaceReady } from './envelope-surface'
const codex = '› work\n\nmodel · /synthetic\n← for agents · ? for shortcuts                 ⚠ 2 warnings · f2 to view'
it('one common positive reader accepts the observed Codex shape and rejects decisions/unknowns', () => {
  expect(envelopeSurfaceReady(codex, 'codex')).toBe(true)
  expect(envelopeSurfaceReady('Would you like to run the following command?\n1. Yes, proceed', 'codex')).toBe(false)
  expect(envelopeSurfaceReady('Unknown', 'codex')).toBe(false)
})
it.each(['gemini', 'opencode', 'grok', 'copilot', 'antigravity'])('%s has no positive surface just because Codex content is visible', agent => {
  expect(envelopeSurfaceReady(codex, agent)).toBe(false)
})
it('host/native reader is chosen by the OS owner, never by the screen contents', () => {
  const owner = { panePid: 1, tty: 't', command: 'codex', argv: ['codex'], pids: [2] }
  expect(ownerEnvelopeSurfaceReady(codex, owner)).toBe(true)
  expect(ownerEnvelopeSurfaceReady(codex, { ...owner, command: 'bash', argv: ['bash'] })).toBe(false)
})

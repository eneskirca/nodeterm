import { describe, it, expect } from 'vitest'
import { canControlCanvas } from './config'

describe('canControlCanvas', () => {
  it('is true for the three builtins, not custom agents', () => {
    expect(canControlCanvas('claude')).toBe(true)
    expect(canControlCanvas('codex')).toBe(true)
    expect(canControlCanvas('gemini')).toBe(true)
    expect(canControlCanvas('custom:abc')).toBe(false)
  })

  it('grok may drive the canvas', () => {
    // Discovery needs no new installer: grok scans `~/.claude/skills` by default (its shipped
    // docs, user-guide/08-skills.md — "Claude Code compatibility (configurable)", switched off
    // only by `[compat.claude] skills = false` / GROK_CLAUDE_SKILLS_ENABLED=false), which is where
    // nodeterm already writes manage-nodeterm-canvas — locally and, via
    // RemoteHooks.installCanvasControl, on an SSH host. This list is what sets
    // NODETERM_CANVAS_CONTROL in the session env, i.e. what makes the shim usable at all.
    expect(canControlCanvas('grok')).toBe(true)
  })
})

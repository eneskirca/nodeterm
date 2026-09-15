import { describe, expect, it } from 'vitest'
import { pasteThenSubmitWhenSettled, type SettleSurface } from './settled-submit'

const ENVELOPE = '--- NODETERM MESSAGE abc ---\nbody\n--- END NODETERM MESSAGE abc ---'
const noWait = { wait: async () => {} }

function surface(frames: Array<string | null>, pasteOk = true) {
  const log: string[] = []
  let i = 0
  const s: SettleSurface = {
    capture: async () => frames[Math.min(i++, frames.length - 1)],
    paste: async () => {
      log.push('paste')
      return pasteOk
    },
    submit: async () => {
      log.push('submit')
    }
  }
  return { s, log }
}

describe('pasteThenSubmitWhenSettled', () => {
  it('submits in a second step once the footer is on screen', async () => {
    const { s, log } = surface(['prompt>', 'prompt>', `prompt> ${ENVELOPE}`])
    expect(await pasteThenSubmitWhenSettled(ENVELOPE, s, noWait)).toBe(true)
    expect(log).toEqual(['paste', 'submit'])
  })

  it('still finds the footer through the Braille animation Codex paints over its composer', async () => {
    // Measured 2026-09-14: dots from Codex's idle animation land inside rendered envelope lines.
    const noisy = '  --- END NODE⠈TERM MESS⠁AGE abc ---   ⠠⠄'
    const { s, log } = surface(['prompt>', noisy], true)
    expect(await pasteThenSubmitWhenSettled(ENVELOPE, s, { ...noWait, polls: 1 })).toBe(true)
    expect(log).toEqual(['paste', 'submit'])
  })

  it('reports the paste but never submits a pane that did not settle', async () => {
    let n = 0
    const s: SettleSurface = {
      capture: async () => `frame ${n++}`, // always changing, never the footer
      paste: async () => true,
      submit: async () => {
        throw new Error('must not submit')
      }
    }
    expect(await pasteThenSubmitWhenSettled(ENVELOPE, s, noWait)).toBe(true)
  })

  it('submits after two identical changed frames when the footer is not rendered verbatim', async () => {
    const { s, log } = surface(['prompt>', 'changed', 'changed'])
    expect(await pasteThenSubmitWhenSettled(ENVELOPE, s, noWait)).toBe(true)
    expect(log).toEqual(['paste', 'submit'])
  })

  it('answers false and submits nothing when the paste itself failed, or there is no envelope', async () => {
    const failed = surface(['prompt>'], false)
    expect(await pasteThenSubmitWhenSettled(ENVELOPE, failed.s, noWait)).toBe(false)
    expect(failed.log).toEqual(['paste'])
    const empty = surface(['prompt>'])
    expect(await pasteThenSubmitWhenSettled('', empty.s, noWait)).toBe(false)
    expect(empty.log).toEqual([])
  })
})

import { describe, expect, it, vi } from 'vitest'
import { sendTextWhenSettled, type TextPane } from './settled-text'

function fixture() {
  let screen: string | null = 'prompt'
  let alive = true
  const write = vi.fn()
  const pane: TextPane = {
    current: () => alive, bracketed: async () => true,
    capture: async () => screen, write
  }
  return { pane, write, screen: (s: string | null) => { screen = s }, exit: () => { alive = false } }
}
describe('observed text settlement', () => {
  it('waits for a slow reader and a stable render, then submits exactly once', async () => {
    const f = fixture()
    let polls = 0
    const wait = async () => {
      expect(f.write.mock.calls).toHaveLength(1)
      if (++polls === 4) f.screen('prompt hello')
    }
    expect(await sendTextWhenSettled(f, 'hello', true, f.pane, { wait })).toBe(true)
    expect(polls).toBe(5)
    expect(f.write.mock.calls).toEqual([['\x1b[200~hello\x1b[201~'], ['\r']])
  })
  it.each(['unchanged', 'unrelated', 'unreadable', 'unstable'])('never submits %s output and bounds the wait', async (kind) => {
    const f = fixture()
    f.screen('hello') // old occurrence is not evidence of THIS paste
    let polls = 0
    const wait = async () => {
      polls++
      if (kind === 'unrelated') f.screen('spinner')
      if (kind === 'unreadable') f.screen(null)
      if (kind === 'unstable') f.screen('hello ' + polls)
    }
    expect(await sendTextWhenSettled(f, 'hello', true, f.pane, { wait })).toBe('pasted-not-submitted')
    expect(polls).toBe(15)
    expect(f.write).toHaveBeenCalledTimes(1)
  })
  it('does not send Enter after the generation exits/replaces', async () => {
    const f = fixture()
    expect(await sendTextWhenSettled(f, 'hello', true, f.pane, { wait: async () => f.exit() })).toBe('pasted-not-submitted')
    expect(f.write).toHaveBeenCalledTimes(1)
  })
  it('refuses overlapping text and bare Enter before they write', async () => {
    const f = fixture()
    let once = false
    const overlaps: unknown[] = []
    await sendTextWhenSettled(f, 'hello', true, f.pane, { wait: async () => {
      if (!once) {
        once = true
        overlaps.push(await sendTextWhenSettled(f, '', true, f.pane))
        overlaps.push(await sendTextWhenSettled(f, 'other', true, f.pane, { wait: async () => {} }))
      }
      f.screen('hello')
    } })
    expect(overlaps).toEqual([false, false])
    expect(f.write.mock.calls).toEqual([['\x1b[200~hello\x1b[201~'], ['\r']])
  })
  it('rechecks liveness after capture and paste mode before Enter', async () => {
    for (const change of ['exit', 'mode']) {
      const f = fixture()
      let captures = 0
      vi.spyOn(f.pane, 'capture').mockImplementation(async () => {
        if (++captures === 3 && change === 'exit') f.exit()
        return captures === 1 ? 'prompt' : 'hello'
      })
      vi.spyOn(f.pane, 'bracketed').mockImplementation(async () => !(change === 'mode' && captures >= 3))
      expect(await sendTextWhenSettled(f, 'hello', true, f.pane, { wait: async () => {} })).toBe('pasted-not-submitted')
      expect(f.write).toHaveBeenCalledTimes(1)
    }
  })
  it('preserves accepted-paste semantics when the final write throws', async () => {
    const f = fixture()
    f.write.mockImplementation((s) => { if (s === '\r') throw Error('exited') })
    expect(await sendTextWhenSettled(f, 'hello', true, f.pane, {
      wait: async () => f.screen('hello')
    })).toBe('pasted-not-submitted')
    expect(f.write).toHaveBeenCalledTimes(2)
  })
  it('reports a folded multiline paste without submitting or duplicating it', async () => {
    const f = fixture()
    const text = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n')
    expect(await sendTextWhenSettled(f, text, true, f.pane, {
      wait: async () => f.screen('> [Pasted text #1 +80 lines]')
    })).toBe('pasted-not-submitted')
    expect(f.write.mock.calls).toEqual([[`\x1b[200~${text}\x1b[201~`]])
  })
  it('keeps insert-only and empty text immediate', async () => {
    const f = fixture()
    const capture = vi.spyOn(f.pane, 'capture')
    expect(await sendTextWhenSettled(f, 'hello', false, f.pane)).toBe(true)
    expect(await sendTextWhenSettled(f, '', true, f.pane)).toBe(true)
    expect(capture).not.toHaveBeenCalled()
    expect(f.write.mock.calls).toEqual([['\x1b[200~hello\x1b[201~'], ['\r']])
  })
})

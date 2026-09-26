// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentStatus } from '../state/agentStatus'
import { useContextWindow } from '../state/contextWindow'
import { deliverToComposer } from '../lib/chatComposerDictation'
import { COMPOSER_EFFORT_MIN_WIDTH, COMPOSER_MODEL_MIN_WIDTH } from '../lib/chatComposer'

/**
 * The claude.ai-style composer (lib/chatComposer.ts is the pure half). This file pins the GLUE:
 * "+" / drop / paste turn files into paths IN THE DRAFT, the mic targets THIS composer and the take
 * lands in the textarea, and the model / effort labels type the agent's own picker command through
 * the SAME send gate as a message before flipping to the terminal.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { sendText, session } = vi.hoisted(() => {
  const sendText = vi.fn((_id: string, _text: string): Promise<boolean | 'pasted-not-submitted'> => Promise.resolve(true))
  const session = {
    api: {
      chat: { readTranscript: async () => ({ messages: [], found: true }) },
      pty: { sendText }
    }
  }
  return { sendText, session }
})
vi.mock('../session/session', () => ({ useSession: () => session }))

import { ChatPanel } from './ChatPanel'
import { escapeDroppedPath } from '../terminal/file-drop'

const NODE = 'n-composer'
const SESSION = 's-composer'
let host: HTMLDivElement
let root: Root
let pathsForFiles: ReturnType<typeof vi.fn>
let onShowTerminal: ReturnType<typeof vi.fn>

function setAgentState(state: 'working' | 'waiting' | 'done' | undefined): void {
  useAgentStatus.setState((s) => ({
    byId: { ...s.byId, [NODE]: { ...(s.byId[NODE] ?? {}), state } as (typeof s.byId)[string] }
  }))
}

function setUsage(model: string | null, effort?: string): void {
  useContextWindow.getState().set({
    sessionId: SESSION,
    usedTokens: 10,
    windowTokens: 100,
    usedPercent: 10,
    model,
    ...(effort ? { effort } : {}),
    windowSource: 'transcript',
    updatedAt: Date.now()
  })
}

async function mount(props: { withPicker?: boolean; withFiles?: boolean } = {}): Promise<void> {
  const { withPicker = true, withFiles = true } = props
  await act(async () => {
    root.render(
      <ChatPanel
        nodeId={NODE}
        sessionId={SESSION}
        agentId="claude"
        pathsForFiles={withFiles ? (pathsForFiles as never) : undefined}
        onShowTerminal={withPicker ? (onShowTerminal as never) : undefined}
      />
    )
  })
}

const textarea = () => host.querySelector('.term-chat__compose textarea') as HTMLTextAreaElement
const button = (label: string) => host.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null
const modelBtn = () => host.querySelector('.term-chat__model') as HTMLButtonElement | null
const effortBtn = () => host.querySelector('.term-chat__effort') as HTMLButtonElement | null

function type(ta: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  setter.call(ta, text)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
}

const flush = () => act(async () => {
  await new Promise((r) => setTimeout(r, 0))
})

beforeEach(() => {
  sendText.mockReset()
  sendText.mockResolvedValue(true)
  // Production's own escaper (the one `droppedPaths` applies), not a re-implementation of it.
  pathsForFiles = vi.fn(async (files: File[]) => files.map((f) => escapeDroppedPath(`/tmp/${f.name}`)))
  onShowTerminal = vi.fn()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  useAgentStatus.setState((s) => {
    const byId = { ...s.byId }
    delete byId[NODE]
    return { byId }
  })
  useContextWindow.setState((s) => {
    const bySessionId = { ...s.bySessionId }
    delete bySessionId[SESSION]
    return { bySessionId }
  })
})

describe('composer attach ("+", paste, drop)', () => {
  it('"+" opens the file picker, and the picked files land in the draft as paths', async () => {
    setAgentState('done')
    await mount()
    await act(async () => type(textarea(), 'look at'))
    const input = host.querySelector('.term-chat__compose input[type="file"]') as HTMLInputElement
    const clicked = vi.spyOn(input, 'click')
    await act(async () => button('Attach files')!.click())
    expect(clicked).toHaveBeenCalled()

    const file = new File(['x'], 'shot 1.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()
    expect(pathsForFiles).toHaveBeenCalledWith([file])
    expect(textarea().value).toBe('look at /tmp/shot\\ 1.png ')
    // Attaching never sends: the user decides when.
    expect(sendText).not.toHaveBeenCalled()
  })

  it('a pasted file (a screenshot) becomes a path in the draft, not raw text', async () => {
    setAgentState('done')
    await mount()
    const file = new File(['x'], 'paste.png', { type: 'image/png' })
    const ev = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'clipboardData', {
      value: { files: [file], items: [], getData: () => '' }
    })
    await act(async () => {
      textarea().dispatchEvent(ev)
    })
    await flush()
    expect(ev.defaultPrevented).toBe(true)
    expect(textarea().value).toBe('/tmp/paste.png ')
  })

  it('a text paste is left to the textarea', async () => {
    setAgentState('done')
    await mount()
    const ev = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'clipboardData', {
      value: { files: [], items: [], getData: (t: string) => (t === 'text/plain' ? 'hi' : '') }
    })
    await act(async () => {
      textarea().dispatchEvent(ev)
    })
    expect(ev.defaultPrevented).toBe(false)
    expect(pathsForFiles).not.toHaveBeenCalled()
  })

  it('a file dropped on the composer lands in the draft and never reaches the canvas', async () => {
    setAgentState('done')
    await mount()
    // The canvas's image-drop listener is on `window`; React's stopPropagation must keep it there.
    const outer = vi.fn()
    window.addEventListener('drop', outer)
    const file = new File(['x'], 'notes.md', { type: 'text/markdown' })
    const ev = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'dataTransfer', { value: { files: [file], types: ['Files'] } })
    await act(async () => {
      host.querySelector('.term-chat__composer')!.dispatchEvent(ev)
    })
    await flush()
    window.removeEventListener('drop', outer)
    expect(ev.defaultPrevented).toBe(true)
    expect(outer).not.toHaveBeenCalled()
    expect(textarea().value).toBe('/tmp/notes.md ')
  })

  it('the drop highlight never sticks: a drag cancelled without a dragleave (Esc, app switch) clears it', async () => {
    setAgentState('done')
    await mount()
    const box = host.querySelector('.term-chat__composer')!
    const over = async () => {
      const ev = new Event('dragover', { bubbles: true, cancelable: true })
      Object.defineProperty(ev, 'dataTransfer', { value: { types: ['Files'], dropEffect: 'none' } })
      await act(async () => {
        box.dispatchEvent(ev)
      })
    }
    await over()
    expect(box.classList.contains('term-chat__composer--drop')).toBe(true)
    await act(async () => {
      window.dispatchEvent(new Event('dragend'))
    })
    expect(box.classList.contains('term-chat__composer--drop')).toBe(false)
    await over()
    expect(box.classList.contains('term-chat__composer--drop')).toBe(true)
    await act(async () => {
      window.dispatchEvent(new Event('blur'))
    })
    expect(box.classList.contains('term-chat__composer--drop')).toBe(false)
    await over()
    await act(async () => {
      window.dispatchEvent(new Event('drop'))
    })
    expect(box.classList.contains('term-chat__composer--drop')).toBe(false)
  })

  it('says so when no path could be resolved (an upload that failed)', async () => {
    setAgentState('done')
    pathsForFiles.mockResolvedValue([])
    await mount()
    const ev = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'dataTransfer', {
      value: { files: [new File(['x'], 'a.png')], types: ['Files'] }
    })
    await act(async () => {
      host.querySelector('.term-chat__composer')!.dispatchEvent(ev)
    })
    await flush()
    expect(textarea().value).toBe('')
    expect(host.querySelector('.term-chat__attach-note--failed')?.textContent).toMatch(/Could not attach/)
  })

  it('has no "+" when the mount site cannot resolve files', async () => {
    setAgentState('done')
    await mount({ withFiles: false })
    expect(button('Attach files')).toBeNull()
  })
})

describe('composer mic', () => {
  it('asks for dictation INTO this composer, and the take lands in the textarea (not the pane)', async () => {
    setAgentState('done')
    await mount()
    await act(async () => type(textarea(), 'please'))
    const seen: Array<{ nodeId: string; composerId?: string }> = []
    const h = (e: Event) => seen.push((e as CustomEvent).detail)
    window.addEventListener('nodeterm:dictate', h)
    await act(async () => button('Dictate into the message')!.click())
    window.removeEventListener('nodeterm:dictate', h)
    expect(seen).toHaveLength(1)
    expect(seen[0].nodeId).toBe(NODE)
    expect(typeof seen[0].composerId).toBe('string')

    let delivered = false
    await act(async () => {
      delivered = deliverToComposer(seen[0].composerId!, 'fix the tests')
    })
    expect(delivered).toBe(true)
    expect(textarea().value).toBe('please fix the tests')
    expect(sendText).not.toHaveBeenCalled()
  })
})

describe('model / effort labels', () => {
  it('shows the session model and effort from the ContextMeter source', async () => {
    setAgentState('done')
    setUsage('claude-fable-5-1', 'medium')
    await mount()
    expect(modelBtn()?.textContent).toBe('Fable 5.1')
    expect(effortBtn()?.textContent).toBe('Medium')
  })

  it('hides the model label when the model is unknown', async () => {
    setAgentState('done')
    await mount()
    expect(modelBtn()).toBeNull()
    expect(effortBtn()).toBeNull()
  })

  it('hides both labels when the mount site cannot flip to the terminal', async () => {
    setAgentState('done')
    setUsage('claude-opus-5', 'high')
    await mount({ withPicker: false })
    expect(modelBtn()).toBeNull()
    expect(effortBtn()).toBeNull()
  })

  it('clicking the model sends /model through the send gate and flips to the terminal', async () => {
    setAgentState('done')
    setUsage('claude-opus-5', 'high')
    await mount()
    await act(async () => modelBtn()!.click())
    await flush()
    expect(sendText).toHaveBeenCalledWith(NODE, '/model')
    expect(onShowTerminal).toHaveBeenCalledTimes(1)
  })

  it('clicking the effort sends /effort and flips to the terminal', async () => {
    setAgentState('done')
    setUsage('claude-opus-5', 'xhigh')
    await mount()
    expect(effortBtn()?.textContent).toBe('xHigh')
    await act(async () => effortBtn()!.click())
    await flush()
    expect(sendText).toHaveBeenCalledWith(NODE, '/effort')
    expect(onShowTerminal).toHaveBeenCalledTimes(1)
  })

  it('is disabled while the agent works or a dialog is up (a picker command would answer it)', async () => {
    setUsage('claude-opus-5', 'high')
    setAgentState('working')
    await mount()
    expect(modelBtn()!.disabled).toBe(true)
    await act(async () => setAgentState('waiting'))
    expect(modelBtn()!.disabled).toBe(true)
    expect(effortBtn()!.disabled).toBe(true)
  })

  it('re-reads the gate at click time: a dialog that arrived after the last render still blocks', async () => {
    setUsage('claude-opus-5', 'high')
    setAgentState('done')
    await mount()
    await act(async () => {
      setAgentState('waiting')
      modelBtn()!.click()
    })
    await flush()
    expect(sendText).not.toHaveBeenCalled()
    expect(onShowTerminal).not.toHaveBeenCalled()
  })

  it('does not flip when the command was pasted but not submitted', async () => {
    setUsage('claude-opus-5', 'high')
    setAgentState('done')
    sendText.mockResolvedValue('pasted-not-submitted')
    await mount()
    await act(async () => modelBtn()!.click())
    await flush()
    expect(sendText).toHaveBeenCalledWith(NODE, '/model')
    expect(onShowTerminal).not.toHaveBeenCalled()
  })

  it('a refused write (session gone) neither flips nor pretends: the composer goes read-only', async () => {
    setUsage('claude-opus-5', 'high')
    setAgentState('done')
    sendText.mockResolvedValue(false)
    await mount()
    await act(async () => modelBtn()!.click())
    await flush()
    expect(onShowTerminal).not.toHaveBeenCalled()
    expect(textarea().disabled).toBe(true)
    expect(textarea().placeholder).toMatch(/Can't write to this session/)
  })

  it('one picker command at a time: a second click or an Enter while /model is in flight types nothing', async () => {
    // /model opens a local picker that fires NO hook, so the gate still reads `done`; without the
    // in-flight guard the second click would paste "/model" + Enter INTO that picker.
    setUsage('claude-opus-5', 'high')
    setAgentState('done')
    let release: (v: boolean) => void = () => {}
    sendText.mockImplementation(() => new Promise<boolean>((r) => (release = r)))
    await mount()
    await act(async () => type(textarea(), 'hello'))
    // A double click lands before React re-renders the disabled state: only the ref can stop it.
    await act(async () => {
      modelBtn()!.click()
      modelBtn()!.click()
      effortBtn()!.click()
    })
    expect(modelBtn()!.disabled).toBe(true)
    expect(modelBtn()!.getAttribute('aria-disabled')).toBe('true')
    expect(effortBtn()!.disabled).toBe(true)
    // The textarea stays live, but its Enter must not reach the pane while the picker opens.
    await act(async () => {
      textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    expect(sendText).toHaveBeenCalledTimes(1)
    expect(sendText).toHaveBeenCalledWith(NODE, '/model')
    await act(async () => release(true))
    await flush()
    expect(onShowTerminal).toHaveBeenCalledTimes(1)
  })

  it('the in-flight guard lifts after a failure, so the label works again', async () => {
    setUsage('claude-opus-5', 'high')
    setAgentState('done')
    sendText.mockResolvedValueOnce('pasted-not-submitted').mockResolvedValueOnce(true)
    await mount()
    await act(async () => modelBtn()!.click())
    await flush()
    expect(modelBtn()!.disabled).toBe(false)
    await act(async () => modelBtn()!.click())
    await flush()
    expect(sendText).toHaveBeenCalledTimes(2)
    expect(onShowTerminal).toHaveBeenCalledTimes(1)
  })

  it('stands the labels down in the unconfirmed-send window (#953): the turn is starting, not idle', async () => {
    setUsage('claude-opus-5', 'high')
    setAgentState('done')
    await mount()
    await act(async () => type(textarea(), 'go'))
    await act(async () => {
      textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    await flush()
    expect(sendText).toHaveBeenCalledWith(NODE, 'go', { typed: true })
    expect(modelBtn()!.disabled).toBe(true)
    expect(effortBtn()!.disabled).toBe(true)
    // The real state speaks (the turn ran and finished): the labels come back.
    await act(async () => setAgentState('working'))
    await act(async () => setAgentState('done'))
    expect(modelBtn()!.disabled).toBe(false)
  })

  it('drops the effort label first, then the model label, as the composer narrows', async () => {
    // Every observer (the thread's and the composer's) hears the resize, like the real thing.
    const cbs: Array<(entries: Array<{ contentRect: { width: number } }>) => void> = []
    const fire = (width: number) => cbs.forEach((cb) => cb([{ contentRect: { width } }]))
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: (entries: Array<{ contentRect: { width: number } }>) => void) {
          cbs.push(cb)
        }
        observe(): void {}
        disconnect(): void {}
      }
    )
    setAgentState('done')
    setUsage('claude-opus-5', 'high')
    await mount()
    await act(async () => fire(COMPOSER_EFFORT_MIN_WIDTH + 50))
    expect(modelBtn()).not.toBeNull()
    expect(effortBtn()).not.toBeNull()
    await act(async () => fire(COMPOSER_EFFORT_MIN_WIDTH - 1))
    expect(modelBtn()).not.toBeNull()
    expect(effortBtn()).toBeNull()
    await act(async () => fire(COMPOSER_MODEL_MIN_WIDTH - 1))
    expect(modelBtn()).toBeNull()
    expect(effortBtn()).toBeNull()
    // The controls that DO something stay at every width.
    expect(button('Attach files')).not.toBeNull()
    expect(button('Dictate into the message')).not.toBeNull()
  })
})

// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchGlobalKeydown, type GlobalKeydownDeps, type GlobalKeyEvent } from './globalKeybindings'
import { shortcutDictationFocus } from './chatComposerDictation'

/**
 * Shortcut dictation (keyed chord, hold-to-talk) around the ⌘M chat view, against the REAL
 * elements: the composer (ChatComposer) and the plan / question answer controls
 * (ChatAnswerControls), whose "Revise…" textarea and "Other" input share the composer textarea's
 * `term-chat__input` class. A class-keyed rule offered the chord in those fields, and with no
 * composer to target the shortcut fell back to the selected terminal — the HIDDEN pane showing the
 * very plan / question dialog they answer.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { session } = vi.hoisted(() => ({
  session: { api: { pty: { sendText: async () => true as const } } }
}))
vi.mock('../session/session', () => ({ useSession: () => session }))

import { ChatComposer } from '../nodes/ChatComposer'
import { PlanAnswerControls, QuestionAnswerControls } from '../nodes/ChatAnswerControls'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

async function renderChatView(): Promise<void> {
  const noop = () => {}
  await act(async () => {
    root.render(
      <div className="term-chat">
        <div className="term-chat__msgs">
          <PlanAnswerControls onSubmit={async () => true} agentLabel="Claude Code" chip="⌘M" />
          <QuestionAnswerControls
            onSubmit={async () => true}
            agentLabel="Claude Code"
            chip="⌘M"
            questions={[{ question: 'Which one?', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }]}
          />
        </div>
        <ChatComposer
          nodeId="n1"
          agentId="claude"
          agentLabel="Claude Code"
          value=""
          onChange={noop}
          onSend={noop}
          placeholder="Message"
          disabled={false}
          onWriteRefused={noop}
        />
      </div>
    )
  })
  // The plan's feedback textarea exists only after "Revise…".
  const revise = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Revise…')!
  await act(async () => revise.click())
}

const reviseTextarea = () => host.querySelector('.term-chat__answer-revise textarea') as HTMLTextAreaElement
const otherInput = () => host.querySelector('input.term-chat__answer-text') as HTMLInputElement
const composerTextarea = () => host.querySelector('.term-chat__compose textarea') as HTMLTextAreaElement

const ev = (): GlobalKeyEvent => ({
  metaKey: true, ctrlKey: false, shiftKey: true, altKey: false, key: 'd',
  defaultPrevented: false,
  preventDefault() { this.defaultPrevented = true }
})
const no = () => false
function deps(active: Element, keyedDictation: GlobalKeydownDeps['gestures']['keyedDictation']): GlobalKeydownDeps {
  return {
    activeElement: () => active,
    kanbanOpen: () => false,
    overrides: () => ({}),
    isMac: true,
    terminalFirst: () => false,
    handlers: {},
    gestures: { keyedDictation, zoom: no, projectJump: no, copy: no }
  }
}

describe('keyed dictation in the ⌘M chat view (dispatcher)', () => {
  it('is offered in the composer textarea', async () => {
    await renderChatView()
    const dictation = vi.fn(() => true)
    expect(dispatchGlobalKeydown(ev(), deps(composerTextarea(), dictation))).toBe(true)
    expect(dictation).toHaveBeenCalledTimes(1)
  })

  it('is NOT offered in the plan "Revise…" textarea or the question "Other" input (same class, outside the composer)', async () => {
    await renderChatView()
    expect(reviseTextarea().classList.contains('term-chat__input')).toBe(true)
    expect(otherInput().classList.contains('term-chat__input')).toBe(true)
    const dictation = vi.fn(() => true)
    expect(dispatchGlobalKeydown(ev(), deps(reviseTextarea(), dictation))).toBe(false)
    expect(dispatchGlobalKeydown(ev(), deps(otherInput(), dictation))).toBe(false)
    expect(dictation).not.toHaveBeenCalled()
  })
})

describe('shortcutDictationFocus (both shortcut paths decide with it)', () => {
  it('fills the composer when the caret is in it', async () => {
    await renderChatView()
    expect(shortcutDictationFocus(composerTextarea())).toBe('composer')
  })

  it('REFUSES anywhere else in a chat view: answer fields, answer buttons', async () => {
    await renderChatView()
    expect(shortcutDictationFocus(reviseTextarea())).toBe('refuse')
    expect(shortcutDictationFocus(otherInput())).toBe('refuse')
    expect(shortcutDictationFocus(host.querySelector('.term-chat__answer-btn'))).toBe('refuse')
  })

  it('leaves everything outside a chat view to the ordinary rule', () => {
    const el = document.createElement('input')
    document.body.append(el)
    expect(shortcutDictationFocus(el)).toBe('default')
    expect(shortcutDictationFocus(null)).toBe('default')
    el.remove()
  })

  it("leaves a READ-ONLY chat view to the ordinary rule: it lies over no pane (a subagent card's thread)", () => {
    const panel = document.createElement('div')
    panel.className = 'term-chat'
    panel.setAttribute('data-chat-node-id', 'parent')
    panel.setAttribute('data-chat-readonly', '')
    const chip = document.createElement('summary')
    panel.append(chip)
    document.body.append(panel)
    expect(shortcutDictationFocus(chip)).toBe('default')
    panel.removeAttribute('data-chat-readonly')
    expect(shortcutDictationFocus(chip)).toBe('refuse')
    panel.remove()
  })

  it('Canvas asks it on BOTH paths before any target is chosen (source pin)', () => {
    const src = readFileSync(resolve(__dirname, '../canvas/Canvas.tsx'), 'utf8').replace(/\r\n/g, '\n')
    const toggle = src.slice(src.indexOf('const toggleDictation = useCallback'))
    const refuseKeyed = toggle.indexOf("shortcutDictationFocus(document.activeElement) === 'refuse'")
    expect(refuseKeyed).toBeGreaterThan(-1)
    expect(refuseKeyed).toBeLessThan(toggle.indexOf('setDictationTarget('))
    // Hold-to-talk: refused BEFORE it arms, so the chord never opens the overlay there.
    const hold = src.slice(src.indexOf('if (!chordHeld(e, combo, isMac)) return'))
    const refuseHold = hold.indexOf("shortcutDictationFocus(document.activeElement) === 'refuse'")
    expect(refuseHold).toBeGreaterThan(-1)
    expect(refuseHold).toBeLessThan(hold.indexOf('armed = true'))
  })

  it('every mic that names only a node goes through nodeDictationTarget and says so on refusal (source pin)', () => {
    const src = readFileSync(resolve(__dirname, '../canvas/Canvas.tsx'), 'utf8').replace(/\r\n/g, '\n')
    // The header / card-modal mic: a bare `{nodeId}` request.
    const onDictate = src.slice(src.indexOf('const onDictate = (e: Event): void => {'))
    expect(onDictate.indexOf('nodeDictationTarget(n.id, title)')).toBeGreaterThan(-1)
    expect(onDictate.indexOf('announceChatDictationRefusal()')).toBeLessThan(onDictate.indexOf('setDictationOpen(true)'))
    // The shortcut / Dock fallback.
    const toggle = src.slice(src.indexOf('const toggleDictation = useCallback'))
    expect(toggle.indexOf('nodeDictationTarget(node.id')).toBeGreaterThan(-1)
    expect(toggle.indexOf('nodeDictationTarget(node.id')).toBeLessThan(toggle.indexOf('setDictationTarget(target)'))
    // Hold-to-talk: the target is decided BEFORE it arms, so a refusal never opens the overlay.
    const hold = src.slice(src.indexOf('if (!chordHeld(e, combo, isMac)) return'))
    expect(hold.indexOf('nodeDictationTarget(sel.id')).toBeGreaterThan(-1)
    expect(hold.indexOf('nodeDictationTarget(sel.id')).toBeLessThan(hold.indexOf('armed = true'))
  })

  it('the chat panel marks its node, so a node-named mic can find its chat view', async () => {
    const src = readFileSync(resolve(__dirname, '../nodes/ChatPanel.tsx'), 'utf8').replace(/\r\n/g, '\n')
    expect(src).toMatch(/className="term-chat nodrag nowheel" data-chat-node-id=\{nodeId\}/)
  })
})

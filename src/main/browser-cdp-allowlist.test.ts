import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { checkCdpCommand, COOKIE_WRITE_METHODS, MAX_VIEWPORT_OVERRIDE, type CdpContext } from './browser-cdp-allowlist'
import { NT_SCRIPTS } from './browser-nt-scripts'

const ctx: CdpContext = { viewport: { width: 1280, height: 800 } }

describe('checkCdpCommand', () => {
  it('an allowlist keyed on METHOD NAME is not what this is', () => {
    // The danger in Runtime.evaluate is not its name, it is one parameter. So the list is
    // (method, params-validator) pairs — which is also what buys the URL check on Page.navigate
    // that a name-only list cannot express.
    expect(checkCdpCommand('Page.navigate', { url: 'https://x.test/' }, ctx)).toBe(true)
    expect(checkCdpCommand('Page.navigate', { url: 'javascript:alert(1)' }, ctx)).toBe(false)
    expect(checkCdpCommand('Page.navigate', { url: 'file:///etc/passwd' }, ctx)).toBe(false)
    expect(checkCdpCommand('Page.navigate', { url: 'data:text/html,<x>' }, ctx)).toBe(false)
  })

  it.each([
    'Runtime.evaluate', 'Runtime.compileScript', 'Runtime.runScript', 'Runtime.addBinding',
    'Debugger.enable', 'Debugger.setBreakpoint', 'Profiler.enable', 'Tracing.start',
    'Fetch.enable', 'Emulation.setUserAgentOverride', 'Storage.clearDataForOrigin',
    'Browser.close', 'Security.setIgnoreCertificateErrors',
    'IndexedDB.requestData', 'DOMStorage.getDOMStorageItems',
    'Network.getAllCookies', 'Page.bringToFront',
    'DOM.getOuterHTML', 'DOM.getAttributes', 'Input.synthesizeScrollGesture'
  ])('%s is refused', (m) => {
    expect(checkCdpCommand(m, {}, ctx)).toBe(false)
  })

  it('callFunctionOn requires IDENTITY with an NT_SCRIPTS entry and value-only arguments', () => {
    const ok = { objectId: 'o1', functionDeclaration: NT_SCRIPTS.readMap, arguments: [{ value: '#x' }], returnByValue: true }
    expect(checkCdpCommand('Runtime.callFunctionOn', ok, ctx)).toBe(true)
    expect(checkCdpCommand('Runtime.callFunctionOn', { ...ok, functionDeclaration: 'function(){return 1}' }, ctx)).toBe(false)
    expect(checkCdpCommand('Runtime.callFunctionOn', { ...ok, arguments: [{ objectId: 'o2' }] }, ctx)).toBe(false)
    expect(checkCdpCommand('Runtime.callFunctionOn', { ...ok, arguments: [{ value: { a: 1 } }] }, ctx)).toBe(false)
    expect(checkCdpCommand('Runtime.callFunctionOn', { ...ok, returnByValue: false }, ctx)).toBe(false)
  })

  it('mouse coordinates must be inside the reported viewport', () => {
    expect(checkCdpCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: 10, y: 10 }, ctx)).toBe(true)
    expect(checkCdpCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: -1, y: 10 }, ctx)).toBe(false)
    expect(checkCdpCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: 99999, y: 10 }, ctx)).toBe(false)
  })

  it('selector length and DOM depth are bounded', () => {
    expect(checkCdpCommand('DOM.querySelector', { nodeId: 1, selector: 'a'.repeat(1024) }, ctx)).toBe(true)
    expect(checkCdpCommand('DOM.querySelector', { nodeId: 1, selector: 'a'.repeat(1025) }, ctx)).toBe(false)
    expect(checkCdpCommand('DOM.getDocument', { depth: 2 }, ctx)).toBe(false)
  })

  it('Input.insertText is capped', () => {
    expect(checkCdpCommand('Input.insertText', { text: 'x'.repeat(8192) }, ctx)).toBe(true)
    expect(checkCdpCommand('Input.insertText', { text: 'x'.repeat(8193) }, ctx)).toBe(false)
  })

  it('Input.dispatchKeyEvent is a FIXED-TABLE key, or a fixed editing command — never free key injection (Tasks 8.2-8.3)', () => {
    // A --press key from the table (the same set the verb parser gates on).
    expect(checkCdpCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter' }, ctx)).toBe(true)
    expect(checkCdpCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown' }, ctx)).toBe(true)
    // A key OUTSIDE the table is refused — no arbitrary key injection.
    expect(checkCdpCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a' }, ctx)).toBe(false)
    expect(checkCdpCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'F5' }, ctx)).toBe(false)
    // The two --clear editing commands are allowed; anything else is refused.
    expect(checkCdpCommand('Input.dispatchKeyEvent', { type: 'keyDown', commands: ['selectAll'] }, ctx)).toBe(true)
    expect(checkCdpCommand('Input.dispatchKeyEvent', { type: 'keyDown', commands: ['deleteBackward'] }, ctx)).toBe(true)
    expect(checkCdpCommand('Input.dispatchKeyEvent', { type: 'keyDown', commands: ['insertText'] }, ctx)).toBe(false)
    expect(checkCdpCommand('Input.dispatchKeyEvent', { type: 'keyDown', commands: ['delete', 'selectAll'] }, ctx)).toBe(false)
    expect(checkCdpCommand('Input.dispatchKeyEvent', { type: 'keyDown', commands: [] }, ctx)).toBe(false)
    // `text` is FORBIDDEN outright — a character that reaches the page is Input.insertText's job.
    expect(checkCdpCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', text: '\r' }, ctx)).toBe(false)
    expect(checkCdpCommand('Input.dispatchKeyEvent', { type: 'char', text: 'q' }, ctx)).toBe(false)
    // A meaningless empty event (no key, no commands) is refused; a bad type is refused.
    expect(checkCdpCommand('Input.dispatchKeyEvent', { type: 'keyDown' }, ctx)).toBe(false)
    expect(checkCdpCommand('Input.dispatchKeyEvent', { type: 'keyDrag', key: 'Enter' }, ctx)).toBe(false)
  })

  it('cookie READS take one explicit domain; the jar-emptying call does not exist here', () => {
    expect(checkCdpCommand('Network.getCookies', { urls: ['https://github.com/'] }, ctx)).toBe(true)
    expect(checkCdpCommand('Network.getCookies', {}, ctx)).toBe(false)      // no domain ⇒ the whole jar
    expect(checkCdpCommand('Network.getAllCookies', {}, ctx)).toBe(false)
  })

  it('cookie WRITES are listed (owner decision 5) and unreachable in v1', () => {
    // The methods stay listed so the allowlist RECORDS the decision; PR 9 Task 9.4 pins that no
    // verb reaches them (browser-cookie-write-guard.test.ts), because a write verb needs a design
    // nobody has done: where does the agent get the value, and what stops it planting
    // accounts.google.com so a later human visit is a login the attacker controls?
    expect(checkCdpCommand('Network.setCookie', { name: 'a', value: 'b', domain: 'x.test' }, ctx)).toBe(true)
    // The jar-mutating set is enumerated in one place; setCookie is the only one the ALLOW table
    // admits, and it is unreachable from every verb (the reachability guard proves that).
    expect(COOKIE_WRITE_METHODS).toContain('Network.setCookie')
    expect(COOKIE_WRITE_METHODS).toContain('Network.deleteCookies')
    expect(COOKIE_WRITE_METHODS).toContain('Storage.setCookies')
  })

  it('a screenshot is PNG-only, and its clip must be a numeric rectangle we authored (Task 9.1)', () => {
    expect(checkCdpCommand('Page.captureScreenshot', {}, ctx)).toBe(true)
    expect(checkCdpCommand('Page.captureScreenshot', { format: 'png' }, ctx)).toBe(true)
    // No jpeg/pdf surface — a caller cannot pick the format (and never supplies params anyway).
    expect(checkCdpCommand('Page.captureScreenshot', { format: 'jpeg' }, ctx)).toBe(false)
    expect(checkCdpCommand('Page.captureScreenshot', { format: 'pdf' }, ctx)).toBe(false)
    // A well-formed numeric clip (our own box model) passes; a structured/garbage clip is refused.
    expect(
      checkCdpCommand('Page.captureScreenshot', { clip: { x: 0, y: 0, width: 100, height: 50, scale: 1 } }, ctx)
    ).toBe(true)
    expect(checkCdpCommand('Page.captureScreenshot', { clip: { x: 0, y: 0, width: 100 } }, ctx)).toBe(false)
    expect(checkCdpCommand('Page.captureScreenshot', { clip: 'whole-page' }, ctx)).toBe(false)
  })

  it('an unknown method is refused with NO per-method detail', () => {
    // An allowlist that explains itself is a probing aid.
    expect(checkCdpCommand('Made.Up', {}, ctx)).toBe(false)
  })

  it('the read/nav infra methods PR 7 adds are gated, not blanket-allowed', () => {
    // Enabling the Network domain (needed for the main-frame status) is fine; it carries no read.
    expect(checkCdpCommand('Network.enable', {}, ctx)).toBe(true)
    expect(checkCdpCommand('Page.getNavigationHistory', {}, ctx)).toBe(true)
    // resolveNode takes OUR document nodeId (a number), never an agent objectId.
    expect(checkCdpCommand('DOM.resolveNode', { nodeId: 1 }, ctx)).toBe(true)
    expect(checkCdpCommand('DOM.resolveNode', { objectId: 'agent-picked' }, ctx)).toBe(false)
    expect(checkCdpCommand('DOM.resolveNode', {}, ctx)).toBe(false)
    expect(checkCdpCommand('Runtime.releaseObject', { objectId: 'o1' }, ctx)).toBe(true)
    expect(checkCdpCommand('Runtime.releaseObject', {}, ctx)).toBe(false)
  })

  it('the full-DOM read cannot arrive by another door (Task 7.6)', () => {
    // `--read html` is refused in the verb parser; here we pin that the CDP methods an HTML/full-DOM
    // read would need are refused by the allowlist too, so the same read cannot arrive by another
    // door — deep getDocument, getOuterHTML and getAttributes are all default-denied.
    expect(checkCdpCommand('DOM.getOuterHTML', { nodeId: 1 }, ctx)).toBe(false)
    expect(checkCdpCommand('DOM.getAttributes', { nodeId: 1 }, ctx)).toBe(false)
    expect(checkCdpCommand('DOM.getDocument', { depth: -1 }, ctx)).toBe(false) // -1 = whole tree
    expect(checkCdpCommand('DOM.getDocument', { depth: 0 }, ctx)).toBe(true)
    expect(checkCdpCommand('DOM.getDocument', { depth: 1, pierce: true }, ctx)).toBe(false)
  })
})

/**
 * Structural pin (the analogue of Task 4.4's second half). `checkCdpCommand` is only THE gate if it
 * is unbypassable: every `sendCommand(` in `src/main` must live inside the one wrapper,
 * `browser-cdp-send.ts`, which calls this function. A direct `debugger.sendCommand` anywhere else is
 * arbitrary CDP that never met the allowlist.
 *
 * WIDENED IN PR 7 (carried obligation, PR 5/#306 MINOR-1). Until the `browser` VERB existed, the only
 * CDP callers were `browser-*.ts` files and the grep scanned only those. PR 7 adds the drive path
 * (`browser-drive.ts`, `browser-actions.ts`) and wires the real `webContents.debugger` into a
 * `BrowserSession` from `index.ts` — so a stray `sendCommand` could now be introduced in a
 * non-`browser-`prefixed main file too. The grep therefore scans ALL of `src/main`, so the single-gate
 * property is enforced across the whole surface the verb path now touches, not just the files that
 * happen to be named `browser-*`.
 */
describe('debugger.sendCommand has exactly one call site in ALL of src/main', () => {
  const mainDir = path.resolve(__dirname)

  it('every sendCommand( in src/main is inside browser-cdp-send.ts', () => {
    const offenders: string[] = []
    for (const f of fs.readdirSync(mainDir)) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue
      if (f === 'browser-cdp-send.ts') continue
      const src = fs.readFileSync(path.join(mainDir, f), 'utf8')
      // Strip comments so a mention in prose is not a false positive; a real call is not a comment.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
      if (/\bsendCommand\s*\(/.test(code)) offenders.push(f)
    }
    expect(offenders).toEqual([])
  })
})

describe('the full-page screenshot override is the only Emulation door (#539)', () => {
  const ctx = { viewport: { width: 1280, height: 800 } }
  const ok = { width: 1280, height: 3000, deviceScaleFactor: 0, mobile: false }
  it('admits exactly the screenshot shape', () => {
    expect(checkCdpCommand('Emulation.setDeviceMetricsOverride', ok, ctx)).toBe(true)
    expect(checkCdpCommand('Emulation.clearDeviceMetricsOverride', {}, ctx)).toBe(true)
  })
  it.each([
    ['an extra key', { ...ok, screenOrientation: { type: 'portraitPrimary', angle: 0 } }],
    ['a viewport sub-rect', { ...ok, viewport: { x: 0, y: 0, width: 1, height: 1, scale: 1 } }],
    ['mobile emulation', { ...ok, mobile: true }],
    ['a device scale factor', { ...ok, deviceScaleFactor: 3 }],
    ['a fractional size', { ...ok, height: 10.5 }],
    ['a zero size', { ...ok, width: 0 }],
    ['an oversized side', { ...ok, height: MAX_VIEWPORT_OVERRIDE + 1 }],
    ['a missing key', { width: 1280, height: 3000, deviceScaleFactor: 0 }],
    ['a string size', { ...ok, width: '1280' }]
  ])('refuses %s', (_name, params) => {
    expect(checkCdpCommand('Emulation.setDeviceMetricsOverride', params, ctx)).toBe(false)
  })
  it('refuses a clear with parameters and every other Emulation method', () => {
    expect(checkCdpCommand('Emulation.clearDeviceMetricsOverride', { x: 1 }, ctx)).toBe(false)
    for (const m of ['Emulation.setUserAgentOverride', 'Emulation.setGeolocationOverride', 'Emulation.setTouchEmulationEnabled', 'Emulation.setScriptExecutionDisabled']) {
      expect(checkCdpCommand(m, {}, ctx)).toBe(false)
    }
  })
})

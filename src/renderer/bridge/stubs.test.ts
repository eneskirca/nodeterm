import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildStubApi, unsupported } from './stubs'
import { E_UNSUPPORTED } from '../../shared/rpc'

describe('bridge stubs', () => {
  it('unsupported rejects with a coded error', async () => {
    await expect(unsupported('x.y')).rejects.toMatchObject({ code: E_UNSUPPORTED })
  })

  it('every boot-path subscription returns a working unsubscribe', () => {
    const s = buildStubApi()
    for (const un of [
      s.license.onChange(() => {}),
      s.onCloseNode(() => {}),
      s.onFocusNode(() => {}),
      s.browser.onBrowserNewWindow(() => {}),
      s.onAgentControl(() => {}),
      s.sshProject.onStatus(() => {}),
      s.usage.onUpdate(() => {}),
      s.updates.onAvailable(() => {}),
      s.updates.onProgress(() => {}),
      s.updates.onDownloaded(() => {}),
      s.updates.onNotAvailable(() => {}),
      s.updates.onError(() => {}),
      s.onMarkdownToggle(() => {})
    ]) {
      expect(typeof un).toBe('function')
      expect(() => un()).not.toThrow()
    }
  })

  it('relay tunnel is a desktop-only unsupported degrade (subscriptions still safe)', async () => {
    const s = buildStubApi()
    // Entry points reject with the coded error so the renderer hides the affordance.
    await expect(s.relayHost.start()).rejects.toMatchObject({ code: E_UNSUPPORTED })
    await expect(s.relayHost.invite({ email: 'a@b.com' })).rejects.toMatchObject({ code: E_UNSUPPORTED })
    await expect(s.relayHost.stop()).rejects.toMatchObject({ code: E_UNSUPPORTED })
    await expect(s.relayClient.connect('offer')).rejects.toMatchObject({ code: E_UNSUPPORTED })
    // Subscriptions must return callable no-op unsubscribes (used as React effect cleanups).
    for (const un of [
      s.relayHost.onPeerPending(() => {}),
      s.relayHost.onOpen(() => {}),
      s.relayHost.onClosed(() => {}),
      s.relayClient.onSas('c', () => {}),
      s.relayClient.onApproved('c', () => {}),
      s.relayClient.onFrame('c', () => {}),
      s.relayClient.onClosed('c', () => {})
    ]) {
      expect(typeof un).toBe('function')
      expect(() => un()).not.toThrow()
    }
    // Void gate/frame members are inert (no connection ever exists here).
    expect(() => {
      s.relayHost.confirm('id')
      s.relayHost.revoke('id')
      s.relayClient.confirm('c')
      s.relayClient.send('c', '{}')
      s.relayClient.disconnect('c')
    }).not.toThrow()
  })

  it('hosted-team bookmarks answer an empty list: a browser cannot join a relay host', async () => {
    const s = buildStubApi()
    await expect(s.relayHosted.bookmarks()).resolves.toEqual([])
    await expect(s.relayHosted.removeBookmark('H')).resolves.toBeUndefined()
  })

  it('boot-path promise members resolve benignly', async () => {
    const s = buildStubApi()
    await expect(s.announcements.fetch()).resolves.toEqual([])
    // UpdateCard reads `p.mandatory` with no null guard, so the stub must return a real
    // UpdatePolicy — a `null` here was a TypeError on every Server Edition page load.
    await expect(s.updates.getPolicy()).resolves.toEqual({ minSupported: null, mandatory: false })
    await expect(s.usage.fetch()).resolves.toBeNull()
    // `ok:false` is load-bearing: the stub means "we could not measure", and an `ok:true` with no
    // rows would render as "nothing on this machine is using memory" — a confident wrong answer on
    // exactly the surface (the relay tab) where the sessions live on somebody else's machine.
    await expect(s.sessionMemory.read()).resolves.toEqual({ ok: false, rows: [], mem: null })
    await expect(s.sessionMemory.host()).resolves.toBeNull()
    await expect(s.license.getStatus()).rejects.toMatchObject({ code: E_UNSUPPORTED })
    // The license layer runs only in src/main, so the key + device cap cannot be read here. These
    // must REJECT rather than resolve a fabricated LicenseDetail — an `{used:0, seats:0}` with a
    // null error would render "0 of 0 devices" and an empty key as fact in Settings → License.
    await expect(s.license.detail()).rejects.toMatchObject({ code: E_UNSUPPORTED })
    await expect(s.license.releaseOthers()).rejects.toMatchObject({ code: E_UNSUPPORTED })
  })

  it('shell.openExternal opens a new browser tab; reveal/openPath are documented no-ops', () => {
    const s = buildStubApi()
    const open = vi.fn(() => null)
    vi.stubGlobal('window', { open })
    s.shell.openExternal('https://example.com')
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener')
    expect(() => {
      s.shell.reveal('/x')
      s.shell.openPath('/x')
    }).not.toThrow()
    vi.unstubAllGlobals()
  })

  it('void members are safe no-ops', () => {
    const s = buildStubApi()
    expect(() => {
      s.setBadgeCount(3)
      s.contextLink.setLinks({} as never)
      s.sendAgentControlResult({} as never)
      // The shortcut recorder calls this on every arm AND on unmount; a throw here would leave
      // Settings unusable in the browser, where there is no main-process intercept to suspend.
      s.shortcuts.setRecording(true)
      s.shortcuts.setRecording(false)
      // The focus mirror fires on every click into and out of a terminal, so a throw here would
      // break the browser canvas on the first keystroke — and the browser has no main-process
      // intercept for it to suspend in the first place.
      s.shortcuts.setTerminalFocused(true)
      s.shortcuts.setTerminalFocused(false)
    }).not.toThrow()
  })
})

/** A minimal `document` for the hidden-textarea copy fallback: vitest runs in the node
 *  environment, so there is no DOM to lean on. `execCommand` is the knob each test turns.
 *  It models the two things reality has and a naive fake does not: `select()` MOVES FOCUS
 *  (activeElement becomes the scratch textarea), and `execCommand` may THROW (Firefox has
 *  historically thrown NS_ERROR_FAILURE) — the two gaps that hid the leak/focus bugs. */
function fakeDocument(execCommand: () => boolean) {
  // The element that had focus before the copy — xterm's helper textarea, in reality.
  const previouslyFocused = { focus: vi.fn() }
  const doc = {
    activeElement: previouslyFocused as unknown as { focus: () => void },
    createElement: vi.fn(() => textarea),
    body: { appendChild: vi.fn(), removeChild: vi.fn() },
    execCommand: vi.fn(execCommand)
  }
  const textarea = {
    value: '',
    style: {} as Record<string, string>,
    setAttribute: vi.fn(),
    // select() focuses the scratch textarea, exactly as in a real browser
    select: vi.fn(() => {
      doc.activeElement = textarea as unknown as { focus: () => void }
    }),
    focus: vi.fn(),
    remove: vi.fn()
  }
  return { doc, textarea, previouslyFocused }
}

describe('bridge clipboard', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('uses the Clipboard API when it is available', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    buildStubApi().clipboard.writeText('hi')
    expect(writeText).toHaveBeenCalledWith('hi')
  })

  it('falls back to execCommand when there is no Clipboard API (plain http)', () => {
    const { doc, textarea } = fakeDocument(() => true)
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('document', doc)
    buildStubApi().clipboard.writeText('hi')
    expect(doc.execCommand).toHaveBeenCalledWith('copy')
    expect(textarea.value).toBe('hi')
    // the scratch textarea must not be left behind in the DOM
    expect(textarea.remove).toHaveBeenCalled()
  })

  it('removes the scratch textarea even when execCommand THROWS (no leaked node)', () => {
    const { doc, textarea } = fakeDocument(() => {
      throw new Error('NS_ERROR_FAILURE')
    })
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('document', doc)
    vi.stubGlobal('window', { dispatchEvent: vi.fn(), isSecureContext: false })
    expect(() => buildStubApi().clipboard.writeText('hi')).not.toThrow()
    // an invisible, focused, position:fixed textarea left in <body> would eat every keystroke
    expect(textarea.remove).toHaveBeenCalled()
  })

  it('restores focus to the previously-focused element after a successful fallback copy', () => {
    const { doc, previouslyFocused } = fakeDocument(() => true)
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('document', doc)
    buildStubApi().clipboard.writeText('hi')
    // without this the terminal goes deaf: activeElement falls back to <body>
    expect(previouslyFocused.focus).toHaveBeenCalledTimes(1)
  })

  it('restores focus even when the copy fails', () => {
    const { doc, previouslyFocused } = fakeDocument(() => {
      throw new Error('NS_ERROR_FAILURE')
    })
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('document', doc)
    vi.stubGlobal('window', { dispatchEvent: vi.fn(), isSecureContext: false })
    buildStubApi().clipboard.writeText('hi')
    expect(previouslyFocused.focus).toHaveBeenCalledTimes(1)
  })

  it('surfaces a toast when even execCommand cannot copy (never silent)', () => {
    const { doc } = fakeDocument(() => false)
    const dispatchEvent = vi.fn()
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('document', doc)
    vi.stubGlobal('window', { dispatchEvent, isSecureContext: false })
    buildStubApi().clipboard.writeText('hi')
    expect(dispatchEvent).toHaveBeenCalledTimes(1)
    const ev = dispatchEvent.mock.calls[0][0] as CustomEvent<{ kind: string; message: string }>
    expect(ev.type).toBe('nodeterm:toast')
    expect(ev.detail.kind).toBe('error')
    expect(ev.detail.message).toMatch(/http/i)
  })

  it('does not blame plain http when the failure happens in a secure context', () => {
    const { doc } = fakeDocument(() => false)
    const dispatchEvent = vi.fn()
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('document', doc)
    vi.stubGlobal('window', { dispatchEvent, isSecureContext: true })
    buildStubApi().clipboard.writeText('hi')
    const ev = dispatchEvent.mock.calls[0][0] as CustomEvent<{ message: string }>
    expect(ev.detail.message).not.toMatch(/plain http/i)
    expect(ev.detail.message).toMatch(/copy/i)
  })

  // Issue #759: copy-on-select writes on EVERY completed drag, so a failure toast per drag would
  // be unusable. The quiet path still tries both routes — it only withholds the banner.
  it('quiet: still falls back to execCommand, but raises no toast when that fails', () => {
    const { doc } = fakeDocument(() => false)
    const dispatchEvent = vi.fn()
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('document', doc)
    vi.stubGlobal('window', { dispatchEvent, isSecureContext: false })
    buildStubApi().clipboard.writeText('hi', { quiet: true })
    expect(doc.execCommand).toHaveBeenCalledWith('copy')
    expect(dispatchEvent).not.toHaveBeenCalled()
  })

  it('quiet: a rejected Clipboard API falls back without a toast either', async () => {
    const { doc } = fakeDocument(() => false)
    const dispatchEvent = vi.fn()
    const writeText = vi.fn().mockRejectedValue(new Error('NotAllowedError'))
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    vi.stubGlobal('document', doc)
    vi.stubGlobal('window', { dispatchEvent, isSecureContext: true })
    buildStubApi().clipboard.writeText('hi', { quiet: true })
    await vi.waitFor(() => expect(doc.execCommand).toHaveBeenCalledWith('copy'))
    expect(dispatchEvent).not.toHaveBeenCalled()
  })
})

describe('bridge stubs: canvasAuthority', () => {
  it('governs nothing and assumes nothing by default (only the Server Edition bridge overrides it)', async () => {
    const s = buildStubApi()
    expect(s.canvasAuthority.assumeAllUntilAnswered).toBe(false)
    expect(await s.canvasAuthority.governed()).toEqual([])
    expect(typeof s.canvasAuthority.onChanged(() => {})).toBe('function')
  })
})

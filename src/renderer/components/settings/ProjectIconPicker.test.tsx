// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectIcon } from '@shared/project-icon'
import { ProjectIconPicker } from './ProjectIconPicker'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The heavy library is mocked with a factory that counts how many times it is EVALUATED. Because
// EmojiPickerLazy imports it dynamically (React.lazy), the factory does not run until the Emoji tab
// is actually rendered — which is exactly the laziness this pins.
const H = vi.hoisted(() => ({ emojiLoads: 0, lastEmojiStyle: undefined as string | undefined }))
vi.mock('emoji-picker-react', () => {
  H.emojiLoads++
  return {
    default: ({
      onEmojiClick,
      emojiStyle
    }: {
      onEmojiClick?: (d: { emoji: string }) => void
      emojiStyle?: string
    }) => {
      // Record the style the wrapper passes: it MUST be 'native', or the picker renders emoji as
      // <img src="https://cdn.jsdelivr.net/…"> which the renderer CSP blocks (broken grid).
      H.lastEmojiStyle = emojiStyle
      return (
        <button data-testid="fake-emoji" onClick={() => onEmojiClick?.({ emoji: '🚀' })}>
          pick
        </button>
      )
    }
  }
})

const COLORS = ['#0a84ff', '#32d74b', '#ff375f'] as const

describe('ProjectIconPicker', () => {
  let root: Root
  let host: HTMLElement
  let onIcon: ReturnType<typeof vi.fn<(i: ProjectIcon | undefined) => void>>
  let onColor: ReturnType<typeof vi.fn<(c: string) => void>>
  let pickProjectIcon: ReturnType<typeof vi.fn>

  const mount = async (icon?: ProjectIcon): Promise<void> => {
    root = createRoot(host)
    await act(async () => {
      root.render(
        <ProjectIconPicker
          projectId="p1"
          name="Alpha"
          icon={icon}
          color="#0a84ff"
          colors={COLORS}
          dark
          onIcon={onIcon}
          onColor={onColor}
        />
      )
    })
  }

  const click = async (el: Element | null): Promise<void> => {
    await act(async () => {
      el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }

  /** Flush the lazy dynamic import + Suspense re-render. */
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 3; i++) await act(async () => await Promise.resolve())
  }

  const tab = (label: string): HTMLButtonElement =>
    [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (b) => b.textContent === label
    )!

  beforeEach(() => {
    H.emojiLoads = 0
    H.lastEmojiStyle = undefined
    host = document.createElement('div')
    document.body.appendChild(host)
    onIcon = vi.fn()
    onColor = vi.fn()
    pickProjectIcon = vi.fn(async () => ({ dataUrl: 'data:image/png;base64,AA==' }))
    ;(window as unknown as { nodeTerminal: any }).nodeTerminal = {
      shell: { pickProjectIcon }
    }
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('defaults to the Lucide tab and does NOT load the emoji module', async () => {
    await mount()
    expect(tab('Lucide').getAttribute('aria-selected')).toBe('true')
    expect(H.emojiLoads).toBe(0)
  })

  it('picks a lucide glyph, sanitized, via its grid button', async () => {
    await mount()
    await click(host.querySelector('[data-lucide-id="rocket"]'))
    expect(onIcon).toHaveBeenCalledWith({ type: 'lucide', name: 'rocket' })
  })

  it('loads the emoji module only when the Emoji tab is opened, then emits the picked emoji', async () => {
    await mount()
    expect(H.emojiLoads).toBe(0)
    await click(tab('Emoji'))
    await flush()
    expect(H.emojiLoads).toBe(1)
    await click(host.querySelector('[data-testid="fake-emoji"]'))
    expect(onIcon).toHaveBeenCalledWith({ type: 'emoji', emoji: '🚀' })
  })

  it('renders the emoji picker with the native style (CSP-safe, no CDN images)', async () => {
    await mount()
    await click(tab('Emoji'))
    await flush()
    expect(H.lastEmojiStyle).toBe('native')
  })

  it('does NOT clear the icon when a picked value fails sanitize (no-op, not a destructive emit)', async () => {
    // An upload whose dataUrl is not a real data: URL sanitizes to undefined. The guard must BAIL
    // (Reset is the only clear), not emit undefined — which would clear+persist the icon.
    pickProjectIcon.mockResolvedValue({ dataUrl: 'not-a-data-url' })
    await mount({ type: 'emoji', emoji: '🚀' })
    await click(tab('Upload'))
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Choose image…')!)
    await flush()
    expect(onIcon).not.toHaveBeenCalled()
  })

  it('re-encodes an uploaded image into an image icon via the main IPC', async () => {
    await mount()
    await click(tab('Upload'))
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Choose image…')!)
    await flush()
    expect(pickProjectIcon).toHaveBeenCalledTimes(1)
    expect(onIcon).toHaveBeenCalledWith({
      type: 'image',
      src: 'data:image/png;base64,AA==',
      source: 'upload'
    })
  })

  it('surfaces an upload error and commits nothing', async () => {
    pickProjectIcon.mockResolvedValue({ error: 'That image is too large even after resizing.' })
    await mount()
    await click(tab('Upload'))
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Choose image…')!)
    await flush()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('too large')
    expect(onIcon).not.toHaveBeenCalled()
  })

  it('does nothing when the upload dialog is cancelled (null)', async () => {
    pickProjectIcon.mockResolvedValue(null)
    await mount()
    await click(tab('Upload'))
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Choose image…')!)
    await flush()
    expect(onIcon).not.toHaveBeenCalled()
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  it('Reset clears the icon back to undefined (the colour monogram)', async () => {
    await mount({ type: 'emoji', emoji: '🚀' })
    const reset = host.querySelector<HTMLButtonElement>('[aria-label="Remove icon"]')!
    expect(reset.disabled).toBe(false)
    await click(reset)
    expect(onIcon).toHaveBeenCalledWith(undefined)
  })

  it('disables Reset when there is no icon to clear', async () => {
    await mount()
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Remove icon"]')!.disabled).toBe(true)
  })

  it('offers Avatar as a disabled stub (Task 5)', async () => {
    await mount()
    expect(tab('Avatar').disabled).toBe(true)
  })

  it('picks a colour through the swatches', async () => {
    await mount()
    await click(host.querySelector('button[data-project-color="#32d74b"]'))
    expect(onColor).toHaveBeenCalledWith('#32d74b')
  })

  const headerSubtitle = (): string =>
    host.querySelector('[aria-label="Current icon"]')!.parentElement!.querySelector(
      '[title]'
    )!.textContent ?? ''

  it('shows a human source label under the header for the current icon', async () => {
    await mount({ type: 'lucide', name: 'folder-git' })
    // Prettified: "folder-git" → "Folder Git glyph".
    expect(headerSubtitle()).toBe('Folder Git glyph')
  })

  it('labels a missing icon as the default monogram', async () => {
    await mount()
    expect(headerSubtitle()).toContain('Default')
  })

  // --- Task 5: Avatar tab + lazy refresh + anti-clobber ---

  const useAvatar = (
    projectAvatar: ReturnType<typeof vi.fn>
  ): void => {
    ;(window as unknown as { nodeTerminal: any }).nodeTerminal.githubIssues = { projectAvatar }
  }

  it('enables the Avatar tab when the project resolves a GitHub avatar and commits it on click', async () => {
    const projectAvatar = vi.fn(async () => ({ dataUrl: 'data:image/png;base64,AV==' }))
    useAvatar(projectAvatar)
    await mount()
    await flush()
    expect(projectAvatar).toHaveBeenCalledWith('p1')
    const avatarTab = tab('Avatar')
    expect(avatarTab.disabled).toBe(false)
    await click(avatarTab)
    await click(
      [...host.querySelectorAll('button')].find((b) => b.textContent === 'Use GitHub avatar')!
    )
    await flush()
    expect(onIcon).toHaveBeenCalledWith({
      type: 'image',
      src: 'data:image/png;base64,AV==',
      source: 'github'
    })
  })

  // lucide-react 1.x dropped its brand icons, so a `Github` import resolves to undefined at runtime
  // and the whole picker throws on render. The glyph is our own now; pin that both uses paint it.
  it('draws the GitHub glyph on the Avatar tab and the "Use GitHub avatar" button', async () => {
    useAvatar(vi.fn(async () => ({ dataUrl: 'data:image/png;base64,AV==' })))
    await mount()
    await flush()
    const avatarTab = tab('Avatar')
    expect(avatarTab.querySelector('svg')?.getAttribute('class')).toBe('size-3.5')
    await click(avatarTab)
    const useBtn = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Use GitHub avatar'
    )!
    const svg = useBtn.querySelector('svg')!
    expect(svg.getAttribute('class')).toBe('size-4')
    expect(svg.querySelectorAll('path').length).toBe(2)
  })

  it('keeps an already-set github icon when the resolve returns null (anti-clobber)', async () => {
    const projectAvatar = vi.fn(async () => null)
    useAvatar(projectAvatar)
    await mount({ type: 'image', src: 'data:image/png;base64,OLD=', source: 'github' })
    await flush()
    expect(projectAvatar).toHaveBeenCalledWith('p1')
    expect(onIcon).not.toHaveBeenCalled()
  })

  it('refreshes a stored github icon on open when the resolved src changed', async () => {
    const projectAvatar = vi.fn(async () => ({ dataUrl: 'data:image/png;base64,NEW=' }))
    useAvatar(projectAvatar)
    await mount({ type: 'image', src: 'data:image/png;base64,OLD=', source: 'github' })
    await flush()
    expect(onIcon).toHaveBeenCalledWith({
      type: 'image',
      src: 'data:image/png;base64,NEW=',
      source: 'github'
    })
  })

  it('hides (disables) the Avatar tab for a project with no GitHub origin', async () => {
    const projectAvatar = vi.fn(async () => null)
    useAvatar(projectAvatar)
    await mount()
    await flush()
    expect(tab('Avatar').disabled).toBe(true)
  })

  it('probes once per open, not again on re-render', async () => {
    const projectAvatar = vi.fn(async () => ({ dataUrl: 'data:image/png;base64,AV==' }))
    useAvatar(projectAvatar)
    await mount()
    await flush()
    expect(projectAvatar).toHaveBeenCalledTimes(1)
    // Force a re-render via internal tab state; the probe must NOT fire again.
    await click(tab('Upload'))
    await flush()
    expect(projectAvatar).toHaveBeenCalledTimes(1)
  })

  // A settings SEARCH mounts every matching project's picker, but only ONE section is active.
  const renderActive = async (active: boolean): Promise<void> => {
    await act(async () => {
      root.render(
        <ProjectIconPicker
          projectId="p1"
          name="Alpha"
          icon={undefined}
          color="#0a84ff"
          colors={COLORS}
          dark
          active={active}
          onIcon={onIcon}
          onColor={onColor}
        />
      )
    })
  }

  it('does NOT probe while the section is visible-but-not-active (a search match)', async () => {
    const projectAvatar = vi.fn(async () => ({ dataUrl: 'data:image/png;base64,AV==' }))
    useAvatar(projectAvatar)
    root = createRoot(host)
    await renderActive(false)
    await flush()
    expect(projectAvatar).not.toHaveBeenCalled()
    expect(tab('Avatar').disabled).toBe(true)
  })

  it('probes once when the section becomes active (the real open)', async () => {
    const projectAvatar = vi.fn(async () => ({ dataUrl: 'data:image/png;base64,AV==' }))
    useAvatar(projectAvatar)
    root = createRoot(host)
    await renderActive(false)
    await flush()
    expect(projectAvatar).not.toHaveBeenCalled()
    await renderActive(true)
    await flush()
    expect(projectAvatar).toHaveBeenCalledTimes(1)
    expect(tab('Avatar').disabled).toBe(false)
  })
})

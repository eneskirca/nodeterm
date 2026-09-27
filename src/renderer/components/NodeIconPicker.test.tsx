// @vitest-environment jsdom
//
// The picker's image path, on a machine that is not a mac.
//
// Two things are pinned here and both were review findings on #293:
//
//  1. **The extension is checked BEFORE the copy.** `selectFile` applies no filter, so an
//     unsupported file is one click away — and validating after `saveCanvasImage` meant the bytes
//     were already written into the project's git-shared `.nodeterm/images/`. Nothing removes
//     them afterwards, so every refusal left a file behind in the user's repo.
//
//  2. **A Windows path from `saveCanvasImage` is usable.** `saveCanvasImage` answers with the
//     host's own `path.join`, i.e. `C:\...` on Windows. The old POSIX-only `startsWith('/')`
//     check refused it, and `chooseImage` then reported "that file type cannot be used" about a
//     perfectly good PNG — sending Windows users after a format problem that did not exist.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NodeIconDialogHost, nodeIconDialog, type NodeIconChoice } from './NodeIconPicker'
import { useProjects } from '../state/projects'
import { popDialog, pushDialog, resetDialogStack } from './dialog-stack'
import { NODE_GLYPHS, type NodeIcon } from '@shared/node-icon'

// React refuses act() outside a configured test environment without this flag.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const selectFile = vi.fn<() => Promise<string | null>>()
const readBinary = vi.fn<(path: string) => Promise<string | null>>()
// Arguments are FORWARDED, not swallowed: the name this is called with is itself under test
// (`iconFileName` vs the old `split('/')`), and a mock that drops its args cannot fail for it.
const saveCanvasImage =
  vi.fn<(projectId: string, name: string, b64: string) => Promise<string | null>>()

// The downscale is stubbed to a pass-through: its own behaviour is covered in
// nodeIconThumbnail.test.ts against injected deps, and the REAL one here would reach for
// `new Image()` — which jsdom never settles, so the picker would simply hang. What is under test
// on this side is the WIRING: that the picker saves what the downscale handed back.
vi.mock('../lib/nodeIconThumbnail', () => ({
  browserThumbnailDeps: {},
  downscaleIconImage: async (picked: { base64: string; name: string }) => picked
}))

vi.mock('../session/session', () => ({
  sessionForProject: () => ({
    api: {
      dialog: { selectFile: () => selectFile() },
      fs: { readBinary: (p: string) => readBinary(p) },
      files: {
        saveCanvasImage: (id: string, name: string, b64: string) =>
          saveCanvasImage(id, name, b64)
      }
    }
  })
}))

const PROJECT = { id: 'p1', name: 'proj', color: '#888', cwd: 'C:\\proj', viewport: {}, nodes: [] }

/** Click "Choose image…" and let the promise chain inside `chooseImage` settle. */
async function clickChooseImage(): Promise<void> {
  const button = [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.startsWith('Choose image')
  )
  expect(button).toBeTruthy()
  await act(async () => {
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const errorText = (): string =>
  document.querySelector('.node-icon-dialog__error')?.textContent ?? ''

describe('NodeIconPicker image pick', () => {
  let root: Root | undefined
  let host: HTMLElement
  let choice: Promise<NodeIconChoice>

  beforeEach(async () => {
    vi.clearAllMocks()
    host = document.createElement('div')
    document.body.appendChild(host)
    useProjects.setState({
      activeProjectId: 'p1',
      getProject: () => PROJECT
    } as never)
    choice = nodeIconDialog({ nodeId: 'n1', title: 'Build' })
    root = createRoot(host)
    await act(async () => {
      root!.render(<NodeIconDialogHost />)
    })
  })

  afterEach(async () => {
    await act(async () => root?.unmount())
    root = undefined
    host.remove()
    // Every test resolves the dialog so the module-level singleton does not leak into the next.
    void choice
  })

  it('refuses an unsupported file WITHOUT copying it into the project', async () => {
    selectFile.mockResolvedValue('C:\\Users\\me\\photo.heic')
    await clickChooseImage()

    expect(saveCanvasImage).not.toHaveBeenCalled()
    // Not even read: there is nothing to do with the bytes once the extension is refused.
    expect(readBinary).not.toHaveBeenCalled()
    expect(errorText()).toContain('cannot be used as an icon')
  })

  it('accepts a Windows path and names the copy after the file, not the whole path', async () => {
    selectFile.mockResolvedValue('C:\\Users\\me\\logo.png')
    readBinary.mockResolvedValue('aGVsbG8=')
    saveCanvasImage.mockResolvedValue('C:\\proj\\.nodeterm\\images\\logo.png')
    await clickChooseImage()

    // The COPY is named after the file, not the whole path. `split('/')` on a Windows path
    // returns it whole, so the saved file was named `C:\\Users\\me\\logo.png` and only
    // `safeUploadName` stopped that being a directory escape.
    expect(saveCanvasImage).toHaveBeenCalledWith('p1', 'logo.png', 'aGVsbG8=')
    expect(errorText()).toBe('')
    // Inside the project root, so it is stored `./`-relative and POSIX-separated: the icon
    // travels with the repo that names it.
    await expect(choice).resolves.toEqual({
      type: 'image',
      path: './.nodeterm/images/logo.png'
    })
  })

  it('keeps a Windows path outside the project absolute rather than refusing it', async () => {
    selectFile.mockResolvedValue('C:\\Users\\me\\logo.png')
    readBinary.mockResolvedValue('aGVsbG8=')
    // The app-local fallback `saveCanvasImage` takes when the project folder will not accept it.
    saveCanvasImage.mockResolvedValue('C:\\Users\\me\\AppData\\nodeterm\\canvas-images\\logo.png')
    await clickChooseImage()

    expect(errorText()).toBe('')
    await expect(choice).resolves.toEqual({
      type: 'image',
      path: 'C:\\Users\\me\\AppData\\nodeterm\\canvas-images\\logo.png'
    })
  })
})

// Escape, which was reachable only while the text input had focus — `useDialogStack()` was called
// and its answer thrown away. The gate matches `confirmKeyAction`: top-of-stack only, with no
// focus requirement, because Escape is the safe direction and Enter is the affirmative one.
describe('NodeIconPicker escape', () => {
  let root: Root | undefined
  let host: HTMLElement

  // The pending choice is returned WRAPPED. An async function returning a promise flattens it, so
  // `await open()` would wait for the dialog's own promise — which nothing has dismissed yet.
  const open = async (): Promise<{ choice: Promise<NodeIconChoice> }> => {
    host = document.createElement('div')
    document.body.appendChild(host)
    useProjects.setState({ activeProjectId: 'p1', getProject: () => PROJECT } as never)
    const choice = nodeIconDialog({ nodeId: 'n1', title: 'Build' })
    root = createRoot(host)
    await act(async () => {
      root!.render(<NodeIconDialogHost />)
    })
    return { choice }
  }

  const pressEscape = async (target: EventTarget): Promise<void> => {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
  }

  afterEach(async () => {
    await act(async () => root?.unmount())
    root = undefined
    host?.remove()
    resetDialogStack()
  })

  it('closes when the press lands outside the input — the reported bug', async () => {
    const { choice } = await open()
    // Focus is NOT in the text input: a swatch is the realistic case, since clicking one is how
    // most people arrive here.
    const swatch = document.querySelector('.node-icon-dialog__swatch')
    expect(swatch).toBeTruthy()
    await pressEscape(swatch!)
    // `undefined` is CANCEL, distinct from `null` (remove the icon). Collapsing the two is how a
    // dismissed dialog silently clears an icon the user wanted to keep.
    await expect(choice).resolves.toBeUndefined()
  })

  it('still closes from the input, and from the document body', async () => {
    for (const pick of [
      () => document.querySelector('.node-icon-dialog__input')!,
      () => document.body
    ]) {
      const { choice } = await open()
      await pressEscape(pick())
      await expect(choice).resolves.toBeUndefined()
      await act(async () => root?.unmount())
      host.remove()
    }
  })

  it('ignores Escape while another dialog is stacked on top of it', async () => {
    const { choice } = await open()
    let settled = false
    void choice.then(() => {
      settled = true
    })

    pushDialog('dialog-above')
    await pressEscape(document.body)
    await act(async () => {})
    expect(settled).toBe(false)

    // ...and takes it back once that dialog closes.
    popDialog('dialog-above')
    await pressEscape(document.body)
    await expect(choice).resolves.toBeUndefined()
  })
})

// Issue #291: the curated glyph grid. Picking one resolves the SAME value the validator keeps, and
// the current glyph is marked so the dialog shows what the node wears.
describe('NodeIconPicker glyphs', () => {
  let root: Root | undefined
  let host: HTMLElement

  const open = async (icon?: NodeIcon): Promise<{ choice: Promise<NodeIconChoice> }> => {
    host = document.createElement('div')
    document.body.appendChild(host)
    useProjects.setState({ activeProjectId: 'p1', getProject: () => PROJECT } as never)
    const choice = nodeIconDialog({ nodeId: 'n1', title: 'Build', icon })
    root = createRoot(host)
    await act(async () => {
      root!.render(<NodeIconDialogHost />)
    })
    return { choice }
  }

  afterEach(async () => {
    await act(async () => root?.unmount())
    root = undefined
    host?.remove()
    resetDialogStack()
  })

  it('offers every curated glyph as a named button', async () => {
    const { choice } = await open()
    for (const glyph of NODE_GLYPHS) {
      const button = document.querySelector(`button[aria-label="${glyph.label}"]`)
      expect(button, glyph.id).toBeTruthy()
      expect(button!.querySelector('svg')).toBeTruthy()
    }
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await choice
  })

  it('resolves the picked glyph as a lucide icon', async () => {
    const { choice } = await open()
    const git = NODE_GLYPHS.find((g) => g.id === 'folder-git')!
    await act(async () => {
      document
        .querySelector(`button[aria-label="${git.label}"]`)!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await expect(choice).resolves.toEqual({ type: 'lucide', name: 'folder-git' })
  })

  it('marks the glyph the node already wears', async () => {
    const { choice } = await open({ type: 'lucide', name: 'database' })
    const db = NODE_GLYPHS.find((g) => g.id === 'database')!
    const button = document.querySelector(`button[aria-label="${db.label}"]`)!
    expect(button.className).toContain('is-current')
    expect(button.getAttribute('aria-pressed')).toBe('true')
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await choice
  })
})

import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  canvasImageFiles,
  canvasImageSink,
  clipboardImages,
  dropDialect,
  droppedPaths,
  escapeDroppedPath,
  localPathsForFiles,
  pasteHasText,
  pastedFiles,
  quoteDroppedPath,
  uploadNameFor
} from './file-drop'

describe('escapeDroppedPath', () => {
  it('escapes what a shell would otherwise interpret', () => {
    expect(escapeDroppedPath('/tmp/Bishop Drew order.xlsx')).toBe('/tmp/Bishop\\ Drew\\ order.xlsx')
    expect(escapeDroppedPath("/tmp/a'b$c")).toBe("/tmp/a\\'b\\$c")
  })
})

describe('quoteDroppedPath', () => {
  const POSIX_CASES = [
    '/tmp/Bishop Drew order.xlsx',
    "/tmp/a'b$c",
    '/Users/me/Screenshot 2026-10-12 at 10.10.10 (1).png',
    '/tmp/plain.png',
    'C:\\Users\\Jane Doe\\x.png'
  ]

  it('posix (and the default) is byte-identical to escapeDroppedPath', () => {
    for (const p of POSIX_CASES) {
      expect(quoteDroppedPath(p, 'posix')).toBe(escapeDroppedPath(p))
      expect(quoteDroppedPath(p)).toBe(escapeDroppedPath(p))
    }
    // Pinned literally, so a change to escapeDroppedPath itself shows up here too.
    expect(quoteDroppedPath('/Users/me/Screenshot (1).png', 'posix')).toBe('/Users/me/Screenshot\\ \\(1\\).png')
  })

  it('double-quotes a Windows path with a space, backslashes untouched', () => {
    const p = 'C:\\Users\\Jane Doe\\Screenshot 2026-10-12 101010.png'
    for (const d of ['win-cmd', 'win-pwsh'] as const)
      expect(quoteDroppedPath(p, d)).toBe(`"${p}"`)
  })

  it('leaves a path with nothing to quote bare, and never doubles a backslash', () => {
    for (const d of ['win-cmd', 'win-pwsh'] as const) {
      expect(quoteDroppedPath('C:\\a\\b.png', d)).toBe('C:\\a\\b.png')
      expect(quoteDroppedPath('C:/a/my_file-1.png', d)).toBe('C:/a/my_file-1.png')
    }
  })

  it('quotes parentheses and ampersands', () => {
    expect(quoteDroppedPath('C:\\a\\shot (1).png', 'win-cmd')).toBe('"C:\\a\\shot (1).png"')
    expect(quoteDroppedPath('C:\\a&b\\x.png', 'win-pwsh')).toBe('"C:\\a&b\\x.png"')
  })

  it('pwsh: `$` or a backtick takes single quotes, doubling an embedded quote', () => {
    expect(quoteDroppedPath("C:\\O'Brien\\$x.png", 'win-pwsh')).toBe("'C:\\O''Brien\\$x.png'")
    expect(quoteDroppedPath('C:\\a`b\\x.png', 'win-pwsh')).toBe("'C:\\a`b\\x.png'")
    // A quote alone needs nothing special inside double quotes.
    expect(quoteDroppedPath("C:\\O'Brien\\x.png", 'win-pwsh')).toBe('"C:\\O\'Brien\\x.png"')
  })

  it('cmd: `$` is literal, so double quotes are enough', () => {
    expect(quoteDroppedPath('C:\\a$b\\x.png', 'win-cmd')).toBe('"C:\\a$b\\x.png"')
  })
})

describe('dropDialect', () => {
  const win = { corePlatform: 'win32', remote: false } as const

  it('is posix for every non-Windows core, whatever the shell', () => {
    for (const corePlatform of ['darwin', 'linux']) {
      expect(dropDialect({ corePlatform, remote: false, shell: 'pwsh' })).toBe('posix')
      expect(dropDialect({ corePlatform, remote: false, agentPane: true })).toBe('posix')
    }
  })

  it('is posix for a remote (SSH) pane even on a Windows core', () => {
    expect(dropDialect({ ...win, remote: true, shell: 'pwsh.exe' })).toBe('posix')
    expect(dropDialect({ ...win, remote: true, agentPane: true })).toBe('posix')
  })

  it('reads the Windows shell', () => {
    expect(dropDialect({ ...win, shell: 'pwsh' })).toBe('win-pwsh')
    expect(dropDialect({ ...win, shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' })).toBe('win-pwsh')
    expect(dropDialect({ ...win, shell: 'cmd.exe' })).toBe('win-cmd')
    expect(dropDialect({ ...win, shell: 'C:\\Program Files\\Git\\bin\\bash.exe' })).toBe('posix')
  })

  it("an unset or unknown shell on Windows reads as PowerShell, the core's own default", () => {
    expect(dropDialect({ ...win })).toBe('win-pwsh')
    expect(dropDialect({ ...win, shell: 'nu' })).toBe('win-pwsh')
    // So a `$` path is not expanded by the default shell.
    expect(quoteDroppedPath('C:\\a$b\\x.png', dropDialect({ ...win }))).toBe("'C:\\a$b\\x.png'")
  })

  it('an agent pane on Windows is quoted for the CLI, whatever the shell under it', () => {
    expect(dropDialect({ ...win, shell: 'cmd.exe', agentPane: true })).toBe('win-pwsh')
    expect(dropDialect({ ...win, shell: 'bash.exe', agentPane: true })).toBe('win-pwsh')
  })

  it('an unobserved core platform falls back to the viewer ONLY for the local desktop core', () => {
    expect(dropDialect({ corePlatform: null, remote: false, localDesktop: true, viewerWindows: true })).toBe('win-pwsh')
    // A Windows browser on a Server Edition / relay tab says nothing about the host.
    expect(dropDialect({ corePlatform: null, remote: false, localDesktop: false, viewerWindows: true })).toBe('posix')
    expect(dropDialect({ corePlatform: null, remote: false, localDesktop: true, viewerWindows: false })).toBe('posix')
  })
})

describe('droppedPaths', () => {
  afterEach(() => vi.unstubAllGlobals())

  const stub = (local: string, uploaded = '/home/me/.nodeterm/uploads/x/Jane Doe.png') => {
    const uploadFile = vi.fn(async () => uploaded)
    vi.stubGlobal('window', {
      nodeTerminal: {
        getPathForFile: () => local,
        files: { saveUpload: vi.fn() },
        sshProject: { uploadFile }
      }
    })
    return uploadFile
  }
  const file = () => new File(['png'], 'Jane Doe.png', { type: 'image/png' })

  it('without a dialect, a local path is POSIX-escaped exactly as before', async () => {
    stub('/tmp/Jane Doe.png')
    expect(await droppedPaths([file()], { sshRemoteTmux: false, projectId: '' })).toEqual(['/tmp/Jane\\ Doe.png'])
  })

  it('spells a local path for the given dialect', async () => {
    stub('C:\\Users\\Jane Doe\\shot.png')
    expect(await droppedPaths([file()], { sshRemoteTmux: false, projectId: '', dialect: 'win-cmd' })).toEqual([
      '"C:\\Users\\Jane Doe\\shot.png"'
    ])
  })

  it('the SSH upload branch is always POSIX, whatever dialect is passed', async () => {
    const uploadFile = stub('C:\\Users\\Jane Doe\\shot.png')
    expect(await droppedPaths([file()], { sshRemoteTmux: true, projectId: 'p', dialect: 'win-pwsh' })).toEqual([
      '/home/me/.nodeterm/uploads/x/Jane\\ Doe.png'
    ])
    expect(uploadFile).toHaveBeenCalledOnce()
  })
})

describe('uploadNameFor', () => {
  it('keeps the file s own name when it has one', () => {
    expect(uploadNameFor(new File(['x'], 'report.pdf', { type: 'application/pdf' }))).toBe(
      'report.pdf'
    )
  })

  it('names clipboard bytes by their type — an agent should not have to guess', () => {
    // A screenshot arrives as image/png with an EMPTY name; a suffix-less `pasted-<ts>` tells
    // whatever reads the prompt nothing about what it is holding.
    const name = uploadNameFor(new File(['x'], '', { type: 'image/png' }))
    expect(name).toMatch(/^pasted-\d{8}-\d{6}\.png$/)
    expect(uploadNameFor(new File(['x'], '', { type: 'image/jpeg' }))).toMatch(/\.jpg$/)
  })

  it('falls back to the subtype, then to .bin, for a type it has no table entry for', () => {
    expect(uploadNameFor(new File(['x'], '', { type: 'audio/ogg' }))).toMatch(/\.ogg$/)
    expect(uploadNameFor(new File(['x'], '', { type: '' }))).toMatch(/\.bin$/)
  })
})

/** Minimal stand-in for the shapes Chromium actually hands a paste. */
const clipboard = (opts: { files?: File[]; items?: File[]; text?: string }): DataTransfer =>
  ({
    files: (opts.files ?? []) as unknown as FileList,
    items: (opts.items ?? []).map((f) => ({ kind: 'file', getAsFile: () => f })) as unknown as
      DataTransferItemList,
    getData: (type: string) => (type === 'text/plain' ? (opts.text ?? '') : '')
  }) as DataTransfer

describe('pastedFiles', () => {
  const png = new File(['x'], 'a.png', { type: 'image/png' })

  it('reads an OS file-manager copy off `files`', () => {
    expect(pastedFiles(clipboard({ files: [png] }))).toEqual([png])
  })

  it('reads raw clipboard bytes off `items` — a screenshot never reaches `files`', () => {
    expect(pastedFiles(clipboard({ items: [png] }))).toEqual([png])
  })

  it('answers empty for a text paste, which is xterm s to handle', () => {
    expect(pastedFiles(clipboard({}))).toEqual([])
    expect(pastedFiles(null)).toEqual([])
  })
})

describe('canvasImageFiles', () => {
  it('keeps MIME images and known image extensions only', () => {
    const png = new File(['png'], 'shot.png', { type: 'image/png' })
    const avif = new File(['avif'], 'photo.AVIF')
    const text = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    expect(canvasImageFiles([png, avif, text])).toEqual([png, avif])
  })
})

describe('localPathsForFiles', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('routes pathless canvas bytes to the project image store, not the uploads staging area', async () => {
    const saveUpload = vi.fn()
    const saveCanvasImage = vi.fn().mockResolvedValue('/proj/.nodeterm/images/pasted.png')
    // The suite runs on the node environment, which has no FileReader; only the base64 handoff
    // matters here, so the read is the smallest stand-in that produces one.
    vi.stubGlobal(
      'FileReader',
      class {
        onload: (() => void) | null = null
        onerror: (() => void) | null = null
        result: string | null = null
        readAsDataURL(): void {
          this.result = 'data:image/png;base64,cG5n'
          this.onload?.()
        }
      }
    )
    vi.stubGlobal('window', {
      nodeTerminal: {
        // A clipboard screenshot: no OS path, so the sink is the only thing that decides where it
        // lands — and a canvas node outlives the 7-day uploads sweep.
        getPathForFile: () => null,
        files: { saveUpload, saveCanvasImage }
      }
    })
    const file = new File(['png'], 'pasted.png', { type: 'image/png' })
    expect(await localPathsForFiles([file], canvasImageSink('project-a'))).toEqual([
      '/proj/.nodeterm/images/pasted.png'
    ])
    expect(saveCanvasImage).toHaveBeenCalledWith('project-a', 'pasted.png', expect.any(String))
    expect(saveUpload).not.toHaveBeenCalled()
  })

  it('reuses an Electron file path without shell escaping it, and never calls the sink', async () => {
    const saveCanvasImage = vi.fn()
    vi.stubGlobal('window', {
      nodeTerminal: {
        getPathForFile: () => '/tmp/My image.png',
        files: { saveUpload: vi.fn(), saveCanvasImage }
      }
    })
    const file = new File(['png'], 'My image.png', { type: 'image/png' })
    // A Finder drop already IS a file on this disk, so nothing is copied anywhere.
    expect(await localPathsForFiles([file], canvasImageSink('project-a'))).toEqual([
      '/tmp/My image.png'
    ])
    expect(saveCanvasImage).not.toHaveBeenCalled()
  })
})

describe('pasteHasText', () => {
  it('separates an ordinary text paste from one that carried nothing at all', () => {
    expect(pasteHasText(clipboard({ text: 'hello' }))).toBe(true)
    // The filtered image-only clipboard: Chromium hands over no files AND no text.
    expect(pasteHasText(clipboard({}))).toBe(false)
    expect(pasteHasText(null)).toBe(false)
  })
})

describe('clipboardImages', () => {
  afterEach(() => vi.unstubAllGlobals())

  /** Stand-in for the async Clipboard API — `read()` is the only member touched. */
  const stubClipboard = (read: () => Promise<unknown[]>): void => {
    vi.stubGlobal('navigator', { clipboard: { read } })
  }

  const item = (types: string[]): unknown => ({
    types,
    getType: (t: string) => Promise.resolve(new Blob(['bytes'], { type: t }))
  })

  it('reads the screenshot the paste event filtered out, and names it', async () => {
    stubClipboard(async () => [item(['image/png'])])
    const [file] = await clipboardImages()
    expect(file.type).toBe('image/png')
    // A bare Blob has no name; without one the upload overlay and the agent both see nothing.
    expect(file.name).toMatch(/^pasted-\d{8}-\d{6}\.png$/)
  })

  it('ignores clipboard entries that hold no image', async () => {
    stubClipboard(async () => [item(['text/html', 'text/plain'])])
    expect(await clipboardImages()).toEqual([])
  })

  it('answers empty where the API is absent — an insecure context, or an older browser', async () => {
    vi.stubGlobal('navigator', {})
    expect(await clipboardImages()).toEqual([])
  })

  it('answers empty when the read is refused, leaving the paste the no-op it already was', async () => {
    stubClipboard(() => Promise.reject(new DOMException('denied', 'NotAllowedError')))
    expect(await clipboardImages()).toEqual([])
  })
})

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { appImagesDir, canvasImageTarget, projectImagesDir, saveCanvasImage } from './canvas-images'
import { UPLOAD_MAX_BYTES, uploadsRoot } from './uploads'

const png = Buffer.from('fake-png-bytes').toString('base64')

let root: string
let userDataDir: string
let projectCwd: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nt-canvas-images-'))
  userDataDir = join(root, 'userData')
  projectCwd = join(root, 'project')
  await fs.mkdir(projectCwd, { recursive: true })
})
afterEach(() => rm(root, { recursive: true, force: true }))

describe('canvasImageTarget', () => {
  it('uses the project folder when it has a local cwd, and a durable app folder when it does not', () => {
    expect(canvasImageTarget(projectCwd, userDataDir)).toEqual({
      dir: projectImagesDir(projectCwd),
      inProject: true
    })
    // No local cwd: an SSH project (its cwd is on the host), a relay tab, or an inline canvas.
    expect(canvasImageTarget(undefined, userDataDir)).toEqual({
      dir: appImagesDir(userDataDir),
      inProject: false
    })
  })

  it('never lands inside the swept uploads staging area', () => {
    // The whole reason this module exists: a canvas image node is persisted, so its file must not
    // sit where UPLOAD_TTL_MS deletes it after a week.
    const sweptRoot = uploadsRoot(userDataDir)
    expect(canvasImageTarget(projectCwd, userDataDir).dir.startsWith(sweptRoot)).toBe(false)
    expect(canvasImageTarget(undefined, userDataDir).dir.startsWith(sweptRoot)).toBe(false)
  })
})

describe('saveCanvasImage', () => {
  it('writes into the project’s git-shared .nodeterm/images/', async () => {
    const path = await saveCanvasImage({
      projectCwd,
      userDataDir,
      name: 'shot.png',
      dataBase64: png
    })
    expect(path).toBe(join(projectCwd, '.nodeterm', 'images', 'shot.png'))
    expect(await fs.readFile(path!, 'utf8')).toBe('fake-png-bytes')
  })

  it('falls back to the app folder for a project with no local cwd, instead of refusing', async () => {
    const path = await saveCanvasImage({ userDataDir, name: 'shot.png', dataBase64: png })
    expect(path).toBe(join(appImagesDir(userDataDir), 'shot.png'))
    expect(await fs.readFile(path!, 'utf8')).toBe('fake-png-bytes')
  })

  it('never clobbers an existing image, and keeps the extension on the renamed one', async () => {
    const first = await saveCanvasImage({ projectCwd, userDataDir, name: 'shot.png', dataBase64: png })
    const second = await saveCanvasImage({
      projectCwd,
      userDataDir,
      name: 'shot.png',
      dataBase64: Buffer.from('second').toString('base64')
    })
    expect(first).toBe(join(projectCwd, '.nodeterm', 'images', 'shot.png'))
    expect(second).toBe(join(projectCwd, '.nodeterm', 'images', 'shot (2).png'))
    expect(await fs.readFile(first!, 'utf8')).toBe('fake-png-bytes')
    expect(await fs.readFile(second!, 'utf8')).toBe('second')
  })

  it('cannot be steered out of the images directory by the pasted name', async () => {
    const path = await saveCanvasImage({
      projectCwd,
      userDataDir,
      name: '../../.bashrc',
      dataBase64: png
    })
    expect(path).toBe(join(projectCwd, '.nodeterm', 'images', '.bashrc'))
    await expect(fs.readFile(join(root, '.bashrc'), 'utf8')).rejects.toThrow()
  })

  it('answers null for bytes it will not store, rather than throwing', async () => {
    // null is the whole contract with the caller: it filters the path out and reports the loss,
    // so a throw here would take the other images in the same drop down with it.
    expect(await saveCanvasImage({ projectCwd, userDataDir, name: 'a.png', dataBase64: '' })).toBe(
      null
    )
    // Refused on the ENCODED length, before any decode — measuring it by allocating it is the
    // exact thing the limit exists to prevent, so the test must not allocate the payload either.
    expect(
      await saveCanvasImage({
        projectCwd,
        userDataDir,
        name: 'a.png',
        dataBase64: 'x'.repeat(Math.ceil(UPLOAD_MAX_BYTES * 1.4) + 1)
      })
    ).toBe(null)
    // Nothing was left behind by either refusal.
    await expect(fs.readdir(projectImagesDir(projectCwd))).rejects.toThrow()
  })

  it('falls back to the app folder when the project folder will not take the file', async () => {
    // `.nodeterm` as a FILE reproduces ENOTDIR, which is the same shape as EACCES on a read-only
    // checkout, a root-owned `.nodeterm`, or a read-only mount. Before the retry this lost the
    // image silently — a regression against the pre-durability behavior, where the write went to
    // userData and essentially could not fail.
    await fs.writeFile(join(projectCwd, '.nodeterm'), 'not a directory')
    const path = await saveCanvasImage({
      projectCwd,
      userDataDir,
      name: 'shot.png',
      dataBase64: png
    })
    expect(path).toBe(join(appImagesDir(userDataDir), 'shot.png'))
    expect(await fs.readFile(path!, 'utf8')).toBe('fake-png-bytes')
  })

  it('does not resurrect a project folder that has been deleted', async () => {
    await rm(projectCwd, { recursive: true, force: true })
    const path = await saveCanvasImage({
      projectCwd,
      userDataDir,
      name: 'shot.png',
      dataBase64: png
    })
    // Saved app-locally, and — the point — `mkdir -p` did not recreate the folder the user removed.
    expect(path).toBe(join(appImagesDir(userDataDir), 'shot.png'))
    await expect(fs.stat(projectCwd)).rejects.toThrow()
  })

  it('leaves no truncated file behind when the write fails partway', async () => {
    // `wx` creates the file and then writes it, so a disk that fills in between leaves a partial
    // image holding a name — indistinguishable from a whole one to whoever reads it next.
    const buf = Buffer.from('fake-png-bytes')
    const real = fs.writeFile
    // Faithful to the failure mode: the file IS created and partially written, and THEN the write
    // fails. Rejecting without creating anything would leave nothing for the cleanup to remove and
    // the assertion below would pass whether or not the cleanup exists.
    const writeFile = vi
      .spyOn(fs, 'writeFile')
      .mockImplementationOnce(async (target, _data, options) => {
        await real(target, 'partial', options)
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
      })
    const partial = join(projectImagesDir(projectCwd), 'shot.png')
    const path = await saveCanvasImage({
      projectCwd,
      userDataDir,
      name: 'shot.png',
      dataBase64: buf.toString('base64')
    })
    writeFile.mockRestore()
    // The project write failed, so it landed app-locally, whole...
    expect(path).toBe(join(appImagesDir(userDataDir), 'shot.png'))
    expect(await fs.readFile(path!, 'utf8')).toBe('fake-png-bytes')
    // ...and the half-written project file was removed rather than left holding the name.
    await expect(fs.readFile(partial, 'utf8')).rejects.toThrow()
    await expect(fs.readdir(projectImagesDir(projectCwd))).resolves.toEqual([])
  })
})

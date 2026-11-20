import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UPLOAD_FAIL_FLASH_MS, startUploadNote, useUploadNotes } from './uploadNotes'

const note = (key: string) => useUploadNotes.getState().byKey[key]

describe('upload notes', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useUploadNotes.setState({ byKey: {} })
  })
  afterEach(() => vi.useRealTimers())

  it('keeps the note in the store until the upload settles, independent of any component', () => {
    const h = startUploadNote('s:n1', 'Uploading big.zip…')
    expect(note('s:n1')).toEqual({ text: 'Uploading big.zip…' })
    h.done()
    expect(note('s:n1')).toBeUndefined()
  })

  it('flashes a failure and then clears itself', () => {
    startUploadNote('s:n1', 'Uploading a…').fail('Upload failed')
    expect(note('s:n1')).toEqual({ text: 'Upload failed', failed: true })
    vi.advanceTimersByTime(UPLOAD_FAIL_FLASH_MS)
    expect(note('s:n1')).toBeUndefined()
  })

  it('an earlier upload finishing does not clear a later one on the same terminal', () => {
    const first = startUploadNote('s:n1', 'Uploading a…')
    const second = startUploadNote('s:n1', 'Uploading b…')
    first.done()
    expect(note('s:n1')).toEqual({ text: 'Uploading b…' })
    first.fail('Upload failed')
    expect(note('s:n1')).toEqual({ text: 'Uploading b…' })
    second.done()
    expect(note('s:n1')).toBeUndefined()
  })

  it('a new upload cancels the pending clear of an older failure flash', () => {
    startUploadNote('s:n1', 'Uploading a…').fail('Upload failed')
    startUploadNote('s:n1', 'Uploading b…')
    vi.advanceTimersByTime(UPLOAD_FAIL_FLASH_MS)
    expect(note('s:n1')).toEqual({ text: 'Uploading b…' })
  })

  it('keeps terminals apart', () => {
    startUploadNote('s:n1', 'Uploading a…')
    expect(note('s:n2')).toBeUndefined()
  })
})

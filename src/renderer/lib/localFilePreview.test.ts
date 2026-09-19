import { describe, expect, it } from 'vitest'
import { localFileExtension, localFilePreviewKind, localImageMime } from './localFilePreview'

describe('local file preview routing', () => {
  it('recognizes the document types shown over Kanban', () => {
    expect(localFilePreviewKind('/tmp/report.HTML')).toBe('html')
    expect(localFilePreviewKind('/tmp/plan.markdown')).toBe('markdown')
    expect(localFilePreviewKind('/tmp/report.pdf')).toBe('pdf')
    expect(localFilePreviewKind('/tmp/screenshot.webp')).toBe('image')
    expect(localFilePreviewKind('/tmp/notes.txt')).toBe('text')
  })

  it('handles Windows paths and returns the image MIME', () => {
    expect(localFileExtension(String.raw`C:\work\shots\screen.PNG`)).toBe('png')
    expect(localImageMime(String.raw`C:\work\shots\screen.PNG`)).toBe('image/png')
    expect(localImageMime('/tmp/notes.md')).toBeNull()
  })
})

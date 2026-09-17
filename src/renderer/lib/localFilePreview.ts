export type LocalFilePreviewKind = 'html' | 'markdown' | 'pdf' | 'image' | 'text'

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  avif: 'image/avif'
}

export function localFileExtension(path: string): string {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function localFilePreviewKind(path: string): LocalFilePreviewKind {
  const ext = localFileExtension(path)
  if (ext === 'html' || ext === 'htm') return 'html'
  if (ext === 'md' || ext === 'markdown' || ext === 'mdown' || ext === 'mkd') return 'markdown'
  if (ext === 'pdf') return 'pdf'
  if (ext in IMAGE_MIME) return 'image'
  return 'text'
}

export function localImageMime(path: string): string | null {
  return IMAGE_MIME[localFileExtension(path)] ?? null
}

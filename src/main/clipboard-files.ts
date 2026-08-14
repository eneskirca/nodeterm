import { isAbsolute } from 'path'

export const FILE_LIST_PASTEBOARD_TYPE = 'NSFilenamesPboardType'
const MAX_CLIPBOARD_FILES = 64

export interface FileClipboardDependencies {
  platform: string
  isFile(path: string): boolean
  writeBuffer(format: string, buffer: Buffer): void
}

const escapeXml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')

export function fileListPropertyList(paths: string[]): Buffer {
  const entries = paths.map((path) => `    <string>${escapeXml(path)}</string>`).join('\n')
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
      `<plist version="1.0">\n  <array>\n${entries}\n  </array>\n</plist>\n`,
    'utf8'
  )
}

/**
 * Put existing local regular files on the macOS clipboard as Finder-compatible file references.
 * Inputs cross an IPC trust boundary, so paths are capped, absolute-only, de-duplicated and
 * re-checked in main. The operation is all-or-nothing so a multi-selection is never silently
 * truncated or partially copied.
 */
export function writeFilesToClipboard(
  input: unknown,
  dependencies: FileClipboardDependencies
): boolean {
  if (dependencies.platform !== 'darwin' || !Array.isArray(input)) return false

  const paths: string[] = []
  const seen = new Set<string>()
  for (const value of input) {
    if (typeof value !== 'string' || !isAbsolute(value)) return false
    if (seen.has(value)) continue
    if (paths.length >= MAX_CLIPBOARD_FILES) return false
    try {
      if (!dependencies.isFile(value)) return false
    } catch {
      return false
    }
    seen.add(value)
    paths.push(value)
  }
  if (!paths.length) return false

  try {
    dependencies.writeBuffer(FILE_LIST_PASTEBOARD_TYPE, fileListPropertyList(paths))
    return true
  } catch {
    return false
  }
}

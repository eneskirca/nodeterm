// A receipt records exact bytes we installed. An edited or foreign file is never ours to replace.
import fs from 'fs'
import path from 'path'
import { writeManagedHookFileAtomic } from './agents/hooks/install-helper'

/** Read the same regular file we inspect; never block on a FIFO or follow a swapped link. */
export function readIntegrationFile(file: string, followSymlink = false): string {
  const target = followSymlink ? fs.realpathSync(file) : file
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0))
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('Integration target is not a regular file')
    return fs.readFileSync(fd, 'utf8')
  } finally { fs.closeSync(fd) }
}

export class IntegrationFiles {
  private receipts: Record<string, string> = {}
  readonly retained: string[] = []
  constructor(private receiptFile: string) {
    try {
      const saved = JSON.parse(readIntegrationFile(receiptFile))
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) this.receipts = saved
    } catch { /* no proof */ }
  }
  private save(): void {
    fs.mkdirSync(path.dirname(this.receiptFile), { recursive: true })
    writeManagedHookFileAtomic(this.receiptFile, JSON.stringify(this.receipts), undefined, 0o600)
  }
  removeBlocks(file: string, knownBlocks: string[]): void {
    try {
      if (!fs.lstatSync(file).isFile()) { this.retained.push(file); return }
      const before = readIntegrationFile(file)
      let next = before
      for (const block of knownBlocks) next = next.split(block).join('')
      if (next.includes('<!-- nodeterm:')) this.retained.push(file)
      if (next !== before && readIntegrationFile(file) === before) {
        writeManagedHookFileAtomic(file, next, undefined, fs.statSync(file).mode & 0o777)
      }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.retained.push(file) }
  }
  reconcile(file: string, body: string | null, knownBodies: string[] = []): void {
    try {
      let before: string | undefined
      try {
        if (!fs.lstatSync(file).isFile()) { this.retained.push(file); return }
        before = readIntegrationFile(file)
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      if (before !== undefined && before !== this.receipts[file] && !knownBodies.includes(before)) {
        this.retained.push(file)
        return
      }
      if (body === null) {
        if (before !== undefined) {
          if (readIntegrationFile(file) !== before) { this.retained.push(file); return }
          fs.unlinkSync(file)
        }
        delete this.receipts[file]
      } else {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        // Publish ownership before the write: a crash cannot turn an existing foreign file into
        // ours, since future passes still compare its bytes. New files use O_EXCL.
        this.receipts[file] = body
        this.save()
        if (before === undefined) fs.writeFileSync(file, body, { flag: 'wx', mode: 0o600 })
        else if (readIntegrationFile(file) === before) writeManagedHookFileAtomic(file, body)
        else this.retained.push(file)
      }
      this.save()
    } catch { this.retained.push(file) }
  }
}

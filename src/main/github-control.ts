import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { GitHubSecretStore } from '../core/github/credentials'
import type { GitHubSecretAvailability } from '../shared/github-issues'

const FILE_NAME = 'github-issues-token.json'

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

type TokenDocument =
  | { version: 1; kind: 'safe-storage'; value: string }
  | { version: 1; kind: 'restricted-file'; token: string }

export class GitHubSecretError extends Error {
  constructor(readonly code: 'invalid-token' | 'keyring-locked') {
    super(code)
  }
}

function validToken(token: string): boolean {
  return token.trim() === token && token.length > 0 && token.length <= 4096 && !/[\r\n\0]/.test(token)
}

async function atomicWrite(file: string, document: TokenDocument): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  await fs.writeFile(temporary, JSON.stringify(document), { encoding: 'utf-8', mode: 0o600 })
  await fs.chmod(temporary, 0o600)
  await fs.rename(temporary, file)
  await fs.chmod(file, 0o600)
}

export class ElectronGitHubSecretStore implements GitHubSecretStore {
  constructor(
    private readonly userDataDir: string,
    private readonly safeStorage: SafeStorageLike
  ) {}

  get availability(): GitHubSecretAvailability {
    return this.canEncrypt() ? 'encrypted' : 'restricted-file'
  }

  private get filePath(): string {
    return path.join(this.userDataDir, FILE_NAME)
  }

  async save(token: string): Promise<void> {
    if (!validToken(token)) throw new GitHubSecretError('invalid-token')
    const current = await this.readDocument()
    if (current?.kind === 'safe-storage' && !this.canEncrypt()) {
      throw new GitHubSecretError('keyring-locked')
    }
    const document: TokenDocument = this.canEncrypt()
      ? {
          version: 1,
          kind: 'safe-storage',
          value: this.safeStorage.encryptString(token).toString('base64')
        }
      : { version: 1, kind: 'restricted-file', token }
    await atomicWrite(this.filePath, document)
  }

  async clear(): Promise<void> {
    await fs.rm(this.filePath, { force: true })
  }

  async readForHost(): Promise<string | null> {
    const document = await this.readDocument()
    if (!document) return null
    if (document.kind === 'restricted-file') return validToken(document.token) ? document.token : null
    if (!this.canEncrypt()) return null
    try {
      const token = this.safeStorage.decryptString(Buffer.from(document.value, 'base64'))
      return validToken(token) ? token : null
    } catch {
      return null
    }
  }

  private canEncrypt(): boolean {
    if (!this.safeStorage.isEncryptionAvailable()) return false
    try {
      return this.safeStorage.getSelectedStorageBackend?.() !== 'basic_text'
    } catch {
      return false
    }
  }

  private async readDocument(): Promise<TokenDocument | null> {
    try {
      const value: unknown = JSON.parse(await fs.readFile(this.filePath, 'utf-8'))
      if (!value || typeof value !== 'object') return null
      const document = value as Partial<TokenDocument>
      if (document.version !== 1) return null
      if (document.kind === 'safe-storage' && typeof document.value === 'string') {
        return document as TokenDocument
      }
      if (document.kind === 'restricted-file' && typeof document.token === 'string') {
        return document as TokenDocument
      }
      return null
    } catch {
      return null
    }
  }
}

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { GitHubSecretStore } from '../core/github/credentials'

const FILE_NAME = 'github-issues-token.json'

export class ServerGitHubSecretError extends Error {
  constructor(readonly code: 'invalid-token') {
    super(code)
  }
}

function validToken(token: string): boolean {
  return token.trim() === token && token.length > 0 && token.length <= 4096 && !/[\r\n\0]/.test(token)
}

export class ServerGitHubSecretStore implements GitHubSecretStore {
  readonly availability = 'restricted-file' as const

  constructor(private readonly userDataDir: string) {}

  private get filePath(): string {
    return path.join(this.userDataDir, FILE_NAME)
  }

  async save(token: string): Promise<void> {
    if (!validToken(token)) throw new ServerGitHubSecretError('invalid-token')
    await fs.mkdir(this.userDataDir, { recursive: true })
    const temporary = `${this.filePath}.tmp`
    await fs.writeFile(temporary, JSON.stringify({ version: 1, token }), {
      encoding: 'utf-8',
      mode: 0o600
    })
    await fs.chmod(temporary, 0o600)
    await fs.rename(temporary, this.filePath)
    await fs.chmod(this.filePath, 0o600)
  }

  async clear(): Promise<void> {
    await fs.rm(this.filePath, { force: true })
  }

  async readForHost(): Promise<string | null> {
    try {
      const value: unknown = JSON.parse(await fs.readFile(this.filePath, 'utf-8'))
      const token = value && typeof value === 'object' &&
        (value as { version?: unknown }).version === 1
        ? (value as { token?: unknown }).token
        : null
      return typeof token === 'string' && validToken(token) ? token : null
    } catch {
      return null
    }
  }
}

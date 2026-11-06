import { describe, expect, it } from 'vitest'
import { GitHubIssuesClient } from './client'

type Call = { url: string; method: string; body: unknown }

function client(answers: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = []
  const github = new GitHubIssuesClient({
    token: 'secret',
    fetch: async (url, init) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined })
      const answer = answers.shift() ?? { status: 500, body: {} }
      return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } })
    }
  })
  return { github, calls }
}

const head = 'c'.repeat(40)
const blob = 'f'.repeat(40)
const threads = {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: [
            { id: 'T_1', comments: { nodes: [{ databaseId: 11 }] } },
            { id: 'T_2', comments: { nodes: [{ databaseId: 22 }] } }
          ]
        }
      }
    }
  }
}

describe('GitHubIssuesClient setReviewThreadResolved', () => {
  it('finds the thread by its first comment and resolves or unresolves it by its GraphQL id', async () => {
    const resolve = client([{ body: threads }, { body: { data: { resolveReviewThread: { thread: { id: 'T_2' } } } } }])
    await resolve.github.setReviewThreadResolved('o/r', 7, 22, true)
    expect(resolve.calls[0].body).toMatchObject({ variables: { owner: 'o', name: 'r', number: 7 } })
    expect((resolve.calls[1].body as { query: string }).query).toContain('resolveReviewThread(input:{threadId:$id})')
    expect(resolve.calls[1].body).toMatchObject({ variables: { id: 'T_2' } })
    const unresolve = client([{ body: threads }, { body: { data: { unresolveReviewThread: { thread: { id: 'T_1' } } } } }])
    await unresolve.github.setReviewThreadResolved('o/r', 7, 11, false)
    expect((unresolve.calls[1].body as { query: string }).query).toContain('unresolveReviewThread')
  })

  it('refuses a thread the PR does not have, with no mutation', async () => {
    const { github, calls } = client([{ body: threads }])
    await expect(github.setReviewThreadResolved('o/r', 7, 99, true)).rejects.toMatchObject({ code: 'request-failed', status: 422 })
    expect(calls).toHaveLength(1)
  })
})

describe('GitHubIssuesClient apply suggestion calls', () => {
  it('reads the comment with its line range, head and author', async () => {
    const { github, calls } = client([{
      body: {
        pull_request_url: 'https://api.github.com/repos/o/r/pulls/7', path: 'src/a.ts', side: 'RIGHT', line: 4, start_line: 2,
        commit_id: head, body: '```suggestion\nx\n```', user: { login: 'ana' }
      }
    }])
    expect(await github.pullSuggestionComment('o/r', 91)).toEqual({
      pullNumber: 7, path: 'src/a.ts', side: 'RIGHT', startSide: 'RIGHT', line: 4, startLine: 2, commitId: head, body: '```suggestion\nx\n```', author: 'ana'
    })
    expect(calls[0].url).toBe('https://api.github.com/repos/o/r/pulls/comments/91')
  })

  it('reads the side a multi-line comment starts on', async () => {
    const { github } = client([{
      body: {
        pull_request_url: 'https://api.github.com/repos/o/r/pulls/7', path: 'src/a.ts', side: 'RIGHT', line: 4, start_line: 2,
        start_side: 'LEFT', commit_id: head, body: '```suggestion\nx\n```', user: { login: 'ana' }
      }
    }])
    expect(await github.pullSuggestionComment('o/r', 91)).toMatchObject({ side: 'RIGHT', startSide: 'LEFT' })
  })

  it('reads a file with its blob SHA, and refuses one with no text', async () => {
    const read = client([{ body: { type: 'file', encoding: 'base64', content: Buffer.from('héllo\n').toString('base64'), sha: blob } }])
    expect(await read.github.fileBlobAt('o/r', 'src/a b.ts', head)).toEqual({ sha: blob, text: 'héllo\n' })
    expect(read.calls[0].url).toBe(`https://api.github.com/repos/o/r/contents/src/a%20b.ts?ref=${head}`)
    const binary = client([{ body: { type: 'file', encoding: 'none', content: '', sha: blob } }])
    await expect(binary.github.fileBlobAt('o/r', 'a.png', head)).rejects.toMatchObject({ code: 'request-failed', status: 422 })
  })

  it('commits the file to the branch with the blob SHA it read', async () => {
    const { github, calls } = client([{ status: 200, body: {} }])
    await github.putFile('o/r', { path: 'src/a.ts', branch: 'feat/x', sha: blob, text: 'é\n', message: 'Apply suggestion from review by ana' })
    expect(calls[0]).toEqual({
      url: 'https://api.github.com/repos/o/r/contents/src/a.ts', method: 'PUT',
      body: { message: 'Apply suggestion from review by ana', content: Buffer.from('é\n').toString('base64'), sha: blob, branch: 'feat/x' }
    })
  })

  it('passes GitHub\'s 409 for a changed file through as a request failure', async () => {
    const { github } = client([{ status: 409, body: { message: 'is at x but expected y' } }])
    await expect(github.putFile('o/r', { path: 'a.ts', branch: 'b', sha: blob, text: '', message: 'm' }))
      .rejects.toMatchObject({ code: 'request-failed', status: 409 })
  })

  it('refuses a bad path, branch or SHA before any request', async () => {
    const { github, calls } = client([])
    await expect(github.putFile('o/r', { path: '../a', branch: 'b', sha: blob, text: '', message: 'm' })).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(github.putFile('o/r', { path: 'a', branch: '-x', sha: blob, text: '', message: 'm' })).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(github.fileBlobAt('o/r', 'a', 'main')).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(github.setReviewThreadResolved('o/r', 7, 0, true)).rejects.toMatchObject({ code: 'invalid-request' })
    expect(calls).toEqual([])
  })
})

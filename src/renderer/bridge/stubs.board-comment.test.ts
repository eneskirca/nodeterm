import { describe, it, expect } from 'vitest'
import { buildStubApi } from './stubs'

describe('board-comment delivery off the desktop', () => {
  it('the browser and relay bridges answer a named refusal, never success', async () => {
    // Server Edition tabs and relay tabs share this stub (relay-api reuses `stub.agentMessage`). A
    // comment typed there is display-only; the typed outcome is what lets its row say so.
    const reply = await buildStubApi().agentMessage.deliverBoardComment({
      projectId: 'p1',
      commentId: 'c1',
      author: 'x',
      text: '@[B](node:b1) hi',
      targetNodeId: 'b1'
    })
    expect(reply.ok).toBe(false)
    expect(reply.result).toEqual({ kind: 'notPermitted', reason: 'unsupported-edition' })
  })
})

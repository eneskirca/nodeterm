/**
 * The board-comment delivery channel is the local user's alone. Three independent fences, each
 * pinned here because nothing else would notice one going missing:
 *
 *  1. It is a RAW `ipcMain.handle` in the desktop shell — the platform table is what a relay peer
 *     dispatches into (platform-electron.ts, invariant 4c), so a raw registration is invisible to
 *     a phone, another desktop or a hosted-team guest. The channel is ALSO host-only (belt).
 *  2. The handler refuses every webContents but the live main window — a <webview> guest (a
 *     browser node showing an arbitrary page) is a webContents in this process.
 *  3. Neither the Server Edition nor core's shared registrar serves it, and the browser/relay
 *     bridges answer a named refusal (`renderer/bridge/stubs.board-comment.test.ts`), so a stray
 *     call can never look like it delivered.
 *
 * (1) and (2) are source assertions because the handler closes over `messagingDeps` and the window
 * inside `src/main/index.ts`; the behaviour behind it is `deliverBoardCommentFromUi`, run for real
 * in `core/agents/board-comment-messaging.test.ts`.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { IPC } from '../shared/ipc'

const read = (p: string): string => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

describe('board-comment delivery wiring', () => {
  const main = read('src/main/index.ts')
  const start = main.indexOf('ipcMain.handle(IPC.agentBoardCommentDeliver')
  const block = main.slice(start, main.indexOf('\n  })', start))

  it('is a raw ipcMain handler behind the main-window sender guard, calling the core service', () => {
    expect(start).toBeGreaterThan(0)
    expect(block).toMatch(/getMainWindow\(\)\?\.webContents\.id !== \w+\.sender\.id/)
    // The guard comes BEFORE the delivery call.
    expect(block.indexOf('sender.id')).toBeLessThan(block.indexOf('deliverBoardCommentFromUi('))
    expect(block).toContain('deliverBoardCommentFromUi(raw, messagingDeps)')
  })

  it('is never registered on a peer-dispatchable table, in any shell', () => {
    for (const f of [...walk('src/main'), ...walk('src/core'), ...walk('src/server')]) {
      const src = read(f)
      expect(src, f).not.toMatch(/(?<!ipcMain)\.(handle|on)(WithSender)?\(\s*IPC\.agentBoardCommentDeliver/)
      if (!f.endsWith(join('src', 'main', 'index.ts')))
        expect(src.includes('IPC.agentBoardCommentDeliver'), f).toBe(false)
    }
    for (const f of walk('src/server'))
      expect(read(f).includes('deliverBoardCommentFromUi'), f).toBe(false)
  })

  it('the preload exposes it on the invoke path', () => {
    expect(IPC.agentBoardCommentDeliver).toBe('agent:board-comment-deliver')
    expect(read('src/preload/index.ts')).toContain(
      'deliverBoardComment: (req) => ipcRenderer.invoke(IPC.agentBoardCommentDeliver, req)'
    )
  })
})

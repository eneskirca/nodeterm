// The node.maximize chord accepts every non-group node, so every node kind with a header owes the
// matching header button — otherwise the feature is reachable only by a shortcut nobody can see.
// Browser, web, video and files nodes (the ones that most want the room) shipped without it.
// Rendering each node needs a React Flow store and a session, so this is a source-level pin.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const read = (f: string): string =>
  fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/\r\n/g, '\n')

const HEADER_NODES = [
  'TerminalNode.tsx',
  'EditorNode.tsx',
  'DiffNode.tsx',
  'BrowserNode.tsx',
  'WebNode.tsx',
  'VideoNode.tsx',
  'FilesNode.tsx',
  'WhiteboardNode.tsx',
  'pull/PullNodeShell.tsx'
]

describe('maximize header button', () => {
  it.each(HEADER_NODES)('%s renders MaximizeButton bound to premaxRect', (file) => {
    expect(read(file)).toMatch(/<MaximizeButton id=\{id\} maximized=\{!!data\.premaxRect\} \/>/)
  })
  it.each(['PullNode.tsx', 'IssuesNode.tsx'])('%s gets it from the shared PullNodeShell', (file) => {
    expect(read(file)).toMatch(/<PullNodeShell\b/)
  })
})

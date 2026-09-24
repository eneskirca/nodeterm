import { expect, it } from 'vitest'
import { isLaunchShell } from './pane'
it.each(['bash', '-zsh', '/bin/fish', 'pwsh.exe', 'PowerShell.EXE', 'C:\\Windows\\System32\\cmd.exe'])('recognizes the launch shell %s', (name) => {
  expect(isLaunchShell(name)).toBe(true)
})
it.each([null, '', 'vim', 'node', 'claude', 'codex', 'sh -c vim'])('refuses non-shell/unknown %s', (name) => {
  expect(isLaunchShell(name)).toBe(false)
})

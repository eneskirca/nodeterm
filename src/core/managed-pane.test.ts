import { describe, expect, it } from 'vitest'
import { linuxManagedBirth, managedCreateFlags, managedLaunchPlan, parseManagedPane, sameManagedPane } from './managed-pane'
import type { ManagedPaneReceipt } from '../shared/managed-terminal'

const receipt: ManagedPaneReceipt = {
  version: 1, creationId: '1e8dd6ac-050b-4e63-a331-9f6e9df8b7fb', nodeId: 'term-test-1234', projectId: 'local-project',
  socket: 'node-terminal', session: 'nt-term-test-1234', paneId: '%42', panePid: 1234,
  paneBirth: 'linux:12345678-1234-1234-1234-123456789012:123', sessionCreated: '1770000000'
}

describe('managed pane receipt', () => {
  it('requires exactly one whole-session pane matching its creation and exact session', () => {
    const raw = `${receipt.session}|${receipt.sessionCreated}|${receipt.paneId}|${receipt.panePid}|${receipt.creationId}`
    expect(parseManagedPane(raw + '\n', receipt)).toEqual({ sessionCreated: receipt.sessionCreated, paneId: receipt.paneId, panePid: receipt.panePid })
    for (const changed of [raw + '\n' + raw, raw.replace('nt-term-test-1234', 'nt-term-test-12345'), raw.replace(receipt.creationId, 'other'),
      raw.replace('|%42|', '|x|'), raw.replace('|1234|', '|0|'), raw.replace('|1234|', '|9007199254740993|'), raw + '|extra'])
      expect(parseManagedPane(changed, receipt)).toBeNull()
  })
  it('compares every generation/ownership field without coercion', () => {
    expect(sameManagedPane(receipt, { ...receipt })).toBe(true)
    for (const key of Object.keys(receipt)) {
      const changed = { ...receipt, [key]: typeof receipt[key as keyof ManagedPaneReceipt] === 'number' ? 999 : 'other' }
      expect(sameManagedPane(receipt, changed as ManagedPaneReceipt), key).toBe(false)
    }
  })
  it('reads Linux field22 after hostile comm parentheses and binds the boot', () => {
    const stat = '1234 (name ) with spaces)) S ' + Array.from({ length: 18 }, () => '0').join(' ') + ' 987 0'
    expect(linuxManagedBirth(stat, '12345678-1234-1234-1234-123456789012\n')).toBe('linux:12345678-1234-1234-1234-123456789012:987')
    expect(linuxManagedBirth('bad', '12345678-1234-1234-1234-123456789012')).toBeNull()
    expect(linuxManagedBirth(stat, 'invalid')).toBeNull()
  })
  it('creates without attach-or-create or detach flags and passes only a validated marker', () => {
    expect(managedCreateFlags(receipt.creationId)).toEqual(['-e', 'NODETERM_MANAGED_CREATION_ID=' + receipt.creationId])
    expect(() => managedCreateFlags('$(touch x)')).toThrow()
  })
  it('keeps launch text on stdin and gates exact pane before both paste and Enter', () => {
    const plan = managedLaunchPlan(receipt, 'claude --permission-mode default')
    expect(plan.body).toBe('claude --permission-mode default')
    expect(plan.args.join(' ')).not.toContain(plan.body)
    expect(plan.args).toContain('%42')
    const condition = plan.args[plan.args.indexOf('if-shell') + 4]
    for (const fact of [receipt.creationId, receipt.session, receipt.sessionCreated, String(receipt.panePid)]) expect(condition).toContain(fact)
    expect(plan.args.at(-2)).toContain('paste-buffer -d -p -r')
    expect(plan.args.at(-2)).toContain('send-keys -t %42 Enter')
    expect(plan.args.at(-1)).toContain('nt-managed-refused')
    for (const command of ['', 'bad\r', 'bad\n', '\u001b', 'a'.repeat(32769)]) expect(() => managedLaunchPlan(receipt, command)).toThrow()
    expect(() => managedLaunchPlan({ ...receipt, paneId: '%42; kill-server' }, 'claude')).toThrow()
  })
})

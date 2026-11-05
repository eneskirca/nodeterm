import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ReceiptStore, reconcileMailboxInstructions } from './integration-files'
import { MAILBOX_INSTRUCTION_MARKERS, buildMailboxTurnNotice, frameMailboxInstructions, mailboxInstructionBlock, mergeMailboxInstructions } from './mailbox-instructions'

describe('required mailbox instructions', () => {
  it('names the installed CLI, preserves invocation dialect, and never claims automatic processing', () => {
    const local = buildMailboxTurnNotice('/actual profile/canvas-control/nodeterm.sh')
    expect(local).toContain('sh "/actual profile/canvas-control/nodeterm.sh" inbox')
    expect(local).toContain('Only the authenticated recipient can ACK/complete')
    expect(local).toContain('NEVER causes automatic ACK or completion')
    expect(local).toContain('--revision <N> --claim <claimId>')
    expect(local).not.toContain('/tmp/nodeterm-start-check-')
    expect(local.length).toBeLessThan(4000)
    expect(buildMailboxTurnNotice('C:\\actual\\nodeterm.sh', 'windows-cmd')).toContain('& "C:\\actual\\nodeterm.cmd" inbox')
  })

  it('keeps bytes outside its block and treats replacement metacharacters as literal data', () => {
    const before = 'User instructions\n' + frameMailboxInstructions('old') + '\nOther tool\n'
    const next = mergeMailboxInstructions(before, '$& $` literal')
    expect(next).toBe('User instructions\n' + frameMailboxInstructions('$& $` literal') + '\nOther tool\n')
    expect(mergeMailboxInstructions(next, '$& $` literal')).toBe(next)
    for (const invalid of [MAILBOX_INSTRUCTION_MARKERS.start, MAILBOX_INSTRUCTION_MARKERS.end, frameMailboxInstructions('a') + frameMailboxInstructions('b')]) {
      expect(mailboxInstructionBlock(invalid)).toBe('malformed')
      expect(() => mergeMailboxInstructions(invalid, 'new')).toThrow()
    }
  })
})

describe('owned compact rules in user instruction files', () => {
  let dir: string
  let file: string
  let receipts: ReceiptStore
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'mailbox-rules-'))
    file = path.join(dir, 'AGENTS.md')
    receipts = new ReceiptStore(() => dir)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('refreshes only its receipted block and leaves unrelated user edits untouched on decline', () => {
    writeFileSync(file, '# User rules\n')
    expect(reconcileMailboxInstructions(receipts, file, 'first')).toBe('written')
    const installed = readFileSync(file, 'utf8')
    writeFileSync(file, installed + 'User footer\n')
    expect(reconcileMailboxInstructions(receipts, file, 'second')).toBe('written')
    expect(readFileSync(file, 'utf8')).toBe('# User rules\n' + frameMailboxInstructions('second') + '\nUser footer\n')
    expect(reconcileMailboxInstructions(receipts, file, 'second')).toBe('unchanged')
    expect(reconcileMailboxInstructions(receipts, file, null)).toBe('written')
    expect(readFileSync(file, 'utf8')).toBe('# User rules\nUser footer\n')
  })

  it('retains edited, malformed and unreceipted foreign blocks without adopting them', () => {
    reconcileMailboxInstructions(receipts, file, 'first')
    writeFileSync(file, readFileSync(file, 'utf8').replace('first', 'user edited'))
    const edited = readFileSync(file, 'utf8')
    expect(reconcileMailboxInstructions(receipts, file, 'next')).toBe('retained')
    expect(reconcileMailboxInstructions(receipts, file, null)).toBe('retained')
    expect(readFileSync(file, 'utf8')).toBe(edited)
    writeFileSync(file, MAILBOX_INSTRUCTION_MARKERS.start)
    expect(reconcileMailboxInstructions(receipts, file, 'next')).toBe('retained')
    writeFileSync(file, frameMailboxInstructions('unknown block'))
    expect(reconcileMailboxInstructions(new ReceiptStore(() => path.join(dir, 'fresh-ledger')), file, 'next')).toBe('retained')
  })

  it('a decline never changes an empty user file that contained no mailbox rule', () => {
    writeFileSync(file, '')
    expect(reconcileMailboxInstructions(receipts, file, null)).toBe('unchanged')
    expect(readFileSync(file, 'utf8')).toBe('')
  })
})

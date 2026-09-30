import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * STRUCTURAL pins for the hosted-team glue in Canvas.tsx — the same class of test as
 * `control-cold-open.source.test.ts`, for the same reason: the glue lives inside a 15,000-line
 * component with no render harness. Every BEHAVIOUR is proven against the real modules elsewhere:
 * the attempt owner (`lib/hostedAttempts.test.ts`), the joiner's boot / drop / click / paste /
 * forget paths (`lib/hostedJoin.test.ts`), the approval queue and the owner subscription
 * (`lib/hostedPendingQueue.test.ts`, `lib/hostedOwner.test.ts`, `session/relay-tab.test.ts`), the
 * role gate and the legacy relay api (`bridge/relay-api.test.ts`), the dialog
 * (`components/HostedApprovalDialog.test.tsx`).
 *
 * What only a source read can pin is that Canvas CALLS them, and — the rule this feature rests on —
 * that a Team Access relay tab and a local tab still take their old path: every hosted branch sits
 * behind a join code, a hosted api or a hosted role. See docs/hosted-team-relay.md.
 */
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function between(start: string, end: string): string {
  const a = src.indexOf(start)
  expect(a, start).toBeGreaterThan(-1)
  const b = src.indexOf(end, a + start.length)
  expect(b, end).toBeGreaterThan(a)
  return src.slice(a, b)
}

describe('hosted team glue in Canvas', () => {
  it('a pairing offer keeps its old connect path; only a join code is handed to the hosted joiner', () => {
    const body = between('const connectOffer = useCallback(', '[confirmAndMount]')
    const divert = body.indexOf('if (isJoinCode(offer) && hostedJoinerRef.current) {')
    const legacy = body.indexOf("await window.nodeTerminal.relayClient.connect(offer)")
    expect(divert).toBeGreaterThan(-1)
    expect(legacy).toBeGreaterThan(divert)
    expect(body).toContain("confirmAndMount(connectionId, 'Remote host')") // no hosted options
  })

  it('a greyed tab asks the joiner first, and a non-hosted tab falls through to the pairing prompt', () => {
    const body = between('const reconnectRelay = useCallback(', 'onError: (message)')
    expect(body.indexOf('if (hostedJoinerRef.current?.reconnectTab(projectId)) return')).toBeLessThan(
      body.indexOf('void reconnectRelayTab(projectId, {')
    )
    expect(body).toContain(`promptDialog({ message: "Paste the host's new pairing code:" })`)
    // R46: a join code pasted there goes to the joiner WITH this tab's id, which refuses to rebind a
    // tab it did not open (lib/hostedJoin.test.ts); a pairing offer is returned untouched.
    const divert = body.indexOf('hostedJoinerRef.current.joinWithCode(offer, projectId)')
    expect(divert).toBeGreaterThan(-1)
    expect(body.indexOf('return offer', divert)).toBeGreaterThan(divert)
  })

  it('the relay tab is built with hosted options, a long approval wait and no alert ONLY when hosted', () => {
    const body = between('const mountRemoteMirror = useCallback(', 'const confirmAndMount = useCallback(')
    expect(body).toContain('...(hosted ? { hosted: true, timeoutMs: HOSTED_APPROVAL_WAIT_MS, activate: hosted.activate } : {})')
    expect(body).toContain('if (hosted) return { error: err, declined }')
    expect(body).toContain("window.alert(`Remote session did not open: ${(err as Error).message}`)")
  })

  it('the joiner is created once and reconnects the approved bookmarks at boot', () => {
    const body = between('const joiner = createHostedJoiner({', '}, [confirmAndMount])')
    expect(body).toContain('createHostedJoiner({')
    expect(body).toContain('void joiner.bootReconnect()')
    expect(body).toContain('joiner.dispose()')
  })

  it('a read-only role never publishes canvas edits, and the rule is false for every non-hosted tab', () => {
    // ONE gate for the node publisher and the kanban publisher (Task 6): the read-only refusal lives
    // in `shouldPublishFor`, and the node publisher asks it for the active project.
    const start = src.indexOf('const shouldPublishFor = (projectId: string): boolean =>')
    expect(start).toBeGreaterThan(-1)
    const gate = src.slice(start, src.indexOf('const pub = createCanvasPublisher(', start))
    // The peer check, OR a project the host's canvas authority governs (authority-gate-wiring.test.ts).
    expect(gate).toContain('shouldPublish(hasPeersRef.current, governedRef.current, projectId) &&')
    expect(gate).toContain('!isHostedReadOnly(activeSession.id)')
    expect(src).toContain('shouldPublish: () => shouldPublishFor(useProjects.getState().activeProjectId)')
    expect(src).toContain('shouldPublish: (projectId) => shouldPublishFor(projectId)')
  })

  it('the canvas turns read-only only for a hosted Viewer/Commenter (a spread: nothing new otherwise)', () => {
    expect(src).toContain('{...(hostedReadOnly ? HOSTED_READ_ONLY_FLOW : {})}')
    expect(src).toContain('const hostedReadOnly = isReadOnlyRole(activeHosted?.role)')
    expect(src).toContain('{activeHosted && hostedReadOnly && (')
  })

  it('the owner dialog shows the queue head, one request at a time', () => {
    const body = between('{hostedHead && (', '{pendingPeer && (')
    expect(body).toContain('<HostedApprovalDialog')
    expect(body).toContain('key={hostedHead.pending.pendingId}')
  })

  it('R40: closing or deleting a tab stops its team\'s attempt (the one disposal both paths share)', () => {
    const body = between('const disposeRelayTabForProject = useCallback(', '}, [])')
    expect(body).toContain('hostedJoinerRef.current?.tabClosed(projectId)')
    expect(src).toContain('disposeRelayTabForProject(id)\n      store.closeProject(id)')
    expect(src).toContain('disposeRelayTabForProject(id)\n      store.deleteProject(id)')
  })

  it('R40: a hosted reconnect refuses to bind to a tab that is no longer open; a Team Access one is unchanged', () => {
    const body = between('const mountRemoteMirror = useCallback(', 'const confirmAndMount = useCallback(')
    expect(body).toContain('if (hosted && !isOpenTab(reconnectProjectId)) {')
    expect(body).toContain('return { id: reconnectProjectId } // reconnect: reuse the existing tab')
  })

  it('R40: the waiting notice is the joiner\'s (every hosted mount), not tied to the SAS dialog', () => {
    const body = between('const confirmAndMount = useCallback(', 'return mountRemoteMirror(')
    expect(body).not.toContain('waitingForOwnerText')
    expect(between('const joiner = createHostedJoiner({', '}, [confirmAndMount])')).toContain('clearNotice:')
  })

  it('R40: an owner\'s answer is settled only once the host answered', () => {
    const body = between('const answerHosted = useCallback(', '}, [])')
    expect(body).toContain('{ begin: q.beginAnswer, finish: q.finishAnswer }')
    expect(body).not.toContain('.settle(')
  })

  it('R41: the owner\'s wait starts only once the SAS was confirmed (hosted), and the joiner hears the SAS', () => {
    const body = between('const confirmAndMount = useCallback(', 'return mountRemoteMirror(')
    expect(body.indexOf('window.nodeTerminal.relayClient.confirm(connectionId)')).toBeLessThan(body.indexOf('hosted?.onSasConfirmed?.()'))
    const joiner = between('const joiner = createHostedJoiner({', '}, [confirmAndMount])')
    expect(joiner).toContain('onSas: (id, listener) =>')
    expect(joiner).toContain('onSasConfirmed: hooks.sasConfirmed')
  })
})

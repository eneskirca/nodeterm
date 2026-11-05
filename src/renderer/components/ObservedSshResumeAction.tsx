import { useEffect, useRef, useState } from 'react'
import type { PaneAdoptionRequest, PaneObservedResumeReply } from '@shared/agents/pane-adoption'

/** Explicit human action only. No auto-start, agent ACK, command or executable crosses IPC. */
export function ObservedSshResumeAction({ api, nodeId, projectId, remote, onRequested }: {
  api: object; nodeId: string; projectId?: string; remote?: boolean; onRequested?(): void
}) {
  const [pending, setPending] = useState(false), [message, setMessage] = useState<string>()
  const mounted = useRef(true), inFlight = useRef(false), epoch = useRef(0)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { epoch.current++; setMessage(undefined); setPending(false) }, [api, nodeId, projectId, remote])
  let resume: ((request: PaneAdoptionRequest) => Promise<PaneObservedResumeReply>) | undefined
  if ('paneOwnership' in api && api.paneOwnership && typeof api.paneOwnership === 'object' &&
      'resumeObserved' in api.paneOwnership && typeof api.paneOwnership.resumeObserved === 'function')
    resume = api.paneOwnership.resumeObserved.bind(api.paneOwnership) as typeof resume
  if (!remote || !projectId || !resume) return null
  return <div className="agent-mailbox__legacy-entry">
    <p className="agent-mailbox__hint">A supported SSH connection can start one new observed resume after this terminal has ended. Native confirmation is required; existing sessions are not stopped or taken over.</p>
    <button type="button" disabled={pending} onClick={async () => {
      if (inFlight.current) return
      inFlight.current = true
      const requestedEpoch = epoch.current
      setPending(true); setMessage(undefined)
      try {
        const result = await resume!({ nodeId, projectId })
        if (!mounted.current || epoch.current !== requestedEpoch) return
        if (!result.ok) setMessage(result.error)
        else if (result.nodeId !== nodeId || result.projectId !== projectId || result.status !== 'launch-requested')
          setMessage('The returned launch origin could not be confirmed.')
        else {
          setMessage('Resume requested. Refresh the terminal view to attach; authorize the observed running session separately for mail.')
          onRequested?.()
        }
      } catch {
        if (mounted.current && epoch.current === requestedEpoch)
          setMessage('Resume state could not be confirmed. Inspect the terminal before requesting another launch.')
      } finally {
        inFlight.current = false
        if (mounted.current && epoch.current === requestedEpoch) setPending(false)
      }
    }}>{pending ? 'Awaiting native confirmation…' : 'Start observed SSH resume…'}</button>
    {message && <p role="status" className="agent-mailbox__hint">{message}</p>}
  </div>
}

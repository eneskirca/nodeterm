import { describe, it, expect } from 'vitest'
import {
  reconnectDelayMs,
  closedReasonMessage,
  keyFingerprint,
  HOSTED_APPROVAL_WAIT_MS,
  stripIpcPrefix,
  classifyJoinFailure,
  joinStopMessage,
  isReadOnlyRole,
  hostedRoleLabel,
  viewerBannerText,
  pendingClosedNotice,
  waitingForOwnerText,
  RelayApprovalError,
  mountFailureRetries,
  mountFailureMessage,
  THROTTLED_NOTICE
} from './hostedTeam'

describe('hosted team helpers', () => {
  it('reconnect backoff 1/2/4/8/15 s then every 60 s', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(reconnectDelayMs)).toEqual([1000, 2000, 4000, 8000, 15000, 60000, 60000])
  })
  it('names only reasons the host actually sent', () => {
    expect(closedReasonMessage('removed')).toBe('Your access to this team was removed by an owner.')
    expect(closedReasonMessage('denied')).toBe('An owner declined the request.')
    expect(closedReasonMessage('expired')).toBe('No owner answered the request in time.')
    expect(closedReasonMessage(undefined)).toBeNull()
  })
  it('fingerprint is short and stable', () => {
    expect(keyFingerprint('AAAABBBBCCCCDDDD')).toBe('AAAA·BBBB')
  })
})

describe('hosted join failures (R35 / R39)', () => {
  const wrap = (m: string) => `Error invoking remote method 'relay:client:connect': Error: ${m}`

  it('the approval wait is the host\'s own pending TTL', () => {
    expect(HOSTED_APPROVAL_WAIT_MS).toBe(600_000)
  })

  it('strips Electron\'s prefix, and only that', () => {
    expect(stripIpcPrefix(wrap('[E_JOIN_REFUSED] The file is bad.'))).toBe('[E_JOIN_REFUSED] The file is bad.')
    expect(stripIpcPrefix('Error: plain')).toBe('plain')
    expect(stripIpcPrefix('nothing to strip')).toBe('nothing to strip')
  })

  it('retries ONLY a network failure', () => {
    expect(classifyJoinFailure(wrap('[E_JOIN_NETWORK] Could not reach the nodeterm service.'))).toMatchObject({ code: 'E_JOIN_NETWORK', retry: true, busy: false })
    for (const code of ['E_JOIN_REVOKED', 'E_JOIN_REFUSED', 'E_JOIN_RATE', 'E_JOIN_BAD_CODE', 'E_JOIN_KEY_LOCKED', 'E_JOIN_BUSY']) {
      expect(classifyJoinFailure(wrap(`[${code}] x`)).retry, code).toBe(false)
    }
    // A failure that carries no code (a dev build's refusal, a bug) is never retried unattended.
    expect(classifyJoinFailure('Remote access is unavailable in development builds')).toMatchObject({ code: null, retry: false })
  })

  it('BUSY is its own fact: another attempt of ours is running, not a verdict about the team', () => {
    expect(classifyJoinFailure(wrap('[E_JOIN_BUSY] Already joining this team.'))).toMatchObject({ code: 'E_JOIN_BUSY', busy: true, retry: false })
  })

  it('keeps the detail main wrote, without Electron\'s prefix or the code tag', () => {
    const f = classifyJoinFailure(wrap('[E_JOIN_REFUSED] The hosted-team bookmarks file /x/relay-bookmarks.json cannot be read or safely rewritten; fix or remove it, then join again.'))
    expect(f.detail).toBe('The hosted-team bookmarks file /x/relay-bookmarks.json cannot be read or safely rewritten; fix or remove it, then join again.')
  })

  it('says one sentence per code; a refusal shows main\'s own detail verbatim (items 13, 19)', () => {
    const refused = classifyJoinFailure(wrap('[E_JOIN_REFUSED] The hosted-team bookmarks file /x/b.json cannot be read.'))
    expect(joinStopMessage(refused, 'box')).toBe('Could not join box: The hosted-team bookmarks file /x/b.json cannot be read.')
    expect(joinStopMessage(classifyJoinFailure(wrap('[E_JOIN_REVOKED] x')), 'box')).toMatch(/^This device's access to box was revoked\. Remove the team and join again with a fresh invite code\.$/)
    expect(joinStopMessage(classifyJoinFailure(wrap('[E_JOIN_RATE] x')), 'box')).toBe('Too many join attempts for box today. Try again tomorrow.')
    expect(joinStopMessage(classifyJoinFailure(wrap('[E_JOIN_BAD_CODE] x')), 'box')).toBe('The invite code for box is not valid. Ask an owner for a fresh code.')
    expect(joinStopMessage(classifyJoinFailure(wrap('[E_JOIN_KEY_LOCKED] Unlock the keyring and reconnect.')), 'box')).toBe(
      "Could not load this device's identity to join box: Unlock the keyring and reconnect."
    )
    expect(joinStopMessage(classifyJoinFailure(wrap('[E_JOIN_NETWORK] Could not reach the nodeterm service.')), 'box')).toBe(
      'Could not reach box: Could not reach the nodeterm service.'
    )
    expect(joinStopMessage(classifyJoinFailure('Remote access is unavailable in development builds.'), 'box')).toBe(
      'Could not join box: Remote access is unavailable in development builds.'
    )
    // A team we know no name for.
    expect(joinStopMessage(classifyJoinFailure(wrap('[E_JOIN_RATE] x')), '')).toBe('Too many join attempts for the team today. Try again tomorrow.')
  })

  it('BUSY is never announced as a failure', () => {
    expect(joinStopMessage(classifyJoinFailure(wrap('[E_JOIN_BUSY] x')), 'box')).toBeNull()
  })
})

describe('hosted roles', () => {
  it('only viewers and commenters are read-only; unknown is not a role this answers', () => {
    expect(isReadOnlyRole('viewer')).toBe(true)
    expect(isReadOnlyRole('commenter')).toBe(true)
    expect(isReadOnlyRole('editor')).toBe(false)
    expect(isReadOnlyRole('owner')).toBe(false)
    expect(isReadOnlyRole(undefined)).toBe(false)
  })

  it('the banner is one English line naming the role and the team', () => {
    expect(hostedRoleLabel('commenter')).toBe('Commenter')
    expect(viewerBannerText('viewer', 'box')).toBe("You're a Viewer in box — terminals are read-only. Ask an owner for Editor access.")
    expect(viewerBannerText('commenter', 'box')).toBe("You're a Commenter in box — terminals are read-only. Ask an owner for Editor access.")
  })

  it('another owner answering a request on screen is said; the rest close silently', () => {
    expect(pendingClosedNotice('approved')).toBe('Another owner answered this request.')
    expect(pendingClosedNotice('denied')).toBe('Another owner answered this request.')
    expect(pendingClosedNotice('expired')).toBeNull()
    expect(pendingClosedNotice('gone')).toBeNull()
    expect(pendingClosedNotice('replaced')).toBeNull()
  })

  it('the joiner\'s wait names the team', () => {
    expect(waitingForOwnerText('box')).toBe('Waiting for an owner of box to approve this device…')
    expect(waitingForOwnerText('')).toBe('Waiting for an owner of the team to approve this device…')
  })
})

describe('a hosted tab that never opened', () => {
  it('retries only a drop the host did not explain, or a host that vanished right after approving', () => {
    expect(mountFailureRetries(new RelayApprovalError('The relay connection closed before it was approved.'))).toBe(true)
    expect(mountFailureRetries(Object.assign(new Error('The connection to the server was lost.'), { code: 'E_DISCONNECTED' }))).toBe(true)
    for (const reason of ['denied', 'expired', 'removed'] as const) {
      expect(mountFailureRetries(new RelayApprovalError('x', reason)), reason).toBe(false)
    }
    expect(mountFailureRetries(new Error('No owner answered the request in time.'))).toBe(false) // our own timeout
    expect(mountFailureRetries(null)).toBe(false)
  })

  it('names the team and says what happened', () => {
    expect(mountFailureMessage(new RelayApprovalError('An owner declined the request.', 'denied'), 'box')).toBe('Could not open box: An owner declined the request.')
    expect(mountFailureMessage(new Error("Error invoking remote method 'x': Error: boom"), '')).toBe('Could not open the team: boom')
  })
})

describe('R41: the per-network throttle', () => {
  const wrap = (m: string) => `Error invoking remote method 'relay:client:connect': Error: ${m}`
  it('is retried, carries a Retry-After when main attached one, and is not a BUSY', () => {
    expect(classifyJoinFailure(wrap('[E_JOIN_THROTTLED] limiting'))).toMatchObject({ code: 'E_JOIN_THROTTLED', retry: true, throttled: true, retryAfterMs: null })
    expect(classifyJoinFailure(wrap('[E_JOIN_THROTTLED] limiting [retry-after:90]'))).toMatchObject({ throttled: true, retryAfterMs: 90_000 })
    expect(classifyJoinFailure(wrap('[E_JOIN_NETWORK] x')).throttled).toBe(false)
  })
  it('says a minute, never "tomorrow"', () => {
    expect(joinStopMessage(classifyJoinFailure(wrap('[E_JOIN_THROTTLED] x')), 'box')).toBe(
      'The nodeterm service is limiting requests from this network. Try again in a minute.'
    )
    expect(THROTTLED_NOTICE).toBe('The nodeterm service is limiting requests from this network — retrying in a minute.')
  })
})

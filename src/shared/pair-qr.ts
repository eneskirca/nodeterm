// What the phone-pairing QR actually encodes.
//
// The payload is built by `pairing-core.buildPairingPayload`, and its JSON shape is a fixed
// contract with the nodeterm iOS app. This module is only about the ENVELOPE that JSON is
// wrapped in on its way to becoming a QR:
//
//   'json' — the raw payload JSON. What every release so far has encoded, and the only shape
//            an older iOS app can read.
//   'url'  — `nodeterm://pair?code=<base64url(json)>`. The same bytes, wrapped in the app's
//            registered URL scheme.
//
// Why 'url' exists (eneskirca/nodeterm#745): a QR carrying raw JSON is just *text* to the
// iPhone's system Camera app — there is nothing in it to open, which is why scanning the
// pairing QR with Camera does nothing. A URL is the only shape Camera can act on.
//
// Mirrors `PairURL` + `PairingService.decode` on the phone (nodeterm-ios#23), which accept the
// URL form, the raw JSON, and a bare base64url code. 'json' stays the DEFAULT until that phone
// build has shipped widely — see the note on `DEFAULT_PAIR_QR_FORM`.

export type PairQrForm = 'json' | 'url'

/** The scheme + host + parameter the phone matches on. Same envelope as the relay offer. */
export const PAIR_URL_PREFIX = 'nodeterm://pair?code='

/**
 * The form used unless the user asks for the other one.
 *
 * Deliberately 'json': a phone running an app version that predates URL support decodes the QR
 * as payload JSON and nothing else, so emitting URLs by default would silently break pairing
 * for everyone who has not updated — the exact failure #745 reported, re-created for a
 * different group. Flip this only once the URL-accepting iOS build is out and adopted.
 */
export const DEFAULT_PAIR_QR_FORM: PairQrForm = 'json'

/** base64url, no padding. Uses `btoa`, a global in both the renderer and Node ≥ 16. */
function base64url(input: string): string {
  const bytes = new TextEncoder().encode(input)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Wrap a built pairing payload in the requested envelope. Pure; never throws. */
export function encodePairQr(payloadJson: string, form: PairQrForm = DEFAULT_PAIR_QR_FORM): string {
  return form === 'url' ? `${PAIR_URL_PREFIX}${base64url(payloadJson)}` : payloadJson
}

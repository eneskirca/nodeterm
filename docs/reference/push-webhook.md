# Push webhook (a script or CI job rings the paired phone) — deep reference

Moved verbatim from `CLAUDE.md` so the always-loaded file stays small. `CLAUDE.md`
keeps a short summary and links here. When a rule here changes, update both.

## Push webhook (a script or CI job rings the paired phone)

Settings → Phone → **Push webhook** mints a per-host bearer token; anything that can run `curl`
then pushes a plain-text notification to the phones relay-paired with this machine
(`POST https://api.nodeterm.dev/v1/push/webhook`, `{"title","body"}`). Agents already push through
their hooks; this is for the jobs that have no agent in the loop. The backend half lives in
nodeterm-server (`src/routes/push-webhook.ts`, `src/lib/host-proof.ts`); the desktop half is
`core/push-webhook.ts` (client), `shared/push-webhook.ts` (types, copy, the example) and
`PushWebhookPanel.tsx`. Rules a change must keep:

- **Minting, reading and revoking need the relay host SECRET key, not the public identity.** Other
  host-authenticated backend routes accept `(hostDeviceId, hostPublicKeyB64)` alone — except, since
  R44, for a LATCHED host (one that has proven its key once; every host after
  `POP_REQUIRED_AFTER`), whose host-token mint also needs a relay PoP proof and whose host-mode
  notify / live-update need a `hostAuth` session (§ Hosted team relay). Both fields are known to
  every paired phone; for a send that only lets the holder reach phones that already
  trust the host, but a webhook token is DURABLE — whoever can mint or revoke one can keep a live
  token or silently cut the owner's CI alerts. So each management call is a challenge: the server
  answers with an ephemeral X25519 key (derived from its own secret + the challenge, so no state
  and any instance verifies), and main returns `HMAC-SHA256(X25519(hostSecret, ephemeral),
  context)` with `context` = domain, challenge, action, host device id. The key never leaves main;
  a proof for `status` cannot be spent on `revoke`; a challenge lives 5 min and is single-use per
  process. `webhookProofContext` and the server's `proofContext` are ONE wire contract — change
  both. `core/push-webhook.test.ts` verifies the desktop's NaCl `scalarMult` proof against Node's
  own X25519 (the server's primitive), so the two cannot drift silently.
- **The token is shown ONCE and kept nowhere on this side.** 256 random bits (`ntwh_` + 43
  base64url), stored server-side only as its SHA-256 (a fast hash is right for a high-entropy
  token), returned `Cache-Control: no-store`. The panel holds it in component state until "Done";
  it is never written to settings.json, storage or a log (the panel test asserts local/session
  storage). There is no "show again" — Rotate mints a new one and revokes the old. One live token
  per host is enforced by a partial UNIQUE index on the backend (`host_id WHERE revoked_at IS
  NULL`), not by the mint's transaction: under READ COMMITTED two concurrent first mints each see
  no live row and both insert.
- **Viewing the page calls nothing without a paired phone.** The client asks `hasPairedPhone` (the
  same local check as `pushHasPairedPhone`: a phone pin or a registry device) BEFORE reading the
  host key or the network: the first read of `remote-host-key.json` CREATES it, and a status call
  sends the device id + public key to the backend — neither may happen because someone opened
  Settings → Phone. A failed local check reads as "no phone". And settings search unmounts and
  remounts every row, so the panel reuses its last status answer for 5 minutes
  (`STATUS_REUSE_MS`, module state) instead of spending a challenge + status round trip per remount
  against a per-IP budget that everyone behind one NAT shares.
- **The example never puts the token on argv.** `pushWebhookCurlExample` (labelled `sh`) reads
  `$NODETERM_WEBHOOK_TOKEN` and feeds the header to `curl --config -` through `printf` (a shell
  builtin), the house rule for every credential we generate. Windows has no `sh`, so there is a
  `PowerShell` twin (`pushWebhookPowerShellExample`): `Invoke-RestMethod` makes the request
  in-process, so there is no child argv at all (and PowerShell 5.1 mangles JSON quotes passed to
  `curl.exe`). `shared/push-webhook.test.ts` runs the
  example under a real `/bin/sh` with a recording curl and asserts the token reached stdin and not
  argv.
- **The push is labelled and inert.** Subtitle `Webhook · <hostname>`, its own `thread-id`, the
  phone's existing no-action category `AGENT_DONE`, and an `nt` block with `kind: 'webhook'` and no
  `nodeId`, so a tap opens the Inbox and nothing else: no Allow/Deny buttons, no deep link, no URL
  opened. Title is one line (≤ 120 code points), body ≤ 500; C0/C1 controls, lone surrogates and
  the bidi/zero-width controls are stripped — NOT all of `\p{Cf}`, which holds ZWJ and the tag
  characters (👨‍💻, subdivision flags) — and a payload over APNs' 4096 bytes is refused with a 413
  rather than answered `sent: 0` (lone surrogates JSON-escape to 6 bytes each; measured 4103 bytes
  before they were stripped).
- **KNOWN GAP — needs an iOS release (@eneskirca).** The phone shows these pushes without a release
  (unknown `kind` + no `nodeId` routes to a plain Inbox open), EXCEPT while its Inbox sheet is open:
  `PushPresentation.shouldSuppressBanner` suppresses every push then (the live feed is assumed to
  show it), so `willPresent` presents nothing — no banner, no sound, no Notification Center entry —
  and a webhook message never appears in the Inbox feed. It is lost. The fix is phone-side: do not
  suppress `nt.kind == "webhook"`.
- **Budgets:** 10 per minute per token, 60 per hour per HOST (keyed by hostId, so rotating does not
  reset it), 20 mints per host per day, plus per-IP shields. Fan-out = exactly a host-mode
  `/v1/push/notify`: this host's live relay pairings with a live APNs registration, minus phones
  that muted this host.
- **Relay-paired phones only.** An SSH-granted phone (push grants) has no row the backend can tie to
  this host, so it does not receive webhook pushes; minting with no live pairing answers
  `no_paired_phone` and the panel says so. The desktop refuses before calling at all when it knows
  of no paired phone, so a token left live after every phone is unpaired cannot be revoked from
  here until a phone is paired again (it sends to nobody meanwhile).
- **No canvas-control verb.** An agent already has hook-driven pushes, and a verb would need the
  desktop to hold the token, which it deliberately does not.

Surfaces: Desktop full. **Server Edition: N/A** — it has no relay host key or paired-phone
registry (same degrade as `push-notify.ts`); the bridge answers `E_UNSUPPORTED` and the row is
hidden in a browser tab. IPC is under `pairing:` so `HOST_ONLY_CHANNEL_PREFIXES` keeps it off the
relay. **Mobile:** the Inbox-open gap above needs an iOS release; an iOS follow-up could also give
`kind: 'webhook'` its own Inbox row and tap target.

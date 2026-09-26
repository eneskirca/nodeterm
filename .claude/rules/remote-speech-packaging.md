---
paths:
  - "src/main/remote/**"
  - "src/main/updater.ts"
  - "src/main/telemetry.ts"
  - "src/main/windows-ssh-keys.ts"
  - "src/main/info-plist.test.ts"
  - "src/core/check.ts"
  - "src/core/phone-approval.ts"
  - "src/renderer/lib/relayHostShare.ts"
  - "src/renderer/session/relay-tab.ts"
  - "src/core/speech/**"
  - "src/shared/speech.ts"
  - "src/shared/pairing-gate.ts"
  - "src/shared/update-platform.ts"
  - "src/renderer/components/UpdateCard.tsx"
  - "src/renderer/components/AnnouncementBanner.tsx"
  - "src/renderer/components/Dictation*.tsx"
  - "src/renderer/lib/speechLanguageRows.ts"
  - "package.json"
  - "build/**"
  - "scripts/make-icon.mjs"
  - "scripts/uninstall.sh"
  - ".github/workflows/**"
  - "bootstrap-windows.bat"
---

## Remote access (phone relay) — free, not Pro

- Phone relay remote access ("Reach this Mac from anywhere") is a **Core (free) feature** as of
  2026-08-01 — the iOS app is itself paid, so a desktop Pro gate double-charged the same feature.
  The former Pro gate AND the free-tier monthly quota (`core/relay-quota.ts`, `RelayQuotaBanner`,
  the ProCompare meter, the `relayQuota` IPC/preload/bridge surface, docs/relay-quota.md) were all
  **removed**. The toggle (`settings.phoneAccessEnabled`, Settings → Phone + quick-pair popover)
  shows for everyone; the standing host reconciles on `enabled && relayAllowed()` alone, with no
  quota metering at `onPeerReady`. **Entitlement passthrough remains**: a stored Pro entitlement is
  sent on mints, else the `{deviceId,…}` body (host-token `{deviceId, hostPublicKeyB64}`, device
  mint `{deviceId, hostDeviceId, hostPublicKeyB64, label}`). **The backend is the real gate now**:
  `POST /v1/relay/host-token` / `/v1/relay/device` must admit deviceId (no-entitlement) mints, and
  the relay server may rate-limit free hosts independently — a client-side gate must NOT be
  reintroduced to work around a backend refusal (fix the backend policy instead).
- **A Windows desktop pairs relay-only — no SSH key, and do not "fix" that by writing one.** The
  phone's direct-SSH path is POSIX sh + tmux end to end (nodeterm-ios `HostCommands`, `TmuxBinary`,
  the typed `tmux new-session -A` attach, workspace paths with no `%APPDATA%` candidate). Windows
  OpenSSH hands out `cmd.exe`, and sessions live in the session host, which nothing on the phone
  can attach to over SSH. So on win32 `createPairingService` installs no key, the QR carries
  `"ssh":false`, the QR is gated on the RELAY instead of sshd (`shared/pairing-gate.ts`), and a
  failed relay mint pairs NOTHING (502 to the phone, `reason:'relay-failed'` to the UI) instead of
  the SSH platforms' LAN-only degrade. **A key sshd accepts makes things worse, not better**: the
  phone tries SSH before the relay, so a working key pins it to a path that cannot work, where a
  rejected one lets it fall through. Issue #758's `administrators_authorized_keys` rule is detected
  (`main/windows-ssh-keys.ts`) only to explain the missing key; revoke still sweeps that file IN
  PLACE (a temp + rename would swap its Administrators+SYSTEM ACL for the directory's, and sshd
  would then refuse every admin key in it). Relay attach on Windows rests on the session host
  being packaged (#575, shipped by #579): without that bundle `pty.attach` spawns a new plain shell
  instead of joining the node's session, while `sessionExists` still answers "warm".

## Speech / dictation (desktop + server)

Voice-to-text input captured via microphone, turned into terminal text via on-device Whisper. Works on desktop (Electron) and Server Edition (browser); iOS support is separate (`nodeterm-ios`, private — see the three-surfaces entry under Conventions).

- **Service seam** (`src/core/speech/`) — `SpeechService` (core) + `PlatformSpeechProvider` interface + shell implementations (`PlatformElectron` / `PlatformServer`). Models are stored under `${dataDir}/speech-models/`, with fenced downloads + orphan sweep (`removeUnusedModels`). Core validates license: **tiny** free (always); **base·small·large-v3-turbo** Pro (via `isPremium()`). One model loaded at a time (FIFO memory management), lazy smart-whisper import degrades to a friendly error if the native dep is unavailable (`"Local whisper is unavailable…"`).
- **Cloud contract (iOS parity)** — `/v1/transcribe` multipart endpoint (not built yet; SDK `transcribe()` call matches iOS byte-for-byte) for future remote transcription. IPC channels `speech:*` (in `src/shared/ipc.ts`) wired in **both** Electron and Server: `speech:transcribe` (returns `Promise<{text}>`), `speech:models`, `speech:model-download`, `speech:model-delete`, `speech:progress` (main/server → renderer download-progress broadcast), and `speech:mic-consent` (Electron mic-prompt only, server always true). There is no `speech:synthesize` / `speech:cancel` and no audio in the reply.
- **Renderer capture** — `PcmCapture` AudioWorklet (16kHz single-channel PCM, WebAudio or fallback SPN) + DictationOverlay (⌘⇧D dock mic / Cmd key; Settings → Speech section for model choice + progress). **Send** appends text + Enter to the terminal; **Insert** sends text-only via `sendText(…, {enter: false})`. **Nothing auto-submits** (user always decides when to send).
- **Language** — `SPEECH_LANGUAGES` (`src/shared/speech.ts`) is whisper's own `LANGUAGES` table
  (tokenizer.py) verbatim: 100 entries carrying the code, CLDR's English name, the endonym and the
  alternate spellings people type (whisper's own name where it differs, plus its documented alias
  table); Cantonese is flagged `sinceV3`, the one entry the pre-large-v3 models have no token for.
  It replaced a **7-entry array inside `SpeechSection`** which was the ONLY limit in the whole
  stack (issue #586): `SpeechSettings.language` is a free string nothing validates on the way to
  disk and whisper.cpp takes any code, so `"language": "pl"` hand-edited into settings.json
  transcribed Polish correctly while the dropdown rendered **blank** and overwrote it on the next
  click in the row. Three rules come out of that:
  - The control is the app's **searchable menu idiom** (`SpeechLanguageSelect` — `.bind-select`
    trigger + portaled `.tab-menu` with a pinned filter over a scrolling list, the Source Control
    branch quick-pick's shape), never a `<select>`: 101 rows with no search, unreachable by typing
    "polski", is not a picker. Rows are the pure `renderer/lib/speechLanguageRows.ts`.
  - **A code we cannot name is still the user's setting.** `speechLanguageLabel` returns an unknown
    code AS-IS (not `''`) and the picker gives it its own row, so a display gap can never become
    data loss the way the `<select>` made it.
  - **The cloud `locale` is passed through unchanged, `auto` included.** `register-ipc.ts` used to
    send `language === 'auto' ? 'en' : language`, so on the Cloud engine "Auto-detect" was a hard,
    silent English — on the one engine where a missing language could not be worked around at all.
    `/v1/transcribe` does not exist yet, so `auto` = detect is our contract to write.
  Deliberately NOT done here: seeding the initial value from the system locale (issue #586 §3) —
  the default is still `auto`. **Mobile** keeps its own list, tracked separately as issue #591.
- **Browser constraints** — `getUserMedia` requires HTTPS or `localhost`; mic permission prompt is the browser's own (not handled by nodeterm). Model downloads land on the **server's data dir** (accessible across sessions).
- **Electron + native dep** — smart-whisper is externalized + `asarUnpack`'d (not bundled); `postinstall` rebuilds it against Electron's ABI. Device verification of the ABI rebuild is not yet exercised on a dev machine — test paths exist but have not been run in CI.

## Packaging & auto-update

Built with **electron-builder** (config in the `package.json` `build` block: appId
`com.nodeterm.app`, productName `nodeterm`, mac dmg+zip for arm64 **and** x64, `asarUnpack`
node-pty, output `dist/`). The app icon is generated from the nodeterm mark by
`scripts/make-icon.mjs` (sharp → `build/icon.png` 1024² + multi-resolution `build/icon.ico`
for Windows, both gitignored — regenerated by `make-icon`, which every dist script runs first);
the same script hand-packs `build/icon.icns` (size-checked frames — issue #369) and `build/icon.ico`, which electron-builder embeds as-is. Scripts: `npm run make-icon`, `npm run dist`
(local **unsigned** arm64 `.dmg` smoke test), `npm run dist:win` (unsigned x64 NSIS installer +
zip, `--publish never`). Production release signing/notarization and the update-feed hosting are
handled outside this repo.

**Linux ships AppImage + deb + rpm**, all unsigned, all built by `release-linux` on a plain
`ubuntu-latest` runner (`npm run dist:linux` locally). Three things about it are easy to get wrong:

- **The packages are named `node-terminal`, the AppImage is named `nodeterm`.** electron-builder's
  `linuxPackageName` is package.json's `name`, not `productName` (it only falls back to the product
  name for an `@scope/…` name), so the artifacts are `node-terminal_<version>_amd64.deb`,
  `node-terminal-<version>.x86_64.rpm` and `nodeterm-<version>.AppImage`, the launcher is
  `/usr/bin/node-terminal`, and the install prefix is `/opt/nodeterm` (that one IS the productName).
  Anything that matches on the package name (`scripts/uninstall.sh`'s `dpkg -s` / `rpm -q` probes,
  the README's install lines) must say `node-terminal` or it silently never fires. Renaming the
  package to match the app would strand existing `.deb` installs on a package apt no longer tracks,
  which is why the mismatch is documented rather than fixed.
- **The rpm target shells out to the system `rpmbuild`.** electron-builder bundles fpm, but not
  rpmbuild, so `release-linux` installs it explicitly (`apt-get install -y rpm`); without it the
  target dies with "Need executable 'rpmbuild' to convert dir to rpm". The default `Requires` set
  electron-builder emits (gtk3, libnotify, nss, libXScrnSaver, `(libXtst or libXtst6)`, xdg-utils,
  at-spi2-core, `(libuuid or libuuid1)`) resolves on Fedora 44 with nothing extra pulled in;
  verified by installing the built rpm, which also proved rpm 6.0.2 accepts fpm's spec.
- **Auto-update is already correct for rpm and needs no work**: `isManualUpdatePlatform`
  (src/shared/update-platform.ts) keys off the absence of `APPIMAGE` in the environment, so a deb
  and an rpm install both land on the manual-download card rather than downloading an AppImage
  they cannot install.
- **The ORDER of `build.linux.target` is load-bearing: AppImage stays FIRST.** electron-builder
  writes the update feed from the first target it can publish, so the entry at the head of that
  array is what `latest-linux.yml` points at — and the AppImage is the only Linux artifact
  electron-updater can actually install in place. `deb` has sat behind it for a long time without
  disturbing the feed, and `rpm` is appended behind both for the same reason. package.json is JSON
  and cannot carry the comment, so it is written here: **do not alphabetize or otherwise re-sort
  that array.**

**Building on a GCC 14+ distro needs `CFLAGS=-D_GNU_SOURCE`** (Fedora, Arch, recent openSUSE; the
CI runners are old enough not to care). smart-whisper's vendored `whisper.cpp/ggml/src/ggml.c`
calls `CPU_ZERO`, `CPU_SET_S`, `pthread_getaffinity_np` and `getcpu` without ever defining
`_GNU_SOURCE` (upstream ggml gets it from its CMake build, which node-gyp does not use), and GCC 14
promoted implicit function declarations from a warning to an error, so a bare `npm install` fails
in smart-whisper's own install script before our `postinstall` ever runs. Measured on Fedora 44 /
GCC 16.2.1: `CFLAGS=-D_GNU_SOURCE npm install` builds both native modules clean. Two Fedora runtime
packages are needed on top: **`libxcrypt-compat`** (fpm's bundled Ruby links `libcrypt.so.1`, which
Fedora's glibc dropped, and without it BOTH the deb and the rpm target fail), and **`fuse-libs`**
for anyone running the AppImage, whose default runtime is still the FUSE2 one. Switching
`build.toolsets.appimage` to `"1.0.3"` would drop that FUSE2 requirement, but the static runtime is
upstream-flagged beta and stops passing the `--no-sandbox` launcher argument the FUSE2 path adds,
so it is a deliberate not-yet.

**Windows ships as an UNSIGNED BETA** (extracted from external PR #276; the session-host phase
#305 merged 2026-08-20, and the decision to release without signing is #454 — CI-green, but no
real-device daily-use verification yet, and that is a stated risk, not an oversight). Deliberate
decisions: the target
is **NSIS via electron-builder** — the fork switched to Squirrel.Windows
(`electron-builder-squirrel-windows` + an 800-line `windows-installer.mjs` wrapper + its own
update feed), but our pipeline is electron-builder end-to-end and NSIS is built in, needs no
extra dependency, and is what electron-updater's generic provider expects on Windows — so
Squirrel was not adopted. Builds are **unsigned** (no Windows cert; electron-builder skips
signing when no cert env is present; SmartScreen warns on install). Release wiring is
`release.yml`'s `release-win` job: on every version tag it uploads the NSIS installer + zip as
GitHub Release assets — **best-effort by design** (the `publish` promote gate does not wait on
it, so a Windows failure never strands the mac+linux release) and with **no update-feed leg**:
`dist:win` stamps `nodeTermUpdates=disabled`, so the shipped app's updater is cleanly off (no
latest.yml anywhere, no 404 polling; users update by downloading the next installer). Do not
add `*.yml`/`*.blockmap` to that job's upload globs — that IS the auto-update leg, and it waits
on signing. `bootstrap-windows.bat` (repo root) takes a fresh Windows
machine to a built checkout: it verifies Node ≥ 20 / VS Build Tools C++ / Python 3 with exact
winget hints (it never installs machine-wide tools itself, and the full bootstrap refuses to run
elevated) and runs `npm ci`. Its `--check-vs-build-tools` mode is the narrow exception used by
`quality-windows`: it branches before the elevation refusal, runs only the VS C++ probe, and exits
before the Node / Python / `npm ci` steps. Fixture injection additionally requires the explicit
`NODETERM_BOOTSTRAP_TESTING=1` sentinel. The C++ probe also verifies the x64 Spectre runtime that
`node-pty`'s `/Qspectre` build requires; the workload alone can be present while that optional
component is absent, which otherwise fails only after the full install with `MSB8040`. Before
`npm ci`, the bootstrap sets `npm_config_enable_thin_lto=false` and
`npm_config_enable_lto=false`: official Node 26 Windows builds carry clang/lld ThinLTO settings in
`process.config`, and node-gyp 12 copies them into an MSVC addon project where `link.exe` rejects
`/opt:lldltojobs` with `LNK1117`. These are gyp overrides, not a reason to reject a Node version
allowed by `package.json`. `.github/workflows/win-package-smoke.yml` is a
**workflow_dispatch-only** packaging smoke on windows-latest — build only, never publishes.
Windows installer safety (#829): `build/installer.nsh` overrides NSIS's process-killing check.
A running app or session host blocks install/uninstall, and a failed process query blocks too.
Never restore automatic host termination: quitting the app preserves those live sessions.
Update preparation must keep saved canvas nodes: exit programs normally, quit, then have the user
verify and stop any remaining host. Never recommend **End session** (it deletes nodes). Cold agent
resume depends on supported, saved conversation history; it does not preserve running tasks.
See `docs/windows-session-host.md` for the user-controlled preparation/recovery steps and limits.

**Follow-ups, in order:** code signing, then Windows auto-update wiring (electron-updater NSIS leg
+ `latest.yml` on the nodeterm.dev feed — blocked on signing: an unsigned auto-update is a
downgrade in trust), and the fork's PE-identity polish (electron-builder leaves `OriginalFilename`
empty; the fork's
`resedit`-based afterSign hook fixes it — cosmetic for NSIS, load-bearing only for Squirrel).

**macOS permission prompts are declared in `build.mac.extendInfo`, and a missing one denies
SILENTLY.** On macOS 15+ a connection to the user's own subnet is gated by Local Network privacy,
and it is attributed to the **responsible process** — for everything nodeterm spawns (the tmux
server, the shell, an agent CLI, the `node` it runs) that is nodeterm.app, not the child. With no
`NSLocalNetworkUsageDescription` there is no string to prompt with, so the system never asks and
**no row appears** under System Settings → Privacy & Security → Local Network for the user to
grant: an agent gets `EHOSTUNREACH` on a LAN address while `/usr/bin/curl` (Apple-signed, exempt)
reaches the same host in the same second — a permission failure wearing a network outage's error
(issue #589). `NSBonjourServices` is the trap that travels with it: it is required only to *browse*
mDNS services, which this app does not do, and declaring service types we never browse is a false
claim to the user and to review — unicast LAN access needs the usage description alone. The key is
what makes the denial grantable; it is not itself proof anyone's access came back. Guarded as an
allowlist-with-reasons by `src/main/info-plist.test.ts`, the sibling of the entitlements guard.

Auto-update uses **electron-updater** (`src/main/updater.ts`, `initUpdater(onBeforeRestart?)` from `index.ts`):
runs **only when `app.isPackaged`** (dev = no-op), checks on launch + every 6h, auto-downloads,
forwards the lifecycle (`update-available` / `download-progress` / `update-downloaded` / errors)
to the renderer over IPC. `components/UpdateCard.tsx` shows the strip + **Restart to update** →
`updates.restart()` → `autoUpdater.quitAndInstall()`; on `update-downloaded` an OS notification
also fires when the window is unfocused. Exposed via `window.nodeTerminal.updates` (`UpdateApi`).
macOS *silent* self-install requires a signed+notarized build; unsigned builds still surface
the card for a manual download.

**Backend check feed** (`src/core/check.ts`, successor to the static `announcements.json`): the
**main process** calls `GET https://api.nodeterm.dev/v1/check?version=&os=&channel=stable` (so the
renderer CSP stays `'self'`) on launch + every 6h, cached 5 min, returning `{ messages, update }`.
Exposed split over two IPC handlers: `announcements.fetch()` → `messages`, `appUpdatePolicy` →
`update`. `components/AnnouncementBanner.tsx` (stacked above `UpdateCard` under the tab bar in a
`.top-banners` column) shows the newest message the user hasn't dismissed (dismissed `id`s persist
in `localStorage`); `update.mandatory`/`minSupported` flips `UpdateCard` into a blocking required-
update state. The call no-ops under `DO_NOT_TRACK`/`NODETERM_TELEMETRY_DISABLED` or in unpackaged
builds (unless `NODETERM_API_BASE` targets a local server). Schema example:
`docs/announcements.example.json`. **Telemetry** (`src/main/telemetry.ts`) is a separate opt-out
ping to `api.nodeterm.dev/v1/ping` (version/OS on launch + daily), gated on
`settings.telemetryEnabled` + the same build/DNT guards; toggle in Settings → Privacy.

### Standing phone consent lifetime (#819)

A browse socket can close before the human clicks the SAS dialog. `core/phone-approval.ts` retains
only the handshake-bound id/key for 120 seconds, at most 64 requests, one per key. Socket closure
releases presence and transport but does not discard that bounded consent; replacement, rejection,
expiry and host stop clear the exact dialog id. Approval requires BOTH id and displayed key (no
key-only match or mismatched-key fallback), consumes once, then persists before granting access.
`remote:phone:approve` is raw, owner-window Electron IPC, never a relay RPC. Its response separates
stale/persistence failure from approved/saved-disconnected; renderer rejection/timeout is explicitly
unconfirmed. SAS derivation and mutual trust verification are unchanged. Legacy interactive offers
remain session-only, and Server Edition rejects standing phone approval as unsupported.

Pin/revoke mutations use `updateApprovedDevices` to queue the entire read/modify/write in process;
unique-temp atomic rename alone cannot prevent lost updates. Non-ENOENT reads and malformed JSON
reject rather than overwrite unknown trust state. The queue is not a cross-process lock. A click
accepted before host stop may finish its disk save, but must never open the now-closed session.

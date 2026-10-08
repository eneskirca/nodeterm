# Android companion — design notes

`android/` is the Android counterpart of the iOS companion (nodeterm-ios, a separate private repo).
It speaks the protocol the desktop serves to phones, with additive typed host verbs, mirror
fields and an owned SSH actions service documented below. This doc records what the app relies on,
where each fact comes from, and what is not done.

**Upstream PR conflict integration (2026-10-08).** The Android contribution now incorporates
upstream `main` at `adde5e85` (v0.4.2), retaining the phone's typed host verbs, managed terminal
ownership, SSH-visible files and marker-framed v2 answers alongside upstream chat, role-scoped
pairing and session backends. Android also recognizes upstream Antigravity and matches its
`agy` launch/resume grammar without inventing approval flags. The merged managed hook uses revision 6: older revision-5 hooks
are not admitted for upstream unmarked structured answers, while legacy phone answers keep
their separate contract. The current merge has its own offline, desktop and CI checks; it does
not change the source binding of the prepared beta23 APK or the last verified installed
beta22/code23. Merged-source device acceptance remains pending, and the original
**10 Pass / 22 Partial / 32 Pending** ledger is unchanged. **iOS implications for @eneskirca:**
the upstream chat/role changes and new structured-answer revision gate are shared host behavior;
the existing Android/iOS phone verbs and v2 framing remain compatible.

**Pending Send after remount (2026-10-08, A137 — published; beta23 prepared).**
Pending Send state and guidance belong to the retained entry, with exact button/IME admission and
uncertainty preserved until dismissal. Source `b9e4cbc7` passes focused66/9, thirteen intended mutants,
fresh1069/116/offline app and CI37740459063 all-five/ten-step. Retained-signer beta23/code24 is
prepared and reviewed with 46 available SDK36/R8/metadata checks; actual SDK37 verification is absent.
A read-only pre-install snapshot refused before any update dispatch. Installation and the controlled
pending-Send phone case remain unverified; beta22/code23/source `2ba0b142` is last verified installed.
The original **10 Pass / 22 Partial / 32 Pending** ledger is unchanged. See [the scoped finding](#pending-send-outcome-after-remount-2026-10-08-a137).

**Beta22 remount follow-up (2026-10-08 — bounded physical pass).** On the Pixel 7a,
retained-signer beta22/code23 (`fa894d4b`, source `2ba0b142`) keeps the exact unsent draft and
checked Ctrl through one normal locally rejected Pair screen and Back. Both original Bash panes,
server/socket, captures and desktop clients stay unchanged; the phone client reattaches under its
same SSH parent/session/TTY. No Send or producer runs. Source `2ba0b142` passes **1054/114**, offline
app compilation and CI37732792493 all-five/ten-step. In-place update preserves measured install
time and full runtime-permission blocks. Owned profile/auth/reverse/fixture cleanup is verified;
raw-input Ctrl timing, selection/IME and pending-Send checks remain unverified. The original
**10 Pass / 22 Partial / 32 Pending** ledger and installed artifact source stay unchanged.

**Retained terminal editor (2026-10-08, A136 — source fixed; bounded fixed-phone pass).**
The Pixel 7a/beta21 loses its unsent draft and armed Ctrl after another screen covers the terminal
and Back returns. The fix keeps the full editor and Ctrl state with that live navigation entry.
Nine store and three wiring regressions pass; seven policy mutants and one wiring mutant are
caught. Beta22/code23 is published and installed; one retained-entry remount now passes. The
original **10 Pass / 22 Partial / 32 Pending** ledger is unchanged; see
[the scoped evidence](#retained-terminal-editor-2026-10-08-a136).

**Captured Ctrl consumption (2026-10-08, A135 — source fixed).** Delayed raw-keyboard
consumption now checks the captured Ctrl revision as well as its viewer. Five policy and three
wiring regressions pass; three policy mutants and one wiring mutant are caught. Source publication
and beta22 installation pass; a physical scheduling reproduction remains pending. See
[the scoped evidence](#captured-ctrl-consumption-2026-10-08-a135).

**Lost Send reply/newer draft (2026-10-08 — bounded physical pass).** A fresh Pixel 7a/beta21
direct-SSH case loses the original reader's successful 22-byte Enter receipt before it can return
to userspace. The exact newer 146-character draft is observed with Send disabled before loss;
it remains afterward while the app reconnects. One original-TTY witness/ACK stays unique at a
late observation more than 120 seconds later, and automatic recovery attaches a new viewer to
the original Bash/server/socket/producer with the complete sibling guard unchanged. Observed
checkout `5a3013dd`, Desktop build `0d8594a6` and installed APK/source `ef4caec2` are distinct.
Owned cleanup and original 15000-ms timeout restoration pass. Android's internal result is not
observed; network blackhole, whole-host loss, remount/Ctrl during pending Send, native TLS/history
and the full device matrix remain unverified. The original **10/22/32** ledger stays unchanged.
See [the measured receipt loss](#lost-send-reply-and-newer-draft-2026-10-08).

**Held Send reply/newer draft (2026-10-08 — bounded physical pass).** A fresh Pixel 7a/direct-SSH
case observes the exact newer 146-character draft with Send disabled before a measured
9.000280-second post-execution receipt hold ends; after release the same draft remains with Send
enabled. One original-TTY witness/ACK stays unique 168.735781 seconds later, with the original
Bash/server/producer/socket/guard retained. Observed checkout `50e7a876`, Desktop build `0d8594a6`
and installed beta21/code22 APK/source `ef4caec2` are distinct; no product or APK change occurs.
Owned phone/host cleanup completes, with original timeout 15000 ms independently confirmed after
an uncertain restore, without replay. At that checkpoint, lost reply, network blackhole,
remount/Ctrl during pending Send and native TLS/history remained unverified; the original
**10/22/32** ledger is unchanged.
See [the measured receipt hold](#held-send-reply-and-newer-draft-2026-10-08).

**Earlier nine-second Send/newer-draft follow-up (2026-10-08 — bounded partial).** A fresh `d361ce8f`
fixture uses unchanged Desktop/build `0d8594a6` and stock beta21/APK source `ef4caec2`.
One Send and a draft suffix return before the same SSH peer resumes, but the final newer-draft/
disabled-Send XML observation misses the pause deadline; the original wrapper remains failed.
Later XML retains the exact newer draft and saved pixels show its suffix; Send is enabled and one
original-TTY witness/real ACK stays unique 125.310 seconds later. At that earlier checkpoint, the
strict timed race and lost-reply cases were unverified; the failed wrapper remains preserved.
See [the bounded follow-up](#nine-second-send-and-newer-draft-follow-up-2026-10-08).

**Silent SSH peer recovery (2026-10-08, Pixel 7a / beta21 — bounded pass).** Fresh owned checkout
`04da9b9e` uses unchanged Desktop/build `0d8594a6` and installed APK/source `ef4caec2`. Only the
admitted old SSH peer is stopped for 45.000 seconds on shared loopback; automatic recovery creates
a new viewer while it is paused, preserving the original shell, producer, tmux server/socket and
guard. The unsent draft and its saved rendered text remain; one later explicit Send executes once
and receives a real ACK. At that checkpoint, whole-host/network loss, cursor position and
lost-reply races remained unverified. Owned cleanup passes; the original **10/22/32** ledger stays
unchanged. See
[the bounded receipt](#silent-ssh-peer-recovery-and-single-send-2026-10-08).

**Native Desktop continuity (2026-10-08 — scoped verification).** A fresh private Desktop/build
`0d8594a6`, observed with the docs-only `98907171` checkout, passes two original session-host
factories, retained capture of all 200 unique numbered markers with Unicode, one normal renderer
reload and input to the same original shell before/after it. The complete sibling capture and
original daemon/Bash/producer/socket generations stay unchanged; owned retirement is verified.
Android native-history/Live-overlay acceptance, silent network loss and native-route held/lost replies remain open.
Installed beta21 and the original **10 Pass / 22 Partial / 32 Pending** ledger are unchanged.
See [the native consumer receipt](#native-desktop-capture-and-renderer-reattach-2026-10-08).

**Login-shell deadline (2026-10-08, A134 — published; original create verified).**
Signed, pushed `3f382367`/`0d8594a6` pass forced **1033 methods / 110 suites**, offline app compilation,
full TypeScript and **161 tests in nine affected Vitest files**, with five known Windows-only skips.
[Run `37702852854`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37702852854), attempt 1, passes all five jobs and ten required steps.
A fresh source-built Desktop observes one original Linux session-host create fulfill and display
its Bash prompt, with zero PTY input. V13's child cause and whether fallback fired remain unknown;
native history and its phone overlay remain pending. Installed beta21/source `ef4caec2` and the
original **10 Pass / 22 Partial / 32 Pending** ledger are unchanged.
See [the scoped source checkpoint](#login-shell-probe-completion-deadline-2026-10-08-a134).

**Direct SSH continuity (2026-10-08, Pixel 7a / beta21).** Desktop `0d8594a6` with the unchanged
stock APK/source `ef4caec2` passes controlled SSH-handler recovery, two active Home/resume cycles,
draft retention and one explicit Send to the original tmux pane. The producer/server/socket and
sibling guard remain unchanged. Phone cleanup is verified; the outer runner stop-accounting
negative is preserved. Native-history/relay/notification and wider lifecycle cases stay open.
See [the bounded continuity receipt](#direct-ssh-reconnect-and-active-background-continuity-2026-10-08).

**Beta 21 published and installed (2026-10-07 — bounded closed SSH display verified).**
Signed, pushed `ef4caec2` passes forced **1033 methods / 110 suites**, zero failures/errors/skips,
offline app compilation and full TypeScript. [Android run `37678829862`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37678829862),
attempt 1, passes all five jobs and ten required steps. Retained-signer **beta 21/code 22** is
installed on Pixel 7a, APK SHA-256 `91638d05e6192794675dee6a045f53f19cdea707187ebb3482b8ae3f10320120`.
All **46 SDK 36 artifact checks** pass; actual SDK 37 tools are unavailable. The 5.083-second
beta-20→21 update preserves first-install time and the complete notification grant/flags;
the same owned SSH profile and session rows remain visible after the update.
A fresh owned direct-SSH producer completes all 1200 numbered rows and its confirmed 24-byte
completion write in **48.23 seconds**. Actual producer progress crosses Home/resume; later phone
screens show numbered/Unicode rows, the completion marker and older tmux history after a swipe.
The crossing uses receipt/filesystem order, not exact phone-monotonic latency. The original A132
negative remains separate, with attribution open. A133's same-page exit-0 display retains eight
Unicode rows, wraps and the final tail; Copy-sheet filtering/selection, exact OSC8/plain URL offers
and font redraw pass. A fresh same-page follow-up copies the exact final marker and one Unicode
row through the normal clipboard into the ended composer; OSC8/plain link offers match after
smaller and restored fonts. At that copy/link checkpoint, browser navigation and Share were untested; wider lifecycle/TUI checks remain unverified. A129/A130 native-history acceptance and wider lifecycle/notification checks remain separate. The original **10 Pass / 22 Partial / 32 Pending** ledger is unchanged.
The preceding docs-only `9b8bba2b` checkpoint passes forced 1033/110/app/TypeScript and
[Android run `37690764287`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37690764287),
all five jobs and ten required steps. The build and installed APK remain bound to `ef4caec2`;
subsequent documentation publication requires fresh exact-revision gates and CI receipts.
The user authorized ongoing tests without a screen lock: ordinary wake and app launch are allowed,
with no PIN input or lock/security changes. The owned QA profile/public-key line/reverse are
removed, actual timeout readback confirms the original 15000 ms, and the exact disposable host
retires with listeners closed and private authentication removed. Beta21 remains installed. The regular Desktop is not deployed
and no PR is opened.

**Fresh native diagnostics (2026-10-08; source unchanged).** The `9b8bba2b` normal-Fedora
40-ms run records all 1200 rows and its standalone marker; original A132 attribution stays open.
Linux session-host V8/V9 pilots stay blank before input; V9's 30-second gate/all-thread observations
still do not prove original creation or attachment. A129/A130 acceptance remains pending. See
[the scoped evidence](#fresh-fedora-output-and-native-desktop-readiness-2026-10-08).

**Browser/Share pilot (2026-10-08; bounded live SSH).** Normal Copy Links Open reaches Vanadium's
exact nonce address and rendered content; Share previews only the selected marker and Back returns
to the owned terminal. Browser Back remains unverified; ordinary resume succeeds. Original
producer/guard continuity and exact owned cleanup pass; Open-focus and timeout uncertainties
are reconciled without replay.
No recipient, closed-page browser-lifecycle, wider matrix or ledger credit is claimed.

**Earlier beta 20 publication and installation (2026-10-07, A131 — physical checks partial).**
Signed `11fbff08` passes forced **1029 methods / 108 suites**, zero failures/errors/skips,
offline app compilation and full TypeScript; [Android run `37659190980`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37659190980)
passes all five jobs and ten required steps. Retained-signer **beta 20/code 21** is installed on
Pixel 7a; the 4.875-second beta-19→20 update preserves first-install time and notification grant/flags.
A resumed direct-SSH screenshot contains later numbered rows than the earlier capture; active
production during backgrounding is unproven, so no background-delivery pass is claimed. The guard
shows only its own prompt. All 1200 numbered rows remain in native capture, but its completion marker is
absent there too ([A132](android-audit-2026-09.md#a132), attribution pending). After a separate
phone Send/exit, the terminal shows `[exited]` and an exit-0 overlay without the previously displayed
history ([A133](android-audit-2026-09.md#a133), cause pending); final-marker emission was not captured.
A131's focused **71/8** and **10 behavioral/four app source-pin mutants** remain source evidence,
not full lifecycle acceptance. Already-dispatched WebView JavaScript, A129/A130 native history,
wider lifecycle/notification cases and the original **10 Pass / 22 Partial / 32 Pending** ledger
remain outside these observations. See [the bounded receipts](#beta-20-publication-and-bounded-output-checks-2026-10-07).

**Closed SSH/tmux display follow-up (A133 — published source repair; bounded physical checks pass).**
Native raw exit traces confirm `CSI 2 J` erases the visible alternate pane before `CSI ?1049l`.
This change retains that pane only at an admitted SSH/tmux EOF, as an inert same-page display with
Copy/links; live parsing, scrolling and transport capabilities stay unchanged. **27 shipped-xterm
component cases pass in the permanent behavioral JUnit regression**, alongside **three passing
app source-pin methods** and the existing swipe suite. The first full run caught a same-view delayed
Enter regression; layout changes now preserve it while viewer retirement still cancels it. Its
27-case mutation/control/restored checks pass. Earlier **11 semantic mutants** plus one geometry
mutant and three separate app source-pin mutants remain separately recorded below. Final
1033/110/app/TypeScript gates and all-five/ten-step CI pass at `ef4caec2`; beta 21/code 22 is
installed. Bounded same-page closed-screen, Copy-sheet, exact final-marker/Unicode clipboard
paste and post-font OSC8/plain link-offer checks pass. The later normal browser/Share pilot is
bounded as above; wider lifecycle/TUI checks remain unverified. The earlier beta 20
came from `11fbff08`, with `656e5d8a` as its later docs-only head. A132's clean native
short/long-prompt controls pass, but the
original Fedora 40-ms/phone completion-marker case remains open. The original 64-row ledger stays
**10 Pass / 22 Partial / 32 Pending**. The equivalent iOS EOF/display behavior needs adoption review
by @eneskirca; no wire change is introduced.

**Earlier beta 19 checkpoint (2026-10-07 — bounded direct-SSH checks pass).**
Signed, pushed `5bda2c32` includes the A130 held Live-touch fix. Forced fresh offline protocol
checks pass **1015 methods / 106 suites**, zero failures/errors/skips; offline app compilation
and full TypeScript pass. [Android run `37608652625`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37608652625)
passes all five jobs and ten required steps. Retained-signer **beta 19/code 20** is installed
on the intended Pixel 7a, SHA-256 `e7271ebe1c1d65d8f6a09f7c59ab4b0042081c152c421568caabdcf6965bad42`.
The 6.18-second beta-17→19 update preserves first-install time and the notification grant/flags;
actual SDK 36 artifact checks pass and SDK 37 tools are unavailable. Public SSH identity continuity
and a fresh explicit-profile first pin pass through an owned ADB reverse tunnel. Emacs/vi copy-mode
Send, brief background/resume draft retention, neutral viewer-close/manual Reattach and controlled
SSH-handler recovery pass on the disposable Linux host; that earlier owned cleanup passes.
Saved-profile/pin reuse and manual changed-key refusal now pass too; A129 native/session-host
history, A130 held Live touch and the wider lifecycle/provider matrix remain pending. The original
**10 Pass / 22 Partial / 32 Pending** ledger is unchanged.

**A105/A106 Pixel 7a checkpoint (2026-10-07, Desktop `e06b5547` / beta 19).** Normal Always
allow applies one original `localSettings` rule; real sibling Claude makes two Bash calls without
another hold. One original two-question request submits Cobalt (single) and Lint/Docs (multi),
with real CLI tool/Stop/final-output confirmation. Saved-profile/pin reuse and changed-key refusal
pass, and both owned fixtures and the QA profile/key/reverse retire cleanly. Rule restart-persistence,
production-pane-child launch and the wider matrix remain pending.

The fresh API-30 emulator boots initially but remains offline
after its one provisioning reboot; its bounded reconnect/screenshot/debugger diagnostics and
owned cleanup add no app/CA/APK acceptance. See [the scoped evidence](#beta-19-publication-provider-and-emulator-checkpoint-2026-10-07).

**Earlier native history publication (2026-10-07, A129 — physical acceptance pending).**
Signed backend `0818bbed` and host/Android/producer/CI `2d693263` are included in the signed,
pushed integration `1add0408`. They implement
`pty.attach`'s `scrollV1` capability and `pty.scrollV1` for bounded, inert native/session-host
history. A valid viewer token continues paging its immutable snapshot despite live application
mouse-mode changes; Live, actual user input, resize or an explicit new intent clears that view.
A new intent checks the actual backend mode before any wheel input. Source publication and
mandatory verification pass; actual app/WebView, physical ConPTY and phone acceptance remain
unverified.

Keep the proof layers separate: **34 emulator tests / 3 files + 20 assertion-caught mutants**;
**343 backend tests / 37 files + 21 assertion-caught mutants**, with four existing Windows-only
skips on Linux; **13 helper/RPC control/restored tests + 18 assertion-caught mutants**; and one
fixture-cleanup test with one assertion-caught mutant. Focused Android control/restored runs pass
**99 methods / 11 suites** and the offline app check. Its **14 assertion-caught variants** are
**13 behavioral mutations + one posted-Runnable source pin**. Separate CI-reader control/restored
checks pass **11 methods** and catch **eight configuration-input deletions**; these are not
additional production mutations. No aggregate combines these layers or earlier attempts.
The root helper/RPC receipt is `a129-history-view-proof-v4-67xv3v57/mutation-result.json`, SHA-256
`fe62c4f299afa9a7254ddb8aaf8e052386e71f7742917565c90363a8fb025583`.
At exact `1add0408`, forced fresh offline protocol checks pass **1012 methods / 105 suites**
with zero failures/errors/skips; offline app compilation, **568 affected Vitest tests / 52 files**
with exactly four existing Windows process-tree skips, and full TypeScript pass.
[Android run `37602046133`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37602046133),
attempt 1, passes all five jobs and ten required steps. Private
`a129-publication-biru7yjl/gates.json`, `ci-result.json` and `final-report.json` bind this source.
The retained-signer **beta 18/code 19** APK is ready and **not installed on the intended phone**, SHA-256
`19d55ee177335064b1edb4874b6d27216862d16a7d30ebe476875c566cd263e0`. Actual SDK 36 artifact
checks pass; SDK 37 artifact verification is unavailable. These are source/component/recorder
and browser-harness boundaries, not full Desktop/WebView or phone acceptance. The regular
Desktop is not deployed and no PR is opened.
The separate published A128 checkpoint `944223ef` has **984 protocol methods / 102 suites**,
**360 affected Vitest tests / 26 files** and all five jobs/ten required steps green in
[Android run `37594743169`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37594743169).
Its private `a128-publication-1vq7hcgc/gates.json` and `ci-result.json` retain that exact source
binding. At that earlier checkpoint, installed beta 17/code 18 remained from `a79375c3`; no new physical acceptance or change
to the original **10 Pass / 22 Partial / 32 Pending** ledger is claimed.

**Held Live-button published follow-up (2026-10-07, A130 — app acceptance pending).**
Signed `9da36320`, included in published `5bda2c32`, stops old momentum and the native pending-scroll
queue on touch-down, preserving history and its display epoch until click. Three new LiveTouch
JVM methods pass within **48 methods / 7 suites** in control and restored runs, with zero
failures/errors/skips. **Three semantic mutants** (old handler, premature history close, parent
gesture) fail assertions. Exact-head final gates/CI pass and beta 19/code 20 is installed;
actual WebView/physical acceptance remains pending. The `1add0408` failure remains historical.

**Composed Send backend follow-up (2026-10-07, A128).** Current source also supports the
attached direct native Windows PTY and a session host that negotiates `composed-input-v1`.
The host owns one-use tickets scoped to its live session generation and the original subscriber
socket; paste and Enter remain separate writes at least 150 ms apart. A lost receipt after input
may have been sent stays uncertain and never replays. Older live hosts refuse without being
restarted. The public Android `pty.submitComposed` request/result is unchanged; its actual
backend producers are tested through the relay and Kotlin client. Windows ConPTY and phone
acceptance of these additional backends remain unverified. At that earlier checkpoint, installed beta 17 still came
from `a79375c3`; that host-side follow-up did not represent a new installed APK.

**Beta 17 Pixel 7a follow-up (2026-10-06, A127/A128).** Retained-signer beta 17/code 18
from `a79375c3` is installed on the intended Pixel 7a (Android 17/API 37,
Vanadium `154.0.8037.126.0`) against a fresh disposable Desktop from the same source.
The 5.48-second same-signer update preserves the first-install time and saved temporary SSH
profile; Sessions reopens without editing its pin or readmitting the phone key. One emacs
copy-mode Send submits exactly once to the original producer, exits copy mode and leaves the
sibling guard unchanged. The A127 viewer-only exit now shows a neutral connection-close notice,
disables Send and retains the draft; manual Reattach preserves the same producer and complete
same-grid history, and the retained draft submits once. These are bounded repaired-device cases;
vi copy-mode recovery/Send also preserves the pane and full same-grid history, with the draft
retained and Send disabled during the outage, then one native submission after recovery. One
Ctrl+C action reaches the owned raw TTY consumer as exactly `03`, with no extra byte in a bounded
0.8-second window. Actual phone-managed shell creation and exact owned SSH End pass too:
the producer/pane/viewers end while the sibling guard and expected canvas node remain.
Only the temporary profile/public-key admission are retired; the nonce-validated host stop
removes generated private authentication and closes both owned listeners. Nine bounded cases
and 303 raw-artifact hashes are recorded in the frozen report; ordinary native Quit is unverified.

At exact merged `a79375c3`, full forced offline protocol checks pass **982 methods / 102 suites**,
zero failures/errors/skips; offline app compilation, **187 affected Vitest tests / 11 files**
and full TypeScript pass. [Android run `37523703627`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37523703627)
passes all five jobs and ten required critical steps. The APK and installed public-code pull
both hash to `c51433d4…`; actual retained-signer verification uses SDK 36, with SDK 37 tools
unavailable. A127 is source-fixed in `0d50075a`; A128 in `7e7d2c04`, with beta CI registration
`5484ab9f` and **30 assertion-caught source/configuration mutations**. Older beta-16 failures
remain historical. This does not complete the 64-item checklist or the original Pixel 10 Pro
ledger, which stays **10 Pass / 22 Partial / 32 Pending**. See [the bounded beta-17 receipt](#pixel-7a-beta-17-upgrade-and-composed-send-2026-10-06).

**Desktop SSH reconnect checkpoint (2026-10-06, A125/A126).** A125 is source-fixed in `415dae9b`; A126 is committed in `5b7286b3`.
Eight actual Linux Desktop **Canvas/Modal × soft/hard wraps × inner none/SGR mouse** cases
pass at `5b7286b3`. Each loses one birth-pinned product ControlMaster, creates a new master/
selected local viewer and retains its remote pane/server/producer/cwd and complete same-grid history before,
during, after and at final observation. Both trusted actual textarea `g` inputs are acknowledged
on the old/new PTY: **16 ACKs**, **zero unexpected bytes**, one producer paint per case and
**16 complete URL activations**. Native hover/leave and exact owned cleanup pass. Modal cases
use `80x24`; Canvas cases use `49x48`, with each history comparison bound to its own grid/case.
**294 unique affected tests / 17 files** and full incremental TypeScript pass. **15 isolated
mutants (six A125 + nine A126)** are caught by assertions; each fix's control/restored runs pass.
Forced offline checks at `5b7286b3` execute **950 tests / 98 suites**, zero failures/errors/skips,
and both protocol/app Kotlin compile tasks. These are disposable QA hosts; no new APK or regular
Desktop installation is included. Publication requires fresh offline gates and all five Android
CI jobs for the exact published HEAD; its private bundle and final report carry that run's result.
A separate Linux two-host soft/none case passes at `59e4c93e`: one quiet park/adopt cycle,
inactive B global-card warm reconnect while A stays active and unchanged, **3 native ACKs / 2
complete URL activations**, retained same-grid history and exact owned cleanup. See [the bounded two-host follow-up](#inactive-global-card-owner-and-bounded-parkadopt-2026-10-06).
The earlier negative/unclassified controls remain historical. Phone release/backend checks still
need their own acceptance; wider parking, Server/cross-window, outage/platform and GPU coverage
remain separate.
Unsupported private shapes preserve input with a warning but may duplicate replies. Android
wire/file/iOS adoption is unchanged. The original Pixel 10 Pro ledger stays paused at
**10 Pass / 22 Partial / 32 Pending**.

**Fresh-phone checkpoint (2026-10-05, A124).** A separate Pixel 7a has a fresh,
hash-verified, non-debuggable beta 16/code 17 installation (Android 16 / API 36,
Vanadium WebView `145.0.7632.120.0`). Manual explicit-profile, high-port SSH and the existing
terminal's input/cwd/Unicode history and bounded held-drag/coast/new-touch-stop checks pass.
The original **New session → Start** attempt kept default Claude selected and failed shared
shell validation on host `15dd1341`. A124 (`651f46da`) fixes absolute executable resolution.
**The repaired single managed-shell case passes physically on Desktop `40731381`:** actual shell
radio selection, canvas registration, input exactly once, viewer reopen and saved SSH reconnect
after an Android process restart all preserve the same pane and the other original terminal.
Offscreen retained-history Find, selected-line clipboard paste and Copy-sheet URL clipboard
roundtrip also pass. Both disposable QA host profiles were removed through the app; beta 16 and
the phone identity remain. The repaired host stopped cleanly with generated authentication removed
and listeners closed. The original Pixel 10 Pro beta-10 checklist stays paused at
**10 Pass / 22 Partial / 32 Pending**. Fresh-install/single-case results do not verify its update,
live agents, managed End, power loss, QR/relay/cellular routes or the full device matrix.
Dated receipts below remain historical.

At checkpoint `40731381`, offline protocol tests pass **949 methods / 98 suites**, with zero
failures, errors or skips; **38 affected Vitest tests** pass with five platform skips, full
TypeScript passes, and all three isolated guard mutants fail their expected assertions.
The frozen full Desktop build passes in **29.3 seconds**. The first push has all five Android jobs
green in [run `37375870878`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37375870878),
verified against exact head `40731381c646ccd3425af597b116b5371daf0a63`. Later pushes need their own gates and CI.

**Native custom-wheel checkpoint (2026-10-06, A86).** A real SSH/tmux regression now verifies
custom copy-mode bindings in both emacs and vi modes, distance across 20-notch chunks and
FIFO-sensitive reversals. All eight settled native positions pass; three deliberately broken
transport variants fail the expected distance assertion. The later Pixel 7a follow-up adds bounded
custom-binding and lifecycle cases; wider gesture/reversal, lifecycle and FPS coverage remains
open. See [the native checks](#native-custom-wheel-checks-2026-10-06) and the physical receipt above.

**Current source checkpoint (2026-10-05, A100–A124).** The branch adds retained terminal history search,
trusted project env/shell and per-agent launch policy, offscreen Sleeping wake, remembered hook
rules and complete held Claude questions. Direct SSH supports Source Control, selected-profile
Board writes and Desktop wake/refresh/rename. New session can now ask a current Desktop/Server
with an enabled Linux/macOS tmux backend to create and register a managed shell or agent in an
open local folder project (A111); the host resolves its command, account, environment and hooks.
Older hosts retain the relay New flow. The actual producer fixture also exposed and fixed Android CI/local incremental coverage for `src/session-host/**` (A112). Current source also adds truthful legacy revoke outcomes (A113), a dictation language picker (A114), exact connection/record retirement (A115) and a saved LAN/VPN adapter choice (A116). This prepares the upstream Android contribution; no PR
has been opened. Beta 16/code 17 was prepared from `2723845e`, passed the local release checks and is now installed on the separate Pixel 7a. It includes A118's eligible legacy relay identity proof, an explicit SSH profile folder (A119) and one-time password enrollment with fingerprint confirmation and retained-key verification (A120). Current host source also fixes direct-SSH coattachment (A13) and protects relative private HostKey Include reads (A117).
A120 also passes controlled native OpenSSH enrollment, cancellation/deadline and synthetic installed-Fedora-PAM checks; see the later verification receipts.
Current Desktop source also fixes focused-terminal native Quit interception (A122, `9613cec5`); all four Linux native focused-terminal cases pass.
Later checks verify eight shipped-tmux and eight actual SSH-project cases. Separate GPU recovery
pilots exposed and verified A123 restored-context cleanup (`db83fb7d`). A later genuine Server
pilot verifies the same retirement path at `fa259f6e`; separate derived Desktop cell comparisons
use the existing `db83fb7d` captures. A single Desktop Canvas SSH reconnect pilot also passes
at `fa259f6e`; see the final follow-up for their limits.
The original Pixel 10 Pro remains paused on beta 10/code 11 with
**10 Pass / 22 Partial / 32 Pending**. Fresh Pixel 7a results and the A124 failure are recorded
separately above; the repaired single managed-shell case passes, while live-provider and broader lifecycle/outage checks remain unverified. Immediate FCM
and fresh-different-desktop relay recovery (A25/A93) still need the maintainers' hosted backend
source; the user has no backend checkout. Existing missing canvas sessions remain attach-only
over SSH. See the audit and Known gaps for unsupported backends and remaining verification.

**Post-beta-10 additions (2026-10-04).** Sessions search filters displayed names, agent labels,
project names/folders and phone-terminal folders while keeping the existing project/status groups.
The saved query returns after opening a terminal. All computers now watches each paired host while
visible, with automatic approval holds intact and serialized refreshes. The beta-11 Find action opened the captured
output Copy sheet: literal case-insensitive matches, UTF-16 highlighting and wrapping Previous/Next
navigation preserve the original rows and copy selection. It searches the captured output, not the
remote tmux history. SSH anchor discovery follows bounded recursive configuration Includes, including
quoted paths, multiple patterns and relative paths rooted under `/etc/ssh`; relative HostKey paths
remain unsupported. These are included in prepared private beta 11; the installed beta 10
and its 10 Pass / 22 Partial / 32 Pending device ledger are unchanged while phone checks are paused.
Additional physical checks belong beside items 10/11/50/56/60; they do not inherit earlier Pass results.

**Historical prepared private beta 11 (2026-10-04).** `0.1.0-beta.11` / code `12`, clean built source
`314105a435d18e719f53d49bb292d0f3e965ad4a`, includes all four additions (`A96`–`A99`) and the
A95 desktop Board fix. Full offline protocol checks pass **730 tests / 70 suites**, with zero
failures, errors or skips; the offline app compile, **297 affected Vitest tests / 17 files** and
full TypeScript checking pass. The four feature regressions catch **81 isolated mutants**.
The actual offline minified release build passes in **51.78 seconds**, retains the private signer,
and passes the R8/runtime keep and packaging checks. Independent SDK 36/37 signature,
nondebuggable-manifest, payload/provenance and 16-KB ZIP/native checks also pass. The existing
New-session-note layout check passes its control/restored run and catches four additional mutants. APK SHA-256:
`ae052a8a02567c42576012309c5de059827d8b9ff28a9972673af0440d977341`. Artifact:
`.nodeterm/android-beta-11/nodeterm-android-0.1.0-beta.11.apk`; build/regression proof:
`.nodeterm/android-beta-build-11/`. **Prepared, not installed:** beta 10/code 11 remains the last
confirmed phone installation. Phone checks and final fixture/rotation cleanup stay paused;
10 Pass / 22 Partial / 32 Pending remains the device ledger. These source/build checks do not
verify the new touch/keyboard, multi-host freshness or included-key pairing flows on the Pixel.

## The two transports

A phone reaches a paired computer one of two ways, and the app tries them in the iOS order:

1. **Direct SSH** (the LAN leg). Pairing installs the phone's Ed25519 public key in the computer's
   `~/.ssh/authorized_keys` (`src/main/pairing-service.ts`). Everything after that is POSIX `sh` +
   tmux on the computer (`protocol/.../ssh/SshScripts.kt`): the `-L node-terminal` socket of a
   nodeterm running on the computer, and the `-L nodeterm-rmt` socket of a desktop that drives the
   computer over SSH (audit `A27`, below), each session reached on the socket it was listed on;
   `attach-session` **without `-d`** (the desktop's own client must stay attached), never
   `new-session` for an existing canvas or agent node (`A08`). PATH is *appended* with the Homebrew
   dirs, exactly like `remoteTmuxPathPrologue`, and the macOS app's bundled `Contents/Resources/bin/tmux` is the last
   resort, as it is for the desktop's `findTmux`. Not available on Windows hosts (the QR says
   `"ssh":false`). A computer with no pairing code can be added by its SSH address instead, and is
   then reached this way only (audit `A27`, below).
2. **The relay** (from anywhere). E2EE through `wss://relay.nodeterm.dev`, to the standing phone
   host (`src/main/remote/standing-host.ts`). The phone trades its device token for a single-use
   relay token (`POST /v1/relay/join`), runs the handshake, and — the first time only — waits while
   the desktop shows the SAS approval dialog (pin-once).

**Explicit plain SSH terminals (`A90`).** The user needs a new shell on their manual
SSH/WireGuard host, which another desktop drives and which has no local nodeterm workspace. The
new flow creates a phone-owned plain shell on a separate `nodeterm-phone` socket in a chosen
discovered host folder or Home. Session metadata lists it under **Phone terminals**; it survives
disconnect and can be reopened or ended by its exact owned session. It does not write
`project.json`, register a desktop canvas node or borrow a managed agent identity. Desktop and
Server Edition behavior is unchanged; their socket scans/reapers remain limited to their own
`node-terminal` / `nodeterm-rmt` sessions. This explicit creation path keeps the `A08` refusal to
create a missing canvas/agent session and the relay New-session flow. Implementation and host
regressions are verified; private beta 10 / code 11 is now installed on the intended Pixel. Earlier
beta-6/code-7 device evidence remains historical, and beta 7 / code 8 was prepared but unused.
The existing SSH host reconnects and lists its driven projects; New terminal is visible and
enabled. Focused Home/project/custom creation/history/reconnect/exact End now pass on the
Pixel; item 32 is Partial: beta 10 relay plain-shell creation/input/End also pass, while managed and cellular creation remain pending; A91 empty-host variant passes. No current
RPC/blob/pairing/mirror/SSH-visible file contract changes;
@eneskirca can adopt the isolated socket and its creation marker/session metadata for iOS.

On a Linux SSH host, use **Sessions → New terminal**, choose **Home folder**, a discovered project
folder or a custom absolute folder, then **Create**. The shell appears under **Phone terminals**.
Close the viewer or app to leave it running; reopen its row to return. Use that row's
**End session…** to stop only its owned session. These shells are independent of the desktop
canvas and managed agents.

`Auto` tries SSH with a 4 s budget and falls back to the relay. Per-computer overrides live in
Settings ("How to reach each computer").

**SSH host key.** Anchored in the pairing (audit `A49-anchor`): the desktop's sealed `/pair` answer
names its SSH host keys (`sshHostKeyFingerprints`, the `SHA256:…` of every
`/etc/ssh/ssh_host_*_key.pub` and of the keys `sshd_config` and every file in `sshd_config.d/`
name, read by `src/main/ssh-host-keys.ts`; macOS 10.10 and older kept them in `/etc`). The phone stores them on
the paired computer (`PairedHost.sshHostKeyAnchors`), and its first SSH connect must present one of
them: a server whose key is none of them is refused during the key exchange, before the phone's key
is offered, and nothing is pinned (`HostKeyNotPairedException`). The keys ride only the SEALED
answer, which is bound to the host key the QR on the computer's screen carries; a plaintext answer
could be rewritten on the LAN, so the desktop leaves them out of it and the phone ignores them
there, and the QR does not carry them. A desktop that predates the field, a Windows desktop (no SSH
leg) and one that could not read its keys send none, and the first connect is then trust on first
use as before. Either way the pin is saved only once the server has accepted the phone's key (audit
`A49`): a machine that merely answers at the paired address and refuses us never becomes the pin. A
server that presents a host certificate (sshd's `HostCertificate`, which sshj negotiates whenever it is
offered) is matched and pinned by the key the certificate certifies (`hostKeyFingerprint`), which is how
OpenSSH fingerprints a certificate and what the desktop reports, so a certificate reissued for the same
key is not a changed key; a pin an older build took from the certificate itself still matches it and
is rewritten as the key at the next connect (review of `A74-refresh`). A key that differs from the
pin (or, before the first pin, from every key the pairing named) is never used over SSH. In `Auto`
the connect then goes on to the relay (`SshFallback`, audit `A74`), which authenticates the computer
on its own (the relay host key from pairing, then the SAS approval), and the host screen keeps a
warning up while connected that way; the relay dial still goes through
`RelayApprovalGate`, so a background check never makes a first relay handshake because of it. "Only
on my network" stops with the warning. The usual cause is benign: the LAN leg dials the DHCP address
the computer last reported (at pairing, or since through the relay, below), and another SSH-running
machine now has it (or the phone is on another network using the same range). The message points at "Only through the relay". A reinstalled
computer's new key is trusted again by the refresh below, or by pairing again (for a computer added
by its SSH address, by forgetting it and adding it again). A key the computer never reported
(`HostKeyNotPairedException`) takes the same route but not that promise
(`SshFallback.NOT_REPORTED_NOTE`): pairing again and the refresh both re-read the computer's keys the
same way, so they help only when those keys changed, and an SSH server using a key the reader cannot
see stays refused on the network (see Known gaps). The iOS app can adopt the same field: it
is additive in the sealed answer, and a phone that does not read it pairs exactly as before (a
follow-up for @eneskirca in nodeterm-ios).

**The LAN leg is refreshed over the relay** (audit `A74-refresh`). The address the LAN leg dials and
the keys it checks were both facts about the moment of pairing: the QR's `host` is a DHCP lease, and
a reinstall regenerates sshd's keys. So every relay `projects.list` answer carries, beside the blob,
what the computer says about its own SSH leg now: `{ output, lan: { host?, sshHostKeyFingerprints? } }`
(`src/main/remote/host-lan-report.ts`: the same `pickLanIPv4` the QR uses and the same host-key
reader as the sealed `/pair` answer; the keys are re-read at most once a minute, the address on every
answer; never on Windows, which has no SSH leg). The phone updates the paired computer from it
(`LanRefresh`, applied by `HostSession` after the primary relay connection's listings): a different
address replaces `PairedHost.host`, and the reported keys become the anchors. The pin gives way only to
a key the computer CONFIRMS (review of `A74-refresh`): when the SSH leg of the connect that opened this
relay connection was refused a host key (`HostKeyChangedException.actual`, which `SshFallback` hands on
as `TryRelay.refusedHostKey`) and that key is among the reported ones, the pin is dropped, so the next
SSH connect must present one of the computer's current keys and pins it once it has authenticated.
That covers a reinstall (new keys) and an sshd that stopped serving the pinned key while its `.pub`
stays on disk, so the computer still reports it. A pin is never dropped merely for being missing from
the report: the report is what nodeterm on the computer could read of its sshd's keys, not what sshd
serves, and a pin the phone has not seen fail is one that works. No reported keys (an older desktop,
keys it could not read) leave the pin and the anchors alone. The cost of asking for a refusal first: a
computer reinstalled while the phone was away is refused once more at its next connect on the network,
which goes on to the relay, and that relay connection confirms the key for the connect after it. This
is safe because the relay authenticates the computer on its own (end-to-end encrypted to the box key
pinned at pairing, served only once approved).
Nothing that came over SSH ever refreshes these facts (`LanRefresh.afterListing` refuses an SSH
listing, and an SSH listing never carries the field), and neither does the relay held next to a live
SSH connection (`viaRelay`), where the LAN leg as recorded has just authenticated. While the host
screen shows a changed-key warning, a refresh that moved the address or confirmed the refused key adds
a sentence saying so. The field sits beside the blob, not inside it, so the blob stays the shape a phone
on direct SSH reads off the host, and an iOS app that does not read `lan` sees the reply it always saw
(a follow-up for @eneskirca in nodeterm-ios).

**Relay approval.** The standing host raises its SAS dialog as soon as an unpinned phone completes
the handshake, so the phone decides *before dialing* (`RelayApprovalGate`): the background worker
dials only a computer that approves this phone without its dialog (a relay connect has succeeded, or
pairing answered `relayApproved`, below), and a refused or unanswered approval suspends automatic
dials until the user asks again. A current desktop pins the phone's relay key at pairing
(the phone sends `boxPublicKey` inside the sealed `/pair` body; the answer says `relayPinned`), so
most phones never see the dialog. A pairing with no relay leg (remote access off at the scan, or a
failed mint) records the key on the device entry in `agent.json` without pinning it, and the
standing host pins it on the phone's first relay handshake while that pairing is listed (audit
`A07-late`, `approvePairedRelayKey`): the phone that adopts the relay later over SSH (`relay.json`,
below) is not met by a dialog at a desk it has left. Either way the answer says `relayApproved`, which
is what the phone stores as approved, so its background check may use a relay it adopts later. Not
pinning at the scan keeps a LAN-only phone out of the pin store, which host-mode push reads as "a
relay phone is paired". The late pin's "still paired?" check runs inside the pin store's queue, so a
revoke racing a handshake cannot leave the key pinned. While the standing host decides on its own
(its pin store, then the late pin), `connectHostSession` holds the phone's requests instead of
answering "Awaiting host approval.", which a background check reads as an approval it needs: they are
answered once the host has approved the phone or raised its dialog (`PEER_DECISION_HOLD_MS`, 5 s at
most). No new file is involved: the key is the one
the scan already authorized, and someone who could edit `agent.json` has a shell as the user, which
could edit the pin store just as well. A confirmed revoke of a recorded last key drops its pin and closes the phone's relay sessions. A113 reports missing association/revoker as unconfirmed and a key authorized by another pairing as retained; removing a local entry alone proves neither cut. The phone then redials (about 1.5 s after a drop while its screen
is open), and for the rest of that desktop run such a handshake raises no SAS dialog: the standing
host leaves it unapproved, so the phone hears "Awaiting host approval.", and closes it a few seconds
later (`REVOKED_PHONE_DENY_MS`), which the phone reads as a refusal and stops dialing on its own, as
after Deny. Pairing the phone again lets it back in (the pin or the recorded key is checked first);
after a desktop restart a dial from it shows the dialog again, as for any unpinned phone. If the
desktop cannot write the unpin, the device stays listed and Settings → Phone says to try again,
because the surviving pin would let the phone back in without a dialog.

**What opening an existing node over direct SSH will not do.** It never creates a missing canvas
or agent tmux session (the desktop injects the hook environment at creation, which the phone
cannot reproduce) and never touches nodes of the desktop's
SSH projects (they live on another host). Both surface as `NeedsRelayException`, and the app opens
the session through a relay connection held next to the SSH one (`HostSession.viaRelay`).

**The relay leg next to SSH (audit `A26`).** `Auto` keeps SSH as the primary connection when it
works. Direct Git runs on admitted folders without a relay (`A107`). A current selected-profile
SSH service handles Board writes (`projects.ensureBoard|setCardColumn|editCardLabels`) on Desktop
and Server, and delivery-only node nudges (`node.wake|refresh|rename`) on Desktop (`A108`).
A canvas-registered new session (`projects.registerNode`, and the attach that creates it) still
needs the relay. For a capability the primary connection does not serve,
`HostSession.connectionFor` opens an allowed relay leg on that tap and keeps it until the
connection is dropped. Which leg answers is ONE pure decision,
`LegRouting.route` (`android/protocol`, `LegRoutingTest`): the primary connection when its
capabilities include the verb, else the relay leg when the phone holds one (a relay block and a
stored device token — often minted while on SSH by late adoption — and a route other than "Only on
my network"), else unavailable with a reason. Holding a token is not enough on its own: it outlives
the desktop's remote-access toggle, so every listing over SSH also reads whether the computer
advertises its relay right now (`relay=1|0` in the browse script's meta block: is
`~/.nodeterm/relay.json` there, which the desktop writes while its phone host is registered at the
relay and removes when it stops). A token with no advertisement is "remote access is off on the
computer" (`RelayLeg.REMOTE_ACCESS_OFF`), not a tap that waits out the relay's 20 s handshake; an
advertisement with no token yet is picked up by late adoption on the user's refresh, or by the
8 s refresh as soon as it appears (`LegRouting.adoptAfterListing`), and says so meanwhile instead
of "turn on remote access". The token is asked by presence (`SecureStore.hasRelayToken`, no Keystore
decrypt), because the screens ask the routing while composing (`A47`). The screens ask the same
function, so an unavailable control is shown **disabled with that reason** (canvas New session, whose
reason is the Sessions list's first row; the board's card actions; the session menu's
wake/refresh/rename), never hidden; the Source control screen (`A29`) says it in place of the
repository. The relay dial still goes through `RelayApprovalGate` with the caller's trigger: these
are taps (`Trigger.USER`), so the first one on a desktop that has not pinned the phone shows the
approval code on the screen that asked (the host screen, or Source control), and a background path
never makes a first handshake that would raise the dialog (its only first handshakes are with a
computer whose pairing answered `relayApproved`, above). Answering approvals, read-acks, typing keys and ending a session stay
on SSH.

**A computer a desktop drives over SSH, and the Server Edition (audit `A27`, part a).** The SSH
browse reads more than the paired desktop's own files. It finds the data dir of a nodeterm running
on the computer in this order: the desktop app's (`~/Library/Application Support/node-terminal`,
`$XDG_CONFIG_HOME/node-terminal`, then the legacy `nodeterm` spelling), then the Server Edition's
(`$NODETERM_DATA_DIR` when the SSH session carries it, then `~/.nodeterm-server`, the default in
`src/server/config.ts`; a fresh install that has written only `install-meta.json` counts). A server
started with `--data-dir` elsewhere can be selected with **Profile folder** in Add SSH server or
**SSH profile folder** under Settings → How to reach each computer (A119). The saved absolute path
overrides discovery; a missing explicit folder reports an error without falling back. Leave the
field blank to restore discovery. A computer with nothing found reads as "not
found, here is where the phone looked", never as an empty computer; it ends by offering the relay
only when the phone has a relay leg for the computer (`NothingFoundException.said`), and for a
computer added by its SSH address it suggests checking the user instead. "Nothing found" is judged
on what the listing can use: the desktop never deletes a status slice, so on a computer a desktop
drove once the old ones stay, and a slice that is no data (stale, unreadable, misnamed) counts as
nothing.
It also lists the `nt-*` sessions on `nodeterm-rmt`, where a desktop ELSEWHERE runs the sessions of
its SSH projects, and reads what that desktop leaves on this computer, since there is no
`workspace.json` for those projects here:

- each project's canvas, `<remoteCwd>/.nodeterm/project.json`, found by walking up from each
  `nodeterm-rmt` session's start directory (`#{session_path}`, the node's cwd the desktop gave
  `new-session -c`); the SSH mirror writes it with the desktop's project id as `id`;
- each status slice, `~/.nodeterm/agent-status-<projectId>.json`
  (`src/main/remote-ssh/remote-status-push.ts`). The desktop re-flushes it at least every
  `STATUS_HEARTBEAT_MS` (60 s) while connected, so a slice whose `updatedAt` is more than twice that
  old is **no data**: its states and Inbox cards are dropped, not shown as current. The comparison
  uses the phone's clock against the desktop's;
- the sessions themselves. One that no project names is still listed, under "Other sessions on this
  computer".

These become projects marked `drivenRemotely` (`HostBrowse`, `android/protocol`), after the host's
own. The host's own index wins: a project id or node it already lists is never listed twice.
Terminal access to the paired desktop's OWN SSH projects stays relay-routed (`A09`), even when
that desktop drives this very computer. What the machine does works on a driven project's sessions over SSH, on
their own socket: attach (attach-only: a session the driving desktop creates there gets its remote
tmux.conf and hook env, which the phone cannot give it), keys, the wake line, held approvals (a file
on this computer, where that desktop's SSH answer path looks), read-acks (written where that
desktop's ack sweep looks; on a computer that also runs its own nodeterm, see Known gaps), and ending
the tmux session. Direct Git also works in a listed driven project's folder on this computer
(`A107`). Its canvas registration, Board and node actions belong to the driving desktop, which
neither leg of this computer reaches; `LegRouting.forProject` makes those unavailable with that
reason. The selected-profile SSH service does not adopt another desktop's driven projects.
A driven session that is not running says it starts from that desktop instead of offering this
computer's relay. The relay is
offered for a session that is not running only when it is a node of the computer's OWN index: the
relay's `pty.attach` creates what it does not find, so for any other node (a driven one, or one no
listing names, such as a driven project no longer listed or a deleted node) it would make a bare
`nt-<id>` of no project on `node-terminal`, which later attaches would then find first. Which nodes
are whose comes from a listing, so the first node-scoped call on a connection that has not listed
yet (a redial, or a terminal restored after the process died) lists first. The status block
merges the host's own mirror with the fresh slices (the host's entries, settings, usage and `server`
block win). The Server Edition's `server` block (version, commit, install date) is shown on the
host screen, above its tabs. A computer that has no pairing code to scan reaches this browse
through "Add SSH server", next.

**A computer added by its SSH address (audit `A27`, part b).** A headless Server Edition has no
pairing service anywhere in `src/server`, and a dev host the phone reaches only over SSH has no
nodeterm of its own to show a code, so neither can be paired. "Add SSH server" (from the computers
list, its empty state and the Pair screen) adds one by host, port (22) and user; the rules are
`ManualHost` (`android/protocol`, `ManualHostTest`) and the screen only lays them out:

- **The key.** Set up manually using the public key below, or choose **Set up with a password**
  (A120). Password setup first inspects the SSH host fingerprint without authenticating. Compare it
  on the computer, confirm the match, then enter the SSH user's password. The app installs only its
  retained public key and proves a fresh key-only login against that fingerprint before saving.
  Passwords stay in memory for this attempt and are cleared from the screen on leaving/backgrounding;
  they are never saved or used for normal connections. The manual path shows the phone's Ed25519 public key line
  (`ssh-ed25519 … nodeterm-android`, the same key every pairing installs; copy or share it) to add
  to `~/.ssh/authorized_keys` of that user, and a one-line command that does it: `sh -c '…'`, so a
  bash, zsh or fish prompt hands it to `sh` as is (only `/bin/sh` itself is tested), which adds the
  line only when it is missing, after a newline when the file's last line has none (appending onto
  it would break both keys), and sets the modes sshd's `StrictModes` wants (`700` / `600`). `ManualHostTest` runs that command under `/bin/sh` and
  then logs in against an SSH server that reads the very file it wrote.
- **The host key.** Nothing like the QR carries anything to check it against, so it is trust on
  first use by A49's rule: Connect pins the key of the first server that **accepts** the phone's
  key (a server that refuses it pins nothing), and the computer is added only then, already pinned,
  so nothing ever dials it in the background before an authenticated connect. The screen shows the
  pinned `SHA256:` fingerprint with the command that prints the computer's own
  (`ssh-keygen -lf` over `/etc/ssh/ssh_host_*_key.pub`) to compare. A refused key says to add the
  line. A login that could not finish (it timed out, or the connection dropped during it) says to
  check the address and the network instead: sshj wraps both in the same `UserAuthException` as a
  refusal, and only one with nothing behind it is the server saying no
  (`SshHostConnection.isAuthRefusal`). An address already in the list (paired or added, same host
  in any case, port and user) is refused with the name it has.
- **SSH only.** The record is the paired one's with `"manual": true` (`PairedHost.manual`): no relay
  block, no host box key, `sshAvailable` true, and a `fromJson` that drops a relay a record might
  carry. Its route is fixed to SSH (`HostStore.route`), Settings shows no choice for it, the late
  relay adoption never runs for it. Direct Git works on admitted folders; a live selected-profile
  Desktop/Server service can handle owned Board writes, and Desktop can deliver node nudges.
  `LegRouting.RelayLeg.ADDED_OVER_SSH` makes a capability that still needs the relay unavailable
  with "remote access isn't set up for this computer: it was added by its SSH address". This
  includes canvas-registered New and Board/node actions without a supporting service. A missing
  canvas session, or terminal access to a third-machine SSH project, is refused without the relay
  offer. The separate phone-owned plain-terminal creation path remains available. Which refusal
  is said follows the relay leg the phone has for the computer (`NeedsRelayException.refusal`):
  "remote access isn't set up" for one
  added by address and for one the phone never got a relay leg for (paired with remote access off),
  and otherwise what is actually in the way, the way `LegRouting`'s reasons name it: remote access
  turned off since, a relay not picked up yet, or the route "Only on my network (SSH)". A changed
  host key stops with "forget it and add it again". Forget works as for a paired computer, and its
  dialog says the phone's access is revoked by removing the line ending in `nodeterm-android` from
  that `authorized_keys`.
- **Older builds.** A build that predates the flag ignores the `manual` key and reads a computer with
  SSH, no relay and the same pin. The add also stores the route `SSH_ONLY` for it, which such a build
  reads, so it does not dial a relay for it either (its late relay adoption could still read a
  `relay.json` on that computer; this build never does). Such a build also DROPS the key: it rewrites
  the whole list on its next save (pairing or forgetting any computer, a late relay adoption) without
  it. So the flag is also read from the id, the one thing that survives that round trip: an added
  computer's id starts with `ssh-` (`PairedHost.MANUAL_ID_PREFIX`), and a paired one's is the
  desktop's `randomUUID()`, which never does. Back on this build it is an added computer again, and a
  relay block or box key that build adopted for it meanwhile is dropped on read.

## Protocol mapping

The standing phone host still speaks the **legacy relay dialect** (`host-service.ts`
`createHostHandlers` + `framing.ts` opcodes), not the rpc.ts tunnel `docs/ios-protocol-migration.md`
describes as the future. The Android client implements what the host actually serves:

| Phone action | Relay (host-service.ts) | Direct SSH |
|---|---|---|
| Repair eligible legacy pairing identity (`A118`) | After approved listing: `pairing.relayKeyChallengeV1 {pairingId}` → `{status, challenge?}`, then one `pairing.relayKeyProofV1 {challengeId, signatureB64}` → `{status}`; `challenge`, `associated`, `unprovable`, `gone`, `conflict`, `expired`; sign with retained SSH identity only | No proof verb; the retained SSH seed stays on the phone. No first-approval bypass or new identity |
| List projects/sessions/status | `projects.list` → the `--NT-PROJECTS-SPLIT--` blob, and beside it **`lan`** (new, `A74-refresh`): the computer's current LAN address and SSH host keys, which refresh the paired record | same blob (and never a `lan`), from `workspace.json` + `tmux ls` + `agent-status.json` in the desktop's userData or the Server Edition's data dir; the v3 index is resolved like `WorkspaceStore` (folder refs → `.nodeterm/project.json`, SSH refs → `cache`, data refs → `inline-projects/<id>.json`). Then what a desktop that drives the computer over SSH left there (`A27`): `nodeterm-rmt` sessions, the `.nodeterm/project.json` above each, and the `~/.nodeterm/agent-status-<projectId>.json` slices (stale after 120 s) |
| Open an existing terminal | `pty.attach` → `{streamId, fresh, scrollV1?}` (a session the phone starts adds `projectId`/`accountId`/`agentId`; the desktop resolves them itself — the project folder, the account, the agent's hook env and the pane's owning project — and applies them only when this attach creates the session), Snapshot frames, Output frames; a node of an SSH project is attached over that project's ControlMaster (`requireRemote`) or refused | which socket has the session (`node-terminal` first, then `nodeterm-rmt`; a reserved phone UUID uses only validated `nodeterm-phone`), then a pty exec of `tmux attach-session` on it — never `new-session`: a session of the computer's own index that is not running, or a node of an SSH project, is refused with `NeedsRelayException` and the app offers the relay (a driven project's session that is not running says it starts from its own desktop, and one no listing names is refused without the relay) |
| Type / resize | `OP.Input` / `OP.Resize` frames | channel stdin / window-change |
| Input-bar Send (`A128`) | additive **`pty.submitComposed {streamId, input:{kind:"paste"\|"control", text, enter}}`** → `{status:"delivered"\|"refused"\|"uncertain", message?}`; current local-tmux, direct native Windows PTY and negotiated session-host backends bind Send to the attached stream and captured generation; older/unverifiable hosts and SSH-project relay routes explicitly refuse | explicit actor submission to the captured Unix SSH viewer/pane; cancel host copy mode, paste with tmux-owned bracketed framing, then wait 150 ms before a separately guarded Enter; a control action is one raw byte with `enter:false` |
| Scroll (`A129`, published source; acceptance pending) | advertised `scrollV1:true` → `pty.scrollV1 {streamId, dir:"up"\|"down", lines:1..20, viewId?}` → bounded `history` page, `input`, `refused` or `uncertain`; native mouse-off reads retained rows without PTY writes; a valid view remains inert until closed. Legacy `pty.scroll` retains the positively known tmux route and safely refuses native mouse-off history | the phone writes the existing SGR wheel events to its captured attached tmux client; direct-SSH gesture/momentum provenance is unchanged |
| Detach / end | `pty.kill` / `pty.destroy` | close channel / `kill-session` |
| Wake on open (`A103`, `A104`) | existing remote-viewer nudge wakes a mounted node or resolves one saved offscreen/closed-project node without switching views; exact owner/generation and Pause guards, no fresh shell or uncertain input replay | explicit Sleeping wake offer uses the agent's measured approval policy and host capabilities; the existing shell/WakeContext checks and user tap remain |
| Wake, refresh, rename | `node.wake\|refresh\|rename` | current Desktop's selected-profile SSH service (`A108`); older hosts need an allowed relay; Server has no node nudges |
| Board | `projects.ensureBoard\|setCardColumn\|editCardLabels` | current Desktop/Server selected-profile service (`A108`), using the real save queue; older hosts need an allowed relay |
| New session on the canvas | SSH `sessions.createManagedV1` → host receipt → guarded attach; legacy relay `pty.attach` + `projects.registerNode` | A current enabled POSIX tmux host creates/registers/launches in an open local folder project. Older hosts retain the relay leg (`A26`). Durable uncertain requests never replay or switch transport. Physical managed/cellular cases remain pending. |
| Explicit plain terminal on the SSH host (`A90`) | separate from canvas registration | Sessions → New terminal → Home/project/custom absolute folder → Create; phone-owned `nodeterm-phone` session, rediscovered under Phone terminals; focused Pixel creation/history/restart/update/reconnect/exact End pass, beta 10/code 11 installed. Item 32 Partial; relay plain-shell creation/input/End pass, managed/cellular pending; A91 empty-host variant passes |
| Source control (`A107`) | unchanged `git.status\|diff\|stage\|unstage\|commit\|push\|pull\|history {cwd,…}` and typed result models; host project-root jail | the same eight verbs over typed POSIX Git argv, physically jailed to listed local/driven folders and repository root; excludes third-machine projects; bounded output, confirmed writes and exact missing-upstream-only push fallback |
| Answer a held approval (`A105`) | `approvals.answer {nodeId, pendingId, decision}` keeps allow/deny and adds allow-always plus original `suggestionIndex`; host-owned live-card/request validation; honest answered/reason outcome | legacy allow/deny file unchanged; remembered reply is marker + request-derived hook JSON, streamed through stdin with post-stream request guard and confirmed status |
| Read-ack | **`inbox.ack`** (new) | write `~/.nodeterm/acks/<nodeId>.seen` |
| Quick answer keys (question digits, legacy approve/deny) | **`node.sendKeys {nodeId, keys}`** (new) → `{sent}`; local tmux answers resolve the exact session to a pane ID, cancel copy mode and type there, also while mounted. Complete writes are ordered per node. SSH-project answers use the project's ControlMaster; unavailable sessions return `sent:false` (the phone opens the session). An older desktop gets attach → wait for paint → write → linger | resolve the exact session to a pane ID, cancel copy mode, then `tmux send-keys -l` there; missing exit status or any command failure opens the session without resending. SSH-project nodes go through the relay leg (`A09`) |
| Retained terminal history search (`A100`) | `pty.historySearch {streamId, query}` searches the attached generation/exact pane, returns bounded matching lines, searched-line count and truncation; older hosts refuse without replacement | resolve the selected session's exact pane and search all retained plain tmux history on the computer, with bounded private spool/result; no copy-mode/input changes |
| Cold relay attach (`A102`) | saved node/project/account/agent facts override create hints; prepare trust-aware project env/shell without spawning, recheck warm races, then respond/snapshot/attach synchronously; a warm join retains its launch facts | existing attach-only SSH behavior stays; cold agent creation is still refused rather than guessing its hook environment |
| Answer complete held questions (`A106`) | `questions.answer {nodeId, pendingId, selections:number[][]}`; original live request determines exact labels for every question and preserves tool input; old hosts open session | same full-schema builder over the selected node's original pending JSON and v2 answer file; gone/unsupported tickets never become numeric keys |
| SSH Board and node actions (`A108`) | existing `projects.ensureBoard/setCardColumn/editCardLabels` and `node.wake/refresh/rename` | same typed requests through `<selected userData>/ssh-actions`; fresh private advertisement, instance/nonce/host-time guards, actual WorkspaceStore save queue; Desktop nudges are delivery receipts; for these Board/node methods, Server advertises Board only; A111 separately adds conditional managed New |

`resizedFrames` is deliberately not sent on attach, matching iOS: the phone is a size *ceiling* on
the shared pty. An `OP.Resized` still shows a "sized to another screen · fit this screen" hint.

**Composed Send adoption (`A128`).** The additive method returns submission to the attested
pane/PTY, not command execution. Refused, uncertain and stale completions retain the draft;
uncertain input never replays or falls back to raw frames or `node.sendKeys`. Raw keystrokes,
emulator replies and wheels retain their existing semantics. The Android client and actual
`android/protocol/src/test/interop/host-fixture.ts` change together in `7e7d2c04`.
iOS **@eneskirca** needs the same explicit awaited action, exact viewer/pane receipt, paste/Enter
separation and draft-retention rules; it must treat an older or unsupported host as a refusal.

### Why typed host verbs

The original approval/read-ack actions already existed for a phone on SSH as owned files. A relay-only phone (every
Windows host, and any phone off the LAN) had neither: `fs.*` is jailed to project roots, correctly.
Typing `1` into the pane is **not** a substitute for answering a held hook-reply approval: while the
hook holds the request the prompt is not on screen, so the keystroke lands in the agent's composer.
`approvals.answer` routes to the same `answerPermission` the canvas Approve/Deny button uses, and
`inbox.ack` runs the same `ackDone` + unread-clear the ack-file sweep runs
(`src/main/remote/host-inbox-verbs.test.ts`). An older desktop answers "not served", which the
phone treats as "open the session" — never a guessed keystroke. The iOS app can adopt both verbs
unchanged.

**Host-owned managed SSH New (`A111`).** A current selected-profile service advertises
`sessions.createManagedV1` only when Linux/macOS tmux is actually enabled and available. The
request carries a creation UUID, project, kind, agent/account, optional title and initial dimensions;
it carries no executable, cwd, env or hook identity. The actual WorkspaceStore/planner and PTY
manager resolve launch facts, exclusively create one `node-terminal` session, attest its kernel
process birth, publish the node, then submit the host command once. Shared project files carry
portable cwd; shell stays in machine-local execution metadata. A private 0700 directory/0600 phase
journal is synced before terminal side effects. Its actual command stays private; uncertain shared
nodes contain an inert manual recovery notice. Duplicate/restarted requests never relaunch.

The Android host-scoped checkpoint commits before dispatch and retains the returned public receipt
until the first SSH viewer is confirmed. Adoption pins selected profile, service instance, session
creation, exact pane/PID/birth and marker, then confirms the newly allocated SSH tty attached to
that generation. It never creates an absent session or falls back after uncertainty. Explicit
"I checked the computer" permits discarding stale proof, followed by a separate list/open action.
The account picker freezes its choice; System does not silently take a later project default.
Managed canvas End still needs the relay so the node is removed from the canvas; direct SSH
Close leaves it running. Phone-owned plain terminal End keeps its separate exact-owned behavior.
Actual isolated native-PTY/tmux tests use a fixture CLI and do not claim real Claude startup.
iOS @eneskirca needs the additive action, durable request and attach-only receipt in the same update.

## What is verified, and how

### Upstream PR conflict integration (2026-10-08)

The contribution merges upstream `main` at `adde5e85` with the existing Android history.
Integration regressions cover an expired structured-answer hold, the separate v2 question wait,
role-scoped phone revocation, and remote attach input arriving before asynchronous attachment
completes. The Android producer fixtures continue bundling the real desktop/Server sources;
upstream's optional SSH native dependency is external to those bundles, like node-pty.
Required offline protocol/app and affected desktop checks verify this merged source before push.
The merged hook revision and its structured-ticket floor distinguish older revision-5 scripts.
These are source checks; the merged desktop and Android app have not been exercised together
on a phone. Prepared beta23 and installed beta22 retain their earlier source bindings.

### Pending Send outcome after remount (2026-10-08, A137)

**Source fixed and published; beta23 prepared.** Before this change, at observed checkout `bb519eac`, installed
beta22/code23 and the archived Desktop build both used source `2ba0b142`. `TerminalDrafts.State` retains the
editor/revision/Ctrl, while `TerminalController` owns only local `submitting` and `notice`. A normal
PairHost cover disposes that controller. `TerminalActions` resolves queued input as REFUSED or
already-dispatched input as UNCERTAIN, but the old controller's current-view fence suppresses its
notice. Back creates a controller with no pending/outcome state. Once attached, it can offer Send
for the retained draft without the earlier guidance. This is a source-demonstrated visibility gap;
no physical duplicate or automatic retry is established. A136's measured no-Send pass is separate.

The fix reserves one immutable attempt from the accepted editor/Ctrl revisions before JS
preparation through the shared button/IME path. Pending state belongs to the surviving entry and
blocks another admission. Only its exact attempt can settle; retired or different-owner handles
cannot adopt it. A stale positive becomes uncertainty. Original view/stream/actor and editor/Ctrl
revision fences still govern positive clearing, so a newer draft or rearmed Ctrl survives.
Uncertainty guidance survives edits, remount and later DELIVERED or REFUSED results until its exact
notice is dismissed; newer uncertainty gets a new notice identity. No command job, controller or
stream is restored, and nothing is persisted across process death or added to the host wire.

**Local validation passes:** twelve entry/actor behavior methods and three explicitly lexical
Android wiring methods, focused healthy/restored **66 methods / 9 suites**, full restored
**1069 methods / 116 suites**, and forced offline app compilation. All original 1054 method names
remain. The thirteen final variants catch their intended assertions: ten behavior and three wiring
mutants, with no errors or skips. Source/Android delegation review passes; this grants no physical
WebView/Handler/Compose timing credit. The whole suite includes the existing isolated SSH/tmux/desktop
interop; new A137 cases execute entry/actor policy and lexical Android checks.

**Publication and artifact review pass.** Signed source `b9e4cbc746e9a405844df9985f07cf47acef5607`
passes fresh forced **1069 methods / 116 suites**, zero failures/errors/skips, and offline app compilation.
[CI37740459063](https://github.com/CPlusPlus17/nodeterm/actions/runs/37740459063), attempt 1, passes all
five jobs and ten required steps at that exact source. Retained-signer `0.1.0-beta.23` / code `24`
uses the same artifact source, APK SHA-256
`a0c336b5fb2dee849f27bc4af1cbdccaf4460828110a87322e6323cfc2a9a3a2`.
All 46 available artifact checks pass, including actual SDK36 signature/alignment, R8 and public metadata;
actual SDK37 artifact verification remains unverified. Archived Desktop build/source `2ba0b142` is unchanged.

**Installation and physical comparison remain unverified.** A read-only pre-install snapshot refused
with no available Pixel transport; no update was dispatched. Beta22/code23/source `2ba0b142` is last
verified installed. A fresh controlled pending-Send cover/Back check still needs actual update and
fresh owned viewer/native admissions. Source tests and A136's no-Send pass grant no physical pending-Send
or duplicate-execution credit. The original 64-item ledger is unchanged.

Private publication records: `pending-send-publication-zl2sk4sl/gates.json`, SHA-256
`728e7658595a06cf55179112027ca75dd44164c812df42ae996d00a39679a9f0`, and independent
`a137-publication-saved-independent-ly_qo2dg/review.json`, SHA-256
`36513b83ccfe3a989a8ec1bc62da55a2e6ab14a806b171fb830d14ab53a08bbb`.
Artifact records: `beta23-send-recipes-q06owcwo/build/artifact-review.json`, SHA-256
`8e507c30335cd70f762c5dcdb5a9942a1815d1635490f82063a24a972cf39bf2`, and
`beta23-send-recipes-q06owcwo/artifacts/beta-metadata.json`, SHA-256
`efdc88f2f3897584038f97d62dedfdcd104e6febe2d11b77298289fe18fd92b4`.
Independent artifact review `beta23-artifact-saved-independent-n6mszggd/review.json`, SHA-256
`91ada275643e9f64c861335e80adc393b43ea73decf5c517e708945bb696a45a`, adds no install or phone credit.
The final mutation receipt is `pending-send-entry-candidate-6pciadbm/proof-final/mutation-receipt.json`,
SHA-256 `2b72eb43ef1b467d4367f8a7725fc22bc1efc062c0ae090c03fdfd93ea1944c3`.
iOS @eneskirca should compare local entry-owned attempt/guidance lifetimes and stale clearing.

Private source report: `pending-send-retained-entry-source-review-5gsfw1r5/REPORT.txt`, SHA-256
`639ac6c616077500c803dcf37fcd5d3eab9f6298aa34528f841034e5dd14c0c7`. The corrected candidate's
independent source review is `pending-send-entry-source-independent-c8sg0jmo/review.json`, SHA-256
`3f1916ade664815f47bd1cfe54d6c81bed3092f2fb2704a3e8c7d98f17c9b4cf`; it grants no test or phone credit.

### Retained terminal editor (2026-10-08, A136)

**Original-beta failure reproduced.** The Pixel 7a (serial `2C091JEHN03336`) runs beta21/code22,
APK `91638d05`, Android source `ef4caec2`; the disposable host uses immutable Desktop build
`0d8594a6` while the clean source checkpoint is `675dd519`. On the independently owned `95b2116a`
terminal, composer `qa_unsent_95b2116a_remount` and checked Ctrl become empty/unchecked after one
normal `nodeterm://pair?code=bnVsbA` Intent covers it with PairHost and one Back returns. The code
encodes JSON null and is rejected locally; no Scan/Connect or terminal Send runs. The entire original
native server/socket, both Bash pane owners and both full captures remain identical. Result
`b0437b63` and independent review `19cb9739` bind the saved XML and native records.

The first harness stopped before Intent because WebView exposes another editor. The corrected
check selects the composer outside WebView and the clickable checked Ctrl ancestor. A 15-second
display timeout stopped Back before dispatch; one ordinary wake and separately admitted Back
completed that same covered entry without repeating Intent. Same-entry continuity follows the
production push/pop code and unique title; its internal runtime key is not directly observed.
Own profile/public-key authorization/reverse are removed, the unchanged 15000-ms timeout and
install identity/full notification grant are read back, and the finite original fixture exits
successfully. Captured generations/listeners are absent and all 136 held outputs remain unchanged.
This is deliberate disposable-fixture retirement, not an ordinary app-Quit measurement.

`TerminalDrafts<TextFieldValue>` now retains the full text, selection/composition, edit revision
and Ctrl in AppGraph process memory for each real navigation entry. The complete live stack retains
covered entries. Pop/replacement and host retirement clear values and seal stale handles. Send and
mic starts read the latest accepted entry, and delivered clearing requires its exact sent revision;
newer edits, including an edit away and back, survive. Controller pending work and speech sessions
are not restored. Command text is not serialized into a Bundle or file; process-death draft recovery
remains unsupported.

Nine store behavior methods and three explicit app wiring methods pass with the updated existing
Dictation pins. Seven draft-policy mutants (revision, exact clear, retirement sealing/value release,
stack membership, owner retirement/replacement) and one whole-stack wiring mutant are caught.
Combined healthy/restored controls pass 48/seven, full candidate **1054/114** and offline app compile
pass, with all prior 1034/110 methods retained. Receipt `098162c5` and independent `fdf4cbcf` review
qualify policy execution versus lexical wiring. A135 supplies the preceding Ctrl API dependency.

Signed source `2ba0b142` passes fresh forced 1054/114 and offline app compilation; CI
`37732792493` passes all five jobs and ten required steps. Retained-signer beta22/code23 is installed
from that source, APK `fa894d4b`; `beta22-phone-update-bound-c2384dzh/receipts/update-result.json`
(SHA-256 `08d5b32b3bcfb245287c12fab00e2098582b971ea2591f68764b5916fac20992`) verifies unchanged first-install time,
full notification flags and all measured runtime-permission blocks. Saved artifact review is
`beta22-editor-compact-final-recipes-oov0gt3l/build/artifact-review.json`, SHA-256
`bfff9ea6eab59735bf41e856e9b94e59c81e95d0dc0fd3c7485f3ebb5f60cdf1`; actual SDK36 verification is
available, SDK37 verification is not claimed. The installed APK/source and immutable Desktop build
remain `2ba0b142` even if subsequent documentation HEAD changes.

**One fixed-phone comparison passes.** On the fresh `071940c8` direct-SSH terminal,
`qa_unsent_071940c8_remount` and the checked clickable Ctrl ancestor are identical in the
before/after XML through one normal `nodeterm://pair?code=bnVsbA` Intent, local PairHost rejection
and Back. No Scan/Connect, terminal Send or producer runs. The original native roles, both Bash
owners, server/socket and full captures are equal, as are both desktop client tuples. Phone tmux
client636 is replaced by834 under the same SSH parent560, target session, TTY and argv. This
reattachment is explicitly excluded from the unchanged-native-sections claim. Same retained entry
follows source push/pop and the unique title; its runtime key is not directly observed. Result
`nodeterm-new-phone-fixture-2idfmnhr/proof/root-draft-remount-fixed-result.json`, SHA-256
`fb2a5c38e07e6daf0d952d3742c5eccd24b5b04ee9e2e9b3364dd8b3a2aa3b56`, binds case
`71d7e2cd` and both native snapshots. A preliminary all-value equality assertion stopped before
writing a result; the qualified comparison does not replay the physical case.

The independent physical review is `beta22-remount-physical-independent-6rhn7izc/review.json`,
SHA-256 `320af8c12084905126320b042f784a5099f3eb83f745bc10684617f0850f729b`; it rehashes
86 records. Editor focus changes from true to false. This is accessibility-XML evidence, without
pixel/glyph, cursor/selection, IME, activity/process-death, pending-Send or raw Ctrl timing credit.
Existing profile/key/pin migration across the update is not established by this new-profile case.

**Owned closure is verified.** Normal own-profile Forget returns Welcome; exactly the added public
key and reverse29453 are removed and original public authorization bytes restored. Initial null-
nonce enrollment records and the reverse-add response refusal are preserved with qualified read-
only reconciliations; neither enrollment action is replayed. The sole 900000-to-15000 timeout restore
has an uncertain post-write result; separate read-only `55b3f2d6` confirms the original 15000 with
zero repeat setting writes. Installed APK/install identity and complete runtime-permission blocks
match update-after. The original finite host exits 0 through validated intentional SIGTERM; seven
unique original outer-host generations and both listeners are retired, private auth absent, and
2516 source inputs, 136 outputs and 22 runtime pins held. An eighth recorded PID/birth entry aliases
one outer generation; no global namespace scan or ordinary app-Quit acceptance is claimed.
Canonical closure is `nodeterm-new-phone-fixture-2idfmnhr/proof/root-case-final-closure.json`,
SHA-256 `3b379602a020dada055d973629763c604dd64bd4f2abee1b480e65bc740e1dd9`.
Independent closure review is `beta22-remount-final-closure-independent-tm_gpcj5/review.json`,
SHA-256 `d036ec60cde523bf57ee1c796759bd6f159a68ee7bc7b5748833f3dd708872a5`. Welcome
XML precedes timeout restoration; the later read-only snapshot supplies package/timeout facts.

Actual cursor/IME/activity recreation, pending-Send remount and raw-input Ctrl scheduling remain
unverified; this one no-Send retained-entry case does not cover them. The original ledger remains **10 Pass / 22 Partial / 32 Pending**. No host/relay/SSH
contract changes; iOS @eneskirca should review equivalent local retained-entry semantics.

### Captured Ctrl consumption (2026-10-08, A135)

`TerminalController.Bridge.onInput` previously posted a Ctrl clear guarded only by page/stream
identity. An off/on rearm before that main-thread callback could therefore be consumed by the old
input. One immutable armed/revision snapshot now covers capture, transformation and guarded
consumption. Raw input still enters the existing write queue immediately. Composed Send retains
its viewer/revision completion fences; automatic terminal reports do not consume Ctrl.

Five `CtrlModifierTest` behavior methods and three explicitly lexical app wiring methods pass
inside the 48-method/seven-suite healthy and restored candidate controls. Removing captured-revision
matching, the current-viewer guard or no-op setter semantics produces the intended assertion
failures; removing the app stream fence is separately caught by a source pin. The complete combined
Ctrl/draft candidate passes **1054 methods / 114 suites**, with no failures, errors or skips, and
forced offline app compilation. Ten policy and two wiring mutants were caught in total. Saved
receipt `098162c5`, root reparse and independent review `fdf4cbcf` bind those results.

This is a verified source ordering defect and tested policy fix, without a phone timing
reproduction or actual Handler execution by the JVM tests. Signed-source gates/CI and beta22
installation now pass; physical raw-input scheduling remains pending. The original 64-row ledger
is unchanged. Pending-Send rearm/remount, native history/Live and whole-network loss remain separate
checks. No host or SSH-visible contract changes; iOS @eneskirca should review equivalent local Ctrl
lifetime without an Android-to-iOS implementation claim.


### Lost Send reply and newer draft (2026-10-08)

Fresh `nodeterm-new-phone-fixture-8kjtzvr7` uses observed checkout `5a3013dd`, immutable
Desktop/build `0d8594a6` and unchanged installed Pixel 7a beta21/code22 APK/source `ef4caec2`.
One ordinary Send targets the original owned pane. The gate matches the exact production Enter
child and its stdout FIFO to the authenticated original SSH reader, then stops at its first
positive **22-byte read EXIT**. It verifies one real application ACK and witness from the original
Bash/node/TTY while the reader is stopped. No payload, tracee-memory or encrypted-packet inspection
is used.

One normal suffix appends a newer draft without submitting it. Fresh XML observes its exact
**146 characters** and disabled clickable Send control before the reader is killed, **4.998662
seconds before** the original nine-second hold deadline. Only the admitted original reader
receives pidfd SIGKILL from that matched syscall stop, with no detach/continuation back to
userspace; actual wait status 9 and readable pidfd confirm its death. This loses that successful
receipt after execution rather than simulating failure before dispatch.

Post-loss XML retains the exact newer draft and disabled Send while showing
“Disconnected. Reconnecting…” and “Reattach”. The later native snapshot records a new phone
viewer/handler attached to the same original Bash, tmux server/socket and producer; the complete
sibling guard remains unchanged. Native capture still contains exactly one standalone ACK and
the journal remains initial null plus the same sole witness at a late observation **over 120
seconds later** (conservative recorded lower bound 128.743 seconds). No suffix invocation or
automatic replay occurs. XML proves the draft/model state; this case claims no full rendered-glyph
equality, cursor preservation or observed Android internal `UNCERTAIN` status. A retained newer
draft alone cannot distinguish that status from an acknowledged completion's revision guard.

Private proof is under the fresh fixture's `proof/` directory:
`ssh-composed-loss-result.json` SHA-256
`293fa824e20bb6acc3f092ed62f179ff69518b27237a6a2c76a70ac69cfdf0e0`,
`lost-read-exit-ui-result.json` SHA-256
`689e347138577581039869166a0e1c8a4b6bbc7f0f81518b4679a27cd7f0c85d`
and `lost-receipt-root-late-readback.json` SHA-256
`8358c9d81a6874edef51287e8678ed45899dbfb47acceb4c160d25622e5504c2`.
Independent actual review `a128-lost-receipt-actual-independent-31xxhq1x/review.json` passes,
SHA-256 `41c9e7d36a6f29f7c7be3a87c03555b96f18376ee2508e69d54d7b2514a1bc5e`.

Normal own-profile Forget, exact public authorization restoration, owned reverse removal and
verified **15000-ms** timeout restoration complete. Separate fresh device readback confirms the
unchanged APK, first-install time and complete notification grant. The original host session
exits 0 with `runner-result.json` passing: 22 runtime tools and all 136 built outputs remain held,
its listeners close and generated private authentication is removed. This is owned cleanup,
not normal App Quit or exhaustive process absence. Independent cleanup review
`a128-lost-receipt-final-cleanup-independent-5ats0kf2/review.json` passes within that scope,
SHA-256 `8b2b27e02b5e66f3fdb894994bca5267cc15db4380cca7444a85d865f4dc338f`:
seven captured outer generations are absent, 2510 immutable inputs/136 outputs and 22 runtime
pins are held, both listener tables are clear and five generated auth paths are absent.
The separate regression-test mutation window is excluded from its current-source comparison.

The added real MINA/tmux `SshTransportTest` case loses only the second Enter exit-status
acknowledgement after actual guarded execution. It requires exact bracketed Unicode paste plus
CR, one paste/Enter attempt, an exited process and disconnected transport before asserting
`UNCERTAIN`. Healthy and restored controls each pass that one registered method with zero
skips. A mutant falsely returning `DELIVERED` after acknowledged paste fails its final status
assertion; production source is restored exactly. Private regression summary
`a128-lost-enter-ack-test-proof-thx73a_2/result-summary.json` SHA-256
`4bc29eefecd8db2ff96bba8c0a52dc5c5c3c3b2f633e3c3669e814faddbf5d39`.
This supplies JVM transport classification evidence separately from the phone's visible state.

This one direct-SSH successful-receipt-loss/newer-draft case passes. Whole-host/network blackhole,
native-route lost receipts, remount/Ctrl during pending Send, native TLS/history and wider lifecycle
checks remain open. No new finding, production source, wire or APK change is introduced; the
original **10 Pass / 22 Partial / 32 Pending** ledger stays unchanged.

### Silent SSH peer recovery and single Send (2026-10-08)

The fresh `nodeterm-new-phone-fixture-ajwhcupk` uses signed docs-only checkout `04da9b9e`, immutable
Desktop/build `0d8594a6` and unchanged installed Pixel 7a beta21/code22 APK/source `ef4caec2`.
The admitted original post-auth SSH peer 568 is stopped for **45.000 seconds** using its exact
generation. New phone viewer 886/handler 854 appears while that peer is paused. Original target
Bash 378/TTY `/dev/pts/1`, producer 605, tmux server 376/socket and sibling Bash 459/complete
capture remain unchanged. This is one silent peer on shared loopback: the listener and new
connections remain available. Whole-host sleep, network blackholing, AUTO relay fallback and
attribution to a particular timeout detector remain unverified.

No Send occurs during the pause. Four before/during/recovered XML snapshots retain the exact
125-character draft in the same focused composer bounds. Actual PNG decoding confirms matching
text-band positions/counts before the pause, and byte-identical early/late/recovered composer RGB
pixels for `(40,2030,920,2290)`, SHA-256
`b47c389b670dbb80561a6cea78560343d129dd97f3cb30f18563a2cf80c64a2e`.
An initial blank-rendering interpretation from inconsistent image-tool previews is discarded;
the saved pixels retain the draft glyphs and establish no new rendering defect. Cursor position
is not serialized or verified. The correction is recorded in
`a135-saved-png-pixel-correction-9cmoh7hy/review.json`, SHA-256
`ae348ad5bdb3bad0f1e62e9bd9d398f1955a9e7f3924e881dd06cedbeb7415cf`;
the earlier visual interpretations stay preserved privately with their conclusions superseded.

One later normal Send produces exactly one `outage` witness from the original Bash/node/TTY and
a real ACK in production capture, then clears the composer. The final journal is checked
**92.719 seconds after that invocation**, with no duplicate. A guarded SSH transport-write receipt
alone is not an application ACK; this separate witness/capture supplies that evidence. No lost
reply is injected, and relay composed-input ticket/race semantics receive no credit.
Private `proof/silent-ssh45-result.json` hashes to
`0b710828a6f14fcf1015b26b570904de31c57ce05cbdf1865eef9152be40d6d8`;
`silent-ssh-final-witness-root.json` to
`7fdc378795882a1c0ed99a3b1bda08ee5f134486d4e1a34fac345c1cf043ec96`.

Normal QA-profile Forget, exact public authorization restoration, owned reverse removal and
15000-ms timeout restoration are recorded in `silent-ssh-root-phone-cleanup.json`, SHA-256
`3bf9a78e1268b86d71b0d7cef8d7f5c6b95f233462b0c6401a94c36bc0c2d312`.
The runner closes with exit 0/`passed:true` after its exact stop request. Retirement receipt
`silent-ssh-root-final-retirement.json`, SHA-256
`f3319b12002aa7456106966a1d640cb048b8136d7d2320a91f78cb743d98414f`, records all 13 captured
generations retired, listeners absent, private authentication removed and 22 runtime tools,
2510 inputs and 136 built outputs held. Its 519 excluded namespace-read permission denials make
the scan non-exhaustive; this is owned SIGTERM retirement, not normal App Quit. Independent final
review `beta21-silent-ssh45-final-cleanup-peer-_rhq3ufq/review.json` hashes to
`b4669575ab81c0edc0dbb5242232477a786011f3702907f0084dc6bf3537641f`; its earlier visual limit is
superseded by the raw-pixel correction above. Item 14's whole-host/network scope and the original
**10 Pass / 22 Partial / 32 Pending** ledger remain unchanged. Native-history, lost replies and
wider lifecycle checks remain open; the separate retained-receipt case below adds no source or wire change.

### Held Send reply and newer draft (2026-10-08)

The fresh `nodeterm-new-phone-fixture-hj1d1rk5` is observed with docs-only checkout `50e7a876`,
immutable Desktop/build `0d8594a6` and unchanged installed Pixel 7a beta21/code22 APK/source
`ef4caec2`. One normal Send targets the original owned tmux pane. The gate matches its exact
production Enter child and unique stdout pipe to the authenticated SSH reader, then stops that
reader immediately after a positive **22-byte read EXIT**. It retains that local result for
**9.000279816 seconds**, without inspecting payload or tracee memory. This supplies a concrete
post-execution boundary rather than inferring dispatch from disabled Send.

During the hold, fresh XML observes the exact **146-character newer draft** in the enabled composer
with the clickable Send control disabled, **1.878384 seconds before** the fixed release deadline.
After release the same newer draft remains and Send is enabled. The original Bash/node/TTY records
one witness; native capture contains its real ACK. The journal remains unchanged **168.735781
seconds later**, with one ACK and no suffix invocation. Original viewer, Bash, tmux server/socket,
producer and complete sibling guard stay unchanged; no automatic replay occurs. XML establishes
the exact draft/model state; the post-release PNG confirms its visible suffix, not full glyph equality.

Private receipts are under
`/home/mgysin/.cache/nodeterm-android-work/nodeterm-new-phone-fixture-hj1d1rk5/proof/`:
`ssh-composed-read-exit-result.json`, `read-exit-ui-result.json`,
`continuity-native-observe-1791429006925922837-395824-result.json` and
`held-reply-late-readback.json`. Independent physical review
`a128-real-read-exit-actual-peer-ui3vxd0m/review.json` has SHA-256
`61812fa43da7e8a2b1484a8cf288142254087cf8be67079f2def3b37aed37aab`.

Normal own-profile Forget, exact public-key restoration and owned reverse removal complete.
`beta21-read-exit-fresh-foundation-ncbp_hwj/receipts/fresh-cleanup-device-readback.json` independently
confirms the original **15000-ms** timeout and unchanged APK/first-install time/notification grant;
the restore helper's uncertainty is archived without repeat write. The host session closes with
exit 0 and `runner-result.json` passes. `proof/fresh-root-retirement-readback.json` verifies the
captured original generations/listeners retired, generated private auth absent, and all **2510
inputs / 136 outputs** held. This is owned stop/cleanup, not exhaustive `/proc` absence or normal
App Quit. Separate late/cleanup review `a128-read-exit-final-cleanup-peer-1r0sd9ws/review.json`
passes within that scope, SHA-256
`ac748cbaf52eea7c4362290966e82309255a7e2c24bfb83f5c2772bd6dd470ae`.

This one direct-SSH retained-successful-receipt case passes. At that checkpoint, lost reply, network
blackhole, whole-host loss, remount/Ctrl during pending Send, native TLS/history and the wider
lifecycle matrix remained unverified. The earlier deadline-missed partial result stays preserved, no new
finding or source/wire/APK change is introduced, and the original **10 Pass / 22 Partial / 32 Pending**
ledger remains unchanged.

### Nine-second Send and newer-draft follow-up (2026-10-08)

The fresh `nodeterm-new-phone-fixture-p4w1lpc2` uses docs-only checkout `d361ce8f`, immutable
Desktop/build `0d8594a6` and unchanged installed Pixel 7a beta21/code22 APK/source `ef4caec2`.
Only its admitted original SSH peer is paused for **9.000066 seconds** and resumed through the same
pidfd. Original viewer 633/peer 573, target Bash 377/TTY `/dev/pts/1`, producer 987, tmux server
375/socket and sibling Bash 458/whole capture remain unchanged.

One normal Send and the suffix input both return before actual SIGCONT. The middle XML observes
the original 125-character focused draft with Send disabled and no connection/exit/uncertainty
overlay. The final newer-draft/disabled-Send XML observation crosses the resume deadline, so
`held-send-nine-ui-result.json` keeps **`passed:false`**; no strict pre-resume race pass is claimed.
Disabled Send alone does not establish SSH dispatch, and the dispatch phase before resume is
unobserved. The independently controlled lease passes without replay or extending its deadline.

After completion, XML retains the exact 146-character draft ending `NEXT_UNSENT_553007ef`, with
Send enabled and no connection/exit/uncertainty overlay. Saved PNG/crop inspection confirms visible
suffix text; it supplies neither exact OCR nor pre-resume glyph evidence. The original Bash/node/TTY
executes exactly one witness and production capture contains its real ACK; the journal is still
at one invocation **125.310 seconds later**. The suffix is not sent automatically.

Private `proof/held-send-nine-ui-result.json` / `held-send-nine-result.json` hash to
`c7475dba4ecadd0faa9d9c635f9b7ca5565fcac4bee702ceb5c8ea2187ef3094` /
`486585fcdeab5b4d09bfd8a692cf1862a636a2b7aabea32e02d933102e88830e`.
`held-send-final-witness.json` hashes to
`58017ce64dc4d626125138a11f0a2c52bf04098a35460a8c7c83173685574a82`;
independent partial review `beta21-held-send-nine-partial-peer-y59ymx4j/review.json` to
`bdbce739393853beaeeeac56a5271f0cada3fee8bb9eacbb04cc2bd6ec71973b`.

Normal own-profile Forget, exact authorization restoration and reverse removal complete; the
stock APK/install/grant stay unchanged. A fresh readback reconciles timeout **15000 ms** while
preserving the original restore helper's uncertain result, with no setting replay. Phone cleanup
`proof/silent-ssh-root-phone-cleanup.json` hashes to
`2207a36a1dbf9a6dec8912b4a8218ec9877ee57f3776bcb21630d56969058ce3`.
Intentional stop closes the runner with exit 0 and the validated supervisor stop passes; retirement
`proof/silent-ssh-root-final-retirement.json`, SHA-256
`22f9cf900ec67b495d5620cfcc65a3c542439400358cd99645720610cd90ff33`, records 14 captured generations
retired, listeners absent and 22 tools/2510 inputs/136 outputs held. Its 549 excluded namespace-read
permission denials make the scan non-exhaustive; normal App Quit is not verified.
This adds bounded later draft/one-Send evidence, not a product finding or a post-write held-response/
lost-reply test. Native-history/relay ticket races, whole items 14/25 and wider lifecycle stay open;
the original **10 Pass / 22 Partial / 32 Pending** ledger remains unchanged. No product, wire,
build or APK change is introduced.

### Native Desktop capture and renderer reattach (2026-10-08)

The fresh private `native-session-host-run-smz7f03m` uses immutable source/build `0d8594a6`
with the signed `98907171` checkout differing only in four Android documentation files. The
before/after guards cover all 2510 tracked inputs, 136 built outputs and 35 public/native tools.
Tmux is genuinely unavailable inside the private home/PID/network namespace, so the normal
Terminal factory selects the bundled session-host backend. Each of the two original factories
has a correlated positive attach response and renderer fulfillment, then a unique original Bash
kernel admission before its fixed producer is started once. Both producer lineages are admitted
before the first production capture.

All 200 unique numbered marker names appear exactly once in retained capture, with CJK, emoji
and a combining accent. Normal renderer keyboard input sends `q` once; capture contains its ACK.
A normal renderer reload preserves both node IDs and reconnects to the same daemon 1382,
target Bash 1407/producer 1464 and sibling Bash 1479/producer 1572, with their original births,
TTYs, private state/socket/token metadata and generations. Normal keyboard input then sends
`r` once and receives its ACK. The actual target raw-input journal is exactly hex `71`, `72`;
the sibling producer records no input and its complete capture stays byte-identical. This verifies
production capture retention and normal renderer reattachment/input. It does not verify full
rendered payload equality, canvas history gestures, Android `scrollV1`/Live or physical ConPTY.

Private `proof/native-pilot-result.json` hashes to
`0b756240cde658fe57a248f7f93527b458c8a003be447f5e94ff5118b299c160`;
`kernel-before-reload.json` and `kernel-after-reload.json` share SHA-256
`71f7310203a4349aec27d99c25c09f9795dd3ff0975df1df8ee1d5d03a03026a`.
The root execution closes with exit 0 and `passed:true`. Birth-guarded cleanup uses daemon
SIGTERM, app SIGTERM/SIGKILL and Xvfb SIGTERM; it is not normal App Quit.
`proof/root-final-retirement.json`, SHA-256
`7803f4b22f3fd0e6aab024802bfd3bc470f23a42e61cda97f9d2efafbce42e72`, records the original
outer bwrap birth retired and no visible members of its private PID namespace; 549 namespace-read
permission denials are excluded, so the scan is not exhaustive. The original V8/V9/V13 negatives and
V14 create-only result remain separate. Installed beta21 and the 64-item ledger are unchanged.

### Direct SSH reconnect and active background continuity (2026-10-08)

This fresh Pixel 7a pilot uses Desktop/build `0d8594a6` and the unchanged retained-signer stock
beta21/code22 APK/source `ef4caec2`. Two original factory-created tmux panes and their kernel Bash
owners are admitted. Only the phone SSH handler 658 receives SIGTERM: it retires, and automatic
recovery creates viewer 1133/handler 1101 without reconnect input. Original producer 569, Bash 374,
tmux server 373/socket and the entire sibling guard remain unchanged.

The staged command is byte-identical after controlled loss and both normal Home/resume cycles.
Producer write records advance **808→825** and **853→870** while the phone is on Home; the witness
journal stays at zero invocations throughout. One explicit Send then creates exactly one `outage`
witness invocation from the original Bash/node/TTY/script; native capture contains its ACK and
`continuity-after-send.xml` has an empty composer. This is a controlled SSH-handler drop, not a
45-second silent network outage or held-receipt race. Native-history/relay, port-22/TLS/FCM,
iOS/Windows, wider lifecycle and the original 64-item ledger receive no acceptance credit.

Private `nodeterm-new-phone-fixture-5ca5k3lt/proof/` retains
`continuity-native-interrupt-handler-1791416998900172828-4064486-result.json`, SHA-256
`bd3b9c5365713acb26b820ff5fd0f691cc9c904fa2a82a943f46f15509807f68`, and post-Send
`continuity-native-observe-1791417127474220491-4070832-result.json`, SHA-256
`806cce70f92fb60e4a667c9c4917f3140cfdef6fee6bca5a9a6ace7da1a67c03`.
`root-phone-home-1-result.json` / `root-phone-home-2-result.json` hash to
`af493a721eaf01bbeb8cd66d4410da1b4a02d79f0a55af3a5cec845b2c0c71b9` /
`a245660ee0a6b0d2ac19409f2ea420a384c77d59cee7046777f72f52df9e7c52`.

The custom fixture profile initially needs its private conventional `node-terminal` alias and
normal Refresh for discovery. The original producer's READY-substring check misses a wrapped
prompt; a read-only reconciliation admits that same once-started producer without replay or an
original-helper success claim. These are fixture calibrations, not new product findings.
Independent physical reviews `beta21-continuity-loss-independent-r2gidnqc/review.json`, SHA-256
`d82d6a63a62939e76399a2a9f4145888c72bb2fa21aa59fb434a4bfda91d2654`, and
`beta21-continuity-send-independent-p1i5jgkq/review.json`, SHA-256
`f65e105beeba054102c7d8fb5c21850522ef442180fc26d66b0e2f78925e270f`, confirm these bounded
cases. `proof/root-phone-cleanup.json`, SHA-256
`0f2bc9f7cd20bcfd79582cc0186e714343fb4c73e76c0b7ad8f51c43846e0464`, records normal Forget
of only the QA profile/Welcome, exact original authorization bytes, only the owned reverse removed,
original 15000-ms timeout readback and unchanged APK/first-install/grant/private ADB generation.

The outer `runner-result.json` remains **`passed:false`**, despite `exitCode:0` and held
source/tools/outputs: root directly atomically publishes the exact-nonce stop request instead of
signalling its launcher, so `intentionalStop` and `stopRequestWritten` stay false. The separate
supervisor validates that request, sends owned app/server SIGTERM and observes both exit; this
is not normal App Quit or an outer-runner success. Final
`proof/root-final-retirement-reconciliation.json`, SHA-256
`845b31a9d8b0ab2fd1247c245b996137c7014907d9f6365b3d7921ebe057a345`, verifies the original
owned generations and listeners retired, generated authentication absent and source/tools/136 outputs
held. Its 597 unrelated namespace-scan permission denials limit global process-absence claims.

### Login-shell probe completion deadline (2026-10-08, A134)

The earlier passive V13 diagnostic at `70fde6b0`, using unchanged `ef4caec2` Desktop outputs, admits the
original renderer/main observers and one normal factory action. Its original create reaches
`M1-path-before` but no later stage before the unchanged 100-second diagnostic bound. It sends
zero producer input and does not establish native attachment, PTY/history or phone acceptance.
The login-shell child's profile behavior, signal handling and pending stream/close cause remain
unproven. Post-retirement empty kernel rows cannot classify its earlier lifetime.

The local `src/core/exec-path.ts` change gives PATH and named-environment probes their own
five-second Promise deadline. Failure preserves the inherited-PATH/null fallback and settles
cache/coalesced callers once; late callbacks cannot replace the result. Cleanup uses only the
returned `ChildProcess`, signals it only while both exit fields are null, and releases its owned
stdio. It never searches for or signals descendants, reused PIDs, process groups or other servers.
Normal parsing and Windows behavior stay unchanged. The signed source fix is `3f382367`;
`0d8594a6` corrects six existing caller mocks to use Node's direct stdout callback. Every push
requires fresh exact-revision gates/CI.

Private `a129-native-v13-actual-stage-peer-j29xcq9l/review.json`, SHA-256
`1c41cedcdc2619944b5a447263ab9b7ad2f8547b0474bf5905ae83b74075e586`, binds the actual stage
observation and its limits. Source-bound `exec-path-deadline-proof-ubzqduoa/run-v3/receipt.json`,
SHA-256 `81b76c97a2dcc2e6c87d13ff6e4ef35d13279c6b5a82e131ef31c8b15dbaa3e2`, records
**37 passing tests in three affected files**, five existing Windows-only skips, full TypeScript,
and **seven assertion-caught mutants** with healthy/restored leaf controls (29 pass, five skips).
After correcting six caller mocks to use Node's direct stdout callback, the expanded nine-file
union passes **161 tests**, with the same five Windows skips. The single-user regression also
checks that desktop attachment preserves phone viewers; its separate `-D` mutant is caught.
Those controlled checks alone do not establish real startup.
A separate controlled TERM-ignoring child comparison leaves the original unresolved at 6253.53 ms;
the candidate settles null at 5006.04 ms with its exact child gone by 6254.08 ms and both namespaces
empty after exit (`exec-path-real-comparison-zxccybzi/actual-ado4gout/receipt.json`, SHA-256
`0137631a112b7881506bcf40cd689fa98b96766e1fd6f5311bcf5084329f48c6`); this does not classify V13.
Independent static source review `exec-path-deadline-independent-p2a62fmt/source-review.json`,
SHA-256 `4bbf36ff60dbf9b738956309f3243f1da4aea9a4fe67f843b5634fa255ab3829`, reports no
source issue; it does not independently execute the controls or establish runtime acceptance.
The published `0d8594a6` checkpoint passes forced **1033 methods / 110 suites** without failures,
errors or skips, offline app compilation, full TypeScript and **161 tests/nine affected files**
with five known Windows-only skips. `a134-publication-41c5uiyz/gates.json`, SHA-256
`83c5a6d7d645784b26c257e1e05a6b5f11d7e58347746ff0ab15f25743195d69`, and `ci-result.json`,
SHA-256 `f3e058762bda093339e729784c427c75760749df6f6b20b598e6f15a136fffe6`, bind the
exact source and [run `37702852854`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37702852854), attempt 1: all five jobs and ten required steps pass.

Its fresh `94gqsiav` Desktop build uses that same source (2510 raw inputs, 136 outputs, 25.47 s).
V14's one normal factory observes the original PATH wait settle, attach request 2 receive success,
ready and renderer fulfillment for fresh persistent `pty-1`, and the visible `bash-5.3$` prompt.
The original daemon/Bash identities agree in early/final records. It sends zero PTY input and
performs no capture, producer, history or phone test; the diagnostic keeps acceptance flags false.
This does not locate V13's child cause or show whether the independent fallback fired.
`a129-native-v14-actual-independent-uu9npxeq/review.json`, SHA-256
`171ec86b253559dacd6e1835ddb40012f16512a0ca7f3bf78db0597d65191de6`, independently reviews
that bounded result. `native-session-host-run-stjrb_65/proof/root-cleanup-review.json`, SHA-256
`c8998f3af47b0afaff586ae62913c1a118dda1a44c94d06d2022fbf6b965860c`, records exact owned
retirement, an empty namespace and held source/tools/outputs; this is not normal App Quit.
Native producer/history/new-intent, Android and Windows acceptance remain unverified.

This shared Desktop fix also benefits iOS companion terminal creation: flag it for @eneskirca,
with no mirror, RPC or wire change. Installed beta21/source `ef4caec2` and the original
**10 Pass / 22 Partial / 32 Pending** ledger are unchanged.

### Beta 20 publication and bounded output checks (2026-10-07)

Signed source `11fbff08c83bfb8403e1186e740796175e705b77` runs fresh forced **1029/108**
protocol with no failures/errors/skips, offline app compilation and full TypeScript. Actual Desktop
inputs are unchanged from the fully gated `644445aa` baseline, so local Vitest is not repeated.
Private `a131-output-publication-beta20-5ao9hwe5/publication/gates.json` hashes to
`40d3584420787739da30b7b2dd9bd48363e8465355f2017c413174d3847cf517`; its exact-head
five-job/ten-step [CI run `37659190980`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37659190980)
receipt `publication/ci-result.json` hashes to
`90407a81af43a778cb82fd74a0156269fb8bfade80f5505797bd7a58413867c4`.

The same root's `artifacts/nodeterm-android-0.1.0-beta.20.apk` hashes to
`823b78b7efbb2ce994ecb96f35ef002729464df735204cc2a7cdc94f8df036d8`.
Its `build/artifact-review.json` hashes to
`1859f8cd360cd454fa841453a5615ca1f6ffd8b0203115d763b1bd5aac41f669`;
public metadata hashes to `ff15cb06b4421bc637d8e48debdf06e7d24dc6d0630de614ad6679ebbf0e5389`.
Actual SDK 36 verifies code 21, nondebuggable release and the retained `c610c3a0…` certificate;
SDK 37 tools remain unavailable. The actual 4.874877-second in-place update on Pixel 7a verifies
installed bytes and unchanged first-install time/notification grant and flags; the receipt
`beta20-phone-bound-zd_nnqz9/receipts/update-result.json` hashes to
`b627318b9275011a4c78f4a9c69c23728b664979b0ec724dc1099157e808ae97`.

On fresh owned Linux/tmux fixture `nodeterm-new-phone-fixture-c04fvzwg`, ordinary Desktop
factories create distinct target/guard panes. Phone screenshots under
`beta20-phone-bound-zd_nnqz9/receipts/` show rows 1053–1094 in `flow1.png`, then 1160–1199
in `resumedflow.png` after background/resume. Home occurs after the producer's nominal finish;
active-production overlap is unproven, so this is no background-delivery/retention pass.
`targetreopened.png` shows the scoped target's
prompt; it does not prove the numbered rows stay displayed on every reopen. `guardafterflow.png`
shows only its original prompt. Native `proof/plain-terminal-output-exercise-1791395248323-1641707-result.json`
hashes to `abdb84f3d3cb48d1a3bde499fd6903dc0ff9da1cc4278ace52180508f90bb05e`:
all 1200 numbered rows occur once, the original shell owner is restored and the guard remains
unchanged, but `flowDone`/`complete` are false. Raw `proof/root-raw-tmux-output.txt` hashes to
`29ed96409aa98a40b3a8d47064233d80e75f3538c42073eab75adf91e2c8f7ec` and also lacks
`FLOW_DONE`; [A132](android-audit-2026-09.md#a132) records the unlocated completion loss.

A separate phone Send contains `printf 'A131_17930152_MOBILE_FINAL_TAIL\n'; exit 0`.
`mobilefinaltail.png` hashes to `5cef21d34ec337b9a3f804a0ba38552194276cfb7b9590d4670f086cf6fcc576`
and shows `[exited]`, an exit-0 overlay and no previously displayed history; `mobilefinalstate.xml`
hashes to `7e9d859cf8b2e724dea150c61ffe08fa4c1baa68b040ff5ab0b7888520539a52`.
No pre-exit capture proves emission of that final marker, and this does not establish an
Android-only cause. [A133](android-audit-2026-09.md#a133) keeps exit-display attribution open.
The owned 30-minute host retirement passes: `proof/runner-result.json` hashes to
`fbe456714d65464f8160e20463883ba0b391a4558a3634303da05322d2ff15fc`;
`proof/supervisor-result.json` hashes to `42e5d9ae083049001f16bbcf022e0c2d4449db08a042a8c7950fad5ce7d3ba16`.
Both listeners close, generated private auth is removed and source/tools/held outputs remain bound.
`beta20-phone-bound-zd_nnqz9/receipts/root-public-admission-cleanup.json` hashes to
`b43a97658f917ec7bc1ef57ed2ff795ed55e328acde0f10a0a3f6437cec8a1b4`: only the admitted
phone public-key line and reverse port 29453 are removed, and the original auth body is restored.
Normal Forget removes only the QA profile; Welcome is observed. The final phone cleanup receipt
`beta20-phone-bound-zd_nnqz9/receipts/root-final-phone-cleanup.json` hashes to
`dce22b6e06fdf9d103aacfeb9fc99029e3463395573df1b2262b86341de4281c`.
It verifies the same installed beta-20 bytes/grant/first-install time and timeout already at the
original 15000 ms. The restore helper refuses before its setting write; after ordinary wake,
Welcome and 15000 are observed again. No timeout restore write or security change is claimed.
These direct-SSH observations provide no
native/session-host history, held Live-button, physical queue-race or full checklist acceptance.
The original Pixel 10 Pro ledger remains **10 Pass / 22 Partial / 32 Pending**.

The frozen physical checkpoint is
`beta20-physical-checkpoint-jn5pg_a6/physical-checkpoint.json`, SHA-256
`96b4356cf2b8c8d25c75396a19b51a572f9a644a2d8cdea1b76bdbd34534be04`.
It binds 124 raw artifacts and keeps the scoped passes, partial cases, A132/A133 failures and
owned cleanup separate. These records do not establish output overlapping backgrounding or
successful final-marker emission.

### Fresh Fedora output and native Desktop readiness (2026-10-08)

Both follow-ups use clean `9b8bba2b`; product source and the installed beta21 artifact remain
unchanged. Paths below are private under `/home/mgysin/.cache/nodeterm-android-work/`.

**A132 fresh discriminator.** Normal Fedora public login startup, a fresh private home, a
49×48 pane and the unchanged original 226-byte/40-ms Python command produce all 1200 ordered
rows exactly once in output-only raw recording and native capture, with one standalone
`A131_17930152_FLOW_DONE`; the tmux client's raw bytes also contain the full marker. The same
original Bash returns to the foreground. Existing Bash OSC3008 reports `exit=success`, a natural
shell report rather than a producer wait status or a final PTY-write witness. Fresh user/hostname,
private cwd and literal native send-keys delivery do not reproduce the earlier exact prompt,
NSS/hostname or Desktop paste path. The original A132 attribution stays **OPEN**; this supplies
no SSH or phone result. Exact owned server/process/socket cleanup passes.

`a132-normal-fedora-discriminator-roamz0e_/run-hyojm26y/result.json` hashes to
`0f12736ffe6713f81380a8be1fc8c42f30e3277e03d6ed9c3855506cd6819d98`;
its `root-review.json` hashes to
`c24d515fab7756e85ef01be3c0dc179b5198d9561f04cf5bdb160181e35a8bba`.
Independent `a132-normal-fedora-actual-independent-zfratst7/review.json`, SHA-256
`45490e72c1fb9749dfe5d1fb9ceb1b61e8d8cc70c74e37786578086ab71ef8a9`, binds 108 records.

**Native Desktop V8 negative.** In `native-session-host-run-uno5mppu`, the ordinary factory
creates `term-muynv94j-6403f949`. Its 74 capture observations stay empty; readiness expires before
any producer input. Exact read-only renderer-navigation `-32000` recovery is preserved. Early
and final snapshots record the same protocol-2 daemon, private socket and token metadata, with
no children visible from its main task only. Other threads were not traversed. Linux's null
pane-owner result is expected; null command/empty capture do not prove attachment or shell absence.
Harness readiness remains unresolved, with no product attribution or A129/A130 acceptance.
The eight-second gate is shorter than supported cold-create budgets; it cannot classify a
startup defect. Source-budget review `a129-native-v8-actual-source-independent-utmwd1m1/review.json`
hashes to `314e5a3a065ae753414f01671ed7fbaa72db32af1b789d059a07812ab44abbd0`.
All 2510 canonical inputs, 136 built outputs and 35 tool pins agree with the saved binding.
Independent `a129-native-v8-negative-independent-6dce7opt/review.json` hashes to
`33a676c41ba01eaef75951abcdd1b58754eedd6dbdecb8aa9fe262f7a1d02830`.
Saved `native-session-host-run-uno5mppu/proof/root-cleanup-review.json`, SHA-256
`d7c651ee487c983df17d4ae2badcc0e3774d111ce4089781a9575308e56affb8`, verifies the original
outer generation gone and zero namespace survivors before separate namespace reuse. Normal Quit
remains unverified. V9 adds the bounded all-thread observation below without replaying input.

**Native Desktop V9 negative.** In `native-session-host-run-wtuahva_`, a 30-second shell-readiness
window still leaves the original `term-muyo5cl0-26e8f7ba` blank: 280 captures are empty and no
producer input is sent. Two complete ten-thread snapshots have no child processes at their
observation points, but belong to different daemon generations: 1064 exits empty after 30 seconds,
then capture starts 2372. They do not establish continuity or shell absence throughout the run.
No original renderer create request/settlement or attachment is proved; the saved renderer warning
also supplies no such evidence. Source, 136 built outputs and 35 tools remain unchanged. The
next discriminant is passive observation of the original spawn decision and create dispatch/settlement,
without another readiness-only run or replay. No product startup bug or A129/A130 acceptance is claimed.

Independent `a129-native-v9-actual-source-independent-oovxt4vw/review-normalized.json`, SHA-256
`789babc5f49a7f7f4ae43d29a3cd67184e0eb1e3f1440596c2ad3b140f26ed8c`, binds 349 records and
2510 normalized source inputs. Saved `native-session-host-run-wtuahva_/proof/root-cleanup-review.json`,
SHA-256 `cde2a35067394cdae9cb63b1e757f0d08b5cec4e289f174d36f1952ca8f29e62`, verifies the
original outer generation gone and zero namespace survivors; normal Quit is not verified.
**Browser/Share physical pilot.** The fresh owned direct-SSH fixture `vu4s5z1a` uses the same
installed beta21/code22/source `ef4caec2` under clean `9b8bba2b`. One normal Copy Links Open
initially records a focus-check uncertainty; no second Open is sent. Read-only reconciliation
records Vanadium's address field `example.com/#nt-beta21-60f53a4e`, its secure connection indicator
and rendered explanatory content. No Example Domain heading or activity-level full URI is claimed.
One Back has no verified return; ordinary app resume succeeds. Both uncertainties are retained.

Normal Share opens the system chooser, whose XML and screenshot preview exactly
`SHARE_60f53a4e_ONLY`. One Back returns to the same owned terminal scope. Native observation
retains the original server/socket/pane generations, genuine producer and unchanged guard capture.
The selection uses screenshot/OCR glyph position y=1090 rather than the discrepant AX row center;
no failed AX tap occurs in this run. No recipient/delivery, ended-page retention across browser
backgrounding, A129/A130 or wider matrix acceptance is claimed.
Normal Forget reaches Welcome; only the original added public-key line and owned reverse are
removed. Exact intentional fixture stop retires all admitted process generations and its namespace,
closes both listeners and removes five private-auth paths; 22 tools/136 outputs remain held. This is
not normal App Quit. Timeout restore writes the original 15000 ms once, then loses post-write focus;
that uncertain receipt is retained. A later read-only check confirms 15000, reverse absence and
unchanged installed APK/first-install time/notification grant, with no second setting write.

Phone paths below are under `beta21-browser-share-phone-bound-ipaufgcy/receipts/`:
`browser-original-open-reconciled.json` hashes to
`eab11ce62cedddb344d2f289f0156ae5b67433183c1a7389dff999da53e32bb1`;
`external-observe-7ff8c2d7cec04279bcf1cc2d352d8231.json` hashes to
`5e7c711675ae8fd9068ee239656d547b930428b1eea2c27b669504ec903eae17`;
`external-chooser-back-result.json` hashes to
`53c24a531a9e3a59db1fab18fa1166c68f86e090395aad98738c605ca67d94e0`.
Native `nodeterm-new-phone-fixture-vu4s5z1a/proof/browser-share-native-observe-1791412545417254277-3571190-result.json`
hashes to `36b6da39f892d11fa5d88e8cf6e972fee0fd47fb0ba06cb4d0d6e32d4c381084`.
Cleanup `nodeterm-new-phone-fixture-vu4s5z1a/proof/browser-share-root-cleanup-review.json` hashes to
`51b138d878baa3c85b97767c4bca74b30e54a6b7b13d07f430ccfb11293af824`;
phone `screen-timeout-original-restored-readonly.json` hashes to
`6aa57e3ffbd9080c9d52123b869356ecd495b6301dd71e5c8e401a5696137e86`.
Independent `beta21-browser-share-physical-independent-nntykgrg/review.json`, SHA-256
`f566c4d258a8aec47b619a4af20c9cac351b638cac9f933487a424afce98e58d`, confirms these bounded observations and cleanup.
The original 64-row ledger remains unchanged at 10/22/32.

### Closed SSH/tmux exit display source checkpoint (2026-10-07, A133)

The frozen native exit discriminator `a133-tmux-raw-exit-v3-rpn5n03z` records immediate and
150-ms-delayed final writes: each confirms 17 bytes containing `A133_FINAL_TAIL`. Its actual
outer tmux suffix clears the alternate screen with `CSI 2 J` before `CSI ?1049l`, then writes
`[exited]`; capturing only at alternate-screen departure is too late. Results `7574288b…` and
`95700b01…` bind both final traces. Replay checks settled parser/Copy state, not whether the tail
was briefly painted during the recorded delay. The earlier beta-20 phone marker remains unconfirmed.

This change passively captures the current visible alternate pane before erasure, including a
blank pane which replaces an older capture. Only the current known SSH/tmux viewer's EOF opts in;
an xterm parser-drain barrier and viewer/revision checks precede the closed display. Native/relay
paths stay unopted. Copy and touch links use the captured physical rows/wraps/URLs; there is no Live
button or PTY input from that layer. Settled rows and Copy survive font/layout changes; new attach,
paint/reset, page retirement or suspension clears them. Backgrounding still uses the existing
reattach flow. This preserves the last rendered pane on one page, not backend history or bytes
tmux never painted. Control sequences are neither swallowed nor stripped, and no tmux capability,
live TUI behavior or transport contract changes. The equivalent iOS EOF/display implication is
for @eneskirca to review.

Actual shipped-xterm component controls pass **23 cases**, then **26** with layout-touch, wrapped
plain-URL touch and outer-TUI/query controls. Private
`a133-augmented-control-root-zruk3bem/result.json` hashes to
`90d9df1e2820eea048d60aebcf0cafa326fcb3e7f974f60dec0734541fd4aef2`.
Eleven semantic mutants are assertion-caught with healthy/restored 23-case controls in
`a133-component-mutations-lg2vrii9/receipt.json`, SHA-256
`a8d17ca753eb00d30d90109745ab8435738adfdf6b96236b04003f0bedb6cba6`.
An additional stale-geometry mutant fails the intended assertion against all 26 cases;
`a133-geometry-mutant-root-0fapgav5/execution.json` binds its result `fdcf14f3…` and recipe
`83172a2b…`. Grouped EOF/origin policies do not establish individual redundant-clause coverage.
These are real xterm5.5 parser tests with jsdom layout/canvas stubs, not WebView/phone/SSH-runtime
acceptance. The permanent behavioral JUnit method and three explicitly labeled app source-pin
methods pass in a fresh forced offline focused run (`a133-permanent-focused-t_nycdfq`), with all
26 component cases required and no failures/errors/skips. Those focused checks predate the final
27-case layout follow-up and publication below; they supply no physical acceptance. The original
**10/22/32** ledger is unchanged.

The three app source pins are separately mutation-checked: removing SSH-only admission, the owned
EOF display call or background capture retirement fails only its intended assertion, while healthy
and restored controls pass. `a133-wiring-pin-mutations-zxu7m35n/run-h0czovso/receipt.json`, SHA-256
`8ae3c307ba0f98a0f148ea9f5f50e2a58a14cb8f5222f0f317ca6fd6378c36d0`, retains five runs of the
same three compiled test/helper classes. These lexical source assertions are separate from the
twelve renderer behavior mutants and provide no device acceptance.

**Integration regression and repair.** The first full run at signed `94c8d2c4` executed 1033
methods in 110 suites and failed the existing delayed-submit swipe assertion (no errors/skips).
Its retained `a133-publication-beta21-gates-v3-t_51tdks/protocol.log` records the failure; that
revision was not pushed or installed. Geometry invalidation incorrectly advanced the submission
epoch. Advancing that epoch only when the viewer/display clears preserves a same-view delayed
Enter while keeping begin/retire/paint/reset/pagehide/suspend barriers and pending EOF revision checks.

A fresh forced focused run (`a133-layout-focused-ndsg_4be`, result `809132cf…`) passes all 16
methods across the closed-view, wiring and existing swipe suites. The behavioral method now
requires 27 exact cases, including combined refit/font/resize during submission. Reinstating
the old epoch placement fails only that new assertion; 27-case healthy/restored controls pass
in `a133-layout-mutant-jberi26g/receipt.json`, SHA-256
`9f0a3879bfa081cc8be4199c63c88dce2119a5475c6fd3cb5915ad68d987373c`.
This additional mutation is separate from the earlier twelve component and three source-pin
mutants. Final signed/pushed `ef4caec2` passes forced **1033/110**, offline app compilation and full
TypeScript; exact-head CI `37678829862`, attempt 1, passes five jobs and ten required steps.
Private `a133-publication-beta21-layout-gates-kvsnfmww/gates.json` hashes to
`0a3536e129651daefbd17e26d38caf06bd39fb909002914f28f7feb327d4a733`;
its `ci-result.json` hashes to `bb6a2b17ad0ce8da0205e80fe6abd8eb7d5786df0ea8ebeafab05a513908e34a`.
The signed beta21 artifact review hashes to `19228d8a3605ea8461b4b54acab205b5a51eca49b2d8148737e88eb2ef367676`
and passes all 46 checks using actual SDK 36 tools, with no actual SDK 37 verification.
The installed beta 21/code 22 APK is bound to this artifact source; later docs-only heads are separate.
Its 5.083-second update keeps first-install time and exact notification grant/flags. The later
bounded physical closed-screen observations below are separate from installation/parser evidence.

**Bounded beta21 active-output follow-up.** On the fresh owned direct-SSH/tmux target, actual
40-ms output completes all 1200 ordered rows exactly once in raw capture, and a successful
24-byte `FLOW_DONE` write reaches the final native capture and phone screen. Actual progress
publication occurs between the root's completed Home input and resume receipt; Quickstep then
nodeterm focus is recorded. The crossing relies on filesystem/receipt order because the generic
phone input receipt does not store key arguments or a monotonic timestamp. The measured producer
duration is 48.23 seconds. The final screen contains rows 1160–1199, Unicode, the marker and one
wrapped ordinary prompt; a later swipe shows older native tmux history. The sibling guard's
process and complete capture are unchanged. Private
`beta21-flow-background-independent-_hyv21hq/review.json`, SHA-256
`eb15e8892941bbf754d8d4ec2f37fbf5f15fbe83ca45a0246fbf5d79fa4ee00b`, binds 36 records.
This neither identifies the original A132 negative's cause nor proves A129/A130 native-history
behavior, the A133 closed-screen check, wider lifecycle latency or overall fixture cleanup.

**Bounded beta21 closed-screen check.** The original owned target emits eight Unicode rows,
wrapped text, an OSC8 anchor, a 128-character plain URL and a successful 25-byte LF final write.
The pane recorder contains 1396 bytes (LF becomes CRLF), the target ends naturally with exit 0,
and its output-only logger receives pipe EOF. The phone's same-page closed screen retains the
rows, wraps, final tail and logout with Copy enabled and sending disabled. At that first pilot, normal Copy-sheet
filtering and one selected URL are observed without proof of clipboard contents or final-marker
copying. Exact original OSC8 and full plain URLs are offered before font changes; A-minus redraw
retains the pane/tail and A-plus restoration is root-observed. Post-font link hits were not yet
verified at that checkpoint. Private `beta21-closed-physical-independent-xs0wdxrr/review.json`,
SHA-256 `7145b2cac1c7fbfed39503de5ef00acec8c1bfbce13650bfe6b3b1e5dee364ab`, binds 31 records.
Opening the sibling guard retires the same-page old closed text. This supplies no unrelated live-TUI,
native-history/held-Live, persistent-ended-history or full-checklist acceptance.

**Later beta21 clipboard and post-font link pilot.** A fresh owned direct-SSH/tmux fixture
`nodeterm-new-phone-fixture-nvfslwqv` uses the unchanged `ef4caec2` build/APK under docs-only
`9e740cec`. Its original target completes a witnessed 25-byte final write; the output-only
logger receives EOF with 1402 raw bytes, SHA-256
`dd9c14d73dbc156f02a5abf340c5dfaea7324b46f28fce16034b64970a216e16`.
The original sibling guard's process and complete capture are unchanged before a later deliberate
view of that guard. Normal Copy selects only the visually checked final-marker row, then only
`03 Ω🧭`; normal clipboard paste into the independently verified empty ended composer yields
exact `A133_c9981a9b_FINAL_TAIL` and `A133_c9981a9b_03 Ω🧭`, with Send disabled.
The exact 74-character OSC8 and 128-character plain URLs are offered after both A-minus and
A-plus restoration through stationary native touch hits at the current visible glyph positions.
Browser navigation and Share were not tested. The first AX-derived row coordinate selected a URL
rather than the marker. Screenshot-calibrated stationary touches select the actual visible row;
later paste admissions independently verify the empty exit-0 composer and disabled Send. That
fixture calibration is not a new Copy-index product finding; the failed initial overlapping
composer-clear capture receives no credit. Raw XML/PNG receipts are under
`a133-copy-link-followup-v3-s3jznolt/phone/receipts/` (`selected-final-tail-visual.png`,
`pasted-final-tail-visual.xml`, `selected-unicode.png`, `pasted-unicode.xml` and all four
`osc8/plain-after-smaller/restored-font.xml` files). Native ownership/write/EOF evidence is
`nodeterm-new-phone-fixture-nvfslwqv/proof/native-fixture-stop-1791407461302681663-2796520-result.json`,
SHA-256 `e276c131230b2e9130ab93cc442c1da205741b1b4978461c536792c8f09d48b5`.
The calibrated final-marker review is `a133-clipboard-calibrated-independent-4_cp_agf/review.json`,
SHA-256 `9d48a7a0ba23cc236bf693ebef89ab7ba342597bfb1ae37084b3c056a6665f25`. The Unicode/post-font
review rehashes that proof and 81 source/evidence records:
`a133-unicode-postfont-independent-9l6o_i4c/review.json`, SHA-256
`4ba6927d86a79ae4c07b85c39ed86ce12f1294de2bf68e4160fbacca198bf2f7`. A later normal opening
of the sibling guard shows only its own prompt/title, with no old closed rows or exit overlay.
These bounded same-page checks do not establish persistent ended history, unrelated live TUI,
A129/A130 native history, the original A132 attribution or the full 64-item ledger.

**Later pilot owned cleanup.** Exact pidfd/nonce SIGTERM completes the current host runner with
exit 0; its receipt is `89d9022eca1f787c3e27d92ce662cb97cf1ce10015d815cbb99f50baf230157e`.
`nodeterm-new-phone-fixture-nvfslwqv/proof/root-cleanup-verification.json`, SHA-256
`7d1e316dd88764391707a7a5a31e91bb6f67ea2aa777ecdd4f98d037251dbdb8`, confirms seven admitted
processes and their namespace are gone, both listeners close, private authentication is absent,
and runtime pins/held outputs remain unchanged. This is owned SIGTERM cleanup, not normal Quit.
The exact admitted public-key line and reverse are removed, original authorized bytes restored,
and normal Forget returns only the temporary profile to Welcome. The first timeout restore writes
900000→15000 but fails its post-write window check; its uncertain result is preserved. A retry
refuses before another write, and a separate guarded read confirms 15000 with the same APK,
first-install time and notification grant/flags:
`a133-copy-link-followup-v3-s3jznolt/phone/receipts/screen-timeout-restore-reconciled.json`, SHA-256
`088a91d9f917a949a7e82449c752a0e18c52b2102060244c44ed0ff3d5211cee`.
Independent saved-evidence cleanup review is
`beta21-copy-cleanup-independent-03y913yc/review.json`, SHA-256
`8e7433a47948f6d623c17da92b4c7b066174236c47c5fe3863b5c7ba5ce67932`.
It rehashes 184 evidence files and all 136 immutable build outputs, checks 2510 source entries
under the docs-only current/build binding, and confirms 2506 non-doc canonical entries and modes
agree. Recorded cleanup, the new guard view and actual 15000-ms reconciliation pass; the reviewer
performs no runtime or device probes.

**Earlier pilot owned cleanup.** Root's exact pidfd/nonce stop completes the host runner with exit 0;
`runner-result.json` hashes to `18d31a6eaa3ca12c5a89ea49085e17e2ec3dd1b05a45c8e19f9c61f43b24f01a`.
The supervisor's admitted app/server SIGTERM cleanup passes; ordinary native Quit is unverified.
The exact processes retire, SSH/CDP listeners close, generated private authentication is removed,
and 22 runtime pins/136 held outputs remain unchanged. The one admitted phone public line and
owned reverse are removed, the temporary profile is forgotten, and the app returns to Welcome.
The same fresh timeout lease restores 15000 ms. The installed beta21 hash, first-install time
and notification grant/flags remain unchanged. Cleanup is separate from target/logger natural exit.

### Viewer output lifetime source checks (2026-10-07, A131)

Final forced focused control/restored runs pass **71 methods / 8 suites**, zero failures/errors/skips.
Eleven new methods exercise the actual Kotlin queue/page/slot with an explicit scheduler and paused
producer; three new source pins check app wiring. The existing keyboard-chip source pin follows
its now page-global focus call. The unchanged pure queue/page/test catches **ten behavioral mutants**
in a frozen first window (32/3 control/restored); the final controller catches **four app source-pin
mutants** in a separate 71/8 window. The earlier three wiring variants are historical, not extra
unique mutations. These checks do not run Android Handler/WebView or reproduce a physical race.

Private first-window receipt `a131-output-proof-6yng04t0/receipt.json` hashes to
`67424776a015bfa3bc7b3bb45bb773fc24408a8b73b816bee1c4a4a5f60c3cae`;
final receipt `a131-output-final-proof-p06l8grq/receipt.json` hashes to
`9271e1a22ebfd50c237486bdded708becc629df12fc5cd19e03f58dcbdb2e9a9`.
The six-file final source inventory hashes to
`a8997ab31466b732a855137bd00a631db4a61ac241e18a1e04395aa0ab89a313`.
Root independently rehashed both windows' logs/compiled descriptors/XML; peer review checks the
actual intended assertion failures and reconstructed mutations. Signed `11fbff08` now passes full
publication and same-signer beta-20 installation; the bounded physical checks above are partial,
with A132/A133 open. JavaScript already dispatched to a ready WebView is outside this fix.
Items 25/26 and the original **10/22/32** ledger remain scoped.

### Beta 19 publication, provider and emulator checkpoint (2026-10-07)

Signed, pushed `5bda2c321118712bb7684eda2b829eaa427f58d7` includes A130's held Live-touch fix.
Fresh forced offline protocol checks execute **1015 methods / 106 suites** with zero failures,
errors or skips; offline app compilation and full TypeScript pass. Exact-head
[Android run `37608652625`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37608652625)
passes all five jobs and ten required steps. The private `a130-publication-final-kyernmsh/`
receipts are `gates.json`, SHA-256
`a2c06567f48f3583e3aa34dcc4881031626eb94a98afe23c6d0c4168cac892d7`, and `ci-result.json`, SHA-256
`77c8a5c5dc92a4b41f3b84f3819d0756542f9aeb1d26f6e66e9b5f57b9d89135`.
Retained-signer beta 19/code 20 hashes to
`e7271ebe1c1d65d8f6a09f7c59ab4b0042081c152c421568caabdcf6965bad42`; its actual SDK-36 artifact
review is `beta19-final-recipes-r5x3c9z6/build/artifact-review.json`, SHA-256
`9157b0f7b1369c1a1e899c67cb4a82dae973e5eac286f2cf28483f972c202186`.
SDK 37 is absent; no SDK-37 artifact verification or A129/A130 actual app/WebView acceptance
is claimed by this checkpoint. One 6.18-second same-signer `adb install -r` updates the intended
Pixel 7a from beta 17/code 18 to beta 19/code 20; the installed public APK hashes exactly to the
reviewed artifact. First-install time and `POST_NOTIFICATIONS`'s `granted=true` plus full flags
are identical before/after. The installer launches no app and makes no UI input; the later
connection check below is separate. Saved-profile/pin reuse is verified in the later follow-up; notification behavior remains unverified.
Update request `beta19-pixel7a-ui-v2-pzsxl_p5/receipts/update-request.json` hashes to
`6ffca2c1f454c82cd7605feb2d586af2148340272feef15414b562ed6d22d11e`; actual
`update-result.json` hashes to `a5478736d7cdedb48e12febdd5493e9cd522c5b1107c01ab66bad92defcad29e`.

**Pixel 7a approval and pin follow-up (2026-10-07, Desktop `e06b5547` / installed beta 19).**
The phone's normal Always allow dialog selects the original `localSettings` suggestion for
`term-muy5k94n-e14b1265`. Real Claude 2.1.292 in the admitted sibling uses the genuine registered
node routing and unchanged production hook: **nine hooks**, one **36.814-second** hold consumed,
two actual Bash calls with no second hold, and the exact CLI-saved rule. The 45.982-second case
exits successfully. Private `nodeterm-new-phone-fixture-ik57x6_y/home/qa-project/real-cli-a105-f862d70c/proof/result.json`
hashes to `615b64dfac6818f578f138dd479eb296b434c81370a852f3ac5ae99400772a38`; independent
`a105-physical-independent-review-v2-_idtfg29/review.json` hashes to
`99190d6e439fe957dceae70a22c2eadd7c17e54b9a8e992d71b2c08a44c12b79`. This verifies the Android
choice plus real application; it does not prove rule persistence after CLI restart or a
production-pane-child launch. Earlier tool-less print calibration supplied no
held question or Android acceptance. The original **10 Pass / 22 Partial / 32 Pending** ledger is unchanged.

**A106 original question application.** Beta 19's real Send answers submits Cobalt for the
single question and nonadjacent Lint/Docs for the multi question in one original AskUserQuestion.
The unchanged production hook preserves the questions and returns `updatedInput`; actual
PostToolUse, Stop and final PTY output match. Private
`nodeterm-new-phone-fixture-0_hyrpew/home/qa-project/real-cli-a106-c6340613/proof-interactive-v2/result.json`
hashes to `f2af01489636c723713e269917acd77ee6954690b8ee84998d2c628762af1dff`.
The owned interactive provider is explicitly stopped/reaped after completion, not a natural exit.
Independent `a106-physical-independent-review-zudb36tm/review.json`, SHA-256
`c29c103b952fafa285a92a8519682c53f9ab213a9fe40560fa1990c2d2640d01`, checks 79 source/evidence
bindings and the byte-exact original ticket, hook reply and final summary. This two-question case
uses no question scrolling; the wider question/layout matrix remains open.

After force-stop/reopen, the saved profile connects and lists both original projects without
repinning (`beta19-live-inbox-ui-wake-0h__gp4s/receipts/after-app-restart.xml` and
`saved-profile-reconnected.xml`). A fresh second host on the same owned reverse/high port presents
another key; the phone shows both original and new fingerprints and refuses before authentication,
although its public key is authorized. `nodeterm-new-phone-fixture-0_hyrpew/proof/root-changed-key-result.json`
hashes to `8155b352d125c8df32e416f80fe7d3812743370e8df9cc2f4fc5aad4050b25ec`; the paired
`changed-key-refused.xml` and bounded sshd log show zero accepted phone authentication. This is
manual direct-SSH pin enforcement, not QR/relay fallback or DHCP refresh. Both owned fixtures
retire cleanly; the final stop proves the nonce, seven owned process births/namespace gone, closed
listeners, removed private auth, and unchanged 22 runtime pins/136 outputs. Private
`nodeterm-new-phone-fixture-0_hyrpew/proof/root-final-cleanup-review.json` hashes to
`a98cdddaf3c432021929cc9f1b34d53cc60e23d322137a49988f07d03d1f7732`. Normal Forget removes
only the QA profile; the exact phone public line and owned reverse are removed while preserving
unrelated authorization/routes, and the original 15000-ms timeout is restored. Private
`beta19-live-inbox-ui-wake-0h__gp4s/receipts/root-final-phone-cleanup.json` hashes to
`3ec41e0ef942075bc0b5c08eb4a678c6dc9628ca0f382c3a4444539ac49c4d13`. Publication requires fresh
exact-revision offline gates and all five jobs/ten critical CI steps, retained in private publication
receipts; the existing beta 19 APK stays installed.

**Earlier fresh direct-SSH admission.** Beta 19's normal Add SSH server screen displays the same public
key as the pre-beta-17 admission: SHA-256
`24fa408ccdbd50a77ae9328cdf2f8a247c4661370b50517c1993ed756c3dbcad` of the displayed line.
A new temporary profile uses `qa@127.0.0.1:29453` and the explicit
`/home/mgysin/.config/nodeterm-new-phone-fixture` folder. Its successful Add SSH screen shows
the first host-key pin `SHA256:cKHWVYY2dvG+/iYairy/ZWCLnjqu8PsHOj81i2dWT44`, matching the fresh
owned Linux fixture's ready receipt. This is physical Pixel 7a SSH authentication through an
owned ADB reverse tunnel, not LAN, cellular, QR, relay or changed-host-key enforcement. No old
saved profile/pin is reused; notification behavior and A129 native/session-host history or A130
held Live-touch behavior remain unverified.

The fixture is prepared through the ordinary Desktop renderer factory and public preload API:
one original local project and two normal Terminal UI creations retain their original pane
owners and full capture bytes across a normal reload. The shell's capture contains all 1800
sequential markers; these are setup observations. The separate physical checks and exact owned
cleanup below have their own raw evidence. Private setup proofs are:

- `beta19-pixel7a-ui-v2-pzsxl_p5/receipts/beta19-connected.xml`, SHA-256
  `5486fbca471c85178ff60cecd8c542689e495ea211d21cc7369f3db7083f031d`.
- `nodeterm-new-phone-fixture-0z36dob3/proof/root-phone-key-admission.json`, SHA-256
  `eb2594e7c2b1beef65511a1dd611b04932d91af22cacaf8e069712facad72fb4`; the prior public identity is
  bound by `nodeterm-new-phone-fixture-q5v1nuem/proof/physical-pixel7a-beta17/01-public-key-admission.json`,
  SHA-256 `457b3812c895fc12aa038ba4135f59bfcc5734ee49d1d5e519e44f5fabef9c9f`.
- `nodeterm-new-phone-fixture-0z36dob3/proof/cdp-1791372226890-323869-result.json`, SHA-256
  `462d35c846911a0c5267179264d56d9d35a5fe2205c7cdb7ee81119aad55e05a`, and its post-reload
  `cdp-1791372268631-334926-result.json`, SHA-256
  `d855b36fa4cefeb7247f8fdd1fc1798285ba6ae9888f0387eeadd838b440358b`.
- Independent read-only setup/source review
  `beta19-cdp-setup-independent-bvt63heg/independent-review.json`, SHA-256
  `c243e7170fb5872ccbb181701e5e4af3e3c4813038aa951b5c2e0566f4dc7ab2`.

**Bounded beta-19 Pixel 7a checks.** The original `%1` shell remains PID 460/birth `14650700`,
with server PID 379/birth `14650581`, the same private socket inode 288 and unchanged sibling
`%0` guard. At 50×43, emacs and vi copy-mode Send each executes its own witness exactly once
(counter/output line 1), cancels copy mode and retains all 1800 earlier markers. The emacs
acknowledgement clears the draft. One observed launcher/background→app resume preserves the
draft; this does not establish process-death, long-background or notification behavior.

Find returns one matching line in 1806 retained lines for the first
`BETA19_QA_e7685ad9 0000` marker while preserving the unsent draft. The separate
`beta19-pixel7a-ui-v2-pzsxl_p5/receipts/beta19-find-result.xml` receipt hashes to
`a9e9ade92de37cf6543163019a717fa930de69249e8190f4efc03c3d035301a3`.

Terminating only viewer PID 1643/birth `14692640` shows the neutral “terminal connection closed
(exit 1)” notice, disables Send at its actual clickable ancestor and retains the draft. Manual
Reattach creates viewer PID 2679/birth `14717301`, preserving the producer and the complete
byte-identical 50×43 history; sending the retained draft adds exactly one execution (emacs counter 2).
Terminating only that connection's SSH handler PID 568/birth `14660326` then automatically
reconnects through handler 3015/birth `14723893` and viewer 3079/birth `14723975`. The vi draft,
producer, guard and complete same-grid history survive; the counter stays 1 until explicit Send,
then becomes 2 and the draft clears. The listener is not signalled. Temporary viewerless geometry
is 88×24, so no same-grid history equality is claimed during that interval. The two screenshots
show ordinary tmux history moving to earlier rows; they do not exercise A129's inert native history,
A130's held Live button, FPS or momentum.

Normal Forget removes only the temporary QA profile. Cleanup removes one exact phone public-key
line from each of the two owned fixture homes while preserving all other authorization bytes;
the owned `tcp:29453` reverse route is removed and the original screen timeout `600000` is restored.
The current `0z36dob3` fixture stops through its nonce-validated supervisor: app/server exit, all six
owned generations retire, both listeners close and generated private authentication is removed.
All 21 runtime pins and 136 built outputs are independently rehashed unchanged. This is controlled
owned cleanup, not ordinary app Quit or a new managed End test.

The independent measured record `beta19-bounded-physical-review-sqflgg52/measured-cases.json`
binds 74 raw files, SHA-256 `20d4e29ae1e07609c5b3df96db3e2a0a1100614cb9cf157ae7b9b1e454cbc9e1`.
It includes the separate UI, native counter/history, signal and cleanup records. Actual current-host
`nodeterm-new-phone-fixture-0z36dob3/proof/runner-result.json` hashes to
`bca0f7a8e5697dc77f97fe30d3fba76b91b2e93d8b9cbc7a28ffe99d0c8a8d19`; fresh
`nodeterm-new-phone-fixture-0z36dob3/proof/agent-stop-verification.json` hashes to
`fe046dda3d77702886305694123494bbf2fbb816e4a17932c0f9da9cb4cc2db4` and binds this host's stop request,
nonce, process generations and unchanged outputs. The deterministic successful runner result also
matches the prior fixture's content hash; the current path/generation is separately verified.
At that earlier checkpoint, these Linux/direct-SSH observations left live A105/A106 and changed-key
acceptance open alongside A129/A130 native app behavior, held Send races and the full device matrix.

Normal existing Claude authorization succeeds for **one bounded tool-free inference** in
**3.865 seconds**, costing **$0.002988**. It copies no credentials, invokes no tool and verifies
neither held remembered-rule application (`A105`) nor full-question application (`A106`).
Their historical HTTP-401 attempts remain separate; this request establishes usable inference
for the measured normal route only. Receipt
`claude-provider-probe-proposal-6tr5n7o6/normal-auth-plan-v2/execution-record.json`, SHA-256
`ec5c129e4d69446fb828099a8b4bf82160ba4105e7168d31e98c4ada6363fe5d`;
its execution manifest hashes to `c41b2bbe5b75fbf8d23c592a043abbb1280058ecbb8cb19b30e13953d12bfb86`.
The same reviewed sibling namespace/auth route separately passes a tool-free inference in
**3.392 seconds / $0.00285**; `claude-sibling-auth-probe-v2-hxhkl2h_/proof/result.json` hashes to
`5574a5f9e17b5b55602c18a583a483afd43ffeb8495052737ea7fb3c0006234f`. Safe-mode disables hooks,
so that result supplies no application acceptance.

**A105 Desktop application (2026-10-07, source `41406fef`).** Real Claude 2.1.292 runs in the
sibling namespace with genuine captured production-node routing and the unchanged managed hook.
The shipped Desktop preload consumer selects an original `localSettings` rule: nine actual hook
events, one consumed/removed PermissionRequest hold, two Bash executions without a second hold,
and the exact allow rule saved by the CLI. The **8.648-second / $0.0166058** case exits successfully
and reaps its CLI. Private `nodeterm-new-phone-fixture-h7nho19u/home/qa-project/real-cli-a105-44b6a670/proof/result.json`
hashes to `741b0f5a73522ec76bf29ebeab7a0cf43b9c2b19a47da0f022ecc0369356c228`; independent
`nodeterm-new-phone-fixture-h7nho19u/proof/root-a105-application-review.json` hashes to
`ee9e1fd9dc3fc191b1d6ede108347252d29265dc4222143bb7d4a60f97c6d434`. At that earlier checkpoint, no phone input or production-pane-child
launch was claimed; Android remembered-rule acceptance, A106, cross-process persistence and the
wider matrix remained pending; the original **10 Pass / 22 Partial / 32 Pending** ledger is unchanged.

The newly created API-30 emulator initially boots with measured root capability in **34.28 seconds**.
Its separate provisioning fails: the first public CA write meets a read-only system, then the
single authorized guest reboot never reaches a changed boot ID/live ADB within its 300-second
observation. One subsequent serial-scoped private reconnect also stays offline for 60 seconds.
The owned console responds with “virtual device is running”; its one official framebuffer
request times out after 10 seconds and produces no PNG. One bounded read-only GDB stack capture
then detaches explicitly, with the same QEMU non-stopped and `TracerPid=0`; the waiting renderer
threads and stripped frames do not establish a conclusive cause. No app launch, installed APK,
CA trust, TLS/relay or A129 app acceptance is established. All work targets this disposable
emulator's private ADB port 5039, separate from the physical phone.

Private raw proofs (under `/home/mgysin/.cache/nodeterm-android-work/`) are:

- Initial `a129-disposable-emulator-h4w8ds5l/proof/ready.json`, SHA-256
  `887fec47bfede3bf28c578c839de9bf78d15b9c886630a009e12f3facfee2b22`.
- First CA-write refusal `a129-disposable-provision-fjf7ufxt/proof/provision-result.json`, SHA-256
  `325009b480e3c259997a85e50004820e05c7838a75d7bd869a170f2767cb8f12`.
- `a129-disposable-provision-fp5wo6vy/proof/provision-result.json`, SHA-256
  `a07b93803acb47ed275393c96f320e8ca8c407ad99d897d7b81e1ef50a5c80ef`.
- `a129-scoped-reconnect-ti7n8bs3/proof/result.json`, SHA-256
  `5efebbbf3ddee482533835e9a0671d473ce9d02bbe2064fb65506f467b8a3c5c`.
- `a129-owned-console-diagnostic-gqwvmz78/console-screenshot-result.json`, SHA-256
  `a61411a50f2574c837a1ca23cb6e4ecaf361c24ebb289d92fe7da54ebcfd35fb`.
- `a129-owned-qemu-backtrace-2_iu1f5z/result.json`, SHA-256
  `00ae08c3b6da28bb394ad5bc793763a16534ac9deef96984ee93b727d530782b`;
  its raw `backtrace.stdout.txt` hashes to
  `5b4d5f68467d46c7acaabc3a05ac62039703e5711351171b378406a5075a95bc`.
- `a129-disposable-emulator-h4w8ds5l/proof/stop-result.json`, SHA-256
  `152926cb678b069e1409796951bf65f29d333a0b55cfce90c90d25d083df2d9a`.

The exact owned supervisor is retired, both child processes are reaped and all owned ports close;
pristine cached images and existing AVD metadata remain unchanged. No stopped fixture is reused.
This failed disposable calibration leaves the original 64-item **10 Pass / 22 Partial /
32 Pending** ledger unchanged. Next work is fresh A129/A130 native app/phone acceptance and the
remaining lifecycle/notification/hosted-backend obligations; it is
not another blind emulator reboot or reconnect. Regular Desktop deployment and a PR remain separate.

<a id="native-history-scrolling"></a>

### Native history scrolling implementation (A129)

At `ce1121ba`, actual Kotlin relay calls through the approved E2EE host handler reproduce
foreground wheel writes on native/session-host backends with mouse reporting off. Up three and
down two notches produce five SGR wheel writes at explicit byte-recorder boundaries while
retained history remains available. The real native emulators and session-host/client are
exercised, with a component host PTY adapter; this is not full Desktop, WebView gesture, kernel
PTY, physical ConPTY or phone proof. Receipt: `/tmp/nodeterm-native-scroll-triage-ylpvdie0/receipt.json`,
SHA-256 `c5d50310e539ad02d1c825ac12d19865b4c488184d1d50a8c809aad44b7cbb1a`.
The finding above remains historical. [A129 is source-fixed](android-audit-2026-09.md#a129) in
`0818bbed` and `2d693263`, published with the passing mandatory gates and exact-head CI at
`1add0408`. Actual app/WebView and physical acceptance remain unverified. `pty.attach`
advertises `scrollV1:true` only when the host serves the safe route. `pty.scrollV1 {streamId, dir:"up"|"down", lines:1..20, viewId?}` returns
`{status:"history", viewId, offset, totalRows, cols, rows, olderTruncated, hasOlder, hasNewer}`,
`{status:"input"}`, or `{status:"refused"|"uncertain", message}`. Each row has printable `text`,
`isWrapped` and `section:"normal"|"alternate"`; it is data, never bytes to feed to the terminal.
Three physical rows move per notch. The exact stream owns one immutable capture bounded to
**1 MiB / 8192 rows**, including pre-attach normal history and the current alternate screen;
pages are bounded to **256 KiB / 200 rows**. All viewers share a **16 MiB** budget, each view
expires after **60 seconds** without activity, and the per-stream FIFO admits at most **32**
pending scroll actions. Expired/foreign tokens refuse rather than adopting another capture.

A valid `viewId` pages only those stored rows, even if the live application changes its mouse
mode. Live, actual user input, resize and explicit new intent invalidate the client token;
a new intent omits `viewId`. On that new intent, the actual headless xterm **6.0.0** tracking
and encoding are read behind queued output/geometry. Mouse-off native history writes zero PTY
bytes; requested default, SGR and pixel mouse encodings use the actual encoder, or a named
refusal when state is unavailable. Session-host `scroll-view-v1` independently negotiates
`scrollViewV1 {name, generation, up, lines, capture}` with the original subscribed socket and
exact session generation. Direct native and tmux paths bind the captured live viewer.
A mixed operation can write mouse input, so lost receipts stay uncertain with no replay or
generic name-only fallback. Known tmux and direct-SSH
wheel, copy-mode, gesture and momentum semantics keep their earlier provenance.

Android keeps the shipped renderer xterm **5.5** parsing live output; history is a separate
inert display. Actor, page and display epochs reject late pages after input, resize, Live or
lifecycle changes. Automatic terminal reports remain ordered live input without discarding the
history view. Copy and link actions read the rows currently displayed. Host, Android and
actual producer interop are part of the same change; iOS adoption of the additive capability,
pages and invalidation policy is owed to **@eneskirca**.

The leaf/backend checks above do not prove
physical ConPTY, kernel PTY acceptance, full Desktop/WebView interaction or phone acceptance.
The revised-policy root proof above has 13 passing control/restored tests and 18 assertion-caught
mutations. Focused Android control/restored runs pass 99 methods/11 suites; its 14 variants are
13 behavioral mutations and one posted-Runnable source pin. Separate CI-reader checks pass
11 methods and catch eight configuration-input deletions. Android proof index
`a129-android-proof-l9kmrcc0/index.json` has SHA-256
`4ceeaacb141c1fc218644676d4287c15ed325f5d0b29a98fbea3fd36629242af`, binding receipt SHA-256
`40d857136369dc851bcd510dbc719fe01339324ed9600bea3652d31914040494`. The CI-reader index
`a129-android-ci8-proof-p6uyz7nw/index.json` has SHA-256
`f39a53b7b4f37135f923a5019660feade9701d82addbbfebb34fb3d5b82a11fd`, binding receipt SHA-256
`749ea7fcb73f29b59120753b4c1c4a0f9efc071ce5c920ca9dbc933f5e799c2c`. The separate fixture-cleanup
receipt `a129-fixture-cleanup-proof-4ev5ts54/final-result.json` has SHA-256
`a45cf3c36858b038978425a6a70af0f865a546cc0847b258361238c2177f4deb` and passes one control/restored
test plus one assertion-caught mutant. These separate scopes receive no combined mutation total.
Published `1add0408` passes the fresh 1012/105 protocol, offline app, 568/52 affected Vitest
(exactly four existing Windows process-tree skips), full TypeScript and all-five/ten-step
Android CI `37602046133` checks. At that earlier checkpoint, signed beta 18/code 19 was ready
and not installed on the intended phone; installed beta 17 and the physical checklist were unchanged.
[A130](android-audit-2026-09.md#a130) separately records the historical held Live-button
failure and focused source fix; neither source-level proof is actual WebView acceptance.

### Composed Send backend follow-up (2026-10-07, A128)

`PtyManager.submitComposed` routes an attached local stream to its tmux receipt, captured
`NativeWindowsPane`, or captured `SessionHostPty`. The outer `pty.submitComposed` wire contract
and Android completion policy remain unchanged. SSH-project relay input still refuses this
operation; direct Unix SSH retains its separately attested tmux path.

Session-host protocol v2 adds the independently negotiated `composed-input-v1` feature and
`prepareComposedV1`, `writeComposedV1`, `cancelComposedV1` requests. Preparation mints a
single-use ticket bound to the live `HostSession` generation and actually subscribed socket.
It expires after 10 seconds. A lock spans paste and its later Enter across all subscribers.
The actual emulator's output barrier determines bracketed paste mode; the host rechecks the
same live generation, subscriber and ticket before each native write. Both client and host
enforce the 150 ms minimum. Cancellation, expiry and detach consume the ticket without input.

The client captures the original subscriber registration, session generation and transport.
It checks them inside the actual deferred send turn, including a provably unwritten retry.
A ticket cannot be redeemed over a replacement socket. After a paste frame may have been sent,
missing receipts and RPC exceptions are uncertain, including server errors; they never authorize
a replay or an Enter on a replacement. Only a structured before-write refusal is a refusal.
Busy/stale/failed-attachment messages describe the current action; only an absent negotiated
feature tells the user to update the computer. An older running host retains its sessions and
refuses the new operation without a forced restart or name-only input fallback.

The direct native Windows adapter uses the same ticketed writer with its captured PTY lifetime
and actual emulator barrier. This is explicit terminal input, separate from agent-message
process attestation and observed-screen submission. Raw keyboard/report/wheel semantics remain
unchanged. A positive receipt means submission through the owned terminal API, not application
execution. The timing bound is between native write calls; ConPTY can queue/coalesce writes,
so this source result does not prove Windows kernel delivery spacing under backpressure.

The independently reviewed frozen candidate passes **181 affected Vitest tests / 17 files**,
full TypeScript and **19 focused actual Gradle methods**: five composed relay methods (including
the two actual backend producers), one executable CI-registration reader and 13 workflow-path
checks. **26 distinct mutations fail assertions**. The 21 initial semantic variants have 47-test
control/restored runs; the final disconnected-capability guard adds one catch with 48-test
control/restored runs, with the exact single production-line delta checked. Four deletions of
the newly required CI registrations fail the actual compiled reader, with control/restored passes.
Failed infrastructure/startup attempts are excluded. The separate final Linux kernel-PTY proof
binds the actual backend/client/socket and records complete framed/plain bytes, one raw Ctrl,
151.038 ms between native writes and 150.844 ms between the corresponding kernel reads in its
measured case, plus no Enter/replay after retirement. These are bounded component results.

Durable private evidence: `/home/mgysin/.cache/nodeterm-android-work/a128-alt-backends-evidence-ic6w1072/archive.json`,
SHA-256 `60bf42315e6b945e27f7b04c57ae5f58205bac2606ab94729c57895a99ca4cca`;
its 91 byte-identical archived evidence files and 21 source files retain the original aggregate
`0a10d94e817caf932588d6400f031553c72daccb7d901139a46dd9212a75cfc7`
and exact patch `4bdf58a3ad0d24da1a45be84dc96c2a3e37416ffb0aafb2c0ca2d497714996c6`.
Mandatory merged full protocol/app and affected Desktop gates are run for publication;
exact-head CI is checked after every push.
The actual producer-to-Kotlin tests use the production backend/client/emulator and encrypted
relay with an explicitly labeled native byte recorder. A separate genuine Linux kernel-PTY and
session-host/socket proof covers delivery. Neither substitutes for physical Windows ConPTY or
phone acceptance. Remaining device checks include lifecycle, held/lost acknowledgements,
changed host keys, notification actions/permissions and usable live-provider authorization.
The original 10 Pass / 22 Partial / 32 Pending ledger stays unchanged. iOS **@eneskirca** can
adopt the additional availability with the same public action/result and retention rules.

### Pixel 7a beta 17 upgrade and composed Send (2026-10-06)

This is a completed, bounded nine-case repaired-device checkpoint. The intended Pixel 7a runs
Android 17/API 37 and Vanadium `154.0.8037.126.0`. The fresh isolated Desktop and installed
`0.1.0-beta.17` / code `18` use signed source
`a79375c3e87a6294ac04de3b94bc11ec15afb6f5`; no regular Desktop or original workspace is changed.

Exact merged full forced offline checks execute **982 methods / 102 suites**, with zero
failures/errors/skips; offline app Kotlin, **187 affected Vitest tests / 11 files** and full
TypeScript pass. [Android run `37523703627`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37523703627)
passes all five jobs and ten critical steps for that exact head. The beta-17 APK SHA-256 is
`c51433d4d52d85a5a81a539dbeeb2140745ececc01543577a7681f3d6921adb1`;
the retained signer certificate SHA-256 is
`c610c3a0b637a8005b6fd858587e8cbf5260622648bc1cd97c0de0ab5f146dbd`.
Actual signing/verification tools are SDK 36; SDK 37 tools are unavailable, so no current
SDK-37 artifact verification is claimed.

The explicit same-signer `adb install -r` update takes **5.48 seconds**. The installed public
APK pull exactly matches the prepared hash; version code rises from 17 to 18 and the
first-install time is unchanged. The saved temporary SSH profile reconnects to the correct
Sessions after update without a pin edit or public-key readmission. This verifies that one
Pixel 7a profile/update path, not the paused original Pixel 10 Pro's paired migration matrix.
The Settings public-identity fingerprint matches the pre-update public key; no Keystore/private
key extraction is used. Pin reuse is established practically by this saved connection, not by
a changed-host-key enforcement test.

**A128 emacs case passes:** one explicit Send from tmux copy mode reaches the original pane
exactly once by native counter/output; copy mode exits and original producer and sibling guard
remain unchanged. The native emacs mode observation precedes draft entry; the vi case below
samples active copy mode immediately before Send. **A127 viewer-only case passes:** only viewer PID 1276/birth 9267123 is
terminated, producing the neutral exit-1 connection notice with Send disabled and draft retained.
Manual Reattach creates viewer PID 2129/birth 9288801 onto the same producer PID 1127/birth
9266970; the entire native `50x40` capture is unchanged. The retained draft then submits once.
Viewer termination is separate from SSH transport loss or producer death.

**A128 vi transport/Send case passes:** the captured phone SSH handler is interrupted while
only the owned SSH listener is paused for 15 seconds and then resumed. The disconnected UI
retains the draft and disables Send. Automatic reconnect creates viewer PID 2597/birth 9299680,
retaining the same producer/guard and byte-identical complete `50x40` native capture. Copy mode
remains active; its scroll position changes from 70 to 31, so exact position preservation is not
claimed. One explicit Send then exits copy mode, increments the native counter once, produces
one output line and retains all 1800 markers while clearing the UI draft.

**Raw Ctrl case passes:** with Ctrl armed and `c` entered, one Send reaches an owned raw TTY
consumer as exactly hex `03`; a bounded 0.8-second extra-byte window observes no framing,
Enter or other bytes. The UI clears/unarms. This does not establish other control combinations
or agent behavior.

**Managed shell and exact owned SSH End pass:** actual shell-radio selection and Start create
and register the target plain shell through the phone. End later removes only its pane `%1`,
producer and viewer clients while the sibling guard `%0` retains its exact identity/history.
The canvas node remains, as the SSH End flow describes; this does not prove relay canvas removal.

**Cleanup passes:** only the temporary profile is forgotten through app UI. The exact admitted
public-key line is removed, restoring the fixture's original authorization file. The owned
nonce-validated intentional host stop reports app/server exit, unchanged source/tool/build
bindings, removed generated private authentication and both owned listeners closed. This is
controlled supervisor cleanup, not ordinary native Quit. The phone returns to Computers with
beta 17 installed and its public identity unchanged; the regular Desktop/original workspace
and other user terminals remain untouched.

The frozen owner-only physical receipt is
`nodeterm-new-phone-fixture-q5v1nuem/proof/physical-pixel7a-beta17/qa-report.json` in the Android
work cache, SHA-256
`ece4fa48d31fab55a9f5158f475b4415e9c116c8a2f1683ec48295bf42e55e6b`,
binding **303 raw-artifact hashes / nine bounded Pass cases**. Earlier helper refusals and an
intermediate overlapping vi preparation remain separate from the final pinned vi case; neither
is a new product finding. The preceding beta-16 negatives and cleanup remain historical below.

Independent read-only review verifies all 303 raw hashes, 2480 source inputs, 136 compiled
Desktop artifacts and the scoped device/cleanup results without material findings. Its separate
receipt is `beta17-independent-physical-review-nvw2zkih/review.json`, SHA-256
`8f2ad01eefe57449498dd9d789d1818d037408f3a827c4a9d03a8d30127a106b`.

Changed-host-key enforcement, deterministic held-receipt edit/rearm/stale-completion races,
uncertain-ack retention, discriminating phone paste/Enter timing and wider Compose/WebView/provider
cases still need their own physical acceptance where admitted; existing isolated source/native
tests remain separate. No full 64-item checklist, live-provider question/approval/notification,
relay/QR/cellular, real PAM, host reboot/power loss, macOS/Windows or SDK-37 artifact acceptance
is claimed. The original **10 Pass / 22 Partial / 32 Pending** ledger is unchanged. A25/A93 still
need hosted-backend source. Later docs-only publication gates/CI are distinct from this installed
`a79375c3` APK/runtime; each published head owes its own checks and private receipt.

### Composed Send source checkpoint (2026-10-06, A128)

`7e7d2c04` fixes the physically reproduced beta-16 input loss; `5484ab9f` registers its four
host suites in private-beta CI. The input bar awaits an explicit submission through the captured
viewer's input actor. It stops JavaScript momentum, discards unsent scrolling and waits behind
the reserved in-flight scroll. The host cancels history mode only on the exact captured
viewer/pane generation. Nonempty paste uses tmux-owned bracketed framing; Enter is a separate
write after 150 ms, with a fresh identity/lifetime guard. Any failure after paste is uncertain.
Ctrl submits one raw control byte without framing or Enter. Payloads use private stdin/buffers.

One-shot completion clears the draft only after a delivered receipt for the same current viewer
and unchanged draft revision; editing away and back to identical text preserves the new draft.
A newly rearmed Ctrl is preserved. Refused, uncertain and stale outcomes retain input without
replay. Synchronous WebView preparation failure also retains the draft. Delivery means input
submitted to the attested pane/PTY, not proof that its application executed the command.
At that source checkpoint, direct Unix SSH and local-tmux relay hosts support this operation;
legacy/unverifiable, native Windows/session-host and SSH-project relay routes explicitly refuse it.
The [2026-10-07 follow-up](#composed-send-backend-follow-up-2026-10-07-a128) adds the two local PTY backends.

The frozen candidate passes **170 distinct affected Kotlin methods / 8 suites**, **187 affected
Vitest tests / 11 files**, full TypeScript and forced offline app compilation. **26 isolated
source mutations** fail assertions, with passing controls/restored runs: 17 Android
transport/preparation/completion mutations and nine host mutations. Actual private native
SSH/tmux fixtures cover emacs/vi copy mode, exact-pane/control input, separately timed Enter,
retirement and uncertainty; the restored host control passes 42 tests including 11 native cases.
The CI registration follow-up passes **nine actual Gradle/JUnit configuration methods**;
deleting each of the four new host registrations fails an assertion, with control/restored runs
passing. This gives **30 assertion-caught mutations** across source and CI registration.

Private aggregate V2: `a128-composed-submit-candidate-elbunqup/a128-composed-review-v2.json`
under `/home/mgysin/.cache/nodeterm-android-work`, SHA-256
`34a0044207b64b5627f0a8653a9969234430a51b697d8ef589220f9e9a26b68f`.
CI registration proof: `/home/mgysin/.cache/nodeterm-android-work/a128-ci-coverage-tzs459s8/proof/receipt.json`,
SHA-256 `6f5b956e6c4ff2d9c0f8a6c070ba429b1cfe8c1175852c56bf30be159c5720f9`.
Independent read-only source/evidence review finds no material issues. These source,
configuration and isolated native-fixture results remain distinct from the subsequent
[beta-17 checkpoint](#pixel-7a-beta-17-upgrade-and-composed-send-2026-10-06): merged 982/102 protocol and app
and affected Desktop gates pass, exact-head CI is green and beta 17 is installed. The single
emacs/vi composed-Send, controlled vi transport recovery, raw Ctrl and A127 viewer-close/
manual-Reattach device cases and exact owned End/cleanup pass. Broader physical/provider cases
remain pending. The original
**10 Pass / 22 Partial / 32 Pending** ledger is unchanged.

### Pixel 7a lifecycle, scroll and input follow-up (2026-10-06)

The intended Pixel 7a runs the retained-signer, non-debuggable beta 16/code 17 from `2723845e`:
APK SHA-256 `9c5309c8cfb225daf59f7fac70be1760fb0abdaac36cb55005b958f2186c8ce3`.
Android 17/API 37 and Vanadium `154.0.8037.126.0` are observed device facts. The cached Desktop
build is `59e4c93e`; `6c570d6a` changes only four documents. Android production behavior is
equivalent to that checkpoint except for a class comment. This is baseline verification,
not a phone pass for A127/A128.

Manual high-port SSH with an explicit private profile and a compared host fingerprint works
with Remote access off. Actual videos capture Creating before Back and Home; each produces
exactly one registered plain shell in the selected local folder. Reopen and a real background
app-process kill/restart retain the saved SSH profile and original pane/cwd. Both original and
new shells remain distinguishable by their native pane/process generations.

Custom wheel bindings `-N7` are observed in both emacs and vi copy tables. Held older-history
drags move repeatedly before finger lift; a free flick continues from native position 784 to
1029 after the ADB swipe returns. A new touch supplies a bounded stable interval below the
history boundary; release can reposition the cursor. Native samples are aligned to ADB command
bounds, not MotionEvent timestamps. These checks establish neither FPS nor instantaneous stop,
the wider reversal/gesture matrix, or restoration of the original bindings: that pre-read
failed, and all modified options disappear with the disposable fixture.

Dropping only the phone's owned SSH handler disables Send and preserves its draft while the
app automatically reattaches to the same shell with all 1800 generated history lines retained.
Find sees an offscreen original marker among 1805 retained lines. SSH End removes only the
owned Home shell; the guard and other shell survive, and canvas nodes remain as the SSH dialog
describes. This does not verify relay canvas End.

Two physical failures become [A127](android-audit-2026-09.md#a127) and
[A128](android-audit-2026-09.md#a128). Terminating only the viewer reports exit 1 as session death
despite the live producer and retained history. Composed Send in history mode clears the draft
without a command/marker, both after vi-mode reconnect and on a healthy emacs-mode connection.
Automatic transport recovery passes; composed command delivery in these cases fails.

A127 is source-fixed in `0d50075a`: every numeric viewer exit now describes the closed terminal
connection. Retry conditions, budget, generation checks and Reattach remain unchanged. Three
JVM methods, offline app compilation and twelve compiled actual-callback cases pass; three
isolated mutants fail assertions, with passing control/restored runs. The callback fixture uses
immediate Handler, viewer-slot and retry-admission fakes, not Android lifecycle or native liveness.
A128 is now source-fixed in `7e7d2c04`, with CI registration in `5484ab9f`; the
[source checkpoint](#composed-send-source-checkpoint-2026-10-06-a128) records its separate checks.
At this beta-16 baseline checkpoint neither source fix had an updated-APK physical pass;
the separate beta-17 checkpoint above records the later bounded repaired-device cases.

The temporary phone profile and its displayed public-key admission were removed. The exact
owned fixture exits successfully with generated private authentication removed and both
listeners closed. Its controlled nonce stop uses SIGTERM for app/server cleanup; ordinary
app Quit is not verified. No regular Desktop, other terminal or phone identity was changed.
The original Pixel 10 Pro ledger stays **10 Pass / 22 Partial / 32 Pending**. Relay/QR/cellular,
provider-authenticated launch, notification/permission paths, phone reboot and wider platforms
still need their own acceptance.

Private physical receipt: `nodeterm-new-phone-fixture-ise429xt/proof/physical-pixel7a-w1gr_uz5/qa-report.json`
under the owner-only Android work cache, SHA-256
`dfce110a6c2fb9d4ed8497bfc2ac6bf59311766a7bc36b866ace1d0dcb2d8408`, binding 125 raw artifacts.
Its `sdk37ApksignerVerified` field lacks current SDK 37 tool/log provenance and is not relied
upon. A separate correction preserves that frozen report and records the actual current SDK 36
v2/v3, single retained-signer verification:
`pixel7a-signature-provenance-correction-ox2gec9p/correction.json`, SHA-256
`374244d6b231f1bcd0932515010215bd8683d1a6795b3528aa18522883977fde`.
A127's private proof receipt is `/tmp/nodeterm-a127-proof.json`, SHA-256
`75069aa576ae694cd1b7b8248a9b81c2364882eb37a00d1ccabb93157bf49f67`.

A125 is source-fixed in `415dae9b`; A126 is committed in `5b7286b3`.
Eight actual Linux Desktop **Canvas/Modal × soft/hard wraps × inner none/SGR mouse** cases
pass at `5b7286b3`. Each loses one birth-pinned product ControlMaster, creates a new master/
selected local viewer and retains its remote pane/server/producer/cwd and complete same-grid history before,
during, after and at final observation. Both trusted actual textarea `g` inputs are acknowledged
on the old/new PTY: **16 ACKs**, **zero unexpected bytes**, one producer paint per case and
**16 complete URL activations**. Native hover/leave and exact owned cleanup pass. Modal cases
use `80x24`; Canvas cases use `49x48`, with each history comparison bound to its own grid/case.
The historical `11e22453` stale-Modal negative and first `415dae9b` control retain their original
provenance. The latter creates replacement viewers but records 18 unexpected DA1/DA2 bytes after
ACK 1; ACK 2 is not attempted. Its unclassified wrapper/runtime exits 1/2 remain separate from the
later A126 diagnosis. Those failed controls are not rewritten as repaired-source positives.
**294 unique affected tests / 17 files** and full incremental TypeScript pass. **15 isolated
mutants (six A125 + nine A126)** are caught by assertions; each fix's control/restored runs pass.
Forced offline checks at `5b7286b3` execute **950 tests / 98 suites**, zero failures/errors/skips,
and both protocol/app Kotlin compile tasks. These are disposable QA hosts; no new APK or regular
Desktop installation is included. Publication requires fresh offline gates and all five Android
CI jobs for the exact published HEAD; its private bundle and final report carry that run's result.
See [the reconnect notes](#desktop-card-reconnect-repair-2026-10-06) and
[audit A126](android-audit-2026-09.md#a126) for receipt hashes and the remaining scope.
Actual Canvas mounting and selected-view native keyboard recovery pass in the eight-case matrix;
one additional two-host soft/none case verifies a quiet park/adopt cycle and inactive global-card
recovery with the active host unchanged. See [the bounded two-host follow-up](#inactive-global-card-owner-and-bounded-parkadopt-2026-10-06). Remaining Android release acceptance needs a
reachable intended phone for lifecycle/outage, answer/notification/permission and live-provider
checks; A25/A93 need hosted-backend maintainers. Further host coverage includes streaming/expiry/
eviction while parked, repeated or broader outage/backoff, Server/cross-window response ownership,
GPU pressure/full-frame display output and macOS/Windows. The synthetic key-only hosts do not
establish real-user PAM, power-loss, agent-launch or ordinary Quit behavior. Unsupported private
xterm shapes warn and retain input but may duplicate replies; legacy onBinary is unchanged.
No Android wire/file or iOS client change is required. The original Pixel 10 Pro ledger remains
paused at **10 Pass / 22 Partial / 32 Pending**.

### Inactive global-card owner and bounded park/adopt (2026-10-06)

One actual Linux Desktop two-host case passes at source/build
`59e4c93e5b1256e9882205700d4907a5d43a8e20`, tree
`0f4753c65b858003a0d1560c3cf278cbffb48fd0`, in **27.39 seconds**. Two distinct private OpenSSH
hosts have independent owner projects, client/host keys, remote PID namespaces and private
home/tmp mounts. The namespace setup is source-reviewed; no separate raw mount-namespace probe
is retained. Each
remote plain-shell producer paints once; both panes stay `80x24` with soft wraps and inner mouse
reporting disabled. This extends native acceptance of the existing A125/A126 repairs; it adds no
product repair, regression-test count, mutation count, APK or regular Desktop installation.

The actual B global-board card stays open through ordinary native Ctrl+K project switches
B → A → B → A. Before the outage, B's detached parked terminal and its adopted terminal preserve
the same installed xterm/core, input/focus wrappers, ordered subscriptions and API binding, quiet
whole renderer buffer, native SSH client/master and remote history. Its SID provenance is the
actual primary create and acknowledged native Canvas `g1`, plus the carried original writer and
subscriptions with no create/detach/client replacement. Canvas keeps that SID in a lifecycle
closure; no current/adopted React SID ref or post-adopt Canvas-input result is claimed.

With actual A active and its Canvas mounted, inactive B's Modal receives native `g2`. One
birth-pinned B-only product ControlMaster SIGKILL then triggers automatic recovery. The same
open B card warms a fresh selected Modal viewer/session on B's new master and acknowledges native
`g3`; there is no inactive-B Canvas create or launch replay. All **3 native `g` ACKs**, **2 complete
wrapped URL activations**, hover/plain-click/Ctrl-click/leave controls, zero unexpected input and
one paint per role pass. B retains its pane/server/producer/cwd and complete same-grid history
before, during, after and at final observation. A's master/client/pane/producer/grid/history,
zero input and owner routing stay unchanged within the acceptance window. Exact owned observer,
session/master/daemon cleanup and generated-auth removal pass; explicit fixture exit supplies no
ordinary-Quit proof.

Private proof: `~/.cache/nodeterm-android-work/nodeterm-linux-ssh-global-owner-6lens2kd/proof/`.
`receipt.json` SHA `e923f8fca25e05aa9869ab3bd22e4b2444147e41621c2bf0a8ca38465ece78c3`;
`runtime-result.json` SHA `313413ea48f371b6fbc62e2d03c14af7f0b0fcd0c573110c9d18137f0da13adb`.
Root acceptance: `~/.cache/nodeterm-android-work/a125-a126-global-owner-root-mq6v7w7z/root-acceptance.json`,
SHA `7cb20c71a52dfc3bf968073170867b6e7ff199957e23a664a5ffebb5e3ab453d`.
Independent review: `~/.cache/nodeterm-android-work/ssh-global-owner-independent-review-kn_5dsw4/independent-review.json`,
SHA `7fc9ace6926a5004ee5a8c817d664fde59f8cf6d83d26a9e1ca5fa3a03cd869a`.
The exact-source full build binds **2,465 tracked inputs / 136 output artifacts**; snapshot SHA
`dc188476bfa29bdf5c71f02a20582a843cdb7a30455dfa42b748adcee939be65`, build receipt SHA
`278094c8102eed6cf5e191cbbcf4ec861b518158c810f9f3ee46ce6a0de4f377`. Source/runtime/held outputs
stay unchanged. This quiet cycle does not establish streaming while parked, expiry/eviction,
foreign-host attachments, Server/cross-window ownership, broader outage/backoff, GPU stress,
phone/provider or other-platform behavior. The paused physical ledger is unchanged.

**Fresh Pixel 7a verification and A124 (2026-10-05).** This separate phone runs Android 16 /
API 36 and Vanadium WebView `145.0.7632.120.0`. Fresh installation of private beta 16/code 17
matches APK SHA-256 `9c5309c8cfb225daf59f7fac70be1760fb0abdaac36cb55005b958f2186c8ce3`;
signature verification and the non-debuggable/run-as refusal check pass. This is fresh-install
proof, not the original Pixel 10 Pro's update/migration result.

Normal manual SSH uses an explicit profile on a disposable shared Desktop/sshd host. The
app displays the actual host fingerprint, refuses authentication before the public key is
installed, and adds/pins the host only after authentication. Reapplying the displayed public-key
installer preserves one phone key and the selfcheck key with private file modes. An existing
owned Desktop terminal receives phone input exactly once in the expected project cwd; retained
Unicode history is visible. A continuous held drag advances copy history from 10 to 135 lines;
after a flick returns, momentum advances 295 to 490. An early new touch stops at 510 while the
grid stays `50x43`; the later long-touch IME resize is recorded separately. The first wrong-direction
scroll attempt was inconclusive and receives no pass. These are bounded gesture checks, not FPS
or a complete 64-item device run. Manual high-port SSH supplies no QR, port-22, relay or cellular proof.

**Original trigger correction:** `managed-terminal-open.xml` records **New session → Start**
with default Claude still selected; tapping the nonclickable option text did not select Terminal.
The real A124 failure is shared absolute-shell validation before any agent CLI lookup. On the
repaired host, repeating the wrong-label selection correctly reports that the Claude CLI is
unavailable; that is a verifier correction, not a new finding.

With the actual shell radio selected (`repaired-shell-selected.xml`), the repaired frozen Desktop
`40731381` creates and registers `/bin/bash` node `term-muvrrd9n-623cda88cddd8ded`, pane PID **1101**.
Phone input executes exactly once in the chosen project cwd; the original node
`term-muvr91rh-12595648`, PID **368**, retains its marker and receives no managed input.
Closing/reopening the viewer succeeds. Restarting only the Android process (**9258 → 14735**),
without resetting app data or identity, reconnects the saved SSH host to the same pane and shows
the previous marker. This is one manual high-port SSH plain-shell case, not live-agent, managed
End, power-loss or QR/relay/cellular verification.

After 150 additional output lines, **Find** reports two matching lines in 155 host-retained lines.
An actual native tmux `-S 0` screen capture excludes the old marker, independently proving the
matches are offscreen; an earlier recent-output capture's misleading live-screen field is
corrected by `repaired-history-native-screen.json`. Selected-line copy pastes the exact marker
into the input draft. The local **Copy** sheet opens; its offscreen-marker query correctly returns
“No matches in captured output” because it searches its current local buffer. A public URL appears
with Open/Copy offers, and URL Copy pastes the exact URL. No external browser-open result is claimed.

Both owned QA host profiles are forgotten through the app and the phone returns to the initial
Computers/Add screen (`phone-qa-cleaned.xml`). Beta 16 remains installed and the global phone
identity is preserved; viewer detach/Forget leave both owned panes intact until fixture shutdown.
The repaired V5 host at clean `40731381` then exits successfully with graceful requested stop,
app/sshd exit, closed listeners and generated private-auth cleanup. The earlier host's negative
source-binding receipt still records the A124 edits and is not replaced by this clean-host pass.

The repair's 38 affected Vitest tests, full TypeScript and three isolated assertion-caught guard
mutations pass. The exact `40731381` offline protocol gate is **949 methods / 98 suites**, with
zero failures/errors/skips; five Windows/platform Vitest cases skip on Linux. Its frozen full
Desktop build takes 29.3 seconds. All five Android jobs pass in the first-push exact-head
[run `37375870878`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37375870878).
Physical evidence: `.nodeterm/android-pixel7a-device-y0ia4hm_/physical-repair-result.json` and its
named registration/input/restart/history/clipboard/cleanup receipts. Earlier installation, manual
SSH and gesture receipts in that directory remain separate. Source proof:
`~/.cache/nodeterm-android-work/a124-executable-mutation-lhf2f_p6/proof/`.
The original Pixel 10 Pro beta-10 ledger stays paused at **10 Pass / 22 Partial / 32 Pending**.
No wire/file contract changes; the shared host repair benefits iOS too (@eneskirca).

**Latest native follow-up (2026-10-05).** A120 passes four cancellation/deadline cases
(76 case-scoped assertions) and a separate 17-check synthetic installed-Fedora-PAM control.
See [the receipt and its limits](#native-setup-timing-installed-pam-and-remaining-desktop-checks-2026-10-05).
The later GPU-enabled eight-case terminal matrix, native File-menu Quit, outside-terminal Ctrl+Q
and one real tmux Canvas pilot pass. A122 fixes focused-terminal native Quit; its four Linux
native cases pass. Later eight-case tmux and eight-case SSH matrices, separate GPU recovery pilots
and A123 native cleanup control/mutant/restored checks pass; see [the follow-up](#tmux-ssh-and-gpu-recovery-follow-up-2026-10-05).
The later Server retirement pilot, derived Desktop compositor cell comparison and single Desktop
SSH reconnect pilot pass. Repeated/
page-wide GPU pressure, full-frame compositor/display output, broader SSH reconnect and macOS/Windows remain unverified.
These checks do not change the paused phone ledger or prepared beta-16 APK.

**Historical prepared private beta 14 (2026-10-04).** `0.1.0-beta.14` / code `15`, clean built source
`facbbd0384bb5b0ee91656f364793a12f8f41eb1`, adds A113 truthful revoke outcomes, A114 dictation language, A115 exact host/session
retirement and A116 saved pairing/LAN adapter choice. Full offline protocol checks pass
**890 tests / 92 suites**, with zero failures, errors or skips.
Offline app compilation, **1628 affected Vitest tests / 71 files** and full
TypeScript checking pass. Only the ten existing Windows/macOS runtime cases are skipped on Linux.
The minified offline release build passes in **47.96 seconds** with the retained private
signer and R8/runtime keeps. Independent SDK 36/37 signature, nondebuggable manifest, payload/
provenance and 16-KB ZIP/native checks pass.

The private archive records **158 assertion-caught isolated mutation variants**,
with passing controls/restored runs and each receipt's source bindings. One additional redundant
retired-guard variant survives equivalently and is recorded separately, never counted as caught.
Historical/intermediate bindings stay separate; full merged gates verify the release source.
Actual local HTTP and producer→Android tests use synthetic OS/key facts; HostStore tests use
in-memory Android interfaces. Native wiring source guards and cached compilation do not prove
physical recognition, VPN reachability, relay revocation or replacement behavior. Earlier beta
proof remains historical. APK SHA-256: `3c75912a5b7bb561fa9a0720be5cb11be75e1672f98379e4745871bf2729f8f6`. Artifact:
`.nodeterm/android-beta-14/nodeterm-android-0.1.0-beta.14.apk`; private proof:
`.nodeterm/android-beta-build-14/`. **Prepared, not installed:** beta 10/code 11 remains the last
confirmed Pixel installation. Phone testing is paused; the ledger stays **10 Pass / 22 Partial /
32 Pending**. No PR opened; A68 stays deferred. Each push requires its own exact-head green
Android workflow. At this APK source checkpoint A13 direct-SSH Desktop detachment, full legacy
identity association and A25/A93 hosted backend dependencies remained open. The later A13 host
follow-up below closes the coattachment source gap; its physical checks remain pending.

**Historical prepared private beta 13 (2026-10-04).** `0.1.0-beta.13` / code `14`, clean built source
`ba64f6289c0f552b85bfc17f99aee879aaf45975`, includes A111 managed SSH New and A112 producer-input coverage,
along with the beta-12 changes. Full offline protocol checks pass **845 tests / 87 suites**,
with zero failures, errors or skips. Offline app compilation, **1433 affected Vitest tests /
60 files** and full TypeScript checking pass; the ten existing Windows/macOS runtime cases
are explicitly skipped on Linux. The minified offline release build passes in **47.77
seconds** with the retained private signer and R8/runtime keeps. Independent SDK 36/37
signature, nondebuggable manifest, payload/provenance and 16-KB ZIP/native checks pass.
The new managed-creation and input-coverage regressions catch **148 isolated behavioral mutation
variants**, with passing controls/restored runs and per-receipt source hashes. Receipts distinguish
assertion failures from the named runtime contract failure; earlier beta-12 proof remains separate.
An isolated native node-pty/Electron/tmux fixture verifies host cwd/account/hooks/env/policy,
one launch submission and uncertainty fences. It uses a fixture CLI; real Claude startup,
macOS native creation and physical power-loss durability are unverified.
APK SHA-256: `faf9e508fa82355f640512ec1861ba886d0e48b8aef3e724edc6435c9f8c134b`. Artifact:
`.nodeterm/android-beta-13/nodeterm-android-0.1.0-beta.13.apk`; build and mutation proof:
`.nodeterm/android-beta-build-13/`. **Prepared, not installed:** beta 10/code 11 remains the last
confirmed Pixel installation. Phone testing is paused; **10 Pass / 22 Partial / 32 Pending**
remains the device ledger. Managed New and the other new source flows require physical checks.
Each push requires its own exact-head green Android workflow; no PR opened, and A68 stays deferred.

**Historical prepared private beta 12 (2026-10-04).** `0.1.0-beta.12` / code `13`, clean built source
`b2e41255d8b2cf7bb342b78b7f686b8b0191879e`, includes A100–A110 and the earlier beta-11 additions. Full offline protocol
checks pass **815 tests / 83 suites**, with zero failures, errors or skips.
Offline app compilation, **1314 affected Vitest tests / 53 files** and full TypeScript
checking pass. The ten existing Windows/macOS runtime cases are explicitly skipped on this Linux
host; no additional skip is accepted. The minified offline release build passes in
**52.47 seconds**, with retained private signer, R8/runtime keeps and source/hash provenance.
Independent SDK 36/37 signature, nondebuggable manifest, payload and 16-KB ZIP/native checks pass.
The private support archive retains **236 isolated mutation variants** with passing controls and
restored runs: 228 assertion cases, six named executable-contract failures and two bounded timeouts.
Historical source hashes remain attached to their own receipts; this count does not claim that
all earlier worktrees were identical to the final merged source. Full merged release gates pass.
APK SHA-256: `d5a350a1f7c6f05f1ab476f25cbe58441eb666d61d1a4b62610a3faa2e058e1f`. Artifact:
`.nodeterm/android-beta-12/nodeterm-android-0.1.0-beta.12.apk`; build and mutation proof:
`.nodeterm/android-beta-build-12/`. **Prepared, not installed:** beta 10/code 11 remains the last
confirmed Pixel installation. Phone checks are paused, with **10 Pass / 22 Partial / 32 Pending**;
live Claude rule/question application and the new physical feature matrix remain unverified.
Each requested push still needs its own exact-head green Android workflow. No PR opened; A68
remains deferred until a PR is requested.

**Historical beta-10 delivery and paired update (2026-10-04):** `0.1.0-beta.10` / code `11`,
clean snapshot `e3ce041c752bdef11b378cf301c719a6e62f70ab`, is installed on the intended Pixel with the
unchanged private signer. The actual release build passes in 52.4 seconds with all R8 keeps;
independent SDK 36/37 signature, 16-KB alignment, payload and provenance review passes.
APK SHA-256: `04ace0ea01540bb477fcf823395a299fa211cfef3745aa28674099038ceb3693`. The 10.14-second
same-signer update preserves install identity, notification grant and the owned SSH second
pane. On beta 9, genuine desktop-issued code text re-pairs the complete original owned desktop
profile and receives relay credentials; safely anchored external SSH refuses, then Automatic
falls back to the actual relay. After updating, that saved
pairing reconnects without re-pairing; the own Terminal1 opens and input reaches its real scoped
PTY. **Items 1/36/51 pass; items 35/49 remain Partial, giving current 10 Pass / 22 Partial / 32 Pending.** Debug-key update/migration
variants remain conditional SKIP on this working private installation. The same owned production
desktop profile now runs repaired build `ec12ea9a`; the original failure was on `071735d6`. Local gates pass 689 protocol tests /67 suites with zero
failures/errors/skips (86.08 seconds wall time including a new daemon), offline app compile
(6.78 seconds), 54 affected Vitest tests and full TypeScript checking. The exact built source `e3ce041c` has all five CI jobs green in [run `37194375778`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37194375778). Each later documentation push needs its own green workflow. Private artifact/proof:
`.nodeterm/android-beta-10/` and `.nodeterm/android-beta-build-10/`; the canonical paired-update receipt is `.nodeterm/android-beta-build-10/paired-update-result.json`. Broader relay/managed,
cellular and the full device checklist remain open; installed A91/A94 full focused empty-host flow passes.

**Relay creation, Rename and exact End verified; Refresh dispatch observed (2026-10-04).** On
beta 10, Sessions → New session → Terminal (shell) → Start creates and opens one actual
canvas-registered shell in the exact private project folder. Native input and pwd reach its
scoped bash pane. Rename updates the mounted desktop title without reload. Sessions Refresh
rediscovers both owned rows; the actual owned session-menu Refresh emits exactly one node-refresh
IPC, preserving pane identity and page time origin. Its repaint effect remains unverified.
Exact native End then removes only the adopted node/pane/PID birth; the original producer
terminal remains unchanged. The mounted Board also removes that card without reload.
Item 32's relay plain-shell variant passes; managed-account/cellular and other required variants
remain pending. Item 35 stays Partial for missing Wake and Refresh repaint evidence; item 36
passes actual repaired-desktop move/remove/re-add/create-label checks (A95). Earlier first-round rotation restoration is historical; final restoration remains pending. The tally is 10 Pass / 22 Partial / 32 Pending; no full release/device pass
or final fixture/service cleanup is claimed.

Native session-action proof is in the Oct4 checklist directory:
`beta10-owned-session-refresh-phone-result.json`, `beta10-relay-owned-end-phone-result.json`,
`beta10-relay-owned-end-confirmation.json` and `beta10-relay-owned-ended-sessions.json`.
The owned desktop fixture retains `beta10-session-refresh-observed.json` and
`release-qa-nodes-ended-1791111850721754129-abe6b2.json`, verifying exact IPC dispatch and
target removal with its original sibling unchanged.

**Settings visible flow passes; item 49 remains Partial (A44, 2026-10-04).** On installed beta 10,
a temporary phone name and safe HTTPS loopback API persist after actual system Back and reopen.
An invalid HTTP address shows its field error after keyboard dismissal and a visually reviewed rejection toast; reopening
retains the prior valid HTTPS value. Reset to default, system Back and reopen restores the built-in
API; the original phone name/API are then restored and verified. Unedited leave/reopen preserves
the visible values. Internal preference-key absence and absence of writes were not physically
inspected on this nondebuggable app; existing `SettingsLeaveTest` behavior/source guards cover
those rules. The strict device ledger therefore marks item 49 Partial, giving 10 Pass /
22 Partial / 32 Pending. Native proof includes `beta10-settings-phase1-result.json`,
`beta10-settings-phase2-result.json` and `beta10-settings-toast-visual-review.json` in the Oct4
checklist directory.

**Final phone cleanup and background watch remain pending (2026-10-04).** The intended Pixel's
wireless ADB endpoint is no longer reachable; its current endpoint has been requested. The guard
refused before the final phone Forget and portrait-lock restoration, so neither action is claimed.
Earlier rotation restoration belongs to the first test round; current final restoration is pending.
The isolated empty SSH service is stopped. Phone name/API and system night mode `yes` restoration
are verified. No natural-periodic background Done watch has started and no result is claimed.
The remaining phone cleanup and notification checks can continue when the correct Pixel returns.

**Phone system-theme compatibility passes (item 51, 2026-10-04).** On the installed beta 10
Pixel, Computers and Settings native screens remain readable under system dark and light modes,
including status/navigation bars; four captured PNGs have a matching visual-review receipt.
The app retains its fixed dark palette in both modes; an automatic light app palette is not claimed.
Original system night mode `yes` is restored and verified. Tablet/foldable is conditional SKIP
because neither is available. Proof: `beta10-system-theme-result.json`,
`beta10-system-theme-restored.json` and `beta10-system-theme-visual-review.json` in the Oct4 checklist
directory. Item 51 passes, giving the current 10 Pass / 22 Partial / 32 Pending ledger.

**A95 is fixed and verified on the rebuilt production desktop (2026-10-04).** The held
`071735d6` build reproduced stale mounted Board moves/labels. The same owned paired profile now
runs the repaired `ec12ea9a` production build; Android remains installed beta10/code11 (`e3ce041c`),
with no APK change for this desktop fix. Actual phone Move to Ungrouped, label removal, re-addition
and creation/application of a second blue label update both persisted state and the mounted
desktop Board without a reload. Baseline and every resulting DOM snapshot share page time origin
`1791111312961.1` and match persisted state. This completes item 36. Nine affected Vitest suites
(133 tests), full and strict acceptance TypeScript checks, and four isolated mutants also pass.
The ledger is 10 Pass / 22 Partial / 32 Pending. This verifies the owned production fixture;
no deployment to the user's regular desktop or full release/device pass is claimed.

**Fresh-desktop relay pairing refusal (A93, open; 2026-10-04).** The same Pixel identity
paired with a fresh isolated production desktop whose remote access was on, but the saved
pairing had no relay credential. A bounded retry using the exact unchanged production request body
returned HTTP 403 reauth_required. Forgetting the old fixture removed its phone-side relay
token; the new desktop has a different identity. The refusal is measured. Original
same-desktop recovery succeeds after ordinary restart of the complete original owned fixture
profile, preserving its host/device identity: genuine beta-9 re-pairing obtains relay credentials
and the beta-10 saved pairing reconnects. No backend repository was reviewed, phone identity reset
or user credentials copied. This measures one recovery case; the fresh-different-desktop failure
remains open. **iOS follow-up for @eneskirca:** verify prior-token lookup and recovery messaging
after Forget for the same persistent phone identity. No new external field is introduced here.

**Empty-host loading follow-up (A94, fixed in 3c217cba; delivered in beta 10).** On beta 9,
the otherwise-empty SSH fixture completes its listing and shows the error banner, Over SSH and
New terminal, but still says “Loading sessions…”. The initial empty snapshot's zero fetch
timestamp causes that label. The correction stamps the completed empty answer; five actual
Kotlin regression methods and eight isolated mutants pass. Full Gradle checks and beta-10
delivery and installed full focused empty-host End/recreate/open/End verification pass. No host contract changed.

**Installed A91/A94 focused empty-host cycle passes (2026-10-04).** On beta10/code11,
native End of the otherwise-empty fixture's sole owned Home shell removes its row/group and
shows “No sessions on this computer yet.” with no Loading label; Over SSH and the data-not-found
banner remain. New terminal → Home → Create opens a new actual bash pane in Home. Back to
Sessions and exact native End removes that new UUID and restores the same completed empty
screen. All three isolated host sockets are empty. Proof:
`.nodeterm/android-beta-build-9/checklist-20261004/beta10-a94-full-cycle-result.json`,
`beta10-a94-recreated-pane.json` and the matching empty-screen UI receipts. This passes the
focused A91/A94 empty-host flow; item 32 remains Partial because managed and cellular
creation remain open; the relay plain-shell variant passes. Total 10 Pass / 22 Partial / 32 Pending. Final fixture/service cleanup is
not yet claimed.

**Focused plain-SSH Pixel proof (`A90`, 2026-10-03):** beta 8/code 9 (`b88d1415`) creates
Home, discovered host-project and custom-folder shells, including spaces/apostrophe/dollar in
the custom path. Real cwd/input, 180 numbered history lines, same-pane reopen/pre-attach history,
14 drag-position changes, coast from 65 to 137 and Esc exit pass. Rapid double Create adds only
one shell; a missing folder shows an error, creates no orphan and can be corrected/retried.
Phone shells have no managed-agent environment and a 50000-line history limit. Force-stop/restart
retains all three PIDs/history and SSH rediscovery. Updating to beta 9/code 10 (`4d33a5b5`) also
retains them; reconnect and native input to the same owned pane pass. Native UI End is verified
for custom → project → Home: only Open/End actions, phone-shell confirmation, exact selected
UUID removal, sibling immutable fingerprints/PIDs unchanged, counts 3→2→1→0 and the Phone terminals
group disappearing. All eleven pre-existing desktop session IDs/pane PIDs and nine protected
project/workspace hashes are unchanged. Owned disposable shells, empty fixture folders and remote
UI dumps are removed; the Pixel is left on regular host Sessions. Proof:
`.nodeterm/android-beta-build-8/a90-pixel-check-20261003/final-focused-results.json` and
`beta9-exact-ui-end.json` in that directory. Only **item 32 becomes Partial**: relay canvas/managed
and cellular creation remain unverified; the separate `A91` otherwise-empty-host variant passes on Oct4; the
Windows variant stays conditional SKIP. This Oct3 checkpoint was **7 Pass /21 Partial /36 Pending**; later item 1/36/51 checks raise Pass to ten.
Broader device checks resumed on 2026-10-04; their new outcomes are recorded separately.

**Beta-9 delivery (2026-10-03):** private `0.1.0-beta.9` / code `10`, clean source
`4d33a5b5366c99479b648086649205350c7752b1`, built in 43 seconds and updated the exact intended
Pixel with the retained signer in 6.46 seconds. Its pulled installed APK matches SHA-256
`719cfeea1dcf27900dd35692a59004ca07e8261b3f14bd43922f0706b6b4ab54`.
Three owned phone shells created on beta 8 survived the update and were rediscovered on beta 9,
then ended through the verified exact-session cleanup above; none remain.
Independent SDK 36/37 artifact review verifies signatures/16-KB alignment, all 149 unsigned
payloads preserved after signing, four ELF alignments, expected R8/service metadata and source/hash
provenance. Installation preserves `firstInstallTime`, notification grant and app data; the
package is non-debuggable. This does not prove paired relay credentials survive. Private proof:
`.nodeterm/android-beta-build-9/artifact-review.json` and
`.nodeterm/android-beta-build-9/device-install-20261003/receipt.json`; private APK:
`.nodeterm/android-beta-9/nodeterm-android-0.1.0-beta.9.apk`.
The historical source CI [run `37144282865`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37144282865)
failed `DeviceChecklistDocsTest` because the new finding's pending device check lacked a checklist
mapping and unrelated Known gaps bullets shared one paragraph. Debug APK, release APK and CodeQL
jobs passed; private-beta packaging was skipped. This is not a green workflow receipt. The recorded
prior all-green branch was `19da35a2` / run `37140762345`; the next push must pass all its checks.
This revision maps A91 into item 32 and isolates its Known gaps paragraph. Fresh full protocol
and offline app gates must follow the frozen final documentation; the recorded 688/67 local
source baseline predates these final documentation changes. Final exact-head CI proof is retained
separately after the next push.

**`A91` empty-host stale rows are fixed in `4d33a5b5` and delivered in beta 9 (2026-10-03).** Ending the last phone-owned shell
on an otherwise empty SSH host makes browse return `NothingFoundException`. The native refresh
previously kept the ended shell's cached row. `ListingFailure.snapshot` now replaces the cached
listing with `ProjectsSnapshot.EMPTY` only for that authoritative empty answer; ordinary host or
transport failures retain it, and cancellation propagates. `ConnectionManager` preserves the
route-specific error and connected SSH state, so New terminal remains available. Four new
`ListingFailureTest` methods cover the real parsed phone row, retention, cancellation and native
wiring. The complete real Gradle protocol suite passes **688 tests / 67 suites**, zero
failures/errors/skips, in 52 seconds; offline app `compileKotlin` passes in 6 seconds. Six isolated
Kotlin 2.2/JDK 21 mutants are caught; proof is in `.nodeterm/android-beta-build-9/`.
**Physical otherwise-empty-host variant passes on beta 9 (2026-10-04).** The first Home shell
is created and opened through New terminal. Native End removes its exact row and the Phone
terminals group; SSH remains connected. New terminal remains usable and creates/opens a second
Home shell, then retained for the beta 10 update and subsequently ended in the A91/A94 flow above. No final fixture cleanup is claimed.
Proof: `.nodeterm/android-beta-build-9/checklist-20261004/a91-beta9-focused-results.json`.
The A94 false Loading label is corrected in beta 10: both installed sole-End cycles show
the completed empty label with no Loading, row or group, while SSH/error remain; Home recreation opens an actual bash pane between them. Item 32 stays Partial; item 1 separately raises the current
tally to 10 Pass / 22 Partial / 32 Pending. No RPC/blob/pairing/mirror/SSH-visible file contract changes are made.

**Historical beta-8 installation receipt (2026-10-03):** the exact intended Pixel 10 Pro / Android 17 was
confirmed before a 28.05-second same-signer `adb install -r` of `0.1.0-beta.8` / code `9`.
The pulled pre-update APK matches the known beta-6/code-7 hash; SDK 37 confirms the retained public
signer before replacement. The pulled post-update APK matches beta 8's
`d373ad5c1790f714cb4464ad4a0a38c5ba9ab68e35103e54cf3aef5ce53081ce`, built from
`b88d141528c1051964da07faf22cc7fa923c4846`. Package metadata confirms code 9/name beta 8,
non-debuggable, with `firstInstallTime` and granted `POST_NOTIFICATIONS` preserved. The app starts
and the existing manual-SSH computer remains in All computers. Opening that host connects over
SSH and lists its real driven projects; the screenshot shows **New terminal**, and own-app UI XML
confirms the FAB is enabled/clickable. No existing pane was touched and no terminal was created
or ended. This establishes host configuration/reconnect/browse survival, not desktop-issued
pairing/relay credential survival or item 32's creation/persistence/End flow. Private proof:
`.nodeterm/android-beta-build-8/device-install-20261003/receipt.json`, package/APK/certificate
checks, `sessions.png` and `ui-sessions-ready.xml`. This makes no TalkBack claim. The
7 Pass / 20 Partial / 37 Pending ledger remains unchanged.

**`A90` implementation and beta-8 host baseline.** Protocol commit
`bcc92367` and UI/model commit `b88d141528c1051964da07faf22cc7fa923c4846` implement dedicated-socket
creation, atomic metadata for interrupted-request rediscovery, frozen UUID/folder retry, live
fingerprint ownership checks and exact End. Real SSH/tmux regressions cover Home and driven folders,
hostile path quoting, renamed-folder retry, partial creation before option finalization,
reconnect/history, warm-server identity/locale cleanup, stale/foreign ownership and socket isolation;
relay interop refuses reserved phone IDs before any creating RPC. The complete protocol suite
passes **684 tests in 66 suites, zero failures/errors/skips** (48 seconds), and the offline app
`compileKotlin` passes (1 second). Eleven actual Gradle/Kotlin 2.2 protocol behavioral mutations,
twelve helper behavior mutations and nine native wiring mutations are caught (**32 total**).
Private proof is in `.nodeterm/android-beta-build-8/`. These are host checks, not Pixel proof:
at that host-baseline checkpoint, item 32 remained Pending and the tally was 7 Pass / 20 Partial /
37 Pending. The focused physical proof above now makes item 32 Partial.

**Historical beta-6 Pixel checklist follow-up, requirement-audited 2026-10-03:** seven complete items pass:
**18, 19, 21, 22, 24, 38 and 39**. Twenty items have partial evidence and 37 remain pending; conditional SKIP variants
below do not pass or close their parent item. This evidence used the then-installed minified
`0.1.0-beta.6` / code `7`, source `c4b1f6cf1009f293a658b6331d2ed1ab80aa36c6`. The intended
Pixel 10 Pro runs Android 17 / API 37 and Vanadium WebView `154.0.8037.92.0`. The real Linux
SSH-driven host runs Fedora 44, kernel `7.2.7-200.fc44` x86_64, OpenSSH server `10.2p1-14` and
tmux `3.7c`; the running desktop nodeterm version is not recorded. These tests use owned synthetic
terminal content through the real sshd, not the JVM/SSH fixture or a simulated phone. No private
hostnames, addresses, keys or clipboard contents are recorded here.

All 17 sending key chips and four application-cursor arrow checks reached the owned pane in
order. A+ changed 56×48 to 52×45; A− restored 56×48, with the connection alive. Rotation retained
the draft and connection: landscape with the IME open was 129×1, and portrait returned to 56×25.
This does not establish more than one row when landscape has usable room; that geometry case
remains open. For each of the three keyboard-chip focus states, the keyboard stayed open and
actual software `a` plus Enter reached the pane rather than the native draft.

The 90000-character synthetic OSC52 clipboard matched exactly. Both 150000 and 450000 were
refused with the app's size message, with clipboard unchanged and no crash (PNG toasts were
visually checked). This phone result establishes visible refusal; the 450000 pre-bridge cap
remains distinct bounded JVM/JS evidence. Invalid base64, missing separator, read query,
overlong selection and invalid UTF8 were silent and preserved the known synthetic clipboard.
The Copy sheet's taps and long-press range copied three exact Unicode lines (lower box border plus fixture lines A/B);
the system Share chooser preserved selection, and modal interactions emitted zero mouse events.
Sheet links/Open, initial top line, each inert target and non-tmux scrollback variants remain open.
Wrapped HTTPS/HTTP links offered the complete 324/323-character URL from first/middle/last rows,
including `/end`; link Copy and All expansion worked, with Less visible. Its collapse tap was not
separately logged. OSC8 HTTPS was offered while
file/JavaScript links were ignored. Browser Open and URL-offer interaction/scroll variants remain
open, so items 54–56 are partial.

Backgrounding a real SSH terminal detached its client; foregrounding reattached and retained the
draft. Detaching only the owned tmux client triggered automatic reconnect, again retaining the
draft. Armed Ctrl plus draft `c` delivered exactly Ctrl-C with no Enter. Airplane-mode/outage and
disabled-input states remain untested. A background `am kill` restored Inbox tab and the host
back stack; a force-stop/reopen retained manual SSH registration/authentication with no host-key
prompt. QR pairing, cellular relay/SAS denial/revoke, notifications, custom wheel bindings and FPS remain
open. Driver coordinate expectations, side-Back navigation and Compose class names were corrected
in the QA helpers; they are not product findings.

**Live production pairing/relay follow-up:** pasting the actual desktop PairingService JSON
succeeds through its encrypted exchange with remote access already enabled. The fixture host is
added alongside the retained manual SSH host. Choosing **Only through the relay** in Settings
opens the isolated desktop's empty Sessions workspace with **"Through the relay · end-to-end
encrypted"**. This is the shipped Pixel app against the real hosted API and
`wss://relay.nodeterm.dev`, so the current `{deviceToken, hostId}` request to `POST /v1/relay/join`
and its accepted response have actual backend proof, beyond interop tests. The desktop runs
production source `58a202be` inside a private bwrap home overlay with real DBus SecretService
encrypted credential storage; no user-profile credentials were copied. Pairing while remote
access is enabled already approves this phone, so no SAS prompt is expected on this path.
Initial Automatic SSH browsing listed the real sshd's files but opened no real node; the route was
changed to relay-only before any node action. A later owned project/plain terminal was seeded
through the actual production preload and Canvas event; the phone attached through the relay,
and its harmless echo input reached that real PTY. This verifies relay terminal attach/input,
not phone New session or the folder picker. Private proof is `relay-terminal.json` and
`relay-input-capture.json` (`hasExpectedEcho: true`). QR/scanner, cellular relay, SAS denial/revoke
and the remaining node/action matrix stay open. Initial phone UI proof is `relay-first-connect.json`.

**Held-hook approval lifecycle (item 39):** a synthetic application invokes the desktop's shipped
managed Claude hook, scoped to the owned node, private home and authenticated hook endpoint.
Pixel Inbox Approve returns its actual allow JSON in 17.596 seconds; Deny returns deny JSON in
6.571 seconds. A 45-second hold expires with empty output; a later Approve visibly says
"The request timed out on computer. Answer it in session." and opens the owned terminal,
without false success. This passes the held-hook lifecycle with an explicit producer limit:
no live Claude CLI/account or requested Bash execution was involved. Private desktop proof
is in `hook-qa-*.jsonl`. At that stage required checks passed all 658 protocol tests in 63 suites with
zero failures/errors/skips (54 seconds), plus offline app `compileKotlin` (5 seconds).

**Relay question follow-up (item 41, partial):** on the desktop-mounted owned terminal, one tap
on Green sends option `2` to the actual synthetic application; its real PostToolUse hook resolves
the desktop mirror question. A multi-select card lists read-only options with "Choose several —
answer in session" and Open session; opening the owned terminal and sending `2` plus Enter from
the phone input bar reaches the application and PostToolUse confirms it. For a separate single
question, the exact owned tmux pane is in copy mode before PreToolUse. One tap on Blue sends
option `3`; the application receives it, copy mode is false, and the mirror becomes working with
that question resolved after actual PostToolUse. These use the shipped hooks and synthetic
application, not a live Claude CLI/account. Private `hook-qa-*.jsonl` and phone
`relay-single-before/after`, `relay-multi-refreshed/multi-terminal/multi-input`, and
`relay-copy-question-before/after` proof record the outcomes. Offscreen/released panes, direct SSH,
missing/prefix-collision targets and notification questions are not device verified; regression
tests cover the transport/target guards. Item 41 stays Partial.

Cleanup forgot only the disposable fixture host and returned the phone to regular Sessions;
only the owned SSH fixture session and isolated desktop/CDP were stopped. Scoped fixture-device
revoke/stop/remote-access-off cleanup left zero fixture devices; it does not pass a full device
revocation or establish a backend revoke result. No new product finding or production change
resulted from these checks.

**Final beta-6 cellular WireGuard check (user-confirmed, 2026-10-03):** with WireGuard enabled
and Wi-Fi off, the user reports "Connects and scrolls smoothly" in their usual terminal on
beta 6 / code 7, confirming connection and smooth scrolling. This is regular manual SSH over cellular VPN,
not hosted cellular relay. It adds evidence to item 20, which remains Partial; the full scroll,
QR/cellular-relay/worker, outage and other 64-item variants remain open. No runtime fix or phone
command accompanied this check. The latest required protocol task passes in 50 seconds and
offline app `compileKotlin` in 1 second; the preceding 54/5-second QA results remain historical.

**Requirement audit and after-hike handover:** item 18 is Pass on existing evidence: all 17
sending chips, four application-cursor arrows, software input, font changes and rotation preserve
the SSH connection (`physical-chips-interior.json`, `keyboard-results.json`, `recovery-results.json`).
The extra route/viewport/Fit matrix previously attached to that row belongs to other items;
item 23 stays Partial. Item 1 needs a desktop-issued pairing and relay credentials to survive a
higher-code update; JSON or QR pairing is acceptable. The user defers remaining Pixel release
checks until after the hike. No new phone work, runtime change or finding produced this tally
correction; full release readiness, hosted cellular relay and live-Claude checks remain unverified.

**Historical prepared update, unused:** private `0.1.0-beta.7` / code `8` uses source
`b53610deb3843b59fa6a1bed5bdc5f36da0f5146` and the retained signer. The local AGP release built
in 47 seconds; R8 and packaging passed. APK SHA-256:
`5141c6484b422b236a98213731076be621c4d14a55f47c79bfd989fb23609e6a`.
Proof/artifacts are in ignored `.nodeterm/android-beta-build-7/` and `.nodeterm/android-beta-7/`.
It was not installed and was superseded by beta 8 below;
preparing it added no runtime fix or device pass.

**Historical beta-8 artifact, now superseded by installed beta 9:** private `0.1.0-beta.8` / code `9` contains `A90`, built
from clean source `b88d141528c1051964da07faf22cc7fa923c4846` with the retained signer. The actual
offline AGP release built in 49 seconds; R8 keeps and local packaging passed, including the same
certificate, 16-KB alignment and source/hash provenance. Independent SDK 36/37 tools verify v2/v3
signatures, one retained signer and 16-KB alignment. All 149 unsigned payloads are preserved, with
three signing entries added; all four ELF PT_LOAD alignments pass. Terminal assets/native libraries
are byte-identical to beta 6; the changed DEX and remapped service entry agree with the feature
source and R8 mapping. Independent proof includes `artifact-review.json`. APK SHA-256:
`d373ad5c1790f714cb4464ad4a0a38c5ba9ab68e35103e54cf3aef5ce53081ce`.
The private artifact is `.nodeterm/android-beta-8/nodeterm-android-0.1.0-beta.8.apk`, with proof in
`.nodeterm/android-beta-build-8/`. Its installation receipt is above. The later beta9→10 update above proves desktop-issued
pairing/relay survival for item 1 without downgrade or uninstall. Debug migration stays
conditional SKIP on the working private installation.
Historical beta-6 proof and its seven Pass / 20 Partial / 37 Pending checkpoint are preserved;
the focused A90 result changes item 32 to Partial. The later paired update passes item 1,
giving the current 10 Pass / 22 Partial / 32 Pending.

Private JSON/PNG/log proof is in `.nodeterm/android-beta-build-6/checklist-20261002/`, including
`physical-chips-interior.json`, `osc52-results.json`, `keyboard-results.json`, `copy-result.json`,
`link-checks.json`, `recovery-results.json` and `activity-results.json`. The 64 rows below reconcile
that physical evidence with the earlier draft ledger. Recorded CI baseline
`19da35a2` has all five jobs green in
[run `37140762345`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37140762345), including
the A90 branch work. Installed beta 9 is bound to source `4d33a5b5`, whose CI run
`37144282865` failed the documentation checklist mapping. The next documentation push needs
its own checks/green workflow.
CI does not imply full device validation.

| Item | Result | Evidence or remaining scope |
|---|---|---|
| 1 | Pass | Genuine desktop-issued beta-9 pairing obtains relay credentials after ordinary original-profile recovery; same-signer code10→11 update to beta 10 preserves the pairing, install identity, notification grant and owned SSH pane. Saved pairing relay reconnect/open/input reaches the actual scoped desktop PTY without re-pairing; anchored SSH refusal still warns before AUTO fallback. Debug-key update/migration variants SKIP* to preserve the working private installation. |
| 2 | Partial | Force-stop retains manual SSH registration/authentication; phone reboot, paired SSH/relay pending. |
| 3 | Pending | Uninstall/Clear storage variants SKIP* on working installation; disposable setup required. |
| 4 | Pending | Second-phone transfer/revoke and cloud restore SKIP*; no authorized setup. |
| 5 | Partial | Minified SSH/copy/link/Copy sheet, encrypted paste pairing and hosted relay browse work; worker/exception/debug variants pending. |
| 6 | Pending | Linux QR pairing pending; macOS/Windows variants SKIP*. |
| 7 | Partial | Actual PairingService JSON paste succeeds; camera/deep link and camera-denial fallback pending. |
| 8 | Partial | Remote-access-enabled pairing permits first relay connection without SAS; denial/revoke/SAS variants pending, older desktop SKIP*. |
| 9 | Pending | Pairing timeout, cancellation and expired/used code pending. |
| 10 | Partial | Manual SSH lists 17 projects; paired Automatic grouping/activity/context pending. |
| 11 | Pending | Named-key, LAN refresh and certificate/refusal matrix pending; macOS variant SKIP*. |
| 12 | Partial | Real hosted relay join/browse succeeds on relay-only route; cellular/SAS and token-request interruption pending. |
| 13 | Pending | 15-minute unapproved-host background check pending. |
| 14 | Pending | Actual host/network loss deadline and relay fallback pending. |
| 15 | Pending | Repeated Back-before-connect cancellation pending. |
| 16 | Partial | Relay-only route takes effect and disposable fixture host is forgotten; other routes and two-paired-host matrix pending. |
| 17 | Pending | Late relay adoption and background authorization pending. |
| 18 | Pass | All 17 sending chips + 4 app-mode arrows, software input, A−/A+ and rotation preserve the real SSH connection; existing physical proof audited. |
| 19 | Pass | Rounded borders, accents, CJK and emoji rendered on real SSH. |
| 20 | Partial | Drag/coast/Esc/new-touch stop and small OSC52 work; user confirms smooth beta-6 cellular-WireGuard SSH scrolling, full matrix pending. |
| 21 | Pass | 90000 chars copied exactly; 150000/450000 refused with size toast, no crash. Bridge boundary is JVM evidence. |
| 22 | Pass | Invalid base64/separator/query/selection/UTF8 silent; known clipboard preserved exactly. |
| 23 | Partial | Portrait font/IME resize works; landscape usable-height and larger-client Fit case pending. |
| 24 | Pass | All three keyboard-chip focus states stay open; actual software a+Enter reaches pane, draft unchanged. |
| 25 | Partial | Background/detach recovery preserves draft; Ctrl+c is exact with no Enter. Airplane/disabled states pending. |
| 26 | Pending | Renderer kill/crash matrix pending; root/DevTools trigger variant SKIP*. |
| 27 | Partial | Real SSH background detach/foreground reattach verified; relay sizing/refresh variant pending. |
| 28 | Partial | Owned-client detach auto-reconnect verified; actual desktop-mount/relay variant pending. |
| 29 | Pending | Sleeping-session wake paths pending. |
| 30 | Pending | Desktop reboot/resume/account/permission paths pending. |
| 31 | Pending | Desktop SSH-project relay routing pending. |
| 32 | Partial | Real Pixel beta 8 Home/project/custom plain-SSH creation, cwd/input/history, double-Create/error retry and force-stop/reconnect pass; beta 9 update retains three shells and exact native UI End removes only each selected UUID, preserving siblings, 11 checked desktop sessions/PIDs and 9 protected file hashes. Otherwise-empty private SSH first Home creation/exact last-End/row-and-group removal/connected SSH/second Home creation pass on beta 9 Oct4; second shell survives beta 10 update, then exact sole-End shows completed empty/no Loading/row/group while SSH/error stay; Home recreation opens an actual bash pane and second exact End restores completed empty again. Beta10 actual relay New session→Terminal(shell) creates/opens one canvas node with exact cwd/input; original producer/pane preserved. Managed-account and cellular creation remain pending; Windows variant SKIP*. |
| 33 | Pending | Back/background during new-session launch pending. |
| 34 | Pending | Project/account removal while new-session dialog open pending. |
| 35 | Partial | Actual beta 10 Rename updates the mounted desktop title; session-menu Refresh delivers exactly one own node-refresh IPC with pane identity/page origin retained, but repaint is unverified. Exact native End removes only the adopted node/pane/PID birth, preserving the original producer; Sessions Refresh rediscovers owned rows. Wake and Refresh repaint remain pending. |
| 36 | Pass | Actual beta 10 phone Move to Ungrouped, label removal/re-add and creation/application of a second blue label update persisted state and the mounted repaired production desktop `ec12ea9a` Board, with identical page time origin and no reload. A95's held071 failure is preserved as before evidence; 133 tests/four mutants also pass. |
| 37 | Pending | Board project/tab/scroll persistence pending. |
| 38 | Pass | Background am kill restores Inbox tab and host back stack. |
| 39 | Pass | Actual shipped managed hook returns allow/deny and expiry opens terminal without false success; synthetic producer, no live Claude/Bash execution. |
| 40 | Pending | Subagent approval while parent waits pending. |
| 41 | Partial | Mounted relay single/multi/Open session and copy-mode answer reach synthetic application/PostToolUse; offscreen/released/SSH/target variants pending. |
| 42 | Pending | Unread/read-ack ownership and sweep matrix pending. |
| 43 | Pending | Background notification arrival/deep-link matrix pending. |
| 44 | Partial | Notification grant persists; deny/re-enable pending. Fresh-denial variant SKIP*. |
| 45 | Pending | Live-notification suppression/delivery matrix pending. |
| 46 | Pending | Notification deduplication/dual-host matrix pending. |
| 47 | Pending | Lock-screen privacy/settings matrix pending. |
| 48 | Pending | Usage/context-meter correspondence pending. |
| 49 | Partial | Actual beta 10 system-Back/reopen preserves edited name/valid HTTPS loopback API; invalid HTTP field error and visually reviewed toast appear, prior API remains. Reset/default and original name/API restoration pass; unedited visible values stay unchanged. Internal preference-key absence/no-write rules remain physically uninspected (existing SettingsLeaveTest behavior/source guards cover them). |
| 50 | Partial | Portrait terminal IME fit verified; Pair/Settings/dialog layouts pending. Android 8–14 variant SKIP*. |
| 51 | Pass | Actual beta 10 Pixel Computers/Settings native screens and system bars are visually readable under system dark/light modes; four matching screenshots reviewed. App keeps its fixed dark palette; original night mode yes restored/verified. Tablet/foldable variant SKIP*. |
| 52 | Pending | Relay-assisted actions and remote-access toggles pending. |
| 53 | Pending | Source-control branch/status/diff/stage/commit/push/pull/conflict/hook matrix pending. |
| 54 | Partial | Wrapped full URL/Copy/All expansion verified; Less collapse, browser Open and remaining bar/isolation/link variants pending. |
| 55 | Partial | HTTP(S) OSC8 offered, file/JavaScript ignored; Open pending. Windows/external-mouse variant SKIP*. |
| 56 | Partial | Taps/long-press range copy three exact Unicode lines; Share/modal isolation verified; links/top line/inert targets/non-tmux scrollback pending. |
| 57 | Pending | Notification approval actions pending; Android 8–11 variant SKIP*. |
| 58 | Pending | Notification question actions pending. |
| 59 | Pending | Already-handled/expired/unreachable notification answers and repeated-tap behavior pending. |
| 60 | Pending | Two-computer Inbox/Usage/approval/state matrix pending. |
| 61 | Pending | Dictation/service/permission/edit/offline matrix pending. |
| 62 | Pending | Separate desktop-driven Linux host matrix pending. |
| 63 | Partial | Manual SSH auth/pin/list/input work; headless Server Edition and failure/fish variants pending. |
| 64 | Pending | Separate driven-host read-ack/key-change/Forget matrix pending. |

*SKIP is limited to the named unavailable variant: no disposable debug/migration or destructive
reinstall profile; no second phone/cloud-restore setup; no macOS/Windows/older desktop; no
root-capable renderer-crash setup; no fresh notification-denial profile; no Android 8–14 or
8–11 comparison device, tablet/foldable or Windows/external-mouse setup. Applicable core checks
remain pending and these variants must be revisited when their prerequisites are available.

**Historical stable-touch correction (`A89`, 2026-10-02):** beta 5 still stops during continuous
swiping and the user must lift to continue. Its controlled phone history shows no coast after the ADB
swipe command completes. Real xterm reproduces the cause: redraw replaces the touched text
span, so later touchmove/touchend no longer bubble to the handlers. `c4b1f6cf` gives the stable
screen `touch-action: none` and changing rows/descendants `pointer-events: none`. The real-bundle
regression verifies computed CSS hit testing and continued drag/release across an actual redraw.
The real-bundle redraw case delivers 24 notches versus one with a detached span. All 658 protocol
tests in 63 suites pass with zero failures/errors/skips (67 seconds), and offline app
`compileKotlin` passes (8 seconds). Thirty-five JS, eleven native and three CSS mutants were caught.

Private `0.1.0-beta.6` / code `7` uses source `c4b1f6cf1009f293a658b6331d2ed1ab80aa36c6`.
Actual AGP release built in 43 seconds and passed every R8 keep. Retained-signer packaging verifies
non-debuggable metadata, signature, 16-KB alignment and source/hash provenance; signing preserves
all 149 ZIP payloads and adds only three signature metadata entries. APK SHA-256:
`4947133a6ccf9c2b1e775e76d7c24f564e087cf036e59eac4dca08162a076d3c`.
The intended Pixel received a same-signer update preserving app data; notification permission
is confirmed. SSH reopened with the retained key/pin in the owned 56×48 pane. A
1000-native-pixel/1200-ms swipe produced 23 observed history-position updates, from 0 to 110 over
about 1103 ms; its ADB command completed at 1535 ms. A 1000-pixel/200-ms swipe reached position
110 when its ADB command completed at 540.5 ms, then 250 at 1339 ms (about 799 ms later), with
29 observed updates overall. This verifies continuous drag delivery and post-command coast.
Esc during coast left copy mode (`mode=0`) and remained out for 1.4 seconds.

New-touch stopping also passes with the keyboard already open and all sampled viewports at
56×25. After a 500-native-pixel/100-ms swipe, the DOWN command completed 152 ms after the swipe
command; the script then waited 1.2 seconds before issuing CANCEL. The last position change was at 503.6 ms, before DOWN completed at
588.8 ms; final position 100 remained unchanged through CANCEL. Earlier tap/DOWN checks opened
the IME and rebased positions; those results were inconclusive, not additional failures.
After normal terminal use, the user confirmed “Both work now” for continuous dragging and coast.
The primary `A86` drag/coast complaint is resolved. The final beta-6 cellular WireGuard SSH check
confirms connection and smooth scrolling; reversal/lifecycle, FPS/custom
bindings and the full 64-item pass remain open. After testing, Esc and Header Back returned to
Sessions and detached the owned client; only the exact owned `nt-term-000android-scroll-20261002-c` session and owned phone UI
XML were removed. Private proof, including `device-summary.json`, is in
`.nodeterm/android-beta-build-6/`, signed artifacts in `.nodeterm/android-beta-6/`.

**Historical kinetic beta (`A86`, 2026-10-02):** beta 4 moves more lines but the user reports missing
momentum on finger lift. `1ad2e944` adds bounded velocity fling; `53462f96` adds `onScrollStop`
to discard unsent native scrolling on new touch/input/reset/font/lifecycle barriers without
pane input or loss of accepted keys/replies. Automatic xterm reports preserve it. Bytes already
handed to SSH's separate writer/network cannot be recalled. All 658 protocol tests in 63 suites
pass with zero failures/errors/skips (59 seconds), and offline app `compileKotlin` passes (10 seconds).
Thirty-five JS and eleven new native mutations were caught; seven strengthened kinetic tests pass.

Private `0.1.0-beta.5` / code `6` uses source `1ad2e94455a7adfb85d41212b12d36df39695324`.
The actual AGP release built in 47 seconds and passed every R8 keep. Retained-signer packaging
verified non-debuggable metadata, signature, 16-KB alignment and source/hash provenance. APK
SHA-256: `7cc68d384aeb21ab40800fa7c83f006dfbfefba16dd2e945967c8c5376f17655`.
It updated the intended Pixel in place; installed code-6/non-debuggable metadata and notification
permission are confirmed. Private proof is in `.nodeterm/android-beta-build-5/`, signed artifacts
in `.nodeterm/android-beta-5/`. The actual gesture reaches history 15 at 369 ms, 25 at 391 ms,
and 30 at 412 ms, then stays fixed through 1.4 seconds after the ADB swipe command completes at
561 ms. Command completion is not a measured physical touchend timestamp. The user reports
continued swiping stops; this failure led to `A89`. Beta-5 build/tests do not prove phone coast.

**Historical report-routing correction (`A86`, `A87`, 2026-10-02):** the user reports that installed
beta 3 still has both lag and too little movement, on Wi-Fi and mobile-data VPN. Its controlled
gain/reversal/Esc results below did not establish satisfactory feel. `3cffb49d` restores one
measured text row per wheel notch and separates automatic xterm focus/mouse/query replies from
user input: reports preserve queued movement; keys, paste and IME input still cancel it. Frame
batching, lossless ordered chunks, stream retirement and SSH TCP_NODELAY remain. Real bundled
xterm interaction regressions pass; 22 JavaScript and nine actor/native-wiring mutations were
caught. All 646 protocol tests in 62 suites passed with zero failures, errors or skips (50 seconds), and the
offline app `compileKotlin` passed (8 seconds). At that checkpoint, `A86` still needed
intended-Pixel/user follow-up and kinetic fling was absent; beta 6 now has drag/coast confirmation.

**Historical beta-4 delivery:** `0.1.0-beta.4` / code `5` built locally from
`3cffb49d8cf64932260e914b42b3883331d0352d` with the retained signer.
The code-5 local AGP release built in 48 seconds and passed every R8 keep. Retained-signer
packaging verified non-debuggable APK metadata (minSdk 26, targetSdk 35), signature, alignment
and source/hash provenance. APK SHA-256:
`c64d6a8dea9621265f23a679104149e511ecd243fbdfa53ced401f4cb4f0f6b5`.
The intended Pixel updated in place, preserving manual SSH configuration/key/pin and granted
notifications; the installed app remains non-debuggable. Its owned 56×48 terminal now reaches
positions 25, 45, 70, 100, 130 on the same five 1000-native-pixel/350-ms swipes, versus beta 3's
5, 10, 15, 20, 25. Each gesture produces 4–6 observed host-position changes, reversal moves
130 to 110, and the actual Esc chip leaves copy mode. Private inputs/proof are in
`.nodeterm/android-beta-build-4/` and the APK/checksum/metadata in `.nodeterm/android-beta-4/`.
These verify delivered movement/order/cancellation, not terminal FPS or satisfactory user feel.
The user subsequently confirmed more movement but reported missing momentum; the active `A86`
kinetic-scroll work above addresses that remaining gap.

**Phone trace limits:** the controlled beta-3 trace records one bridge invocation per gesture and
roughly one content presentation per gesture. Invocation begins 84–90 ms after touchstart; first
presentations occur 170–196 ms after touchstart, as temporal correlation without an SSH/action flow.
Presented Chromium scroll events measure roughly 36–56 ms; the >1-second aggregate mostly counts
no-paint termination. Sparse FrameTimeline data and non-damaging scroll-jank events establish no
terminal FPS or renderer cause. There are no named JavaScript/native methods or scheduler/V8
measurements, and the parser reports unknown newer extension fields. The trace supports comparing
delivered updates after the fix, not a claim that WebView spends a second painting.

The matching beta-4 trace records 42 bridge invocations versus 12, 26 content commits versus 12,
and 25 distinct presentations versus 11 over twelve gestures. First invocations occur at 25–36 ms
versus 84–90 ms; this supports more frequent delivered updates, without establishing terminal FPS
or end-to-end SSH latency. Both traces and queries are retained in the private beta-4 evidence.

**Packaging verifier (`A88`):** the earlier range-label fix `fed68fb3` passed 32 local tests, but
CI run `37058184031` again failed private packaging (five of 32 tests); protocol/debug/release/CodeQL
passed. Official SDK 37 reproduces verification exit 0, one signer and v2 true with `V3.0 Signer:`
certificate labels. `f5fd3821` accepts exact V2/V3.0 single labels and V3.0/V3.1 ranges,
requires one pinned certificate and verified v2, and rejects duplicate/unknown/hybrid identities.
Fixtures use the explicitly installed SDK 36/platform 35 unless a reproduction override is set;
only disposable-fixture verifier output is included in failure diagnostics. All 39 Python tests
pass against each real SDK 36/37, and ten new parser/fixture-selection mutants are caught.
Follow-up [run `37061593216`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37061593216)
at `c37798b6495b4b68df379d0ae80887c23104b66d` completed with all five jobs green, confirming
observed CI repair. Each subsequent push still requires its own green workflow.
Every requested push owes green Android workflow verification; `A68` remains deferred and no PR
is requested.

**Historical beta-3 scroll update (`A86`):** after checkpoint `cf0487a3`, the user reports poor responsiveness on
both Wi-Fi and mobile-data VPN. Controlled SSH/tmux measurements found amplified wheel steps,
fast-swipe clipping and some TCP_NODELAY-sensitive latency; a bounded desktop DOM replay showed
no backlog at that load. The implemented mitigations match drag distance to stock tmux's five-row
wheel steps, batch by frame without losing distance, serialize scroll/input, cancel unsent scroll
before input and enable SSH TCP_NODELAY. No external host/payload contract or phone setting changed.
All 638 protocol tests in 61 suites passed with zero failures, errors or skips (51 seconds), and
the final offline app `compileKotlin` passed (7 seconds); 30 mutations were caught. Private
`0.1.0-beta.3` / code `4` from `40c4ee49592e2f92fc7e6e9b548ba88a33b1e2d3` built locally in
49 seconds, passed every R8 keep and retained-signer packaging, and updated the intended Pixel in
place. Signature, alignment and source/hash provenance passed; all 149 ZIP payloads were unchanged
by signing. APK SHA-256: `dda44df7ebb541afccd18b428634d66246349ccb62fd202917b77a333fbadba3`.
Manual SSH registration/key/pin and notification permission survived. The app reopens the intended
Linux host over SSH and its controlled test terminal fills 56×48. Five identical 1000-native-pixel,
350-ms downward swipes reached positions 25, 40, 55, 70, 85 on beta 2 versus 5, 10, 15, 20, 25 on
beta 3. Reversal moved 25 to 20 and the actual Esc chip left copy mode. The phone returned to
Sessions and refreshed; only the owned test session was removed, with user panes untouched.
Private proof/screenshot/installed-package checks are in `.nodeterm/android-beta-build-3/`,
including `device-checks.json`. These establish drag gain/order/input cancellation, not FPS
or perceived smoothness. The tiny isolated UI-frame samples are not a WebView renderer trace.
The user subsequently reports that beta 3 still lags and moves too little. Those historical
checks verify gain/order/cancellation, not satisfactory feel; the current correction is above.
At that checkpoint, custom wheel bindings and kinetic fling remained open. The [finding](android-audit-2026-09.md#a86) records the evidence and limits. Push is
authorized, each requested push requires green Android workflow verification, no PR is requested
and `A68` stays deferred.

**Installed beta history (2026-10-02):** restored host access allowed reconciling remote tip
`82940e17` in `990f90c6` and building the actual app locally. The first AGP 8.9.1 release exposed
R8 Kotlin-metadata warnings (`A83`). The corrected source
`fa71cb08072f399f24a81bfb361ea852a0275f3b` uses AGP 8.10.1 with Kotlin 2.2.0, wrapper Gradle 8.14.3
and JDK 21. Its real release and final offline `:app:assembleRelease` (15 seconds) passed, the
metadata warnings are gone, and `check-r8-output.sh` passed every runtime keep.

`0.1.0-beta.1`, version code `2`, was privately signed with the retained signer, verified as
non-debuggable with the expected certificate and local APK/R8/source/hash provenance, and installed
on an MI8 running Android 15 / API 35. The first cold start succeeded and reached the notification
permission dialog. After granting `POST_NOTIFICATIONS`, the app shows its empty Computers screen,
Pair button and Settings, with no crash markers. Installed metadata confirms version code `2`,
minSdk `26` and targetSdk `35`; `run-as` is refused because the app is non-debuggable. The phone's
WebView is `com.android.webview` `144.0.7559.76`. Inputs/logs are in the original workspace's ignored
`.nodeterm/android-beta-build-1/`; the APK/checksum/metadata are in `.nodeterm/android-beta-1/`.
APK SHA-256: `39afa15f15219536e3de1a462f2e5018515847a43684093eef18d95faf5e7fb4`.
**Wrong test device:** the user identified the MI8 as the wrong phone. The newly installed app and
its test UI dump were removed. The phone's newly authorized SSH public key was removed, restoring
the host's `authorized_keys` byte-for-byte to its pre-change state. The MI8 had no paired host and
no SSH connection was attempted. The device evidence above remains first-launch evidence for that
test device only. The subsequent intended-phone results are below. The user's target is this
Linux host over their WireGuard VPN; full validation remains open under `A50`.

**Intended phone, initial beta:** the user supplied the intended phone's ADB endpoint. The Pixel
10 Pro runs Android 17 / API 37 with Vanadium WebView `154.0.8037.92.0`. Private beta
`0.1.0-beta.1` (code `2`) installed, the user granted notifications through Android's normal dialog,
and `run-as` was refused on the non-debuggable build. Its SSH public key was authorized while
preserving existing authorized entries. Through Add SSH server, the app connected to this Linux host;
the pinned Ed25519 fingerprint matches the host's public key. It lists 17 actual projects, and a
harmless `echo` sentinel entered from the phone executed in a controlled temporary tmux window.
This is manual direct-SSH registration/authentication, not verification of QR/code or relay pairing.

The initial terminal still advertises only 52/56 columns by one row despite a large visible
viewport, including after changing the font (`A85`). Chromium treats a WebView's `WRAP_CONTENT`
height as zero CSS layout height, despite its large native bounds. The local fix supplies explicit
`MATCH_PARENT` layout parameters before loading the terminal page (`febe022a`); the real Gradle
`TerminalWebViewLayoutTest` wiring guard passes, and two layout-policy mutations were caught in a
temporary source mirror. The actual `0.1.0-beta.2` (code `3`) from
`febe022ad2fc373f27ac11d9ad5f130f36f027a5` passed its offline AGP release build in 45 seconds and was
signed with the retained certificate; signature, alignment and same-build provenance were verified.
Inputs/logs are in `.nodeterm/android-beta-build-2/`; finished APK/checksum/metadata are in
`.nodeterm/android-beta-2/`. APK SHA-256:
`a022a399e23c81607a4a3664862b964ad781f0a589ab77dda902b4c2dc597eca`.
An independent artifact review verified v2/v3 signatures with the same retained certificate,
all APK/provenance hashes, 16 KiB ZIP alignment and 16 KiB load-segment alignment for all four
native libraries.

Updating the Pixel with `adb install -r` succeeded and preserved its host configuration, phone SSH
key, host-key pin and notification grant. The app reopened the intended Linux host over SSH. The
controlled terminal now reports 52×45 instead of 52×1 and fills its viewport. A downward swipe
entered tmux copy mode at position 82; a screenshot visibly showed the pre-attach ready/sentinel
and marker rows 001–039, from 120 rows printed before the update/attach. The layout fix restores
this pre-attach tmux history without any production SSH-scroll change. A− restored font size 13
and a 56×48 terminal; showing the soft keyboard resized it to 56×25 with native bounds
`[0,396][1280,1462]`, and hiding the keyboard restored 56×48. The Esc chip left tmux copy mode
(`pane_in_mode=0`). Sending a second unique `echo` marker through the updated beta's draft executed
and displayed the entire output line. The app returned to Sessions; only the owned temporary test
window was removed, with the previous window restored and its original Python process still alive.
The intended phone's app, SSH key and configuration remain. Device checks and controlled screenshots
are retained in `.nodeterm/android-beta-build-2/`, including `device-checks.json`. The full phone
pass remains pending; the subsequent user-reported mobile connection is below.

**User-reported mobile check:** with WireGuard enabled and Wi-Fi off, the user confirmed that the
intended Linux host's terminal opens over mobile data. This is separate from the ADB-assisted LAN
checks above. Mobile reconnect, approvals/questions, background behavior and the full 64-item
checklist remain open.

History regressions in `d6619bf6` pass 47 focused real Gradle SSH/terminal/link tests with zero skips. Both JavaScript swipe-direction/disabled-scroll mutations, the real-SSH wheel-direction mutation and the two native layout-policy mutations were caught; production sources were restored. **Beta-2 verification:** all 609 protocol tests passed in 59 suites with zero failures, errors or skips (52 seconds); the offline app `compileKotlin` passed (7 seconds).

The full desktop type-check and 679 desktop tests passed, with three platform skips. The offline
Gradle app type-check passed, and 23 Python beta-tool tests passed with real SDK APK/signature
fixtures. Eight bounded compatibility/CI guard tests and two toolchain mutations also passed.
The real Gradle protocol run executed 605 tests: 603 passed, two real-SSH tests failed, none skipped.
The two initial SSH failures were test-harness isolation faults (`A84`): a Fedora login-shell
command-not-found handler delays the literal `-R` command, and an earlier no-exit-status test leaves
Escape in the shared pane's Readline state, corrupting the next `echo` into `cho`. The test-only fix
in `1d6b04cc` isolates a fresh non-login pane and initialization environment per test. That earlier
full protocol rerun passed all 606 tests with zero failures, errors or skips; both harness mutations were caught,
and the fixed test source was restored before that rerun. The user authorized this local build
instead of requiring CI for the first beta; each newly requested push still requires green Android
workflow verification.

Device results remain partial overall, with complete passes for items 18, 19, 21, 22, 24, 38 and 39 in
the latest record above. Items 1/5/10/63 retain install/minified/manual-SSH evidence, and current
key/input/font/rotation survival completes item 18; viewport/Fit, copy/link, mounted-relay
question/copy-mode answers and SSH lifecycle results cover partial items. The private
update preserved manual SSH registration and its identities; pre-attach tmux history is visible.
Paste pairing, live hosted relay browsing/terminal input and the item-39 held-hook lifecycle are verified.
QR pairing, cellular relay,
actual network-outage/answer behavior and the full
64-item pass remain open. The current complete
protocol run after the stable-touch correction passed all 658 tests, as recorded above. Use the
[private-beta procedure](../android/README.md#private-beta), which accepts same-build local
APK/R8/source/version/hash provenance with `buildOrigin: "local"`.

**Continuation checks (2026-10-02, cached branch base `6afd8f53`):** the new `A78`–`A80` fixes are
local and have not run in CI. Six targeted desktop unit suites pass (170 tests), and eleven
production mutations fail the relevant regressions. These run with a cached Vitest 4.1.9 runtime;
the lockfile's runtime is 4.1.11. Two additional relay verb suites could not load because Electron
is missing. The new SSH shell tests compile and execute
with a cached Kotlin 2.3.20 compiler, minimal model dependencies and temporary test assertion stubs:
three shell tests pass, covering both sockets, copy mode, literal answers/Enter/Escape and errors;
four shell mutations fail. An isolated adapter containing the actual SSH `sendKeys` method refuses
null/nonzero exit status; restoring null-as-success fails that check. This is narrower than compiling
the full SSH transport or running JUnit/MINA.

In the earlier restricted sandbox, the required full protocol tests and app type-check could not start: system Gradle is absent, and
a recovered Gradle 9.5.1 fails initializing its socket-based lock service in this sandbox. Real
tmux/SSH checks and adb are also blocked by socket permissions. `npm run typecheck` is blocked by
missing desktop dependencies, and `npm ci --offline --ignore-scripts` cannot complete from the cache.
That command deletes `node_modules` and leaves node-pty unpatched/unbuilt; a desktop checkout
recovers with `npm install` or `npm run rebuild` once dependencies can be installed.
GitHub DNS was unavailable in that sandbox, so fetching, downloading an APK, pushing and checking
Android CI were not possible at that stage. **No device checklist item had been run at that stage.**
The checks below describe earlier work; current local checks and partial phone results are above.

No relay verb or payload changes in this continuation. The desktop fix serves Android and iOS;
@eneskirca should check the iOS direct-SSH answer path for the same copy-mode and exit-status hazards.

Private beta preparation adds bounded relay HTTP requests (`A81`) and owned read-ack consumption
(`A82`). `RelayApiTest` passed all six methods with real cached OkHttp, Okio, serialization and
coroutines, using in-memory sockets for stalled headers/body, trickling responses and cancellation;
the deadline also bounds dispatcher queueing and preserves a caller's shorter cancellation.
Three initial and three follow-up mutation checks were caught. This is a direct compiler run
(Kotlin 2.3.20, language 2.2), not the
required Gradle suite or a live backend test. The ack changes retain foreign files before reading or
deleting them and aggregate ownership across every project on an SSH host; Android's producer format
stays the same, with new producer/consumer interop coverage. iOS should preserve the same ack format
and confirm multiple-desktop behavior with @eneskirca.

For `A82`, five desktop suites pass 225 tests (ack sweep, mirror, remote ack/project teardown), and
the actual Android producer plus real desktop consumers pass two ack interop methods and the new
bundle path-coverage check under that cached compiler. Eight mutations were caught; a focused
strict TypeScript check of the ack core/new fixture also passes. The separate fixture guard's
`tsc --listFilesOnly` child fails with `EPERM` here, so its full check remains unverified.

The [private beta procedure](../android/README.md#private-beta) keeps the signing key and finished
APK local. Pushes to the exact takeover branch prepare versioned unsigned beta inputs without a
PR; manual CI beta inputs provide the later optional path once the workflow is on the default branch.
A verified local AGP build is now also authorized; its same-build unsigned APK, R8 reports and
provenance use the same required fields, with `buildOrigin: "local"`. The CI path selects those inputs;
the beta checks require protocol/release success, desktop type-check and delivery/ack tests, and
real-tool packaging regressions. Local packaging verifies the expected private signer, release
manifest, R8 keeps, alignment and checksum. **The actual corrected release is signed and installed
on the intended Pixel; the code-3 update preserves identities, resizes with font/keyboard changes
and exposes pre-attach tmux history. The remaining full phone validation is pending.** Packaging fixture APKs prove the tool's gates only; the
actual APK and partial phone results are recorded above. `A50` stays partly open until the full
phone pass.

The user confirmed a first private beta; its retained RSA-3072 PKCS12 signer is now prepared in
the original workspace's ignored `.nodeterm/android-beta-signing/`, outside the temporary source
checkout. The directory is `0700` and every file `0600`; passwords stay in separate local files.
The private-key entry, certificate fingerprint and distinction from the public debug certificate
are verified. Source exports contain none of these private files. Preserve a private backup for
future APK updates. The wrong MI8 installation was removed; the same first signed APK is now on
the intended Pixel and updated in place to the code-3 sizing fix. The full phone pass remains open;
each requested push requires green Android workflow verification.

Beta tooling checks pass 22 real SDK packaging fixture tests plus one selected-version environment
test (12 cases), with 13 packaging mutations and one version-validation bypass caught. Seven CI
configuration tests pass under the cached compiler; six workflow mutations are caught. Nine existing
device/contributor documentation tests pass under that runner. The extracted Gradle version
expressions also pass nine boundary/default cases; this does not run Gradle configuration. The full
protocol/app Gradle commands were retried in the restricted sandbox and stopped before project tasks
at the lock service; desktop type-check stopped at missing `electron-vite/node` types. Restored-host
results supersede those limits above. No continuation CI result is available.

`android/protocol` has no Android dependency and is tested on a JVM (`./gradlew -p protocol test`):

- **Crypto** — byte-for-byte against vectors generated by the desktop's own `tweetnacl` and
  `node:crypto` HKDF (`scripts/gen-crypto-vectors.cjs`): key derivation, `box.before`, secretbox
  across block boundaries, tamper rejection, session key, SAS, relay host id.
- **Relay** — the Kotlin client against the desktop's real `connectHostSession`/`connectRelay`
  through a local broker: handshake, SAS agreement, approval wait, `projects.list`, attach with
  snapshot paint (including a >256 KB snapshot whose chunk boundary splits a code point), input,
  resize/`OP.Resized`, exit codes, scroll, detach/destroy, node actions, board verbs (`null` =
  Ungrouped), `approvals.answer`, `inbox.ack`, registration, and the `git.*` verbs. What is real is
  the verb routing and its validation; the pty, board, inbox and node-action bridges behind the
  verbs are fakes that record what was asked. The git bridge is not: it is the desktop's own
  `GitService` (`src/core/git-service.ts`, what `hostBridge.git` hands both phone hosts) behind the
  production jail, over a repository the fixture makes in the project's folder (`A29`). The
  `projects.list` blob is the desktop's own: `buildProjectsListBlob`
  (`src/core/projects-list-blob.ts`, which the desktop's `listProjectsOutput` calls too) over a real
  `WorkspaceStore` (it writes the v3 index and the project file, then assembles them) and an
  `agent-status.json` written by the real mirror from Claude hook payloads (audit `A64`). The `lan`
  field beside it is the desktop's own `createHostLanReporter` over the test's interfaces and
  host-key dir (`A74-refresh`): the phone parses the address and keys, and a record that pins a key
  the computer no longer has is refused by a real MINA server before the refresh and accepted (and
  pinned) after it, once the report confirms the key that server was refused; a pin the computer
  still reports but its sshd no longer serves gives way the same way; a desktop that sends no field
  changes nothing.
- **Relay security** — scripted-host tests for: no re-key after ready, reflected boxes (own role)
  dropped, replayed/reordered sequence numbers dropped, boxes under a foreign key dropped.
- **Pairing** — against the desktop's real `createPairingService` with HOME in a temp dir: the
  E2EE-sealed exchange, the key landing in `authorized_keys` under `nodeterm-ios-<deviceId>`, the
  relay leg and its `/v1/relay/device` body, a refused wrong token, the relay key pinned at the scan
  and, without a relay leg, recorded and approved on the first relay handshake (`A07-late`: the
  fixture asks the service what the standing host asks, for the phone's key and a stranger's, before
  and after revoking), the SSH host keys a sealed answer names (`A49-anchor`: read from a host-key
  dir the fixture is pointed at, never the machine's `/etc`; in the form sshj reports; none in a
  plaintext answer; a first connect to a real MINA server whose key they name pins it, and one whose
  key they do not name is refused), and the size of the desktop's largest answer (1,803 bytes with
  the 16 host keys it sends at most, counted through a proxy). Scripted local servers pin the client's
  bounds on an answer from whatever `host:pairPort` a code names: a declared length is refused
  above 64 KiB or below zero before anything is allocated, a body with no length stops at 64 KiB,
  and the whole exchange ends at a 45 s deadline (or when the caller is cancelled) by closing the
  socket, so a server that trickles bytes cannot hold the pairing screen.
- **SSH** — against Apache MINA sshd running every command through a shell, with real tmux on a
  private `TMUX_TMPDIR`: v3 index resolution, attach with keystrokes both ways, cold-start
  detection, literal `send-keys` (a leading `-` is text), answer files, read-acks, host-key pinning.
  Both sockets (`A27`): a computer with no nodeterm of its own that another desktop drives (its
  `nodeterm-rmt` sessions, project file and slices, a stale slice dropped, attach / keys / pane read /
  kill landing on `nodeterm-rmt`, nothing created for a session that is not running, also on a
  connection that has not listed yet), one with both sockets in use (a name on both is the host's
  own; the paired desktop's own SSH project stays relay-routed), a Server Edition data dir, and a
  computer where nothing is found, also when only stale slices remain. A node no listing names is
  not offered the relay, and the first node-scoped call on a fresh connection settles which nodes are
  whose. The SSH server's commands get none of the developer's `NODETERM_*` variables. A computer
  added by its SSH address (`A27`, `ManualHostTest`, its own MINA server whose authenticator reads
  `~/.ssh/authorized_keys`): refused before the key line is installed (no pin, no record), the
  install command run under `/bin/sh`, then accepted and pinned to exactly the server's host key; a
  later connect verifies that pin and another server at the address is refused; a server that drops
  the connection during login is reported as unreachable, not as a refused key; the form's checks,
  the record's JSON (and what an older build reads of it, and what this build reads back after an
  older build saved it without the flag), and the app's wiring, pinned in its source.
  No desktop code runs on this leg: the test writes the files the desktop would have (the v3
  `workspace.json` index and project files, `agent-status.json`, the status slices, the held request
  in `~/.nodeterm/pending`), and checks what the phone writes against file names copied from
  `pending-approvals.ts` and `ack-sweep.ts`. `SshScriptsTest` runs the browse under `/bin/sh` with a
  stand-in tmux for the walk up to project files, the slice names and the Server Edition's data dir;
  `HostBrowseTest` pins the assembly rules and reads the desktop's heartbeat, slice file name, server
  data dir and socket names from its sources.
  A command without a pty runs as `/bin/sh -c <cmd>`. One that asks for a pty runs under `script(1)`
  in place of sshd's pty: util-linux's `script -qfec <cmd> /dev/null` on Linux (which runs `<cmd>`
  through `$SHELL`), BSD's `script -q /dev/null /bin/sh -c <cmd>` on macOS. They are told apart by
  `script --version` and a probe (`SshTestHost.kt`); with neither, or without tmux, the class skips.
  The temp root is short and resolved (`/tmp` first): under macOS's `/private/var/folders/…` the
  socket path passed the 103-character `sun_path` limit (audit A62). Only the Linux leg has run.
  One tmux fact measured along the way: an exact-match **pane** target is `=name:`, not `=name`
  (tmux 3.4 answers "can't find pane").

The **app** module is built by CI (`.github/workflows/android.yml`) against the runner's Android
SDK. The first run, [36109984730](https://github.com/CPlusPlus17/nodeterm/actions/runs/36109984730)
on `2f58918`, built the debug APK successfully. CI also builds an unsigned release APK, the only build
type R8 minifies (audit `A37`). A missing `-dontwarn` then fails CI instead of the first release,
because R8 reports the missing class. `tools/check-r8-output.sh` then checks that these existing
keeps for code reached by name matched: the WebView bridge's methods, the WorkManager worker's constructor,
BouncyCastle's provider tables, and one exception class's name (error text can fall back to it). A
missing `-keep` is otherwise not detected: R8 renames or drops code it cannot see used and reports
nothing, so a new reflection or name-dependent target (a new `Class.forName`, a class a library loads
from a string) builds green without its keep. It needs its own keep and a line in
`tools/check-r8-output.sh`. `R8RulesTest` re-derives the classes Android lacks from the jars the
protocol module ships to the app, and requires a keep for every WorkManager worker in the app sources.
The debug APK stays unminified. CI attaches unsigned release inputs; the private-beta path signs
them locally. The app has no instrumented tests. The actual private minified APK is installed on
the intended Pixel and has listed real projects and delivered basic terminal input over SSH.
The corrected code-3 update resizes for font/keyboard changes and exposes pre-attach tmux history;
code 4 verifies reduced drag gain, reversal and Esc cancellation. Remaining
relay and device behavior are unverified; the
[device checklist](#device-checklist) below is what the full device pass has to run. An audit of the code found release blockers; the fixed ones are
marked in its index, and the rest are open: [`android-audit-2026-09.md`](android-audit-2026-09.md).
The plan and the decisions still open are in [`android-handover.md`](android-handover.md).

Interop coverage (audit `A64`) now includes actual producers on both routes. Relay `projects.list`
uses `buildProjectsListBlob` over the real `WorkspaceStore` and mirror writer; session-list and
settings-provider inputs remain fixture data. Server-profile tests read actual Server config/platform,
workspace and mirror publications over private SSH, including selected-profile isolation and Board
persistence. This component fixture does not boot the full Server or install hooks/account probes.
`SshActionsInteropTest` and `ManagedSessionInteropTest` exercise actual selected-profile services and
Kotlin writers; the managed fixture keeps its native process/CLI recorder boundary explicit.
`AckSweepInteropTest` drives the actual Android `.seen` writer and desktop local/remote consumers.
Two additional `SshTransportTest` methods now read the actual account-level relay-advertisement
writer/remover through the Kotlin SSH parser, checking every field, replacement, removal and profile
isolation. Their producer adapts the OS home only during initialization into a private scratch
folder; it does not run a standing relay host, mint tokens or prove adoption, SAS approval or revoke.
Legacy/malformed browse, held-file and driven-status-slice fixtures remain hand-maintained. The
`A02` directory spelling and `SshScriptsTest` prelude checks remain useful; parser unit tests
(`ModelTest`, `UsagePaceTest`) deliberately use malformed and edge-case blobs.

Since the audit, the SSH tests also cover: resize/keystrokes/close from a thread that must not do
network I/O (a JVM stand-in for Android's StrictMode, `A01`), a transport that breaks mid-write
(`A01`), and non-ASCII through an attach whose host sets no locale (`A03`). The relay interop tests
cover an approval answered after the hook's hold ended (`A06`), and the desktop tests run the
generated SSH answer command under a real `/bin/sh`. `QuickActionsTest` pins which node state each
Inbox quick answer needs (`A38`): a ticketed approval is judged by its card, so it is answered while
the node still shows WAITING for a held question; keys are typed only for a ticketless approval on a
BLOCKED node or a question on a WAITING one, and only while the fresh listing still lists the card
unresolved. A card the computer's feed has dropped (it keeps an event 6 hours, and trims its feed to
50 events, keeping only each node's newest unresolved ask) opens the session instead: a key carries no
identity of the prompt it answers, and the node may be blocked on a newer one by then (the review of
`A25`). `QuestionChoicesTest` pins what a question card shows (`A57`): a single-select question keeps its answer buttons, while a multi-select one lists its options
numbered and read-only under "Choose several — answer in the session." beside "Open session", and
`QuickActions` never types into it. The card's drawing is pinned in the source and only type-checked.
`UsagePaceTest` pins the Usages pace line (`A58`): no line
without a reset time, 300/10080-minute defaults for the session/weekly kinds (Claude reports no
window length), none for an unknown kind, and injected clocks; the elapsed share is taken at the
account's `updatedAt` (when the percentage was measured), so a stale snapshot never drifts toward
"slower". `Osc52Test` pins OSC 52 copy
(`A53`): parsed like the desktop's `parseOsc52` (the `;` is required, a `?` read query is refused,
base64 and UTF-8 are decoded strictly), but capped at 100,000 characters, because the clipboard
write is a binder call whose buffer (about 1 MB, shared) the desktop's 1,000,000-character base64
cap does not respect. `TerminalJsOsc52Test` runs the app's real `terminal.js` in node against stub
xterm/bridge objects and checks that it applies that cap before a copy crosses the WebView bridge.
The app also catches a failing `setPrimaryClip` and says so in a toast; that part is not tested.

Links and copying in the terminal (`A32`) had no way in: tmux runs `mouse on`, so xterm's own
selection never runs, its link handling stands aside, and tmux's copy-mode is out of easy reach on a
touch screen. `TerminalJsLinksTest` runs the real `terminal.js` in node against a stub xterm buffer.
A URL is matched across the rows it wraps over: xterm's soft wraps, and the full-width rows a tmux
repaint or an agent's fullscreen TUI paints with no wrap flag (the desktop's `file-links.ts` URL
matcher, ported; `@xterm/addon-web-links` joins only soft wraps, so a long OAuth URL opened its first
row's fragment). A tap on a link, an OSC 8 link included (its label hides the URL), hands the bridge
the URL as the URL parser writes it and cancels the touchend, so the click the tap makes never
reaches tmux or the app in the pane; a tap anywhere else, a swipe or two fingers are left alone. OSC 8
links go through `options.linkHandler`, never xterm's `confirm()` (the WebView has no WebChromeClient
to show one), and only http(s) crosses from any way in. The app then names the host (`Open <host>?`)
and shows the URL, two lines of it until All shows the whole (a long one scrolls inside the bar), and
opens it with a browsable `ACTION_VIEW` only on Open; `ExternalLink`
(`TerminalCopyTest`) checks the URL again: http(s), a host, printable ASCII, and the host named is the
one after any user info. The key row's Copy chip opens a sheet of what the buffer holds (its last 500
rows, which under tmux is the visible screen; soft wraps joined) and the links in it. `TerminalCopyTest`
covers how `TerminalCopy` reads that snapshot, the selection (a tap toggles a line, a long-press
selects the range from the last line tapped), and the 100,000-character cap the OSC 52 copy keeps,
for Copy and Share alike. `TerminalLinksWiringTest` pins the Android half in the source, including
that every bar, card and sheet drawn over the terminal keeps a touch on it from reaching what it
covers (`blockTouchesBelow`): Compose hands a touch to the sibling below wherever the one on top has
no pointer-input node, and a background or a `Text` has none, so a tap on the bar's URL or the
sheet's title reached the WebView (a click or a scroll in the pane) or the input bar (the keyboard).
The blocker consumes nothing, since a consumed move would cancel the overlay's own taps and scrolls.
The offer, the sheet, the intents, whether a touch on them stays there, and whether a tap on a phone
produces the events the page expects are a device check. The matching shares the desktop's limits:
text that exactly fills a row can be joined with the next, a URL inside a box a TUI draws with `│` at
both edges is not joined, and each CJK character before a URL on its row shifts where a tap lands by
a column. One difference: below a run
of more than 32 such full-width rows, the desktop's join could leave out the row asked about (a
missed link there); the port's always includes it, which also keeps the Copy sheet's scan through
such a run from standing still (a test runs one).

An SSH test pins that a server which completes the key exchange and then refuses the phone's key
(or user) leaves the host-key pin empty (`A49`), and that a first connect to a server whose key the
pairing did not name is refused before the phone's key is offered, while one whose key it named
connects and pins exactly that key (`A49-anchor`). `HostCertificatePinTest` runs a MINA sshd that
presents a host certificate: the phone matches the pairing and pins by the key it certifies (not the
certificate's own fingerprint, which the desktop never reports), a reissued certificate for the same
key connects with that pin, and a pin an older build took from the certificate itself still connects
and is rewritten as the key (review of `A74-refresh`). `HostKeyAnchorsTest` checks that sshj
fingerprints GitHub's published host keys exactly as OpenSSH prints them
(`src/main/ssh-host-keys.test.ts` checks the desktop's reader against the same pair), the parsing
and the record, and that a plaintext answer's keys are ignored.
`SshFallbackTest` pins what follows a failed SSH leg (`A74`): a changed key goes on to the relay in
Auto with a warning, stops on the SSH-only route, and its text names "Only through the relay" rather
than only re-pairing; a key the computer never reported is sent to the relay without the promise
that pairing again trusts it (review of `A49-anchor`). `HostKeyAnchorsTest` also pins, in the app's
source, that its pin (`ConnectionManager.pinFor`) hands the verifier the anchors its record keeps and
that the SSH dial uses that pin: the interface's default (no anchors) would compile without it.
`LanRefreshTest` pins the refresh (`A74-refresh`): only a relay listing counts,
only a dialable IPv4 is taken, the pin gives way only to a refused key the computer reports (also when
the pin is still among them) and never merely for missing from the report, no keys leave the pin
alone, and a computer added by its SSH address or paired relay-only is untouched; `SshFallbackTest`
pins that the relay leg is handed the refused key.
The app's use of them (the relay dial behind `RelayApprovalGate`, the warning on the host screen,
the refresh after each primary relay listing, whose order in the source is pinned) is only
type-checked.

`TerminalHandoffTest` pins the terminal screen's attach hand-off (`A40`). A stream that arrives
after the screen left (back, or the app going to the background), or from an attach a newer one
replaced, is detached instead of shown. A session the phone starts keeps its stream until its launch
line is typed and the node is registered, even when the user leaves during the settle delay: the
request was consumed to get there, so a launch dropped half-way could not be retried, and would
leave an unregistered shell no canvas shows. Going to the background cancels a connect or an
approval wait, but never an attach already sent: that one still arrives, so it can be let go of and
hand its launch on. The terminal screen's use of these rules is only type-checked (its source is
pinned). Both transports also keep the `HostConnection.attach` contract that a cancelled attach
leaves nothing attached: the relay sends `pty.kill` for a stream whose caller gave up while the
request was on the wire (`RelayInteropTest`, through the desktop's real host: its viewer on the node
is released), and SSH detaches a stream whose blocking open finished after its caller was cancelled
(`SshTransportTest`: no tmux client stays attached).

`InputBarTest` pins the terminal input bar's Send (`A34`, `A41`). While no stream is attached
(connecting, disconnected, ended), nothing is sent: the screen keeps the draft and an armed Ctrl
stays armed, instead of clearing text that reached nothing. Attached, Ctrl plus one character sends
that control byte alone, and anything else goes as a paste followed by Enter. The screen disables
Send, the Resume offer and the sending key chips while nothing is attached; that part is only
type-checked. An unanswered Resume offer stays on screen, disabled, through the reattach, and can
be tapped again once the reattach has settled it (see `ResumeOfferTest`).

`TerminalPageTest` pins what happens when the terminal WebView's renderer process goes away
(`A45`). The app handles `onRenderProcessGone` instead of being killed with the renderer: it
detaches the stream, destroys that WebView and builds a new one. Each page has a generation, so a
callback the dead page posted just before the loss cannot mark the new page ready, and JavaScript
queued for the dead page is dropped rather than replayed into the new one. A paint offered before
the new page exists is kept for it. A renderer the system killed is reattached automatically once
the new page has reported its size. The renderer keeps WebView's default priority while the terminal
is visible and has it waived while it is not, so a kill in the background is expected: it is not
counted, and the terminal is reattached when the screen is started again. A crash is not reattached,
because the reattach would repaint the same screen: the screen offers "Reopen terminal" instead. More
than two kills of a visible terminal within a minute (on a monotonic clock) fall back to that offer
too. Only that automatic reattach builds the new WebView at once; otherwise it is built for the next
attach something asks for, so a page whose renderer dies as it loads is not rebuilt and lost in a
loop. A screen that was showing an answer with its own button (the session ended, the connection
dropped, "Open through the relay", or an earlier "Reopen terminal") keeps it, and nothing
reattaches unasked: over the relay, an attach to a pane that has exited creates a new, empty
session. The offer says the session is still running only when a stream was attached. The WebView
handling itself is only type-checked.

`ResumeOfferTest` pins what the terminal screen offers to type after an attach (`A15`, `A76`). A cold
attach (the computer rebooted; only the relay creates a session) gets the cold-restore line: `cd` into
the node's folder, its managed account, and for Claude the permission mode. A Sleeping (Eco-hibernated) node opened over direct
SSH gets the desktop's own wake line instead, with no `cd` and no account prefix, since the pane's
shell is the one the CLI exited back to (again the permission mode for Claude only). It is offered
only while a shell owns the pane: the phone reads the pane's foreground command
(`#{pane_current_command}`) and requires one of the desktop's own shell names (`isShellCommand`,
src/shared/agents/pane.ts, pinned by the test), the gate the desktop's wake keeps. The Sleeping flag
alone is not enough, because it can outlive the sleep. Until the A76 review the desktop cleared it
in the mirror only through its own wake, so a CLI resumed any other way stayed Sleeping there (codex
reports its start as a live state, which the renderer cleared only in its own store). The renderer
now reports that clear and the mirror applies the same rule to the hook events it records, but an
older desktop does not, and with the desktop app not running nothing hears the resumed CLI at all. So after the phone wakes a codex session, the node can still
read Sleeping, and without the pane check every later open would offer `codex resume` into the
running CLI, as a prompt. Accepting a wake clears the prompt's line first (Ctrl-U, the desktop's
kill-line) and re-checks, at the tap, that the node is still Sleeping and that a shell still owns
the pane. A shell outside the desktop's list (nu, pwsh) gets no offer. Through the relay a Sleeping
node gets no offer: the attach already asked the desktop to wake it. A shallow "Pause session" is
Sleeping in the mirror (it carries no `paused`), so it too gets only the offer, which is the explicit
Resume the desktop's PAUSED chip is; a deep pause leaves no Sleeping flag and gets nothing.
A reattach of the same screen (the stream dropped, the app went to the background) is warm, because
the cold attach created the session, so an unanswered resume is carried through it rather than
re-derived from the attach: it is kept while the computer still builds that same line and has heard
nothing from the node since (its mirror entry's `updatedAt`), re-listed right after the reattach, and
dropped otherwise, since a CLI started in the pane meanwhile would take the line as a prompt. Until
the reattach has settled it, it cannot be tapped. A wake is not carried; every attach re-derives it.
Leaving the screen and opening the node again is a new screen, whose warm attach offers nothing.
`SshTransportTest` runs the offer end to end against the real tmux: the line it types starts the
stand-in CLI in the node's own folder even with a half-typed line left at the prompt, and a stand-in
codex the phone woke, still running under a flag nothing cleared, is not offered the wake again on
the next open. The banner
itself is only type-checked.

`TerminalKeyboardChipTest` covers the key row's ⌨ chip (`A46`), which used to leave the soft keyboard
down: it only called `focus()` in the page. The chip now releases the input bar's focus, gives the
WebView Android's focus, moves the page's focus onto xterm's textarea (blurring it first, because
Blink ignores `focus()` on the element that already has focus, which is the usual state after a tap),
and then asks `InputMethodManager` for the keyboard, after the next frame, so the focus change has
been processed first. The page half runs the real `terminal.js` in node against a textarea stub that
follows Blink's rule. The Android half cannot run on a JVM, so the test pins its order in the source.
The signed-beta Pixel follow-up passes checklist item 24: the keyboard comes up and stays up
in all three focus states, with actual software input reaching the pane rather than the draft.
Other Android/device variants remain untested.

`SettingsLeaveTest` covers leaving Settings (`A44`). The system back (gesture or button) used to pop
the screen without storing the edited phone name or relay API address; only the top-bar arrow stored
them. Both now run one `leave()`, which stores, then pops. A screen taken away without a back (a
notification tap replaces the stack, a pairing link pushes its screen on top) stores the edits as it
goes, silently. Nothing is stored per keystroke. The relay address must be a full `https://` URL
(`ApiBaseSetting`: a host, no query or fragment); one that is not is left unstored, the field says
so while it is being typed, and leaving shows a message. An unusable address an older build stored
is kept without a message, but the field flags it too. Leaving without an edit stores nothing, and
the built-in relay address is never stored: "Reset to default" forgets the stored address instead.
A phone that stores none follows the default of the build it runs, so storing the default would pin
it to this build's for good. The address rule and the leave decision are unit-tested; the wiring is
pinned in the source, and whether the back gesture reaches it is a device check.

`SourceControlTest` and three relay interop tests cover the Source Control screen (`A29`). The app
already had the client half of the desktop's git bridge (`HostConnection.git`) but no screen used
it. A project's Source control (from its heading on the Sessions tab, or beside the Board's project
picker) now shows the status split into conflicts, staged, changed and untracked files, a file's
diff on either side, stage and unstage (one file or a whole section), a commit of what is staged,
push and pull, and the last 50 commits. The folder is the project's `cwd` from `projects.list`;
there is no free-form git, only the bridge's typed verbs. The interop tests run them through the
desktop's real `GitService` over a repository in the project's folder, from the status to a pushed
commit, and check that the bridge's refusals ("cwd is outside the shared project roots." for a
folder outside its jail, `..` included; "git is not served on this host." for a desktop without the
bridge) reach the phone as those sentences. A git command that fails on the computer is an answer,
not an error: `ok: false` with git's own message, which the screen shows as it is. The desktop's
status sends `U` both for an untracked file (porcelain `??`) and for a path git reports as unmerged,
and has no field telling them apart; an unmerged path is the one it sends in BOTH lists. The phone
takes those out into a Conflicts section (git's `UU`, `AA`, … with its wording), opens one as plain
`git diff` (the combined diff with the conflict markers, never the untracked form, which shows it as
a new file) and offers no Stage for it, since `git add` would mark it resolved, markers and all;
Commit says to resolve them first, as git would. An interop test drives the real `GitService` over a
merge that conflicted. The unit tests pin the reading of each reply (a reply of another shape says
so instead of showing an empty repository), every unmerged state, the diff colouring (a `+++` inside
a hunk is an added line, not a file header; a combined diff's two marker columns; the view keeps the
first 4,000 lines and says how many it left out), the parameters each verb sends, and that every
write (stage, unstage, commit, push, pull) waits three minutes rather than the usual 30 s: the
desktop sets no limit on them, and a commit runs the repository's hooks, a stage its clean filters.
A write that still gets no answer (that wait, or a connection that dropped) says it may still be
running or have finished there, and the screen reads the status again after every write, failed or
not. Whether it can open at all is decided before any request (`SourceControlGate`): a project with
no folder, one of the desktop's SSH projects (the listing names its folder, but that is a path on
the host the desktop reaches over SSH, which the bridge's jail of this computer's own project
folders normally does not include), and a computer the phone reaches only over SSH with no relay leg
each get their reason on the screen. The screen is only type-checked; its wiring (the routing
decision, the gate, every call through `connectionFor(Capability.GIT)`) is pinned in the source.

`InboxNotificationTextTest` pins what an Inbox notification says (`A52`). An approval's notification
used to carry the desktop's tool summary (the command's first line, a file path, a fetched URL), and
a finished turn's the agent's last message. Android shows a notification's full content on a secure
lock screen under its default setting, and a public version changes that only for users who hide
sensitive content, so the event's own text is now left out unless the user turns on **Settings →
Show details in notifications** (off by default). The title keeps the session and whether it needs
you or completed ("Needs you — build-bot"), and the text says the kind ("Needs approval", "Has a
question", "Finished", "Interrupted"). A public version with only that title and the computer's name
is always set. The iOS app does get the detail: the desktop sends the event's title and detail in
the APNs push body (`src/core/push-notify.ts`), and what iOS shows on its lock screen is iOS's own
preview setting. That is a difference in platform defaults, not an Android-only leak. The words are
unit-tested; the notification's use of them and the setting's default are pinned in the source, and
what a lock screen shows is a device check.

`LiveNotificationsTest` covers when notifications are posted (`A73`). The app said they were live
every 8 s while a computer was open, but only the 15-minute background check ever posted one; the
in-app refresh only updated the listing. Now every listing that arrives (the 8 s refresh of the
computer on screen, a change that computer pushes, the background check) runs the one announce path,
so notifications are live for the computer whose screen is open. All computers now watches every
paired host while visible, through the same announce path. What the user is looking at is left
out and recorded as seen instead, so no later check announces it: every event while that computer's
Inbox tab is on screen, and what a session's terminal shows while it is attached. That is recorded
even with notifications off, so turning them on later does not announce it either. Recording is
permanent, so it must never claim more than the screen shows (the review of A73): a held hook-reply
approval (it carries a `pendingId`) is announced with its terminal open, because Claude paints that
prompt only once the hold ends; a terminal showing an overlay instead of its pane (ended, relay
offer, approval code, lost view) hides nothing; and one still connecting leaves its session's events
for a later listing, which the attach settles at once from the latest listing. Other computers are not
polled while one is open, so theirs still come only from the background check, and the Settings
text, the README and the notifier's comment now say exactly that. The All computers screen (`A55`)
re-lists every paired computer every 8 seconds while visible; its first dial and subsequent polls
use AUTO, preserving a refused or unanswered approval until that computer's Try again. While its
Inbox tab is on screen every computer's Inbox counts as on screen. A computer the user just left is
one of them: its connection can stay open until it drops or the background check closes it, and a
change it pushes meanwhile is no longer re-listed (it used to be, and so announced live; the review
of A73). What that push carried is not recorded as seen, so the background check announces it. The
announce costs no network call (the listing already arrived), and the check writes the phone's
seen-log only when something is new. The decision and the screen bookkeeping are unit-tested; the
wiring into the refresh, the worker and the two screens is pinned in the source, and whether a
notification appears on a phone is a device check.

`SeenLogTest` covers the seen-log itself (`A48`, and its per-computer follow-up). It keeps each event
id with the time the phone last saw it (or the event's own time, when the computer's clock runs
ahead), and drops an entry a day after that, past the 6 h announce window, never by count (bar a
memory backstop no real Inbox reaches), so nothing still eligible is forgotten. It is kept PER COMPUTER: a desktop's
event id is `<ts>-<seq>` with a counter that restarts with each app run, so two computers can mint
the same id in the same millisecond, and with one phone-wide log the first computer's event would
have silenced the second one's notification. Every entry is filed under the pairing id of the
computer whose listing it came from, with the node its event belongs to. The node is what keeps one
event that reaches the phone through two pairings from being announced twice: a desktop's listing
carries the nodes of its SSH projects, and the SSH host it drives, when the phone added that one too,
lists the slice the desktop pushes there (`A27`), with the same event ids. So an event also counts
as seen when another pairing recorded the same id for the same node, and meeting it that way records
it under this pairing too, so forgetting the other one later does not announce it again. A real
collision, two computers minting the same id for different nodes, stays apart; the same id for the
same node on two computers would need one node id on both (a canvas committed to two repositories)
and the same millisecond and counter value. Forgetting a computer drops its entries; pairing the same
computer again (a new pairing id) carries them over, since its ids continue, so pairing again
announces nothing a second time; and nothing is recorded for a computer no longer paired. The
phone-wide log of the previous build (and the older bare id set) migrates on first use as seen for
EVERY computer, because it never said which computer an entry came from; those entries age out a day
after they were last seen and nothing new is added to them, so an upgrade announces nothing again
and the old phone-wide behaviour lasts only that day, for those ids alone. The log's rules are
unit-tested; which computer each caller names is pinned in the source.

`NotificationActionsTest` covers answering from a notification, and where its tap goes (`A25`, the
in-app part). A notification had no actions, and its tap opened only the computer's Inbox. Now an
approval carries Approve and Deny and a single-select question its options, and the tap opens that
session's terminal, with the computer's Inbox one Back away. Which actions an event gets is the pure
`InboxNotificationActions.plan`, on the Inbox card's own rules: Approve and Deny only where
`QuickActions` can answer from outside the session (a held ticket, or a claude prompt), options only
where `QuestionChoices` lists them as answers, and at most three, Android's limit. A question with more
options, a multi-select one, another agent's approval without a ticket, and a computer the phone could
reach only through a first relay handshake get Open instead. With "Show details in notifications" off
the options are labelled "Option 1", "Option 2", … (`A52`). A tap reaches an unexported receiver
through an explicit, immutable PendingIntent. The receiver takes the actions off the notification
("Approving…", so a second tap cannot send a second answer) and hands the answer to expedited work, one
per event. The work connects the way the background check does and never makes a first relay
handshake, since the user tapped but is not looking at the app to compare the desktop's code (`A05`):
it reuses a connection already open, or takes the SSH leg or a relay that has already approved this
phone; otherwise the notification says to open the app. The phone cannot tell whether it is on a
computer's network before it dials, so a computer paired with an SSH key always gets the answers; one
tapped away from its network goes through a relay that has already approved this phone, or is not
sent ("couldn't reach"). Open replaces the answers only for a computer reached through the relay
alone that has not approved this phone; the listing that raised the notification normally came over
that relay and approved it. The answer is `QuickActions`', with its re-checks (still unresolved, the
node-state rules, the ticketed path of `A38`, and keys only for a card the computer still lists, since
a notification outlives the card in the desktop's feed), and it is sent at most once: a run
WorkManager starts again by itself after an interrupted one (the system stopped the work, or the
process died during it) sends nothing and says the answer could not be confirmed
(`InboxNotificationActions.answerOnce`, on the run attempt count). The answer, the background check
and the screens share one connection per computer, which is closed when a background job ends only if
no other job and no screen still uses it (`ConnectionUsers`). The notification then says how it went.
"Approved.", "Denied.", "Answered with option N." and "Already handled." go away after 10 s; a
timed-out hold, a request only the session can answer, an answer not sent (and why) and one that could
not be confirmed stay, and their tap opens the session.
The app does not open the session by itself at that point: Android 12 forbids starting an activity
from a notification's receiver or service (a "trampoline"), and Android 10 forbids starting one from
the background, so the notification says "Tap to …" instead. An answering action needs an unlocked
phone: Android 12 and later ask for the unlock before they send it (`setAuthenticationRequired`);
Android 11 and lower send it from a locked screen, so there the receiver refuses and says to unlock.
The plan, the answer run against `QuickActions` (every answer the plan offers is one `QuickActions`
sends, and none is typed for a card the feed dropped), the work's whole run (a rerun sends nothing,
every dial happens while the connection is held), the outcomes and the hand-off's encoding are
unit-tested, and `ConnectionUsersTest` covers the shared connection (two overlapping jobs close it
once, after the last); the PendingIntents, the receiver, the work, its dial trigger and the tap's
route are pinned in the source, and whether the actions show and answer on a phone is a device
check.

`AllComputersTest` covers the All computers screen and the needs-you counts (`A55`). iOS merges its
Agents feed across every paired connection and shows one Usages section per connection that reports
usage (docs/mobile-usage-inbox.md); Android had one computer's Inbox and Usage, inside that
computer's screen, and the computers list showed no count. Now each computer's row shows how many of
its approvals and questions are open, read from the listing its session already holds (the open
screen's, the background check's, or the last one this process made), so the list dials nothing;
before a computer's first listing in a process its row shows no count. With two or more computers
paired, the list starts with "All computers": every computer's Inbox and Usage on one screen. The
rules are the pure `AllComputers` and `InboxFeed`: events of every computer newest first (a stable
sort, so the same moment keeps the computers' order), open cards above the archive, the working
sessions in the computers' order rather than by time (their time moves with every tool call), every
card keyed and labelled by its computer (a name two computers share gets `user@host`, and the same
computer paired twice a number), and one Usage section per computer whose mirror has accounts in its
`usage` block. A computer's own Inbox tab is the same `InboxFeed` of that one computer, so the two
cannot sort or count differently. Opening the screen (and coming back to it, or Refresh) re-lists
every paired computer once through its normal connect path, so a relay leg goes through
`RelayApprovalGate`; it is not polled after that. That re-list is the app's own foreground refresh
(`Trigger.AUTO`), not a tap on each computer: a computer that has never approved this phone shows its
approval code on this screen, labelled with its computer, but one whose approval was refused or went
unanswered keeps its hold, and says so with a Try again of its own (`Trigger.USER`). Lifting every
hold on every visit would raise the desktop's dialog again, each time, on a computer the user did not
ask about and may not be at (`A05`/`A23`). A computer whose last listing failed says so too, with the
same Try again, also when the failure dropped its connection (an error the phone did not expect leaves
the session idle): nothing on this screen re-lists it on its own, so its cached cards would otherwise
stay on screen looking current. A computer's own screen shows that error under the same rule
(`ConnState.showsListError`). Open, Approve and Answer on a card go to the card's own
computer: its session and connection, and its relay leg for a node of that computer's SSH projects.
The cards are the Inbox tab's composables (`InboxFeedList`, `UsageCard`), not copies. The rules are
unit-tested; the screen, the row count and the route (saved in the back stack as `["all"]`, a name
of its own, so every earlier entry restores as before and a build that does not know it drops just
that entry) are type-checked and pinned in the source, and how the screen looks and answers on a
phone is a device check.

`PhoneIdentityTest` and `BackupRulesTest` cover what leaves the phone (`A51`). `allowBackup="false"`
stops cloud backup, but an app that targets Android 12 or later is still copied by a
device-to-device transfer unless its data extraction rules exclude it. The transfer carried
`nodeterm.hosts` (every paired computer, its SSH pin and the phone's relay deviceId) to the new
phone, while the Keystore-sealed secrets could not follow. The manifest now names rules that exclude
every domain from both cloud backup and device transfer, so a new phone starts unpaired.
`BackupRulesTest` pins those files and checks that every preferences file the app opens is covered;
what a real transfer copies is a device check. Independently of the rules, the relay deviceId now
goes with the box key (`PhoneIdentity`): when the key has to be created (absent, or provably lost),
the stored deviceId is removed first, durably, and a deviceId is minted only once the key exists. A
phone whose key was lost therefore registers with the relay backend under a new id instead of
re-registering the old one without its previous device token, which the free tier can refuse (per
the desktop's note on `priorDeviceToken` in `pairing-service.ts`; the backend is not in this repo).
From this build on, it also no longer shares a device row with the phone it was copied from, so
removing one pairing on an entitled desktop cannot revoke the other phone. The old row is left unused
on the backend, as after an uninstall. An existing install keeps its id while its key still opens,
so a phone whose key an older build already replaced keeps the id it had (and any row it shares)
until the app is reinstalled.

`KeyboardInsetsTest` covers the soft keyboard on Android 15 (`A77`). The app targets API 35, so on
Android 15 its window is edge-to-edge whether it asks or not: the keyboard no longer resizes the
window, and its inset reaches Compose instead. The terminal screen added the keyboard's inset on top
of the Scaffold's padding, which already held the navigation bar, so with the keyboard up the
navigation bar was counted twice. Pair and Settings, whose text fields sit in a scrolling column,
made no room for the keyboard at all. All three now go through one helper (`aboveKeyboard`), which
consumes the Scaffold's padding before it adds the keyboard's inset, and which comes before the
scroll, so the keyboard shrinks the visible part instead of padding the end. The app still does not
call `enableEdgeToEdge()`: on Android 8 to 14 the window keeps fitting the system bars and makes room
for the keyboard itself, as before, and the helper adds nothing there. Text fields in dialogs are left
alone: a dialog is a floating window, and the framework clears inset fitting only for non-floating
windows (read from Android 15's `PhoneWindow` classes, not measured). The test pins the helper, that
nothing else asks for the keyboard's inset, and that every Scaffold body with a text field uses it;
how the screens and the dialogs look with the keyboard up is a device check.

`DictationTest` covers dictation into the terminal's input bar (`A59`). The phone had none: iOS and
the desktop dictate with on-device Whisper, and Android had only the keyboard's own voice typing,
which still works in the field. Now a mic button beside Send runs Android's `SpeechRecognizer` and
writes what it hears into the draft, and never sends it: the draft reaches the pane only on Send,
the desktop's rule for its own dictation ("nothing auto-submits"). The rules are the pure
`Dictation` machine. Its phases are idle, listening, partial (words heard so far, shown in the draft
as they come), finishing and an error with a short sentence. A tap on the mic while listening asks
for the final result (finishing), and a second tap cancels, so a recognizer that never answers
cannot keep the button stuck. The final result is an event that fills the draft and returns to idle.
The draft as it was when the dictation started is kept, and the heard words are appended after a
space (none after a trailing space or newline). Each partial result replaces the previous one rather
than piling up, and a blank final result keeps what the partial results showed. Each time dictation
writes the draft the cursor goes to its end, after the heard words, so typing after a dictation
continues there. (The draft was a plain string at first, and the field's string overload keeps the
previous cursor when the text is set from code: after dictating into an empty draft the cursor stayed
at the start, and the next keystroke went in front of the words.) Any other change to the draft's
text while listening (typing, or Send clearing it) ends the dictation, so its late results cannot
bring back text that was sent or deleted; moving the cursor changes no text and ends nothing.
Whatever the draft shows when a dictation is cancelled or fails stays in it. Each of the 15
`SpeechRecognizer.ERROR_*` codes maps to a failure with a short message, and any other code to a
generic one; a test reads the codes out of the android-all jar the type-check compiles against,
and is skipped where that jar is not in the Gradle cache (CI). The microphone permission (`RECORD_AUDIO`) is asked for on the first tap. A refusal says
how to allow it, and the manifest does not require a microphone. The button is hidden when
`SpeechRecognizer.isRecognitionAvailable` is false, which on Android 11 and later needs the
manifest's `<queries>` entry for `android.speech.RecognitionService`. The screen cancels a dictation
when it stops (nothing listens in the background) and releases the recognizer when it goes.
Settings now offers a searchable language/region picker (A114). System default omits
`RecognizerIntent.EXTRA_LANGUAGE`; an explicit choice sends its canonical BCP47 tag, frozen for
that utterance. The locale catalogue describes language names, not installed-model support.
Native unsupported/unavailable errors remain visible. The desktop defaults to `auto`, Whisper's
own detection. The recognizer is
the phone's recognition service (Google's on most phones), which may send the audio to its servers,
unlike Whisper. The machine and the error codes are unit-tested; the recognizer's wiring, the
permission request and the manifest are pinned in the source; how the dictation sounds and behaves
on a phone is a device check.

## Device checklist

A later Pixel 7a beta21 pilot verifies recovery from a 45-second stop of one old SSH peer,
retained draft text/glyphs and one subsequent Send/application ACK. This narrower case does not
pass item 14's whole-host/network scope or change the original 64-row results above. See
[the bounded receipt](#silent-ssh-peer-recovery-and-single-send-2026-10-08).

Partial results are recorded in "What is verified, and how": beta 10 / code 11 is installed on
the intended Pixel 10 Pro, with its exact APK hash/retained signer, non-debuggable metadata,
install identity, notification grant and its saved desktop-issued pairing/relay reconnect/input
preserved. The update preserves one owned second SSH pane, then the focused A91/A94 two-End/Home
recreation cycle passes. The three-shell update is historical beta8→9 proof. Focused A90 Home/project/
custom creation, cwd/input/history, restart/reconnect and exact End pass on beta 8/9; item 32 is
Partial; beta 10 relay plain-shell creation/input/End also pass. The tally is 10 Pass / 22 Partial / 32 Pending; managed and cellular creation
remain open; A91's otherwise-empty-host variant passes on Oct4. The following historical beta-6 evidence uses Android 17 /
API 37 and Vanadium WebView `154.0.8037.92.0`, with manual SSH key/pin authentication, 17 real
projects listed and basic terminal input executed. The wrong
MI8 installation and its newly authorized SSH key were removed. The terminal-sizing/history
failure `A85` is fixed in code-3 beta, with a 52×45 viewport and pre-attach tmux history visible after
swiping. The code-4 scroll mitigation update also preserved SSH registration/key/pin and notification
permission and verified reduced drag gain, reversal and Esc cancellation. Beta 4 delivered more
movement but lacked momentum; the then-installed code-6 beta implements bounded fling/native stop but
still loses continued swipe/release events (`A89`). Code 7 received a same-signer update preserving
app data and notification permission; SSH reopened with the retained key/pin at 56×48. Controlled
continuous drag, coast and Esc stopping pass; a held touch stops coast at a stable 56×25 viewport.
Earlier IME-resizing touch checks were inconclusive; the user confirms normal drag/coast both
work now. The current verified Pass items are 1, 18, 19, 21, 22, 24, 36, 38, 39 and 51; all other items
are Partial or Pending as recorded in the 64-row table above, with named conditional SKIP variants.
Real SSH background/detach recovery, encrypted paste pairing, relay-only hosted browse/input and
the synthetic shipped-hook lifecycle are verified;
outage/cellular-relay and remaining lifecycle
checks stay open. The user resumed remaining Pixel release checks on 2026-10-04 after the hike. Run these
on a real phone against a real desktop and record, for each item, pass or
fail, the phone model, its Android and WebView versions, the desktop's OS and nodeterm version, and
the route (network or relay). Write the results into "What is verified, and how" above, and turn each
failure into a new finding. Every item names the audit finding it checks; `A65` marks the baseline
checks that finding asked for, where the feature table is the only claim. An item that needs
something a tester may not have (a Windows desktop, Android 15, a second phone, a release key) says
so; skip it and record why. The list starts from the 23 items the handover drew up and adds what each
later fix left to a device.

### Install, update and what stays on the phone

1. For beta readiness, install two consecutive private betas using the same private signer and
   increasing version codes; pair on the first and update to the second without uninstalling, keeping
   the pairing. The installed beta 10 / code 11 already retains the desktop-issued pairing;
   test its next same-signer higher-code update. Do not downgrade or uninstall the working app.
   Also check the committed-debug-key path separately with two CI debug APKs (artifact
   `nodeterm-android-debug`). Migrating from debug to private beta needs one deliberate uninstall
   because the signing certificates differ; revoke the stale phone entries and pair again.
   *(A10)*
2. Pairings survive a restart: force-stop the app, reboot the phone, reopen the app. The computer is
   still listed and connects on both routes without pairing again, the desktop's Settings → Phone
   still shows one entry for this phone, and no new relay approval is asked for. *(A24, A65)*
3. Uninstall, then install again: the app starts with no computers (its Keystore key and data went
   with it). Pairing the same computer again works, relay included, also on a desktop without Pro.
   Revoke the stale entry on the desktop. Then do it once more with Clear storage (Android Settings →
   Apps → nodeterm → Storage) in place of the uninstall. After either one the phone has a new
   identity, which the README's recovery after adb access depends on: on a macOS or Linux desktop the
   key the new pairing adds to `~/.ssh/authorized_keys` differs from the stale entry's, and the box key
   the desktop pins (`remote-approved-devices.json` in its app data) differs from the old one.
   *(A51, A65, A50)*
4. Android 12 or later, with a second phone: a device-to-device transfer ("copy apps and data" in the
   new phone's setup) leaves the app there with no computers and no pins. Pair it too, then revoke
   one of the two phones on an entitled (Pro) desktop: the other keeps working. A cloud backup
   restored onto a fresh install brings back nothing of the app either. *(A51)*
5. With the private-beta signing key: install the signed, minified release APK and run the pairing,
   SSH, relay, OSC 52 copy, links and Copy sheet, and background-notification items on it, since that is where code R8 could
   have broken runs (BouncyCastle's provider tables on the first connect, the WebView bridge, the
   WorkManager worker). An error message names a real exception class, not an obfuscated one.
   `adb shell run-as dev.nodeterm.android` is refused on it, while on the debug APK it opens a shell
   in the app's data, which is what the README's debuggable warning says. *(A37, A50)*

### Pairing

6. Pair by QR from the Pair screen's scanner with a macOS desktop, then a Linux desktop, then a
   Windows desktop. The Windows QR carries `"ssh":false`, so that pairing is relay-only, and a failed
   relay mint pairs nothing. *(A65)*
7. Pair by pasting the code's text, and by scanning the desktop's QR with the phone's own camera app.
   The desktop's QR is raw JSON by default, which a camera app shows only as text: check that nothing
   opens. For the camera, first choose "Scan with the phone's Camera app instead" under the QR in the
   desktop's Settings → Phone (the quick-pair popover has no such switch); that QR carries the
   `nodeterm://pair?code=…` link, which the camera hands to the app. Scan it once with the app closed,
   once with it open on another screen. Deny the camera permission: pasting still pairs. *(A65)*
8. With remote access on, against a current desktop: the Pair screen says "Remote access is on", the
   pairing ends with "Paired, and approved for remote access.", and the first relay connect later
   raises no SAS dialog on the desktop. Revoke the phone there (Settings → Phone → Revoke) while it
   has a terminal open over the relay (route Only through the relay): that terminal ends at once, SSH
   is refused, and the phone's automatic redial shows a code for a few seconds and then says the
   computer did not approve it, while the desktop shows no dialog at all; it stops dialing until Try
   again, which ends the same way. Restart nodeterm on the desktop and tap Try again: now the SAS
   dialog appears (deny it). Against an older desktop the toast says an approval is still owed, and
   the first relay connect shows the code. *(A07, A07-revoke, A93)*
9. A pairing code whose computer does not answer (the desktop quit after showing the QR, or the phone
   is on another network) ends within about 45 s with a sentence, not an exception name, and Back
   during the wait works without a hang. An expired or already-used code shows the desktop's one-line
   refusal. *(A54)*

### Connecting

10. On the LAN (route Automatic): the Sessions tab shows the desktop's projects and sessions, grouped
    Needs you / Running / Sleeping, with activity and context %. *(A02, A65)*
11. Pair with a current desktop (macOS and Linux), then connect over the network: the first connect
    is accepted (the key the computer's sshd serves is one the pairing named) and pins it, and later
    connects use it silently. Then present a different key at that address (another SSH-running
    machine takes the desktop's LAN address, or the desktop's host keys are regenerated): on
    Automatic the phone refuses SSH, connects through the relay and keeps a warning on the host
    screen that names "Only through the relay"; on "Only on my network (SSH)" it stops with the
    warning. Do the same once between pairing and the first connect: the phone says the key is not
    one the computer reported, and pins nothing. With a current desktop, move it to another address
    on the LAN while the phone is away and connect through the relay, then come back: the next
    connect on the network dials the new address. Regenerate its host keys instead: the next connect
    on the network is refused and goes on to the relay, and the host screen's warning adds that the
    computer confirmed the key its SSH server presented; the connect after that (once the relay
    connection has ended) accepts the new key without pairing again. With sshd serving a host
    certificate, the pin is the certified key (`ssh-keygen -lf` of its `.pub`), and a renewed
    certificate connects silently. On a Linux computer, make sshd serve only a key the desktop
    cannot see (a `HostKey` outside `/etc/ssh` with no `.pub` beside it) and pair: the phone refuses
    SSH, connects through the relay on Automatic, and its warning says that pairing again changes
    this only if the keys changed.
    *(A49, A74)*
12. On cellular, off the LAN: connect through the relay. The desktop shows the SAS dialog and the phone
    shows the same code; approve. Reconnect later: no second prompt. On another pairing press Deny: the
    phone says it was not approved and does not dial again until Try again. Briefly enable airplane
    mode during connection, then recover: a stalled relay token request fails within about 30 s
    rather than connecting indefinitely; leaving the screen cancels it, and reopening can connect.
    *(A65, A30, A81, A93)*
13. Leave the phone in the background for 15 minutes or more with a paired computer that has never
    approved it over the relay: no SAS dialog appears on the desktop. *(A05, A17, A23)*
14. Put the desktop to sleep (or pull its network) while the phone is connected over SSH: within about
    45 s the phone notices, and on Automatic it moves to the relay or says the computer is offline.
    Waking the desktop reconnects. *(A31)*
15. Open a computer and go Back before it has connected, several times in a row: no connection error
    is recorded for it, and the next open connects normally. *(A20)*
16. Change a computer's route in Settings → How to reach each computer and check that the next connect
    follows it; forget a computer; pair two computers and move between them. *(A65)*
17. Pair while the desktop's remote access is off (the toast says the phone is approved for remote
    access once the computer offers it), then turn it on and open the computer over the network: the
    host list gains "From anywhere" without the app being restarted. Then take the phone off the LAN
    with the app in the background for 15 minutes or more: the background check reaches the computer
    through the relay, and the desktop shows no SAS dialog; its `remote-approved-devices.json` now
    lists the phone's key. Open the computer off the LAN: it connects through the relay, again with
    no dialog. Revoke the phone on the desktop, pair it again with remote access off, and adopt the
    relay as above: still no dialog. The host list stays smooth while a connection is being made.
    With a legacy pairing lacking a relay key association, approve its first relay handshake and
    verify its retained SSH identity repairs only that entry. Revoke it: only its last-key session
    closes; another pairing authorizing the same key stays retained. Missing seed/key attribution
    must keep browsing usable and revoke unconfirmed; a network close during proof must not report
    connected or falsely report Deny after approval. These additional physical cases are pending.
    *(A47, A65, A07-late, A93, A118)*

### Terminal

18. Open a terminal over SSH and type with the soft keyboard. Rotate the phone. Use A−/A+ and every
    key chip (Esc, Tab, ⇧Tab, the arrows, ⏎, ⇧⏎, ^C, ^D, ^R, ^L, Home, End, PgUp, PgDn): the
    connection survives all of it. *(A01, A04)*
19. Non-ASCII renders over SSH: Claude's rounded borders, accented letters, CJK, emoji. *(A03)*
20. Swipe to scroll the tmux history. A copy the pane makes reaches Android's clipboard (OSC 52) with a
    "Copied N lines" toast: in tmux's copy-mode (Ctrl, then b, then [ from the key row and the input
    bar), or from an application such as vim (`"+y`). Record slow/fast drag gain, reversal and
    movement after finger lift, stopping on a new touch, and automatic focus/mouse reports during a
    drag. Keep moving through terminal redraws and check that the remaining drag and release still
    work. With inert native history open, fling, then hold, move or cancel a touch on the displayed
    Live button: momentum and pending scroll stop immediately, without closing history until click.
    Click Live to return to live output; a late old page must not reopen history.
    *(A65, A85, A86, A87, A89, A130)*
21. A large OSC 52 copy. In the pane, run
    `printf '\033]52;c;%s\a' "$(head -c 150000 /dev/zero | tr '\0' x | base64 | tr -d '\n')"`
    (the desktop's tmux passes an application's OSC 52 on): the phone says it is too large to copy and
    nothing crashes. With 450000 in place of 150000 the page refuses it before it crosses the bridge,
    with the same message. With 90000 it is copied, or, if the system refuses a clip that size, "Could
    not copy: too large for the clipboard." shows; never a crash. *(A53)*
22. Invalid OSC 52 is ignored silently: a payload that is not base64, one with no `;`, a `?` read
    query, and a selection field longer than 16 characters copy nothing, show nothing and leave the
    clipboard as it was. *(A53)*
23. The terminal uses its visible viewport height on initial open, after changing font size and
    with the keyboard shown/hidden; its host receives more than one row when the viewport has room.
    "Sized to another screen · Fit this screen" appears when the desktop's view of the session is
    larger, and Fit works. *(A65, A85)*
24. The ⌨ chip raises the soft keyboard, and it stays up, in three states: right after the terminal
    opens, before the page was ever touched; after tapping the terminal and then dismissing the
    keyboard (the page's input already has focus); and while the input bar has focus. The keys then
    go to the pane, not to the input bar. *(A46)*
25. With a terminal open, turn on airplane mode: the input bar's draft stays (Send, the sending key
    chips and Resume are disabled, and the keyboard's Send leaves the text in place). Turn it off: the
    terminal reattaches by itself ("Disconnected. Reconnecting…" clears) and the draft then sends. Arm Ctrl and send "c" from the input bar: the
    pane gets ^C, with no Enter after it. With continuous numbered output, background and resume
    repeatedly: each reattach paints its own snapshot without replaying the previous viewer's
    buffered bytes. A current terminal's final tail remains visible before its exit. After a known
    SSH/tmux viewer ends, its last visible pane and Copy/links stay on the same page; a retired EOF
    cannot restore them into a new viewer. *(A41, A34, A36, A131, A133)*
26. The terminal WebView's renderer goes away. A kill while the terminal is on screen: the app stays
    open and the terminal is rebuilt and reattached by itself; a third kill within a minute offers
    "Reopen terminal" instead. A crash offers "Reopen terminal", never an automatic reattach. A kill
    while the app is in the background: the terminal is back when the app returns. A kill while the
    screen shows "The session ended", "Open through the relay" or "Reopen terminal": that answer stays
    and nothing attaches. One way to provoke them, not tried: on an emulator with `adb root`, `kill -9`
    the WebView's renderer process for a kill; a crash needs the renderer itself to crash (for
    example `chrome://crash` from DevTools). Old buffered output and commands waiting for page
    readiness must not cross into the replacement viewer. *(A45, A131)*
27. Send the app to the background with a terminal attached through the relay, for a few minutes: the
    desktop's view of that session is no longer held to the phone's size, and the 8 s refresh stops.
    Coming back reattaches. *(A18)*
28. On the desktop, open the project of a session the phone is attached to, so the desktop mounts that
    node: on the updated host both relay and direct-SSH phone views stay attached. Repeat both
    attachment orders, unequal grids and a desktop remount. Older hosts may detach; Android then
    reattaches rather than saying the session ended. New variants remain Pending. *(A13)*
29. A Sleeping (Eco) session opened over direct SSH offers "Wake <agent>" while a shell owns its pane.
    The tap wakes the conversation, and opening it again (the CLI now running) offers nothing. Through
    the relay, opening it wakes it with no offer. Verify capable agents retain their actual host's
    project approval policy on wake, including non-Claude agents. *(A76, A103)*
30. Reboot the desktop, then open a session through the relay: the resume offer appears, and Resume
    continues the right conversation, in the node's folder, under its Claude account and with the
    project's permission mode. Drop the connection before tapping it: the offer comes back with the
    reattach and can be tapped once the reattach has settled. Over direct SSH such a session is not
    created: the phone offers "Open through the relay". Repeat non-Claude resumes with their
    measured approval flags and available old/new Codex vocabulary; unsupported modes keep the
    actual CLI default. *(A15, A16, A41, A08, A102, A103)*
31. A session of one of the desktop's SSH projects: over direct SSH the phone offers the relay
    instead, and through the relay it opens on that project's host. *(A09, A28)*

### Sessions, the board and new sessions

32. New session from the phone (Claude, then a shell), through the relay: the node appears on the
    canvas, the agent runs in the project's folder, and its status badges update on both sides; a
    Claude permission prompt reaches the phone's Inbox as an approval. Managed Claude accounts are
    named by their label or email in the picker, the session row and the Usage card, never by an id.
    Repeat against a Windows desktop: the session starts in the project's folder under the chosen
    account there too. On a current desktop, verify trusted project env/shell overrides on a cold
    relay launch; denied/untrusted executable settings cannot run. Saved owner/account/agent facts
    override conflicting create hints, and joining a warm session does not change its launch facts.
    Repeat with capable non-Claude agents and their project approval modes; verify the host Codex
    vocabulary and unsupported-mode defaults against the actual CLI, without a sandbox bypass.
    With an updated enabled Linux/macOS tmux host and beta 14, repeat New session over direct SSH
    for a shell and managed Claude account. Confirm real cwd/account/environment/hooks, canvas
    registration and Inbox status; dismiss/background during creation, restart the app and reconnect.
    Lost replies, a restarted service, changed account/folder or replaced/multiple panes must require
    inspection without creating or launching again. A confirmed viewer retains normal reconnect.
    This new variant is Pending and does not inherit the earlier relay/plain-shell passes. *(A111)*
    Separately, on the intended Pixel's installed beta 10 / code 11
    over manual SSH/WireGuard use Sessions → New terminal → project folder → Create, then create
    another in Home; also check a custom absolute folder. Confirm real shell cwd, input and history; disconnect/reopen and
    restart the app so both remain in Phone terminals; end only the owned session and confirm
    the other survives. Existing desktop sessions/project files/canvas stay unchanged. This
    does not verify relay registration, managed-agent launch or account selection.
    On an otherwise empty SSH host, end the last owned phone shell: its row disappears after
    refresh, while the host stays connected over SSH and New terminal remains available.
    *(A72, A33, A14, A39, A75, A90, A91, A94, A102, A103)*
33. New session, then Back within a second of Start (before the launch line is typed), and once more
    by sending the app to the background right after Start: both times the node still appears on the
    canvas with its agent running, not a bare shell. *(A40)*
34. With the New-session dialog open, close the selected project on the desktop (or remove the
    selected account): within a refresh the dialog moves to a project it still offers, or disables
    Start with a line saying why; nothing crashes. *(A42)*
35. Wake, refresh, rename and end a session from the phone, through the relay and with the
    current Desktop SSH actions service and remote access off. Wake an eligible Sleeping node in
    an inactive and closed project without switching desktop tabs; explicit Pause stays respected,
    a replaced/exited pane refuses, and an old backend is not restarted. Refresh/Rename receipts
    prove nudge delivery; inspect the actual result separately. *(A65, A104, A108)*
36. Board: move a card, add and remove a label, create a new one; the desktop's board updates
    without a reload. Repeat through the current selected-profile SSH service with remote access
    off, alongside mounted desktop edits, and on Server Board. A replaced/stopped service or lost
    receipt never reports success or retries the mutation through another transport. *(A65, A95, A108)*
37. On the Board tab, pick a project and scroll; open a terminal and come back: the same tab, scroll
    position and project. Switching tabs and back keeps them too. *(A43)*
38. Kill the app's process in the background (Developer options → "Don't keep activities", or
    `adb shell am kill dev.nodeterm.android`) and reopen it: the screen and the back stack are
    sensible, and the tab is kept. *(A22, A43)*

### Inbox, notifications and usage

39. Approve and deny a held Claude permission from the Inbox within 45 s. Answer one after its
    hold has expired: the phone must not report success. On an eligible v2 ticket, confirm the exact
    Always allow rule/destination on relay and SSH; verify actual CLI application and its settings
    scope. Changed/expired/no-suggestion requests offer no remembered answer and never type 2.
    *(A06, A35, A56, A105)*
40. A subagent's approval while its parent waits on a question: Approve from the Inbox answers it,
    rather than saying "Already handled." *(A38)*
41. Answer complete held AskUserQuestion cards through relay and SSH: single/multi selections
    and 2–4 questions, exact labels, every question required, input preserved and actual CLI result.
    Expired/replaced/unsupported tickets never type guessed keys; older phones open held v2 cards.
    Separately test an unheld legacy single-select with the pane in copy mode: the answer reaches
    the application and leaves copy mode on both routes. Legacy multi-select offers Open session.
    Repeat mounted and offscreen/released relay background answers; a missing session must not
    type into a longer session name sharing its prefix. *(A12, A57, A65, A78, A79, A80, A106)*
42. Open a finished session on the phone: the desktop's unread dot clears. On a host that runs its
    own nodeterm and is driven over SSH by another desktop, repeat for each desktop's sessions while
    both sweepers run: the owning desktop's unread dot/Done card clears and the other's pending
    acknowledgment is retained for its owner. Repeat with two SSH projects on the same host and
    after an owning desktop restarts with an old unresolved Done card. *(A65, A82)*
43. A background notification arrives within about 15 minutes; tapping it opens that session's
    terminal, with that computer's Inbox one Back away: at launch, with the app in the background, and
    with the app open on another computer. *(A11, A19, A25)*
44. Notification permission on Android 13 or later: deny it at first launch; Settings → Notifications
    then reads Off; switching it on asks again or opens the app's notification settings; nothing is
    posted while it is denied. *(A21)*
45. Live notifications for the computer on screen: with its Sessions tab open, a turn finishing on the
    desktop raises a notification within about 8 s; with its Inbox tab open, none, and none later;
    with a session's terminal attached, none for that session, except a held hook-reply approval.
    Another paired computer's events arrive only from the background check. *(A73)*
46. Each event notifies once: an event announced once is not announced again by later refreshes, by
    the background check, or after the next APK is installed over this one. With a desktop paired and
    the SSH server one of its projects runs on added too (item 64), an approval in that project
    notifies once, not once per computer, and reading it on either computer's Inbox keeps the other
    quiet. *(A48, A27)*
47. The lock screen: with "Show details in notifications" off (the default), a notification shows its
    title ("Needs you — <session>" or "Completed — <session>"), the kind and the computer, but no
    command, question or last message; turned on, the shade shows those too. With the lock screen set
    to hide sensitive content, only the title and the computer's name show there, either way. *(A52)*
48. The Usage tab shows a pace line ("5h usage pace faster", "slower" or "on pace") when a limit's reset
    time is known, and none when it is not. Approval, question and done cards show the node's context
    ring and "N% context", matching the desktop's meter. *(A58)*

### Settings and system UI

49. Settings: edit the phone's name and the relay API address, then leave with the system back gesture:
    both are stored (reopen Settings to see). An address that is not a full `https://` URL shows the
    field's error and a toast on leaving, and is not stored. "Reset to default" forgets a stored
    address. Leaving without an edit stores nothing. *(A44)*
50. Android 15 (edge-to-edge) with the soft keyboard up: the terminal sits right above the keyboard
    with no extra gap the height of the navigation bar, and the Pair and Settings text fields scroll
    into view above it; the label and rename dialogs look right. On Android 8 to 14 the same screens
    are unchanged. *(A77)*
51. Light and dark system theme; a tablet or a foldable if one is available. *(A65)*

### The relay leg next to SSH

52. On the same network with Automatic, compare the current SSH actions service and an older
    desktop: current Board/Wake/Refresh/Rename work over SSH with remote access off; older hosts
    need the allowed relay and show the reason when unavailable. Canvas New still needs the relay.
    With Only on my network, no action silently opens relay. A submitted unanswered SSH mutation
    is not replayed after reconnect. Desktop-owned SSH-project metadata can use its service;
    opening/typing/ending that third-machine terminal still needs its relay. After toggling remote
    access, old-host relay availability updates within a listing. *(A26, A108)*
### Source control

53. Open Source control from Sessions/Board through relay and direct SSH, including remote
    access off and Only on my network. Status/diff/history match the actual repository; stage,
    unstage, commit, push and pull show confirmed results. Test spaces/newlines/Unicode and
    dash/pathspec-like filenames, nested repositories, symlink escape refusal, no-folder and
    third-machine projects. Conflicts remain unresolved in the screen; a long hook completes
    within the write deadline. A rejected remote mentioning set-upstream never triggers a second
    push. Lost/missing status retires the SSH connection without a replay or success. *(A29, A107)*
### Links and copy in the terminal

54. Print a URL long enough to wrap over several rows, e.g.
    `printf 'https://example.com/%s/end\n' "$(head -c 300 /dev/zero | tr '\0' a)"` in a shell, and
    ask a Claude session to print one: tap the URL on its first, a middle and its last row. Each time
    a bar names the host and shows two lines of the URL, and nothing reached the pane (no click in
    Claude, no soft keyboard). The bar's All shows the WHOLE URL, scrolling inside the bar when it is
    long: the printf one starts `https://example.com/` and ends in `/end`, wherever the tap was; Less
    shortens it again. Open opens the browser on the whole URL; Copy puts it on the clipboard ("Copied
    the link"); × closes the bar. A tap or a drag on the bar's text, away from its buttons, changes
    nothing: no click or scroll in the pane, and the bar keeps its link even with another link under
    that spot. A tap on plain text, and a swipe that starts on a URL, behave as before. *(A32)*
55. An OSC 8 link: `printf '\033]8;;https://example.com/osc8\033\\label\033]8;;\033\\\n'` in the
    pane, then tap "label": the bar offers example.com and opens `https://example.com/osc8`. The same
    with `file:///etc/passwd` in place of the URL offers nothing. With a mouse connected, a click on a
    link in a session that is not under tmux (a Windows computer's), where the pane does not report
    the mouse, offers it too. *(A32)*
56. The key row's Copy chip opens a sheet of the screen's lines (with a session that is not under tmux,
    some scrollback too) and, above them, its links with Open and Copy. Tap lines to select them,
    long-press one to select the range from the last line tapped; Copy puts them on the clipboard
    ("Copied N lines"), Share opens the system share sheet, and Back or × closes the sheet. The sheet
    opens on the line at the top of the screen. A tap on the sheet's title, its instructions or its
    "No lines selected" line does nothing: no soft keyboard comes up, and nothing reaches the pane
    under the sheet (after closing it, the pane shows no click or scroll there). Separately, Find
    searches text emitted before attachment in the computer's retained history on both routes:
    literal case-sensitive query, line numbers, caps, Previous/Next and copied matches. A new query,
    replaced stream or background closes/discards stale results; Copy-sheet search remains local.
    *(A32, A98, A100)*

### Notification actions

57. An approval notification (a held Claude permission, through the relay and again on the same
    network) shows Approve and Deny. With the phone unlocked, Approve answers it within a few seconds:
    the notification reads "Approving…", then "Approved." and goes away by itself, and the desktop's
    prompt is answered. Deny the same way. With the phone locked: on Android 12 or later the tap asks
    for the unlock first; on Android 8 to 11 the notification says to unlock and nothing is sent. On
    Android 11 or lower a short "Sending your answer…" notification shows while an answer is sent.
    *(A25)*
58. A single-select question with up to three options shows "Option 1", "Option 2", … (the options'
    text with "Show details in notifications" on, cut to fit); a tap answers it in the live session.
    One with four or more options, and a multi-select one, shows Open, which opens the session.
    *(A25, A57)*
59. Answer from a notification something already answered on the desktop: "Already handled.". Answer a
    held approval after its hold expired: the notification says it timed out, and its tap opens the
    session. Pair a computer with remote access off, let it raise an approval's notification on the
    same network, then leave that network (mobile data) and tap Approve: the notification reads
    "Not sent: couldn't reach …", and nothing appears on the desktop; with remote access on (and the
    phone approved for it at the scan), the same tap answers it through the relay. Tapping Approve twice quickly sends one answer, and Approve on
    two notifications of one computer a few seconds apart answers both. *(A25, A05, A06)*

### All computers

60. Pair two computers. Each row of the computers list shows "N need you" once that computer has
    been listed (opened, or checked in the background), and nothing before. "All computers" at the
    top of the list opens one screen: its Inbox lists both computers' cards newest first, each
    naming its computer; Approve, Answer and Open on a card act on that card's computer (try one on
    each, through the relay and on the same network), and its Usage tab shows one section per
    computer that reports usage, with the computer's name and when it was measured. Away from the
    network of a computer that has never approved this phone through the relay, opening the screen
    shows that computer's approval code under its name; deny it there, and opening the screen again
    shows the refusal with a Try again and puts no dialog on that desktop until Try again is tapped.
    With the screen on its Inbox tab, raise a permission prompt on one desktop and tap Refresh: its
    card appears on top, and no notification follows, then or later. Open a terminal from a card and
    come back, and kill the process in the background: the screen and its tab come back. *(A55, A05,
    A22, A43, A73)*

### Dictation

61. In a terminal, tap the mic beside Send. The first time, Android asks for the microphone: deny it,
    and the input bar says how to allow it; tap again and allow it. Speak a sentence: the words show in
    the draft as you speak, the final words replace them when you stop, and nothing reaches the pane
    until you tap Send. With text already typed, the dictation is added after it with one space. Type
    right after a dictation, with the keyboard still up: the text goes at the end, after the dictated
    words, both into an empty draft and after text typed before with the cursor moved into it. Tap
    the mic while speaking: it stops and fills the draft. Type while it listens: the dictation stops
    and later words do not come back. Move the cursor while it listens: it keeps listening. Start one
    and say nothing: one line says so ("No speech heard." or "Didn't catch that."), with an OK. In
    airplane mode, on a phone without offline speech recognition, one line says it could not reach
    the network. Send the app to the background while it listens: the microphone indicator (Android
    12 and later) goes off. On a phone with no speech recognition service (no Google app, say) the mic
    is not shown, and the keyboard's own voice typing still fills the field. In Settings → Dictation,
    choose a language/region, return to the terminal and check its recognition and draft-only behavior.
    Test System default and a service-unavailable language, and cancel/background during dictation.
    These A114 variants are Pending and inherit no older recognizer pass. *(A59, A114)*

### A computer a desktop drives over SSH

62. Pair with a Linux computer that runs nodeterm and that another computer's nodeterm also uses as an
    SSH project host. On the same network, the Sessions tab lists that other desktop's project after
    this computer's own ones, marked "run here over SSH", with its sessions and, while that desktop is
    connected, their states; quit that desktop and within about two minutes those states read
    Unknown, while the sessions stay listed. Open one of its sessions and type; answer one of its
    approvals from the Inbox; end one of its sessions: the other desktop shows it ended. Its canvas New
    session and unowned Board/Wake/Refresh/Rename say they belong to the other computer; direct SSH
    Git works only within that host's listed admitted folder. A node of
    the paired desktop's own SSH projects still opens through the relay. *(A27, A09, A108)*

### A computer added by its SSH address

63. On a Linux computer with a Server Edition installed (`install-server.sh`) and no desktop app,
    tap "Add SSH server" on the computers list, fill in address, port and user, and tap Connect
    before adding the key: it says the computer did not accept the phone's key, and nothing is
    added. Share the key line to yourself, run the screen's command on the computer as that user (in
    bash, then once more in fish or zsh: the key is in `~/.ssh/authorized_keys` once, the file `600`
    and `~/.ssh` `700`), and tap Connect: the computer is added and the screen shows a `SHA256:`
    fingerprint that matches one line of the screen's `ssh-keygen` command on the computer. Open it:
    the Sessions tab lists the Server Edition's projects, the host screen shows its version, and a
    session opens and takes keys. Current Server Board writes for its local owned projects and
    direct SSH Git work without a relay; Server SSH-project references remain refused. Canvas New and
    Wake/Refresh/Rename remain unavailable, as does a cold session that is not running; Settings → How
    to reach each computer offers no choice for it. *(A27, A108)*
64. Add a Linux dev host that another computer's nodeterm drives over SSH (no nodeterm of its own) by
    its address: its projects and sessions are listed as in item 62, and approvals are answered from
    the Inbox. Open one of its finished sessions on the phone: within about 15 s the other computer's
    nodeterm clears that session's unread dot. Then reinstall its SSH host keys (or point the address
    at another machine): the phone refuses it, saying to forget it and add it again. Forget it: the
    dialog names the `nodeterm-android` line to remove on the computer, and the computer leaves the
    list. Adding an address that is already in the list (paired or added) is refused with its name.
    *(A27, A49)*

## Known gaps

**Closed SSH/tmux exit display (`A133`, published source repair; bounded physical checks pass).** The
[source checkpoint](#closed-sshtmux-exit-display-source-checkpoint-2026-10-07-a133) retains only
the last visible pane at a current known SSH/tmux EOF, with inert Copy/links and no Live/input.
Full 1033/110/app/TypeScript gates and exact-head five-job/ten-step CI pass at `ef4caec2`;
beta 21/code 22 is installed. One same-page closed-screen/Copy-sheet/link-offer/font-redraw
physical case passes. The later exact final-marker/Unicode clipboard paste and post-font OSC8/plain
link-offer pilot also passes. The later [normal browser/Share pilot](#fresh-fedora-output-and-native-desktop-readiness-2026-10-08)
is bounded to observed navigation/chooser preview; wider TUI/lifecycle checks remain unverified.
Checklist item 25 covers this retention without promoting the 64-row ledger.

**Native history scrolling (`A129`, published source; acceptance pending).** Published
`1add0408` adds negotiated inert history and mouse routing through its captured backend. The
[implementation checkpoint](#native-history-scrolling) keeps the original component failure
separate from the passing source gates and CI. At that earlier checkpoint, beta 18/code 19 was
ready and not installed, and installed beta 17 had not acquired this change. The current beta-19
checkpoint verifies bounded known-tmux/direct-SSH cases; inert native/session-host app history and
physical ConPTY acceptance remain unverified.

**Held Live-button touch (`A130`, focused source fix; acceptance pending).** Touch-down now
stops old momentum and native pending movement without closing history or advancing its
display epoch. The [finding](android-audit-2026-09.md#a130) retains the `1add0408` failure
(20 additional requests / 23 notches over 512 ms) separately from the passing 48/7
control/restored checks and three semantic assertion mutants. Final gates/CI pass on published
`5bda2c32`, and beta 19/code 20 is installed with measured update preservation. Actual
WebView/physical behavior acceptance remains pending.
Device checklist item 20 includes this held/moved/cancelled Live-touch and late-page check; the
original 64-row physical ledger remains unchanged.

A125 is source-fixed in `415dae9b`; A126 is committed in `5b7286b3`.
The eight controlled Linux Desktop reconnect cases, 294 affected tests, incremental TypeScript,
15 isolated assertion mutants and exact-source forced950/98/app gates pass. The `11e22453`
stale-input baseline, unequal-grid refusals and first `415dae9b` control's unclassified exits/
18-byte DA diagnosis retain separate provenance. The additional two-host soft/none case at
`59e4c93e` verifies one quiet park/adopt cycle and inactive global-card recovery with active A
unchanged; see [the bounded two-host follow-up](#inactive-global-card-owner-and-bounded-parkadopt-2026-10-06). These disposable QA-host results add no APK or regular
Desktop installation. Remaining release acceptance needs a reachable intended phone for the
physical lifecycle/outage, answer/notification/permission and live-provider checks. Wider parking,
Server/cross-window response ownership, repeated outage/backoff, GPU/display and other-platform
coverage remain separate from those device and hosted-backend obligations.

Immediate Android push (`A25`) and fresh-different-desktop relay recovery (`A93`) need the hosted
backend maintainers. The user has no service repository to supply. Same-owned-desktop paired-update
recovery does not establish recovery on a fresh different identity; no backend fix is claimed.

The [native custom-wheel checks](#native-custom-wheel-checks-2026-10-06) verify two copy-mode tables,
chunked distance and reversals over actual SSH/tmux. The broader phone custom-binding/lifecycle/FPS
matrix remains open; those native results do not promote the paused device checklist.

- **Remaining native matrix.** Linux DOM Desktop/Server and GPU-enabled Desktop link checks pass
  (four hardware Canvas WebGL2 plus four intentional DOM Modal cases). Native File-menu Quit,
  outside-terminal Ctrl+Q and one real tmux Canvas pilot also pass. A122 fixes focused-terminal
  native Quit; all four Linux native cases pass. Later tmux8/SSH8 and individual GPU loss/restore
  checks pass, including A123 native retirement control/mutant/restored. A genuine Server retirement
  pilot, derived Desktop compositor cell comparison and single Desktop SSH reconnect pilot also pass.
  Repeated/page-wide GPU pressure,
  full-frame compositor/display output, SSH reconnect beyond the accepted eight-case and two-host
  global-card checks, and macOS/Windows remain unverified. Synthetic installed-
  Fedora-PAM setup passes; real-user
  policy and Android setup/lifecycle still need their own checks.
  See [the latest native receipt](#native-setup-timing-installed-pam-and-remaining-desktop-checks-2026-10-05).

- **A95 is fixed and physically verified in the owned production fixture.** Commit `ec12ea9a`
  fixes the core Board announcement and actual Desktop preload subscription. Actual beta 10 phone
  move/remove/re-add/create-label actions now update the mounted desktop without reload; item 36
  passes. The held071 stale-Board failure remains recorded separately. No regular-user-desktop
  deployment or Android APK change is claimed; other device checks remain open.

- **Fresh-desktop relay pairing can finish without a relay credential (A93, open).** The
  same Pixel identity pairs with remote access on, but the actual mint refuses HTTP 403
  reauth_required in a bounded production retry. The old fixture's phone-side token was forgotten
  and the desktop identity changed. Ordinary complete-original-profile restart and re-pair
  now succeeds with unchanged identity and relay credentials, including saved beta-10 reconnect.
  This does not resolve fresh-different-desktop refusal or establish the full backend policy.
  No backend source or user credentials were copied. iOS recovery needs verification for @eneskirca. Historical beta-6 relay proof remains valid; pairing/relay device checks remain open.

- **Completed empty SSH listings looked like loading in beta 9 (A94).** Source fix
  3c217cba timestamps the authoritative empty answer while preserving the A91 route/error
  behavior. Five Kotlin methods/eight mutants, full 689-test protocol and beta-10 delivery pass;
  both installed sole-End cycles show the completed empty label with no Loading/row/group
  while SSH/error remain; Home recreation opens an actual bash pane between them. Item 32 stays Partial.

- **The desktop wrapped-link follow-up is fixed in `127b6b28` (`A92`).** The
  shared Desktop/Server renderer's capped paragraph could omit the hovered row after more than
  32 continuing rows. Reserving one upward-budget row fixes complete URL lookup. Focused Vitest
  24/24, all affected link/dialect tests 54/54, full TypeScript check and three isolated mutants
  pass; all eight native Linux Desktop UI cases now pass at `01b4a2f5` with A121's leave fix.
  Separate Linux Server checks pass at `dcdf664a`. The later GPU-enabled eight-case matrix passes
  (Canvas4 hardware / Modal4 DOM). Those earlier runs did not verify GPU recovery; later individual
loss/restore pilots are recorded in the final follow-up. macOS remains unverified. Android already
  has the `A32` correction.
  No host RPC/blob/pairing/mirror/SSH-file change or iOS adoption is owed. Beta 10/code 11
  remains last installed; the device ledger is unchanged and no new phone evidence is claimed.

The current `/v1/relay/join` contract is verified against the live hosted backend: the Pixel's
encrypted paste pairing and forced relay-only browse succeed against production desktop source
`58a202be`. The backend is a separate repo; cellular relay, SAS denial/revoke, interruptions and
the wider relay action matrix remain device checks.

- **A pairing that recorded no relay key still asks once on the relay** (audit `A07-late`). The
  desktop approves a late-adopting phone by the box key its pairing recorded from the sealed `/pair`
  body. A pairing made by a phone that does not send `boxPublicKey` (the iOS app, until it adopts the
  field), or by a desktop older than `A07`, recorded none, so that phone's first relay connect after
  a late adoption still shows the first SAS dialog. A118 can repair an eligible legacy association
  after approval using the phone's retained SSH identity, so later exact revocation works. Missing
  identity/key attribution and relay-only pairings still need re-pairing. iOS can adopt `boxPublicKey`
  and `relayApproved` unchanged, plus the new proof verbs/encoding for eligible legacy records.
- **Push.** No FCM leg exists in the backend; the app polls (see android/README.md). The backend's
  `/v1/push/*` fan-out is APNs-only, so nothing wakes the app when an agent needs you, and there is no
  equivalent of iOS's Live Activities (an ongoing notification would need FCM or a foreground
  service). The desktop's phone-push switches (Needs you, Done, hold alerts while at the computer, the
  per-computer mute) gate only its own APNs send and are not in the mirror's `settings`, so no phone
  can read them; Android's per-kind control is its two notification channels. What the app does have
  (`A25`): the notifications it posts itself carry Approve / Deny and a question's options, and their
  tap opens the session.
- **A computer added by its SSH address is SSH only, and has no push** (audit `A27`, part b). "Add
  SSH server" reaches a headless Server Edition or a dev host the phone reaches only over SSH, but
  only where the phone can open an SSH connection to it (the same network, or a VPN): there is no
  relay leg for it, ever, and no "from anywhere". Direct Git works on admitted local/driven folders
  without an actions service. A current selected-profile service supplies owned Board writes on
  Desktop/Server and delivery-only Wake/Refresh/Rename on Desktop; Server has no node nudges.
  Missing service capabilities have no relay fallback on a manually added host, and
  A111 supports canvas-registered New on a current enabled local POSIX tmux profile. Missing
  creation capabilities still need the relay; phone-owned plain SSH New remains separate.
  It gets no push either: the grant an iOS phone drops in
  such a host's `~/.nodeterm/push-grants` and the backend's `/v1/push` fan-out are APNs-only (see
  Push), and Android drops none, so the phone polls it like any other computer; docs/SERVER.md's
  "full push / Live-Activity coverage" is iOS's. A120 adds optional one-time password setup after human
  fingerprint confirmation. Keyboard-interactive/MFA, the Server Edition's `install-server.sh`
  one-liner offered per connection, and Windows remain unsupported (the
  browse is POSIX `sh` + tmux, as for a paired computer). The host key is trust on first use, as for
  a paired computer, but with no pairing LAN behind the first connect: compare the fingerprint the
  screen shows. A119 adds an explicit saved profile folder for a Server Edition's custom `--data-dir`;
  a slice's freshness compares the phone's clock with the driving desktop's; on a
  computer that runs its own nodeterm AND is driven, launch settings come from its own mirror (a
  driven session's wake line uses its permission mode); a project whose sessions all start outside
  its folder (a worktree beside it) has no file found, so it is named by its id from its slice, and
  its plain terminals are listed under "Other sessions on this computer". When no data dir is found
  but another desktop's sessions are, the listing shows that desktop's projects and nothing of the
  `node-terminal` sessions of a nodeterm whose data dir the phone could not find (a Server Edition
  with `--data-dir` elsewhere and no explicit selection), and nothing says they are missing.
- **Read-ack ownership is locally fixed; device validation remains open** (`A82`). Both the local
  `src/core/ack-sweep.ts` consumer and `sweepRemoteAcks` require ownership before reading/removing
  `~/.nodeterm/acks/<nodeId>.seen`. Remote ownership combines all connected projects on the host.
  Retained local files are retried when ownership changes, including restored unresolved Done
  cards. Android's actual producer/consumer interop is covered; the multi-desktop device case and
  iOS verification remain pending. Held approvals continue to use each hook's own `.answer` file.
- **Explicit plain SSH creation has focused Pixel proof (`A90`).** It uses `nodeterm-phone` and a
  separate Phone terminals group; it does not change canvas registration or managed-agent
  creation. Home/project/custom creation, cwd/input/history, restart/reconnect/update survival
  and exact owned End pass on beta 8/9 without changing desktop sessions/files. Item 32 is Partial;
  relay plain-shell creation/input/End now pass; managed and cellular creation remain pending; A91's empty-host variant passes on Oct4.

- **Empty-host stale rows are fixed in installed beta 9 (`A91`).** The branch clears them
  only on authoritative `NothingFoundException`, retaining cached rows on uncertain failures and
  keeping the SSH route/error intact. Host regressions/mutations, beta-9 delivery and the Oct4
  physical otherwise-empty-host last-End/row-and-group removal/connected SSH/New-terminal flow
  pass. That second Home shell later survives beta 10's update and is ended in the full A91/A94
  empty-screen/Home recreation/second-End cycle; final fixture/service cleanup is not claimed. Broader checks
  resumed on Oct4; item 32 stays Partial because managed and cellular creation remain open; relay plain-shell creation/input/End pass.

- **Direct SSH is POSIX-only (`A108`).** Current Desktop/Server instances advertise their
  private typed SSH actions service for Board writes on the selected profile. Desktop additionally
  accepts Wake/Refresh/Rename nudges; Server has no renderer and advertises no node nudges.
  Unknown claim ownership fails closed; a crash inside its short startup/cleanup transition
  requires operator recovery before the SSH service can be advertised again.
  The service uses the actual WorkspaceStore save queue and normal change broadcasts, preserving
  mounted edits. Old/unavailable services may use an allowed relay before submission; a submitted
  unanswered mutation never replays or switches transport. A Desktop can serve its own SSH-project
  metadata; another desktop's driven project is refused without selected-profile ownership.
  A111 adds genuine host-owned create/launch/register for open local folder projects using enabled
  POSIX tmux. Windows/non-tmux and third-machine creation remain unsupported. Ordinary attach
  never creates a missing canvas node. The separate phone-owned plain SSH terminal remains.
- **Direct SSH source control is implemented (`A107`); its physical matrix remains
  open.** The eight existing typed verbs run Git on listed local/driven folders of that computer,
  with physical cwd/repository-root jails, bounded output and honest confirmed/uncertain write
  outcomes. Third-machine projects remain unavailable. A second push is allowed only for the
  exact native exit-128 missing-upstream diagnosis matching the current branch before dispatch.
  Branch switch, discard, init, publish, per-commit file lists, older-than-50 history and merge
  resolution remain outside the exposed contract; the phone still cannot edit or stage unmerged
  conflict resolutions through this screen.

- **Direct-SSH coattachment is source-fixed (A13, `ed2965be`).** Updated hosts preserve external phone clients in either attachment order and remounts; only verified app-owned prior viewers are retired. Real tmux control-client checks and eight actual Linux native checks pass; physical SSH/phone and macOS/Windows runtime checks remain pending. Android still reattaches when an older host detaches it.
- **Safe remembered rules and complete question answers replace the old fixed gaps (`A105`,
  `A106`; prior `A56`, `A57`).** Always allow confirms only exact eligible original addRules
  scopes; it cannot mean guessed option 2 or a permission-mode switch. Held questions expose every
  question and submit all selected labels through the documented hook contract, preserving full
  input. Older phones see Open on held v2 cards; older hosts, unsupported/free-text cases and
  expired/replaced tickets never fall back to digits. Unheld legacy multi-select remains read-only
  with Open session. Bounded beta-19 phone rule and single/multi question cases pass real CLI
  application at `e06b5547`; rule persistence after CLI restart and the wider matrix remain open.
  @eneskirca must adopt the additive mirror/verb/v2 SSH contract in iOS together.
- **Legacy unheld multi-select questions remain Open session.** Complete held questions use
  the v2 hook contract described above; unsupported/free-text schemas open the session.
- **Sleeping offscreen relay wake is implemented (`A104`).** The desktop resolves the saved
  node/project and owning live/released pane even outside the mounted canvas, without switching
  tabs or creating a shell. It preserves explicit Pause, recorded exit proof and exact process/
  generation guards, and never retries an uncertain write. Unsupported older hosts refuse safely;
  physical inactive/closed-project wake and ownership/lifecycle variants remain to verify.
- **Trusted project env/shell and per-agent policy are carried on cold relay launches (`A102`,
  `A103`).** Saved host owner/account/agent facts win over phone hints; warm panes are left intact.
  The phone now uses the measured Claude/Codex/Gemini/Grok dialects for launch, cold resume and
  Sleeping wake. Codex's host vocabulary and Claude's own auto gate determine emitted flags;
  unsupported modes keep the CLI default. No physical/live agent policy matrix is claimed.
- **The SSH pin is anchored only by a current desktop, and the LAN address is refreshed only over the
  relay** (audit `A49`/`A74`). A desktop with `A49-anchor` names its SSH host keys in the sealed `/pair`
  answer and the first connect must present one of them; an older desktop, one that could not read
  its keys, a computer paired before this build and one added by its SSH address still pin on first
  use (on the pairing LAN, right after the QR, so normally the real computer), where a server that
  accepts any key could become the pin. An sshd that serves a key `ssh-host-keys.ts` cannot see is
  refused over SSH, as a key the computer did not report: a relative `HostKey` path, a key with no `.pub`
  beside it (sshd needs only the private key), and a `HostKey` named only in a config file the
  desktop's user cannot read (some distributions install `sshd_config` and its drop-ins readable by
  root only; `/etc/ssh/ssh_host_*_key.pub` are still read there). Pairing again does not help: it
  re-reads the same files and names the same keys, and the phone has no way to accept the key it was
  refused (forgetting the computer and pairing again sets the same anchors). In Auto, with a relay
  leg, the phone then uses the relay and keeps its warning up at every connect; with "Only on my
  network", or a pairing with no relay leg, the computer is unreachable over SSH. The ways out:
  choose "Only through the relay" for it; or make the key visible to nodeterm on the computer (a
  readable `.pub` beside a key that is an `/etc/ssh/ssh_host_*_key` or a `HostKey` in a readable
  config) and pair again, or let a relay connect report it; or forget it and add it by its SSH
  address, which trusts on first use and has no relay or push (its screen's `ssh-keygen` command
  reads only `/etc/ssh`, so compare the fingerprint with `ssh-keyscan localhost | ssh-keygen -lf -`
  on the computer instead). The iOS app does not read the field yet. The relay refresh
  (`A74-refresh`) does not take the reader's answer as the truth about the pin: it drops one only for a
  key the SSH leg was refused that the reader also names, so a pin that works (one trusted on first use
  with an older desktop, on a computer whose sshd serves a key the reader misses) is kept. The
  refreshed address now follows the same saved Desktop Settings → Phone adapter as the QR (A116).
  Automatic prefers a physical LAN adapter on POSIX; select a VPN or another adapter when needed.
  DHCP follows that adapter's current IPv4. A missing selected adapter supplies no replacement
  dial address; current address enumeration does not prove phone reachability. The refresh needs
  a relay connection, so a phone that only ever uses
  "Only on my network" keeps the pairing's address and keys, and the iOS app does not read `lan` yet.
- **Private beta device validation pending** (audit `A50`). AGP marks every debug build
  debuggable: anyone with adb access to the unlocked phone while USB
  debugging is on can read the app's files (`run-as`) and attach a debugger to the running app, whose
  code can use the Keystore key those files are sealed under. That is the phone's pairing
  credentials: the SSH key its computers accept, the relay box secret and the relay device token.
  android/README.md says so under Security. A private beta now has a local signing/verification
  tool and opt-in versioned unsigned CI inputs, documented in the README; its key and signed APK
  stay off Actions. The first private minified APK is installed on the intended Pixel and basic
  SSH listing/input works. The code-3 update fixes sizing/history (`A85`) and preserves identities;
  code-4 scroll mitigations pass protocol/type-check and local AGP/R8/signing checks, and its
  in-place update verifies identity persistence, reduced drag gain, reversal and Esc cancellation.
  The user reports that beta 3 still lags and moves too little; `A87` corrects automatic-report
  cancellation and restores responsive gesture gain. Beta-4 delivery and controlled movement pass
  in the verification record above. The user reports more movement but no momentum on finger lift;
  the bounded-fling code-6 beta builds/signs/updates and passes 658 protocol tests, but actual
  continuous swiping still stops. `A89` fixes the detached target; code-7 build/sign/update and
  658 protocol tests pass. Code 7 reopens SSH with its retained key/pin and verifies controlled
  continuous drag/coast/Esc. A held touch stops coast at a stable 56×25 viewport; earlier
  IME-resizing touch checks were inconclusive. The user confirms normal drag/coast both work.
  The requirement-audited real Pixel QA passes ten complete items (1/18/19/21/22/24/36/38/39/51), plus
  partial copy/link and SSH recovery checks. Encrypted paste pairing, live relay browse/terminal input and
  shipped-hook Approve/Deny/expiry and mounted relay question/copy-mode answers work; the hook
  producer/application are synthetic, with no live Claude execution. Offscreen/released/direct-SSH/
  target-guard device variants remain open.
  The user also confirms beta-6/code-7 connection and smooth scrolling over cellular WireGuard
  with Wi-Fi off on regular manual SSH; cellular hosted relay is untested.
  QR/cellular-relay/SAS/worker, real outage,
  reversal/remaining lifecycle, FPS/custom bindings and the full device pass remain open.
  The desktop's Android link continues to open the `android/` source folder and both
  phone surfaces label it "nodeterm for Android (build from source)" (`ANDROID_APP_LABEL` in
  `src/renderer/lib/links.ts`, audit `A66`); drop that label when the link points at a release.
- **Dictation is the phone's own recognizer, not Whisper** (audit `A59`). The input bar's mic uses
  Android's `SpeechRecognizer` (see "What is verified, and how"), which on most phones is Google's
  service and may send the audio to its servers. iOS and the desktop transcribe on the device with
  Whisper; running whisper.cpp on the phone would be a native build and model downloads of its own.
  The Cloud engine iOS and the desktop share (`/v1/transcribe`, multipart WAV and a locale) does not
  exist on the backend yet (`src/core/speech/cloud-speech.ts` maps its 404 to "not available yet"),
  so there is nothing for Android to send that request to either. Settings → Dictation now offers
  a searchable language/region choice (A114); System default leaves the recognizer's language unset.
  The locale catalogue does not prove the phone's speech service has that model installed, and
  unavailable/unsupported errors stay visible. Physical language checks remain pending. The phone
  keyboard's own voice typing (Gboard's mic, say) also works in the input bar, mic button or not.
- **Instrumented UI tests** and a store listing do not exist yet.

## A113

**A legacy pairing can report a successful revoke without proof that relay access was removed (2026-10-04).**

Fixed in `349b791a`. Desktop revocation now reports `unconfirmed` for a saved pairing with no
recorded relay key or no available revoker, and `retained` when another saved pairing still
authorizes that exact key. Settings shows these outcomes separately from local SSH-key removal
and Pro expiry. An absent relay outcome from an older main process also remains unconfirmed;
the confirmation dialog no longer promises removal of every connection. Confirmed last-key
unpin/session closure remains required for the clean relay receipt. Seven affected main/renderer
suites pass 111 tests; eleven isolated assertion mutants are caught with passing control/restored
runs. The source-bound mutation fixture uses a temporary-home service boundary and mounted React.
These additive local Desktop IPC outcomes do not change the phone wire contract. Full legacy
identity association/migration and physical relay revocation remain open; no unrelated approved
key is guessed or removed.

## A114

**Android dictation has no language choice (A59 follow-up, 2026-10-04).**

Fixed in `6b989e59`. Settings offers a searchable language/region picker using human-readable
locale names and an explicit System default. The phone-wide preference is separate from host
identities and is frozen when a dictation starts. System default omits the native language extra;
a chosen language sends its canonical BCP47 tag. Partial/final results still fill only the draft,
and microphone, cancellation and lifecycle rules remain unchanged. The bounded catalogue lists
locales, not installed speech models: native unsupported/unavailable errors stay visible.
Three focused protocol classes pass 39 methods, offline app compilation passes, and eighteen
isolated compiled mutants fail assertions with passing control/restored runs. Native intent/UI
wiring is covered by source guards; the cached Kotlin/Compose compilation is separate evidence,
not a recognizer/device pass. Physical language availability, recognition and layout checks remain
pending. No host wire contract changes.

## A115

**Re-pairing leaves local host preferences and lets retired connections publish late (2026-10-04).**

Fixed in `0a71c028`. Replacing a paired record retires its route, relay approval,
managed-creation checkpoint and old token while preserving unrelated computers and same-ID preference
updates. Forget and re-pair retire the exact old connection objects; a shared session-admission
barrier covers local record/token publication, including incoming IDs with no previous key match.
No network await runs under that barrier. A failed local secret write retains the record, while its
old socket remains retired. This is a local monitor fence, not a crash-safe Keystore/preferences
transaction.

Owner-bound lifetime leases cancel pending dials and prevent late pin, LAN, relay-token, approval,
notification or checkpoint publication into a successor, even when it reuses the ID and key.
Normal disconnect still permits reconnect and retains an uncertain creation receipt; permanent
retirement never reconnects. Both primary and side relay results are retained before cancellable
handoff and closed on cancellation. Quiet notification reach uses the exact session without a
reverse manager lookup. Closing local polling does not revoke an existing Desktop SAS consent.

Private controls/restored runs execute 177 repository methods and 29 actual
production HostStore adapter cases against in-memory Android interfaces. 73 isolated variants
fail assertions. One additional redundant retired-guard experiment survives equivalently because
retirement also invalidates every admitted generation; it is recorded separately and is not counted
as caught. Native wiring remains source-guard evidence, with app compilation checked separately.
No phone, live transport, physical durability or full legacy Desktop identity migration pass is
claimed. No host wire contract changes.

## A116

**Pairing can advertise a Docker/VPN address the phone cannot reach (A49/A74 follow-up, 2026-10-04).**

Fixed in `a6b3e88b`. Desktop Settings → Phone lists current IPv4 adapters and an Automatic choice.
The saved selection is an adapter name, so each new QR and authenticated relay LAN report follows
its current address across DHCP. An unavailable explicit adapter prevents a new QR and omits the
report's dial address; it never silently substitutes another adapter. Automatic prefers a physical
adapter on POSIX, retains Windows' validated current route hint, and permits a virtual-only fallback.
The list describes current local addresses, not proof that the phone can reach them. Windows remains
relay-only; browser Server pairing/network controls deliberately remain unsupported.

Both Settings and quick pairing acknowledge pending settings writes before starting. Changing the
choice hides/stops the old QR first, offers an explicit failed-save retry, and cannot restart after
its visible row is hidden. Real global-search rows work too; hiding that row retires only its own
listener, including while its parent hook remains mounted. Old replies/events cannot stop or update
a newer pairing view. The legacy exported picker helpers also use the shared policy.

Isolated Desktop controls/restored runs pass 156 methods; one unrelated pre-existing worker-spawn
guard is explicitly filtered in that private sandbox and remains part of the full merged gate.
Root's actual local HTTP-listener controls/restored pass all six methods. Five producer→Android
methods call the real policy, QR builder and LAN reporter with a fake OS table/public-key directory,
then the existing Android parser and LAN-refresh policy. They prove paired-host identity/pin
preservation, not Keystore or approval publication. The three final proof groups catch 56 assertion
mutants (32 Desktop, six real HTTP, eighteen interop); preliminary receipts remain separate.
The existing wire shape is unchanged and the Android client needs no parser change. iOS @eneskirca
should adopt the existing authenticated `lan` field; it now reflects the saved Desktop adapter.
Physical QR/VPN/DHCP, search UI and multiadapter checks remain pending. No external message sent.

## Direct SSH coattachment follow-up (A13, 2026-10-04)

Fixed in `ed2965be` after the beta-14 APK checkpoint. A current Desktop app attaches beside
external SSH/relay clients, then replaces only a live app painter attested by an exact PID/birth
receipt in the same private userData profile and tmux socket/session. Both old and incoming client
identities are rechecked in the tmux command queue before an exact-client detach. A failed or
departed new attach cannot evict the old viewer. Unknown, legacy unmarked and other-profile clients
survive; missing process attestation preserves viewers. Existing per-manager joins and grid policy
remain. Exit/quit releases the exact receipt; only proven stale receipts are pruned within bounds.

Private controls/restored pass 122 focused tests and full TypeScript checking. Twenty-four distinct
isolated mutations fail assertions; three critical variants are additionally caught against the
actual tmux server. Seven real private-socket tmux control-client methods pass without skips on
tmux 3.7c: both phone/app attachment orders, unequal native pane grids, remounts, foreign/legacy
clients and stale-client races. Control-client height formatting is empty on this host, so grid
evidence reads the native pane and checks phone-only restoration.

An additional Linux smoke at source `32d412b6` passes eight checks using cached Electron 42.11.3,
Node 24.19.0, actual node-pty and tmux 3.7c. It exercises the production `PtyManager` and painter
tracker in a private home/tmp/run/PID/network namespace: external/app attachment in both orders,
same-manager joins, selective app remount takeover with exact shell output retained, and normal
quit receipt cleanup while the external client and shell survive. Observed native pane grids
return to 56×48 after the 100×40 app replacement leaves. The in-memory `CorePlatform` adapter is
an explicit IPC boundary; no actual renderer, SSH handshake, relay, Pixel, macOS or Windows runtime
pass is claimed. The cached native binding, Electron binary, all 96 bundled source inputs and
external node-pty wrappers are hash-bound and unchanged across the final run.

The private painter receipts are internal app state, outside the phone's named workspace/status/
project files; no host-service verb, payload, mirror or client wire shape changes. Android keeps
its exit-zero reattach fallback for older hosts. The same host policy preserves iOS SSH clients;
@eneskirca should verify physical coattachment. Prepared beta 14/code 15's Android client remains
unchanged and uninstalled; host-side verification uses the later source. The device ledger stays
10 Pass / 22 Partial / 32 Pending, and phone testing remains paused.

## A117

**Relative private HostKey declarations can be opened by a configuration Include (2026-10-04).**

A relative `HostKey` is still excluded from SSH anchors because discovery does not know the
daemon's working directory. Its normalized private basename now also excludes lexical and
canonical Include candidates before they are opened. Explicit public `.pub` declarations remain
readable, and relative declarations share the existing bounded declaration budget. This is a
conservative exclusion by name; it does not infer relative paths or discover unknown aliases.

All 22 host-reader methods pass on this Linux host, including the existing real FIFO race.
Seven isolated reader mutations fail assertions with passing controls/restored runs. The real
pairing-service → Android regression seals only a disposable server's permitted key, preserves
the anchors in the phone record, accepts that real SSH server and refuses a second real server.
The original source and removal of the canonical exclusion both fail that regression; restored
source passes. Private-file inputs are synthetic config sentinels, never actual private keys.
Proof is retained in `.nodeterm/android-relative-hostkey-2026-10-04/`.

The sealed field and Android production code are unchanged; the actual interop fixture is updated
with the producer. iOS @eneskirca should verify the existing anchor handling against the current
host. Prepared beta 14 remains valid client source and is not installed. Physical checks remain
pending; phone testing is paused and the ledger stays 10 Pass / 22 Partial / 32 Pending.

## A118

**Eligible older pairings cannot associate their existing relay key with a saved device (2026-10-04).**

The standing phone host now offers `pairing.relayKeyChallengeV1 {pairingId}` and
`pairing.relayKeyProofV1 {challengeId, signatureB64}` only after the normal relay approval gate.
A legacy pairing is eligible only when its exact host-minted UUID has one unambiguous, canonical
Ed25519 public key under the host's existing `nodeterm-ios-<id>` authorized_keys attribution.
Missing, option-bearing, duplicate, malformed, replaced or unsafe files refuse proof; relative
identity guesses and device names are never used.

Each connection holds at most one ephemeral challenge and one in-flight inspection. It binds
version, challenge UUID, pairing UUID, pinned host box key, authenticated peer box key, raw SSH
public key, random nonce and expiry. All fields use the fixed newline encoding in
`src/shared/relay-pairing-proof.ts` and Android `RelayPairingProof.Challenge.signingBytes`.
Both wall and monotonic host time enforce 60 seconds. Every proof attempt consumes the challenge
before awaiting publication, including malformed signatures; another session cannot use it.

Android attempts the optional proof only after an approved first listing, using its existing
encrypted SSH seed. It validates the captured host, peer and SSH keys before signing, checks the
current record/lifetime around awaits, and never creates an identity, changes approval or tokens,
or retries an uncertain proof. Missing identity, unsupported older hosts and ordinary optional
errors preserve browsing; cancellation propagates. A socket closed during proof cannot be handed
off as connected, and a later network close after proved approval is not reported as Deny.

The actual host pairing queue stages a private association, then rechecks the bounded exact
registry snapshot, attributed public key, approval, connection lifetime and expiry immediately
before synchronous atomic publication. Existing same-key association is idempotent; conflicts and
deleted/replaced entries refuse. This is a same-service queue, not a cross-process transaction.
Normal revocation can then unpin/cut the exact proven last key; a sibling pairing still authorizing
that key keeps the explicit retained outcome.

Focused controls pass 87 host and 15 Android helper methods. Forty compiled host and 25 compiled
helper mutation variants fail assertions. Seven real producer→Kotlin encrypted interop methods
cover sealed legacy pairing, actual signature verification, exact publication/revoke, distinct and
shared-key siblings, wrong SSH identity, cross-session/consumed challenges, old-host fallback,
unapproved access and the close/callback ordering. Six additional interop variants fail assertions
with passing controls/restored. The public-pin adapter, human decision, OS address and unused PTY
are explicit fixture boundaries. Private evidence: `.nodeterm/android-legacy-relay-proof-2026-10-04/`.

This is an additive host/Android contract. iOS @eneskirca needs the same retained-key signer and
exact encoding to repair eligible legacy records; old iOS remains usable. A phone without its
retained SSH seed, its matching attributed SSH public key in the host's authorized_keys or SSH support still needs re-pairing. This proof never
bypasses first SAS approval and does not solve hosted FCM or A93. New Android source needs a later
APK than beta 14; no new installation or physical/live transport pass is claimed. Phone testing
remains paused, beta 10/code 11 is last installed, and the ledger stays 10 Pass / 22 Partial / 32 Pending.

## Prepared private beta 15 and verification checkpoint (2026-10-04)

`0.1.0-beta.15` / code `16` is built from clean signed source `aa902d0a52ba8ccfa0be57e073c350e90cfad5d3` and includes
A118's optional retained-SSH legacy relay identity proof. The host must also run this source for
migration; older or unprovable hosts remain browsable. A117's relative private-key Include fix and
A13's coattachment fix are included in the host source.

Required source checks pass: 912 protocol methods / 94 suites, zero failures/errors/skips;
offline app compile; 1,919 affected desktop methods with exactly ten known macOS/Windows skips;
full TypeScript checking. All five exact-source Android jobs pass: [source CI](https://github.com/CPlusPlus17/nodeterm/actions/runs/37228985208).
A118's focused proof remains 87 host and 15 helper methods, 40 + 25 compiled assertion-caught
mutants and seven actual producer→Kotlin methods with six additional assertion-caught variants.

The local release build uses a fresh tracked Android-only snapshot, cached AGP 8.10.1/Kotlin 2.2.0/
Gradle 8.14.3/JDK 21 and `--offline`. R8 runtime keeps and 56 independent artifact checks pass:
SDK 36/37 signatures and 16 KB alignment, retained signer, actual version/manifest/provenance,
service-loader mappings and unchanged terminal/native assets versus beta 10.
Private APK: `.nodeterm/android-beta-15/nodeterm-android-0.1.0-beta.15.apk`.
SHA-256: `c1e707c8a18555db7e01129b709d39db342128f3c54d8103d548cc177bc9abaf`.
Signer SHA-256: `c610c3a0b637a8005b6fd858587e8cbf5260622648bc1cd97c0de0ab5f146dbd`. Private build/review evidence:
`.nodeterm/android-beta-build-15/`. The APK, signer and proof remain outside source exports.

Live A105/A106 application is still unverified. An isolated installed Claude 2.1.289 fixture uses
the actual managed hook server/script/writer with an in-memory CorePlatform. Its fresh-context,
read-only credential/config and fixed-tool guards pass 34 static checks and the exact offline
mount/auth gate. The first attempt hid the system DNS target and timed out before tools; a
separate corrected fixture exposes only that regular resolver file read-only. It reaches the
provider, but receives authentication HTTP 401 before any tool request. No application pass is
claimed. Original profile/source/binary/resolver metadata remains unchanged; raw diagnostics stay
private and no credential refresh/reset is attempted. After the existing CLI account is usable
for inference, rerun the isolated remembered-rule/full-question checks. This gives no physical,
renderer, SSH or hosted-relay proof.

Phone testing remains paused. Beta 10/code 11 is last confirmed installed; beta 15 is prepared
and not installed. The ledger stays **10 Pass / 22 Partial / 32 Pending**. Next device work uses
this APK and current host source, checks saved key/pin survival and the expanded checklist,
then restores rotation and removes only owned QA host state. A25/A93 still require hosted-backend
maintainers; iOS @eneskirca owes the new proof contract and earlier mirror/verb/v2-answer adoption.
No PR is opened; A68 stays deferred until requested PR preparation.

## A118 JUnit registration follow-up (2026-10-04)

The focused Kotlin runner exercised all 15 helper methods, but the initial Gradle/JUnit run
registered only 14: the outer-timeout coroutine test inferred an exception-valued return.
Its explicit `runBlocking<Unit>` signature now lets JUnit discover it. Actual offline Gradle
controls register all 15 with no failures/errors/skips. Removing the signature compiles and
passes 14 methods, then fails the exact method-registration assertion; restoration passes 15.
The seven actual host/Android interop methods were already registered. Private evidence:
`.nodeterm/android-legacy-relay-proof-2026-10-04/junit-registration/`.

The required local gate now checks the actual JUnit helper inventory and the outer-timeout
method explicitly. This correction changes only a protocol test and documentation after
beta 15's `aa902d0a` source; its shipped Android runtime inputs and private APK are unchanged.
The APK remains prepared and uninstalled, live Claude application remains unverified after
provider HTTP 401, and the physical ledger stays 10 Pass / 22 Partial / 32 Pending.

## A119: explicit SSH profile folder (2026-10-04)

Add SSH server now accepts an optional absolute **Profile folder**. Existing computers can change
**SSH profile folder** in Settings → How to reach each computer. The saved phone-local choice
selects a custom Desktop/Server data directory ahead of all automatic discovery. Blank restores
discovery. A missing or invalid explicit choice reports an error and never selects another profile.
Board, project reads and all three managed-view stages use the same captured profile. Saving a
change invalidates pending connection work and clears old displayed rows while retaining uncertain
creation receipts; it never recreates a session. SSH host pins, pairing and relay credentials remain
unchanged. Paths are quoted literally and reject relative/dot components, controls and oversized input.

Regression coverage uses actual Server config/platform/WorkspaceStore/mirror/actions producers,
a real private MINA SSH server and isolated tmux. The fixture supplies a plain-shell planner/native
create boundary; it does not run full Server boot, installed hooks or account probes. Native storage
coverage uses actual app classes with in-memory Android adapters. Ten protocol model methods,
three actual Server/SSH methods and the complete 62-method SSH/10-method workflow suites pass.
Four compiled SSH profile mutants fail their intended assertions. Final native control/restored
runs pass 19 cases and catch the retired-session mutation; seven earlier native variants have
separate historical source bindings. Private receipts: `.nodeterm/android-ssh-setup-2026-10-04/`. Physical setup/profile switching remains unverified;
phone testing is paused and the ledger stays **10 Pass / 22 Partial / 32 Pending**. At this source checkpoint, beta 15 was
the latest prepared APK and excluded A119. The beta-16 receipt below records its later packaging.
iOS implication for @eneskirca: offer an explicit saved SSH profile choice consistently for discovery
and managed attachment. No host verb or pairing payload changed. A25/A93 and A68 remain open;
no PR is opened.

## A120: one-time password SSH setup (2026-10-04)

Add SSH server keeps its public-key Copy/Share/manual command and adds **Set up with a password**.
The app inspects the SSH host key without authentication. Compare its fingerprint on the computer,
then explicitly confirm **I compared it — it matches** before entering the password. Password login
rechecks that exact key, installs only the retained phone public key, closes the setup connection,
and proves a separate pinned key-only login before saving the host. A changed key, refused password,
unsafe key-file target, uncertain command or failed key verification never saves a computer.
No setup write is automatically replayed. A lost acknowledgement may leave the public key installed;
use the normal key connection or check authorized_keys on the computer before starting a new attempt.

The password is memory-only, absent from saved state/preferences, shell text and diagnostics. Leaving
or backgrounding setup cancels owned sockets and clears its password/fingerprint approval. JVM/library
transient copies cannot all be erased. Existing keys and restrictions are preserved; commented or
trailing key-like text is not an installed declaration. Symlink, nonregular, foreign-owned and hardlinked
targets refuse. These are bounded pathname preflight checks, not descriptor-atomic protection against
concurrent same-user replacement. Keyboard-interactive/MFA, password changes and Server installation
remain unsupported. Host pins, pairing/relay credentials and ordinary key-based connections retain
existing behavior. iOS implication for @eneskirca: confirm fingerprints before password auth and verify
fresh retained-key auth before saving; no host-service verb or pairing payload changed.

Seventeen actual protocol methods pass against a private MINA SSH server and private POSIX HOME.
They cover fingerprint/auth order, other/restricted keys, uncertainty/no replay, both-stream output
limits, own timeout versus external cancellation and socket closure. Offline app compilation passes.
Seven isolated compiled semantic variants fail assertions, with 17 passing control/restored
methods and exact integrated source hashes. Private proof: `.nodeterm/android-ssh-setup-2026-10-04/password-final/`.
The full required gate verifies actual Gradle/JUnit method registration too. This is source/fixture proof.
Actual Android setup UX, ordinary PAM/account behavior and macOS runtime checks remain pending;
the controlled native OpenSSH receipt below adds wire/exec evidence. Phone testing stays paused,
with beta 10/code 11 last installed and **10 Pass / 22 Partial / 32 Pending**. Beta 15 excluded A119/A120;
the subsequent beta-16 receipt below includes both. A25/A93 require the hosted-backend maintainers; A68 stays deferred and no PR opens.

## Prepared private beta 16 and verification checkpoint (2026-10-04)

`0.1.0-beta.16` / code `17` is built from clean signed source
`2723845efac75cfcf2cd0a9fdfa11d9496699641`. It includes A119's explicit saved SSH profile folder and
A120's opt-in password enrollment, along with the earlier beta-15 changes. Missing explicit profiles
never fall back to another profile; enrollment saves a host only after a separate pinned key login.
Full offline protocol checks pass **944 tests / 98 suites**, with zero failures, errors or skips.
Offline app compilation, **151 affected desktop Vitest tests / eight files** with zero skips, and
full TypeScript checking pass. Actual JUnit inventories include the new setup tests. An obsolete
inline UI behavior source pin was removed; actual SSH authentication regressions remain.
All five Android jobs pass for the APK source:
[workflow 37233114167](https://github.com/CPlusPlus17/nodeterm/actions/runs/37233114167).

The minified release build passes offline in **54.87 seconds**. Packaging uses the retained private
signer; all **56 independent artifact checks** pass, including official SDK 36/37 signatures,
nondebuggable version/manifest, R8/runtime keeps, payload/provenance and 16-KB ZIP/native alignment.
APK SHA-256: `9c5309c8cfb225daf59f7fac70be1760fb0abdaac36cb55005b958f2186c8ce3`.
Private APK: `.nodeterm/android-beta-16/nodeterm-android-0.1.0-beta.16.apk`.
Build proof: `.nodeterm/android-beta-build-16/`; behavioral/mutation proof:
`.nodeterm/android-ssh-setup-2026-10-04/`. Earlier failed or historical runs retain their separate
receipts; they are not counted as successful merged gates. The release receipt changes only docs.

**Prepared, not installed.** Phone testing remains explicitly paused, beta 10/code 11 is last
confirmed installed, and the device ledger stays **10 Pass / 22 Partial / 32 Pending**.
When authorized, install beta 16 as a same-signer update and verify saved identities, profile
selection/switching/no fallback, password/fingerprint/cancellation UX on actual OpenSSH, and the
remaining managed-session, relay/cellular, notification and lifecycle matrix. MINA/POSIX fixtures
and in-memory app adapters do not verify physical Android or macOS behavior. Live Claude rule and
question application remains unverified after provider HTTP 401. A25 FCM and A93 fresh-desktop
relay recovery require the hosted-backend maintainers. For iOS, @eneskirca should adopt the saved
profile/enrollment UX and review the earlier host protocol changes. No PR opened; A68 remains
deferred until a PR is requested. Every push requires its own exact-head green Android workflow.

## Native OpenSSH enrollment verification (2026-10-04)

A120 now has an actual **OpenSSH 10.2p1** control run in addition to its MINA regressions.
The actual protocol sources at `bac1aa7fe90416b07dd0de47ac95049e817ce8b5` were compiled privately;
**28 distinct assertions / 40 passing assertion events** verify inspection against an independently
measured public fingerprint, password login followed by fresh pinned key login and exec,
retained unrelated keys, newline/mode handling, idempotence, consumed confirmation, rejected password
and host pin, commented key text, restricted keys, symlink/nonregular targets, and closed client sockets.
These are native fixture assertions, not additional Gradle/JUnit methods or physical checklist passes.

The daemon ran as UID 1000 in a filesystem/user/PID sandbox exposing only read-only `/usr` and private
account files/home. Its password and SSH identities were newly generated for this test. It listened
only on loopback, with PAM, keyboard-interactive, forwarding, PTY and source penalties disabled.
This Fedora build warns that `UsePAM no` is unsupported; the asserted crypt/password and public-key
wire/exec flow nevertheless passes in that exact controlled configuration. This does not verify a
normal PAM/account backend, MFA, macOS, Android setup UX/Keystore, native cancellation/timeouts,
or profile/managed-session behavior. The earlier MINA tests retain their separate coverage.
Both disposable daemon runs are closed; their generated passwords/private keys/account hashes were
removed after the run. No host account, credential, SSH configuration, retained phone identity or
phone state was changed. Private proof: `.nodeterm/android-beta-build-16/openssh-native/`.

The stale SSH class comment now describes A111's host-owned managed New support; missing existing
canvas sessions remain attach-only. It changes only KDoc, with the same source line count.
The prepared beta-16 APK remains source `2723845e`, code 17 and the same retained signature/checksum;
no new APK is built or installed for this verification/comment checkpoint. Fresh compilation in the
same AGP graph confirms every protocol class byte matches the immutable beta-16 build. This byte
comparison is a required gate before publishing the receipt. Required local gates and exact-head Android CI also remain mandatory.
Phone checks stay paused at **10 Pass / 22 Partial / 32 Pending**, with beta 10/code 11 last installed.
Actual Pixel setup/lifecycle, ordinary PAM accounts, macOS and live Claude checks remain open;
A25/A93 still need hosted-backend maintainers, iOS follow-up stays with @eneskirca, and A68 remains
deferred until a requested PR. No PR opened.

### Relay-advertisement producer/SSH coverage (`A64`, 2026-10-05)

Two actual private-SSH regression methods now check every public field from the desktop's
account-level `relay.json` writer, replacement, removal and profile isolation. A third method
checks the actual writer/remover and `fs-atomic` bundle inputs against Android CI path coverage.
All 75 affected protocol methods pass with zero failures/errors/skips. Four isolated behavior
mutants fail assertions, and control/restored runs pass. Private proof: `.nodeterm/android-beta-build-16/desktop-links-and-advertisement-receipt/a64/`.
The producer uses a temporary OS-home adapter during module initialization, restored before its
operations; no standing relay host, token mint, adoption, SAS, revoke or phone result is claimed.
No production contract or APK changes. Beta 16/code 17 remains prepared, beta 10/code 11 remains
installed, and phone checks stay paused at **10 Pass / 22 Partial / 32 Pending**.

## Canvas terminal link leave follow-up (A121, 2026-10-05)

The full Linux Desktop native hover check for A92 exposed a separate Canvas leave defect:
synchronous blur redraws xterm's DOM rows before its screen receives mouseleave, leaving the
link pointer active after a native non-drag leave in the SGR mouse case. A121 now defers only
owned blur to the next timer task and cancels it on re-entry, focus and cleanup before park.
Nine behavioral methods, all 63 affected terminal tests, full TypeScript and five assertion
mutants pass. Fresh full Linux Desktop control and restored builds each pass all eight native
UI cases at `01b4a2f5`; the old-bound A92 and synchronous-blur A121 mutants fail on their named
hover/leave assertions after trusted mouse delivery. Separate Linux Server checks pass at
`dcdf664a`. The later GPU-enabled eight-case matrix passes (Canvas4 hardware / Modal4 DOM); GPU
context recovery and native macOS remain unverified. No Android runtime, APK, external contract
or iOS change is involved. Phone testing remains paused: beta 10/code 11 is last installed,
beta 16/code 17 is prepared, and the physical ledger stays **10 Pass / 22 Partial / 32 Pending**.

## Native Desktop wrapped-link and leave verification (A92/A121, 2026-10-05)

Signed source `01b4a2f5` now passes the full actual Linux Electron Desktop UI check. Four fresh
full builds consume all **2,462 exact raw Git blobs**, with only the one approved source literal
changed in each mutant. Control and restored runs each pass all eight combinations of Canvas
and maximized Board modal, hard/soft wraps, and normal/SGR mouse reporting. A real plain native
NodePTY paints the long run; native trusted XTest tail hover shows the entire URL underline and
pointer, plain click opens nothing, Ctrl-click opens exactly the complete URL once, and a native
non-drag leave clears the pointer and underline. No direct provider or activation call is used.

The old upward cap fails with `A92_TAIL_HOVER_MISSING` after calibrated native tail hover.
Restoring synchronous Canvas blur fails with `A92_HOVER_CLEAR_FAILED` after trusted hover, full
Ctrl-click activation and native leave, retaining pointer/link state. The final blur mutant fails
in Canvas soft/SGR; an earlier run also reproduced it in hard/normal mode. Nine controller tests
and five assertion mutants cover cancellation, replacement, same-object park/adopt and cleanup
reuse; all 63 affected terminal Vitest methods and full TypeScript pass.

Private durable proof: `.nodeterm/android-beta-build-16/desktop-links-and-advertisement-receipt/`
contains `a92/results.json` with 72 source/build/runtime evidence files, `a121-unit/results.json`
and `a121-affected/result.json`. Network/PID/home isolation and unchanged source/tools/held output
checks pass. Earlier archive-line-ending refusal, phase-specific classification rejection and
quit timeout are preliminary recipe results; they were not counted as product failures or final
controls. The final disposable fixture uses explicit exit after recording the checks; ordinary
app quit is outside this proof. Synthetic SGR reporting does not verify a real TUI/tmux/SSH path,
Server Edition, GPU, macOS or Android. No APK, host/client contract, iOS adoption or physical
checklist promotion follows. Phone testing remains paused at **10 Pass / 22 Partial / 32 Pending**.

## Native Server wrapped-link and leave verification (A92/A121, 2026-10-05)

Signed source `dcdf664a4ffa0cf752350c29fc21843f74c93ae1` passes separate genuine Linux Server
control and restored runs, each with all eight Canvas/Board-modal, hard/soft-wrap and normal/SGR
cases. Four fresh full builds use 2,462 raw Git blobs; each separate `server:build` adds only
`server/main.cjs` to the unchanged 136 artifacts. Actual Node 26 runs the shipped Server entry.
Chromium loads its real login form and HTTP renderer with no Desktop preload, Node integration
or injected API. Passive observation confirms authenticated `/ws` handshakes, actual PTY create
requests/replies and binary output. Native trusted hover, full underline, plain/Ctrl click and
non-drag leave assertions pass. Both the old-cap and synchronous-blur mutants fail their named
assertions after calibrated native input; restored source passes again.

Private proof: `.nodeterm/android-beta-build-16/server-links-receipt/a92/results.json` and its
105-file manifest bind source, builds, recipes and runtime. Three earlier browser-bootstrap
failures remain separate infrastructure evidence, with no terminal assertions or product finding.
Loading the actual login document before enabling debugger network observation resolves the
runner stall. Final owned Node children close on SIGTERM; disposable Chromium exits explicitly
after the report. This verifies Linux Server DOM rendering with a synthetic reporting-mode TUI;
real tmux/SSH, GPU, macOS, ordinary quit and Android UI remain outside its scope.

No runtime or external contract changes follow from this verification. Beta 16/code 17 remains
prepared from `2723845e`, uninstalled; beta 10/code 11 is last installed. Phone testing stays
paused at **10 Pass / 22 Partial / 32 Pending**. Next: resume the Pixel update/checklist when
authorized; live A105/A106 needs a usable provider account after HTTP 401; A25/A93 need hosted
backend maintainers. The Android contribution is in this repository. No PR is opened; A68 waits
for requested PR preparation.

## Native setup timing, installed PAM and remaining desktop checks (2026-10-05)

A120 now passes four native OpenSSH cancellation/deadline cases at clean source
`7cf2bb339d73c98e7876a7ce1edec5f6f3585141`, with **76 case-scoped assertions**.
All 76 protocol source files were compiled privately with Kotlin 2.2/JDK 21 and SSHJ 0.39.
The pre-install gate admits real password authentication and the exact production exec request,
then holds it without running the installer; cancellation/deadline leaves authorized_keys unchanged.
The post-install gate retains the actual installed key, accepts a third connection and reads a
real upstream SSH banner before withholding it. That case does not complete a third key exchange
or key authentication. External cancellation remains CancellationException; the operation's own
12-second post-dispatch deadline reports HostUnansweredException. Neither returns a PairedHost.
Owned client sockets, gates and daemon descendants close; caller password buffers clear, consumed
confirmations cannot replay, unrelated key bytes/modes survive, and generated secrets are removed.
This is protocol/native proof, not physical HostStore, Keystore or Android background/setup UX proof.
Private proof: `.nodeterm/android-beta-build-16/operation-verification-receipt/openssh-timing/`.
The earlier 28 distinct native assertions / 40 events and 17 JVM methods / seven product mutants
retain their separate inventories; these new fixture checks are not new JUnit methods or mutants.

A separate **17-check native installed-PAM control** passes against OpenSSH 10.2p1 and this host's
unchanged Fedora PAM stack. It uses a namespace-only synthetic NSS/shadow account and a UID/GID
1000 client with every process capability cleared. Actual logs record one accepted password,
two accepted key authentications, three successful PAM account checks, and three matched session
opens/closes, with no PAM session/credential errors. Public fingerprint confirmation, independent
retained-key exec, wrong-password/pin refusals, key-file preservation, no replay and socket cleanup
pass. All 31 public installed-stack bindings remain unchanged, SELinux remains enforcing, and
generated credentials plus owned daemon descendants are removed. This reuses 513 class files from
the earlier timing compilation after verifying all 76 protocol source bytes; only the 11 standalone
driver class files are freshly compiled. It does not verify real-user policy, MFA, ordinary systemd
user-session registration, macOS, or Android UI/storage. Earlier setpriv and private-log traversal
failures are retained as failed fixture attempts, without product fixes or mutation credit.
Private proof: `.nodeterm/android-beta-build-16/operation-verification-receipt/runtime-checkpoint-supplement/`.

The earlier RTX 4090 WebGL2 probe verified the environment only; the successful PAM namespace
admission performed no authentication. Their historical scope is unchanged. Later product GPU
and installed-PAM results supply the separate evidence recorded here.

Earlier focused-terminal Ctrl+Q attempts remain nonpositive. V5's trusted renderer capture and
main before-input observations do not establish `defaultPrevented` after xterm's target handler.
Minimal Electron Quit controls verified the environment, not product Quit; failed fixture and
classifier attempts remain separate from the successful runs below.

**Historical Linux Desktop runtime checkpoint:** current source `972f7994` differs from built
Desktop `01b4a2f5` only in six documents. Native File-menu Quit/Cancel and a separate outside-terminal
Ctrl+Q/Cancel both pass, followed by native File-menu confirmation and natural zero exit. Cancel
preserves the exact own PTY/workspace/window; Quit retires the own PTY/hook and saves state.
The GPU-enabled eight-case link matrix passes with eight complete URL opens: four Canvas cases
use the actual NVIDIA RTX 4090 xterm WebGL2 context, real glyph pixels and production 2D link
underline before/hover/leave; four Modal cases intentionally use DOM. The single GPU pilot stays
separate. A real shipped-tmux Canvas soft-wrap/inner-no-reporting pilot also passes one native
hover/plain-click/Ctrl-click/leave case while preserving the exact pane/client and shipped mouse-on
options. GPU and tmux fixtures use explicit `app.exit(0)`, supplying no ordinary-Quit proof.
These do not verify GPU context recovery/compositor pixels or full tmux/SSH matrices.
Private proof: `.nodeterm/android-beta-build-16/operation-verification-receipt/desktop-checkpoint-20261005/`.

**A122 is fixed in `9613cec519c1469aff10371bf0acf97adb90ed1a`.** Desktop Canvas/Modal now keeps the
exact native Quit chord ahead of xterm on keydown/keyup under either shortcut policy, without
preventing the native menu. Server retains Ctrl+Q/XON. 133 focused policy tests, 218 affected tests
in three files, full TypeScript and six assertion-caught isolated mutations pass. The fresh full
Desktop build is bound to that exact source (snapshot `57e09375369a1a68f0c28b7975616561aad6715a4dc05a6fc5eeb00d0dc0706c`;
build receipt `86eb82912ab7aa8a853a7236bacebc40ffbd9eff6845f3b79caaac83a029f5ff`).
All four native Linux cases pass: Canvas/Modal × app-first/terminal-first. At dispatch the actual
owned xterm textarea and main focus IPC are true; Ctrl+Q opens the real parented Quit dialog.
Native Escape Cancel retains the exact PTY and saved state; native File → Quit / Tab / Enter then
exits naturally with code zero, retires every admitted PTY birth and removes the own hook endpoint.
No signal, `app.exit`, renderer-dispatched key or API Quit supplies a pass. These are four separate private
home/network/PID/Xvfb cases, with zero link cases/URL opens; native macOS/Windows remains unverified.
Private proof: `.nodeterm/android-beta-build-16/operation-verification-receipt/desktop-native-quit-20261005/`.

The A122 source repair changes Desktop shortcuts only; Android and external contracts are unchanged.
Beta 16/code 17 remains prepared from `2723845e`, uninstalled; beta 10/code 11 is last installed.
Phone testing stays paused at **10 Pass / 22 Partial / 32 Pending**. The later tmux/SSH and
GPU follow-up below keeps its own source bindings; other-platform runtime remains unverified.
A105/A106 live checks need a usable provider after HTTP 401;
A25/A93 need hosted-backend maintainers. Resume Pixel checks when authorized. No PR is opened,
and A68 remains deferred until requested PR preparation.

## Tmux, SSH and GPU recovery follow-up (2026-10-05)

The fresh full Linux Desktop build at `6bfa5412` passes two separate eight-case matrices:
Canvas/Board modal × soft/hard wrap × inner mouse reporting off/SGR. Each matrix delivers
52 native mouse actions and eight complete URL opens through shipped xterm handlers. The local
matrix uses real shipped tmux; the remote matrix uses an actual SSH project, production
SshProjectManager/OpenSSH ControlMaster and remote `nodeterm-rmt` tmux. Exact pane, server and
client births survive every case. SSH retains its connection notice in history and calibrates the
actual viewport offset; the fixture does not erase it. Own session and SSH service cleanup pass.
These fixtures end with explicit app exit and supply no ordinary-Quit or SSH-reconnect proof.
Private proof: `desktop-tmux-matrix-20261005/` and `desktop-ssh-matrix-20261005/` below
`.nodeterm/android-beta-build-16/operation-verification-receipt/`.

Two separate one-terminal GPU pilots at that same source pass delayed loss → readable stock DOM
→ fresh NVIDIA WebGL2 and quick original restoration → DOM → fresh WebGL2. Both retain the same
49×48 buffer/PTY and three trusted native input acknowledgements, with complete URL interaction
and glyph checks before/after. Quick restoration also exposes A123: the detached original
context remains live after the new renderer is granted. Chromium cap-pressure consequences are
an inference; no page-wide pressure failure was reproduced.

A123 is source-fixed in `db83fb7d`: retire the captured original context after addon disposal and
before reporting context loss to the budget coordinator. Two new behavioral tests cover detached
canvases and retirement continuing after a throw; all 44 budget tests and 301 affected tests in
seven files pass with full TypeScript checking. Full 44-test control/restored helper runs catch
two exact assertion mutants. Three separate fresh full Desktop builds at `db83fb7d` verify the
actual restore hook: both fixed controls release the original context before fresh regrant, while
the compiled sole-call-removal mutant fails only `GPU_RETIRED_CONTEXT_NOT_LOST` after all three
native input acknowledgements and both complete URL controls pass. A capture-phase native event
witnesses the genuine restoration before production retires it; a passive second-loss event and
DOM/fresh/final checks verify retirement. Fixture probes retain the original context for observation;
no forced GC or second fixture loss supplies a pass. These are one-terminal Linux Canvas pilots,
with explicit fixture app exit rather than ordinary Quit. Private proof: `gpu-context-recovery-20261005/`
for historical recovery and `a123-context-retirement-20261005/` for the new source/compiled mutants.
The older 6bfa and A122 source/build bindings remain separate.

**Additional Server verification (`fa259f6e`).** Three fresh genuine Linux Node Server/browser
Canvas soft/none runs pass fixed control / sole-call-removal mutant / restored confirmation
with natural fixture exits 0 / 3 / 0. Each authenticates through the shipped HTTP login and WS
bridge, without Desktop preload, and retains the same plain NodePTY, producer, 49×48
buffer and geometry. Three trusted native input ACKs and two complete URL/glyph controls complete before
the retirement assertion. Fixed runs witness genuine original restoration, production loss of that retired
context, stock DOM fallback and fresh NVIDIA rendering; the calibrated mutant fails only
`GPU_RETIRED_CONTEXT_NOT_LOST`. Owned Server SIGTERM closes it gracefully with zero and removes
its PTY/producer; fixture app exit supplies no ordinary-Quit proof. This is one visible Server
Canvas pilot, not a Server GPU matrix or pressure test.

**Additional SSH reconnect verification (`fa259f6e`).** One Linux Desktop Canvas soft/none
pilot passes after a single controlled SIGKILL of the exact product ControlMaster. Actual SSH
exit 255 triggers shipped automatic recovery; a separate strictly pinned read-only observer
verifies the same remote tmux pane and server, session-created identity, full history and producer across
the gap and recovery. A new master, local PTY and remote attachment are required. Two trusted
native `g` ACKs and complete URL hover/plain-click/Ctrl-click/leave checks pass with one producer
paint. Exact owned session, observer, master and daemon cleanup passes; explicit fixture app exit
provides no ordinary-Quit proof. Observer reads may affect timing, so this proves no performance
or backoff guarantee. Broader SSH reconnect matrices remain pending; this pilot supplies no
Modal, Server, Android or PAM enrollment proof.
Earlier V2 nonce admission and V3 service-process failures remain fixture negatives; V3's outage
state was not established. Private proof: `.nodeterm/android-beta-build-16/operation-verification-receipt/desktop-ssh-reconnect-20261005/`.

**Derived Desktop compositor evidence (`db83fb7d`).** A separate hash/CRC-checked analysis of
three existing positive-run `capturePage` PNGs compares an uncovered repeated `A` cell and a blank
cell with the actual framebuffer RGB references. All three match 152/152 pixels in each cell;
42 glyph pixels differ from the blank background. The Sessions-covered top-left cell is excluded,
not a product failure. Recorded geometry establishes 1:1 capture/CSS/GL scales at zoom 1;
a direct device-pixel-ratio query was not recorded. This adds a single-run compositor cell
correlation without rerunning the product or relabelling its old receipts. It does not establish
synchronized frames, whole-frame or physical-display output, or link-underline compositing.

Private proof: `.nodeterm/android-beta-build-16/operation-verification-receipt/a123-server-context-retirement-20261005/`
contains **80 evidence/recipe files plus its manifest**. Server runtime and historical Desktop
cell derivation remain separate; the original Desktop receipts are unchanged.

Android and external contracts are unchanged. Beta 16/code 17 remains prepared from `2723845e`,
uninstalled; beta 10/code 11 is last installed. Phone testing remains paused at **10 Pass /
22 Partial / 32 Pending**. Repeated/page-wide GPU pressure, shared glyph eviction, synchronized/
full-frame compositor or physical-display output, broader SSH reconnect, macOS/Windows and the remaining
Pixel checklist are unverified. Live
A105/A106 needs usable provider authentication; A25/A93 belong to the hosted-backend maintainers.
A68 is source-fixed for branch readiness; no PR has been opened.

**A68 workflow readiness (2026-10-05).** Source fix `7e91785c` limits Android
push runs to `main` and retains pull-request path filters, without `merge_group`. Feature-branch
pushes no longer duplicate PR checks or automatically prepare beta inputs. Manual
`workflow_dispatch` with `prepare_beta=true` runs all five Android jobs; beta version overrides
and **Private beta checks** are confined to that opt-in. The registered workflow `366764274`
accepts API/CLI dispatch on the selected ref; verify the run's exact head before using its results.
Pre-cutover control [run `37260849252`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37260849252)
was dispatched at `c371860f` with `prepare_beta=true`: all five jobs passed.
That control establishes dispatch admission, not verification of the later A68 source fix.
All 13 focused trigger/path methods pass. All eight actual workflow mutations fail the real
configuration test, with all 13 methods passing before and after restoration. The full
949-method/98-suite protocol gate and offline app compilation are required before push.
After push, exact-head CI is required through `workflow_dispatch` with `prepare_beta=true`;
the verified run and exact head are recorded with the source exports. This closes the source
finding; no PR is opened by this checkpoint. APK/client bytes, private signing, phone pause
and **10 Pass / 22 Partial / 32 Pending** are unchanged.

## Native custom wheel checks (2026-10-06)

`SshTransportTest` adds `SSH scrolling honors custom wheel bindings in both copy key tables`.
It uses the actual SSH connection and `TerminalActions` with a native tmux server in a private
`TMUX_TMPDIR`. It seeds 750 output lines, selects each copy key mode and installs asymmetric
wheel bindings. Requests of 37, 23 and 29 notches exceed one transport chunk; the host bindings
define the history distance rather than a client-side normalization.

| Mode | Up/down row gains | Up37 | Then down23 | Then up29 | Queued up37/down73/up29 |
| --- | --- | --- | --- | --- | --- |
| Emacs / copy-mode | 3 / 2 | 111 | 65 | 152 | 87 |
| Vi / copy-mode-vi | 7 / 4 | 259 | 167 | 370 | 203 |

Each native `scroll_position` must settle for 300 ms within an eight-second deadline. The queued
sequence reaches the live bottom before returning to history, making its final result sensitive
to direction ordering. The fixture verifies exact restoration of the original local mouse/mode
overrides and both affected wheel bindings, including absent overrides.

The targeted offline control passes **one test, zero failures/errors/skips**, in 14.135 seconds.
A separately isolated network/PID/home/source control and restored run each pass the same eight
positions. Three actual transport mutants fail the exact first-distance assertion: reversed
direction and a dropped wheel write produce 0; clamp20→1 produces 6, versus 111 expected.
Setup/cleanup assertions do not count as caught mutations. The first idle-copy-mode cancellation
mistake stopped the test before scrolling; its negative receipt remains separate from the corrected
control and earns no product finding or mutation credit.

Source base is `e6dc6ef3` plus the new test (SHA-256
`5cd81c49f36744393d98fcfabd6c73ee086f5cb25e1940ce43811c1ac17fe3cc`). Private control proof:
`~/.cache/nodeterm-android-work/a86-custom-wheel-native-kkvz22xp/`; mutation proof:
`~/.cache/nodeterm-android-work/a86-native-wheel-mutation-yo4k_bju/proof/`.
The mutation receipt binds all 2,462 tracked files unchanged before/after; production sources
are unchanged. Before publication, the full offline protocol/app gates and exact-head five-job
Android CI still apply. This is native copy-mode transport/ordering evidence, not phone gestures,
FPS, broader lifecycle/outage or macOS/Windows proof. Beta 16 and the original Pixel's
**10 Pass / 22 Partial / 32 Pending** ledger remain unchanged. Next: continue the remaining
physical matrix when the intended Pixel is reachable; A25/A93 still need the hosted backend.

## Desktop card reconnect repair (2026-10-06)

A125 is source-fixed in `415dae9b`; A126 is committed in `5b7286b3`.
A125 replaces only the lost open card viewer after the coordinator succeeds and passes the
owning project through both boards. The card stays open, retains persistKey/requireRemote and
never replays an initial, pending or agent launch command. Its 13 new cases/100 affected tests
and six assertion-caught mutants retain their separate control/restored evidence.
A126 chooses one live automatic responder per exact `api.pty`/actual session in this renderer,
while preserving genuine input/focus and deterministic promotion. Its 16 new cases comprise nine
installed-xterm checks, one fallback shim and six fake-rendering mounted Modal cases with real
helper/LocalTransport/coordinator.
**294 unique affected tests / 17 files** and full incremental TypeScript pass. **15 isolated
mutants (six A125 + nine A126)** are caught by assertions; each fix's control/restored runs pass.
Forced offline checks at `5b7286b3` execute **950 tests / 98 suites**, zero failures/errors/skips,
and both protocol/app Kotlin compile tasks. These are disposable QA hosts; no new APK or regular
Desktop installation is included. Publication requires fresh offline gates and all five Android
CI jobs for the exact published HEAD; its private bundle and final report carry that run's result.

Eight actual Linux Desktop **Canvas/Modal × soft/hard wraps × inner none/SGR mouse** cases
pass at `5b7286b3`. Each loses one birth-pinned product ControlMaster, creates a new master/
selected local viewer and retains its remote pane/server/producer/cwd and complete same-grid history before,
during, after and at final observation. Both trusted actual textarea `g` inputs are acknowledged
on the old/new PTY: **16 ACKs**, **zero unexpected bytes**, one producer paint per case and
**16 complete URL activations**. Native hover/leave and exact owned cleanup pass. Modal cases
use `80x24`; Canvas cases use `49x48`, with each history comparison bound to its own grid/case.
Private native aggregate: `~/.cache/nodeterm-android-work/a125-a126-native-matrix-ww8e8nwo/root-acceptance.json`,
SHA `d8a5366b83d4c4b3ada9a1112521f762905ce3b835be4a32983ce9150f4f391a`.
It binds all eight receipt/runtime hashes, geometry/history/timing and exact cleanup.

The historical `11e22453` stale-Modal negative and first `415dae9b` control retain their original
provenance. The latter creates replacement viewers but records 18 unexpected DA1/DA2 bytes after
ACK 1; ACK 2 is not attempted. Its unclassified wrapper/runtime exits 1/2 remain separate from the
later A126 diagnosis. Those failed controls are not rewritten as repaired-source positives.
See [audit A125](android-audit-2026-09.md#a125) and [audit A126](android-audit-2026-09.md#a126) for exact evidence.

**Two-host follow-up (2026-10-06).** One Linux Desktop soft/none case at `59e4c93e` passes in
27.39 seconds: an ordinary quiet B park/adopt cycle, then inactive B's continuously open global
card reconnects while A remains active and unchanged. Three native `g` ACKs, two complete URL
activations, zero unexpected input, one paint per role, same-grid retained history and exact owned
cleanup pass. Carried SID provenance is primary create/native Canvas `g1` plus unchanged writer/
subscriptions/client; no adopted Canvas-input/current SID-ref result is claimed. See [the bounded two-host follow-up](#inactive-global-card-owner-and-bounded-parkadopt-2026-10-06)
for exact source/proof hashes and the remaining scope; no new repair or product test count is added.

Actual Canvas mounting and selected-view native keyboard recovery pass in the eight-case matrix;
one additional two-host soft/none case verifies a quiet park/adopt cycle and inactive global-card
recovery with the active host unchanged. See [the bounded two-host follow-up](#inactive-global-card-owner-and-bounded-parkadopt-2026-10-06). Remaining Android release acceptance needs a
reachable intended phone for lifecycle/outage, answer/notification/permission and live-provider
checks; A25/A93 need hosted-backend maintainers. Further host coverage includes streaming/expiry/
eviction while parked, repeated or broader outage/backoff, Server/cross-window response ownership,
GPU pressure/full-frame display output and macOS/Windows. The synthetic key-only hosts do not
establish real-user PAM, power-loss, agent-launch or ordinary Quit behavior. Unsupported private
xterm shapes warn and retain input but may duplicate replies; legacy onBinary is unchanged.
No Android wire/file or iOS client change is required. The original Pixel 10 Pro ledger remains
paused at **10 Pass / 22 Partial / 32 Pending**.

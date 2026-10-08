# Android companion: handover (updated 2026-10-08)

Read this first if you are picking up the Android work. It records where the work stands, what has
and has not been verified, what is known to be broken, and the plan in order. The full list of
findings, with evidence and fixes for each, is [`android-audit-2026-09.md`](android-audit-2026-09.md)
(original IDs `A01`–`A77`, continuation findings `A78`–`A137`). The design notes are [`android.md`](android.md) and the user-facing readme is
[`../android/README.md`](../android/README.md).

## TL;DR

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
The original **10 Pass / 22 Partial / 32 Pending** ledger is unchanged. See [the scoped finding](android.md#pending-send-outcome-after-remount-2026-10-08-a137).

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
[the scoped evidence](android.md#retained-terminal-editor-2026-10-08-a136).

**Captured Ctrl consumption (2026-10-08, A135 — source fixed).** Delayed raw-keyboard
consumption now checks the captured Ctrl revision as well as its viewer. Five policy and three
wiring regressions pass; three policy mutants and one wiring mutant are caught. Source publication
and beta22 installation pass; a physical scheduling reproduction remains pending. See
[the scoped evidence](android.md#captured-ctrl-consumption-2026-10-08-a135).

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
See [the measured receipt loss](android.md#lost-send-reply-and-newer-draft-2026-10-08).
A new real SSH/tmux second-Enter acknowledgement regression passes healthy/restored controls;
its false-success mutant is caught. Production behavior and the installed APK are unchanged.

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
See [the measured receipt hold](android.md#held-send-reply-and-newer-draft-2026-10-08).

**Earlier nine-second Send/newer-draft follow-up (2026-10-08 — bounded partial).** A fresh `d361ce8f`
fixture uses unchanged Desktop/build `0d8594a6` and stock beta21/APK source `ef4caec2`.
One Send and a draft suffix return before the same SSH peer resumes, but the final newer-draft/
disabled-Send XML observation misses the pause deadline; the original wrapper remains failed.
Later XML retains the exact newer draft and saved pixels show its suffix; Send is enabled and one
original-TTY witness/real ACK stays unique 125.310 seconds later. At that earlier checkpoint, the
strict timed race and lost-reply cases were unverified; the failed wrapper remains preserved.
See [the bounded follow-up](android.md#nine-second-send-and-newer-draft-follow-up-2026-10-08).

**Silent SSH peer recovery (2026-10-08, Pixel 7a / beta21 — bounded pass).** Fresh owned checkout
`04da9b9e` uses unchanged Desktop/build `0d8594a6` and installed APK/source `ef4caec2`. Only the
admitted old SSH peer is stopped for 45.000 seconds on shared loopback; automatic recovery creates
a new viewer while it is paused, preserving the original shell, producer, tmux server/socket and
guard. The unsent draft and its saved rendered text remain; one later explicit Send executes once
and receives a real ACK. At that checkpoint, whole-host/network loss, cursor position and
lost-reply races remained unverified. Owned cleanup passes; the original **10/22/32** ledger stays
unchanged. See
[the bounded receipt](android.md#silent-ssh-peer-recovery-and-single-send-2026-10-08).

**Native Desktop continuity (2026-10-08 — scoped verification).** A fresh private Desktop/build
`0d8594a6`, observed with the docs-only `98907171` checkout, passes two original session-host
factories, retained capture of all 200 unique numbered markers with Unicode, one normal renderer
reload and input to the same original shell before/after it. The complete sibling capture and
original daemon/Bash/producer/socket generations stay unchanged; owned retirement is verified.
Android native-history/Live-overlay acceptance, silent network loss and native-route held/lost replies remain open.
Installed beta21 and the original **10 Pass / 22 Partial / 32 Pending** ledger are unchanged.
See [the native consumer receipt](android.md#native-desktop-capture-and-renderer-reattach-2026-10-08).

**Login-shell deadline (2026-10-08, A134 — published; original create verified).**
Signed, pushed `3f382367`/`0d8594a6` pass forced **1033 methods / 110 suites**, offline app compilation,
full TypeScript and **161 tests in nine affected Vitest files**, with five known Windows-only skips.
[Run `37702852854`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37702852854), attempt 1, passes all five jobs and ten required steps.
A fresh source-built Desktop observes one original Linux session-host create fulfill and display
its Bash prompt, with zero PTY input. V13's child cause and whether fallback fired remain unknown;
native history and its phone overlay remain pending. Installed beta21/source `ef4caec2` and the
original **10 Pass / 22 Partial / 32 Pending** ledger are unchanged.
See [the scoped source checkpoint](android.md#login-shell-probe-completion-deadline-2026-10-08-a134).

**Direct SSH continuity (2026-10-08, Pixel 7a / beta21).** Desktop `0d8594a6` with the unchanged
stock APK/source `ef4caec2` passes controlled SSH-handler recovery, two active Home/resume cycles,
draft retention and one explicit Send to the original tmux pane. The producer/server/socket and
sibling guard remain unchanged. Phone cleanup is verified; the outer runner stop-accounting
negative is preserved. Native-history/relay/notification and wider lifecycle cases stay open.
See [the bounded continuity receipt](android.md#direct-ssh-reconnect-and-active-background-continuity-2026-10-08).

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
[the scoped evidence](android.md#fresh-fedora-output-and-native-desktop-readiness-2026-10-08).

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
remain outside these observations. See [the bounded receipts](android.md#beta-20-publication-and-bounded-output-checks-2026-10-07).

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
owned cleanup add no app/CA/APK acceptance. See [the scoped evidence](android.md#beta-19-publication-provider-and-emulator-checkpoint-2026-10-07).

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
ledger, which stays **10 Pass / 22 Partial / 32 Pending**. See [the bounded beta-17 receipt](android.md#pixel-7a-beta-17-upgrade-and-composed-send-2026-10-06).

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
complete URL activations**, retained same-grid history and exact owned cleanup. See [the bounded two-host follow-up](android.md#inactive-global-card-owner-and-bounded-parkadopt-2026-10-06).
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
open. See [the native checks](android.md#native-custom-wheel-checks-2026-10-06) and the physical receipt above.

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
A92/A121 also pass separate eight-case native Linux Desktop and genuine Server UI checks;
the later receipts preserve both assertion mutants and their source bindings.
The original Pixel 10 Pro remains paused on beta 10/code 11 with
**10 Pass / 22 Partial / 32 Pending**. Fresh Pixel 7a results and the A124 failure are recorded
separately above; the repaired single managed-shell case passes, while live-provider and broader lifecycle/outage checks remain unverified. Immediate FCM
and fresh-different-desktop relay recovery (A25/A93) still need the maintainers' hosted backend
source; the user has no backend checkout. The push adapter points to a separate `nodeterm-server` spec; it was not found in 39 nearby checkouts or the owner’s 22 public GitHub repositories. Existing missing canvas sessions remain attach-only
over SSH. See the audit and Known gaps for unsupported backends and remaining verification.

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

- **Four additions are implemented after the beta-10 checkpoint (2026-10-04).** Sessions search,
  live All computers refresh, Find in captured terminal output, and recursive SSH Include anchor
  discovery are prepared in beta 11/code 12; full shared checks and the local release build pass;
  the Pixel still runs beta 10/code 11. Phone testing remains paused, including final rotation
  restoration/fixture Forget and background notification checks. The current device ledger stays
  10 Pass / 22 Partial / 32 Pending; new search/refresh/Include flows need physical verification.

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

- **Beta 10/code 11 is installed; item 1 paired update passes (2026-10-04).** `0.1.0-beta.10` / code `11`,
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

- **Relay creation, Rename and exact End verified; Refresh dispatch observed (2026-10-04).** On
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

- **A95 is fixed and verified on the rebuilt production desktop (2026-10-04).** The held
  `071735d6` build reproduced stale mounted Board moves/labels. The same owned paired profile now
  runs the repaired `ec12ea9a` production build; Android remains installed beta10/code11 (`e3ce041c`),
  with no APK change for this desktop fix. Actual phone Move to Ungrouped, label removal, re-addition
  and creation/application of a second blue label update both persisted state and the mounted
  desktop Board without a reload. Baseline and every resulting DOM snapshot share page time origin
  `1791111312961.1` and match persisted state. This completes item 36. Nine affected Vitest suites
  (133 tests), full and strict acceptance TypeScript checks, and four isolated mutants also pass.
  The ledger is 10 Pass / 22 Partial / 32 Pending. This verifies the owned production fixture;
  no deployment to the user's regular desktop or full release/device pass is claimed.

- **Checks resumed on 2026-10-04; A93 is an open relay-pairing finding.** Remote-on pairing to
  a fresh isolated desktop succeeds locally but receives no relay credential. A bounded
  retry using the exact unchanged production mint request body returns HTTP 403 reauth_required. The old fixture was
  forgotten, removing its phone-side relay token; the fresh desktop identity differs.
  Original same-desktop recovery now succeeds through ordinary full-profile restart/re-pair,
  unchanged identity and actual relay credentials. Fresh-different-desktop refusal remains open;
  no backend source, copied user credentials or phone-identity reset is involved. iOS recovery
  needs verification for @eneskirca.
- **A94 is fixed in 3c217cba and delivered in beta 10; full focused phone flow passes.** The otherwise-empty SSH host remains labelled
  “Loading sessions…” on beta 9 despite a completed empty answer, connected SSH and New terminal.
  The fix stamps that answer's fetch time. Five actual Kotlin methods and eight isolated mutants
  pass; full 689-test protocol/offline app checks and APK delivery pass, with the installed
  both sole-End cycles show completed empty/no Loading/row/group with SSH/error retained;
  Home recreation opens an actual bash pane between them. Item 1 passes; the ledger is **10 Pass / 22 Partial / 32 Pending**.

- **`A92`: the recorded desktop file-link gap is fixed in `127b6b28`.** The
  capped paragraph now contains the hovered row after long hard/soft wrapped runs. Focused
  Vitest 24/24, affected link/dialect suites 54/54, full TypeScript check and three isolated
  mutants pass. All eight native Linux Desktop UI cases now pass at `01b4a2f5` with A121's
  leave fix; separate eight-case Linux Server checks pass at `dcdf664a`. The later GPU-enabled
  eight-case matrix passes (Canvas4 hardware / Modal4 DOM). Those earlier runs did not verify GPU
  recovery; later individual pilots are recorded in the final follow-up. macOS remains unverified.
  This is Desktop/Server renderer
  work only: Android already fixed `A32`, no host contract changes or iOS adoption are owed,
  and no APK rebuild or phone-check promotion follows from it.
- **`A91`: empty-host stale rows are fixed in `4d33a5b5` and delivered in beta 9/code 10.** The last phone-shell
  End on an otherwise empty SSH host returns `NothingFoundException`; native refresh now clears
  that authoritative empty listing while retaining cached rows on other errors and propagating
  cancellation. The error and connected SSH route remain. Four new regressions and six isolated
  Kotlin 2.2/JDK 21 mutants pass; full protocol **688/67**, zero failures/errors/skips (52 seconds),
  and offline app compile (6 seconds). Source `4d33a5b5` built in 43 seconds and updated the
  intended Pixel with the retained signer in 6.46 seconds; its installed APK hash matches.
  Three owned beta-8 shells survived the update and later verified cleanup. On Oct4, the
  otherwise-empty-host first Home creation/exact last-End/row-and-group removal/connected SSH
  and second Home creation pass. That second shell survives beta 10's update, followed by
  the full A91/A94 End/Home recreation/open/End empty-screen cycle. Final fixture/service cleanup
  is not yet claimed.
- **`A90`: explicit plain SSH-terminal creation is implemented and host-verified.** Protocol
  `bcc92367` and UI/model `b88d1415` add the path. The manual
  SSH/WireGuard host has driven projects but no own desktop workspace. Create a shell in a
  discovered host folder or Home on dedicated `nodeterm-phone`; rediscover it under Phone
  terminals and end its exact owned session. No shared project-file/canvas writes or managed
  agent identity; desktop/Server Edition scans remain on their own two sockets. Cold-agent
  `A08` refusals and relay canvas New session stay unchanged. Installed beta 10 / code 11 contains
  it; focused Pixel Home/project/custom creation, history/restart/update/reconnect and exact UI
  End pass. Item 32 is Partial; relay plain-shell creation/input/End pass, managed and cellular creation stay open. A91 empty-host flow passes on Oct4.
  Beta-6 physical proof is historical,
  and beta 7 / code 8 remains a prepared, unused candidate.
- The private minified beta 10 is installed on the intended Pixel 10 Pro (Android 17 /
  API 37), with a retained private signer. Historical proof retained through beta 6 covers manual
  SSH listing of 17 real projects, input, font/keyboard resizing, pre-attach tmux history and
  user-confirmed terminal access over mobile-data WireGuard with Wi-Fi off. The wrong-MI8
  installation and its newly authorized SSH key were removed.
- **Beta 6 verifies continuous dragging, coast, Esc and new-touch stopping on the Pixel (`A86`, `A89`).**
  SSH reopened with its retained key/pin at 56×48. A slow controlled swipe produced 23 position
  updates; a fast swipe kept moving for about 799 ms after the ADB command completed. Esc left
  copy mode and remained out for 1.4 seconds. `c4b1f6cf` fixes beta 5's detached text-span touch
  target by targeting the stable screen. A held touch stops coast in a stable 56×25 keyboard-open
  viewport; earlier resizing tap checks were inconclusive. The user confirms normal dragging and
  coasting both work now. The final beta-6 cellular WireGuard SSH check with Wi-Fi off confirms
  connection and smooth scrolling.
  Remaining lifecycle checks, FPS and custom bindings remain open.
- **Requirement-audited real Pixel checklist QA:** complete passes are **1/18/19/21/22/24/36/38/39/51**.
  All sending chips, software input, font changes and rotation preserve SSH. Unicode renders;
  90000 clipboard characters match exactly, 150000/450000 are refused, and invalid OSC52 is silent
  with clipboard preserved. All three keyboard-focus states send real software input to the pane.
  Background process kill restores Inbox/tab/back stack; the shipped managed hook passes
  Approve/Deny/expiry with a synthetic producer (no live Claude CLI/account or requested Bash execution).
  Seventeen sending chips plus four app-mode arrows and font/rotation complete item 18;
  links/Copy sheet and SSH detach/recovery add partial evidence. Landscape
  with the IME open is 129×1, not a verified usable-height case. The [64-row table](android.md#what-is-verified-and-how)
  records ten Pass, 22 Partial and 32 Pending items after item 1 paired-update, focused creation, partial Rename and item 36 Board verification, with conditional
  SKIP variants. The earlier 7/20/37 checkpoint is preserved. Those
  earlier checklist results used beta-6 source `c4b1f6cf`; current installed beta 10 uses `e3ce041c`.
  Recorded prior all-green branch CI `19da35a2` has all five jobs green in
  [run `37140762345`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37140762345), including A90.
  Source run `37144282865` failed the documentation checklist mapping; debug/release APK and
  CodeQL jobs passed, private packaging was skipped. The next push needs its own green workflow.
- The user resumed remaining Pixel release checks on 2026-10-04 after the hike. Item 18's Pass comes from
  reviewing existing proof against its written requirement, with no new phone work. Item 1 now
  passes desktop-issued pairing/relay credentials through the same-signer code10→11 update.
- Historical private `0.1.0-beta.8` / code `9`, clean `b88d1415`, was **installed on the exact intended Pixel**
  via a 28.05-second same-signer update. Before/after pulled APK hashes and the public signer match;
  metadata is code 9/name beta 8/non-debuggable, `firstInstallTime` and notification grant remain,
  and the app starts with its existing manual-SSH computer row. Opening that host reconnects over
  SSH and lists real driven projects; New terminal is visible/enabled. No terminal was created or
  ended; actual creation/persistence/End remain pending. Build/R8/artifact checks pass. After the hike, pair on current
  beta 9, then verify pairing/relay credential survival across a later same-signer higher-code
  update for item 1. Keep the working app installed. Beta 7 remains prepared, unused. The tally remains
  seven Pass / 20 Partial / 37 Pending. Debug migration stays conditional SKIP on this working Pixel.
- **Live encrypted paste pairing and relay-only browsing work.** The actual Pixel pairs from
  PairingService JSON with remote access enabled, then opens the empty isolated production
  desktop through the hosted relay. The current `/v1/relay/join` request/response is verified
  beyond interop. Desktop source `58a202be` uses a private bwrap home and real SecretService
  encrypted credential storage; no user credentials were copied. This approved-at-pairing path
  expects no SAS prompt. Relay terminal attach/echo input to an owned real PTY also pass; the node
  was created through production preload/Canvas events, not phone New session. QR/scanner,
  cellular relay, SAS denial/revoke and remaining node actions stay open.
- Mounted relay single/multi-select and copy-mode questions now have actual synthetic-application/
  shipped PostToolUse/mirror proof; item 41 is Partial. Offscreen/released/direct-SSH/target-guard
  device variants remain open. Cleanup forgot only the fixture host, stopped owned resources and
  returned the phone to regular Sessions. The user confirms beta 6 / code 7 connects and scrolls
  smoothly there over cellular WireGuard; hosted cellular relay remains untested.
- The A90 baseline checks pass **684 protocol tests in 66 suites, zero failures/errors/skips** (48 seconds),
  plus offline app `compileKotlin` (1 second). Eleven actual Gradle/Kotlin 2.2 protocol behavioral,
  twelve helper behavior and nine native wiring mutations are caught (32 total). Historical scroll
  checks caught thirty-five JS, eleven native and three CSS mutations (49 total), including the
  strengthened new-touch regression's seven kinetic tests.
  `A88` (`f5fd3821`) now reproduces SDK 37's actual `V3.0 Signer:` format; 39 Python tests pass against each
  real SDK 36/37, and ten new parser/fixture-selection mutations are caught. CI run `37058184031`
  passed its four main jobs but failed private packaging. Follow-up [run `37061593216`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37061593216)
  at `c37798b6495b4b68df379d0ae80887c23104b66d` completed with all five jobs green, confirming
  the observed packaging workflow repair. Each later push still requires its own green workflow.
- Private `0.1.0-beta.6` / code `7` uses source `c4b1f6cf1009f293a658b6331d2ed1ab80aa36c6`.
  Its actual AGP release built in 43 seconds and passed every R8 keep. Retained-signer packaging
  verified non-debuggable metadata, signature, 16-KB alignment and source/hash provenance; all
  149 ZIP payloads stayed unchanged by signing. APK SHA-256:
  `4947133a6ccf9c2b1e775e76d7c24f564e087cf036e59eac4dca08162a076d3c`.
  The intended Pixel received a same-signer update preserving app data; notification permission
  is confirmed. SSH reopened with its retained key/pin, and controlled continuous drag/coast/Esc
  checks pass. New-touch stopping passes at a stable 56×25 viewport; lifecycle stopping,
  FPS and custom wheel bindings remain open; normal drag/coast have earlier user confirmation.
  The final cellular WireGuard SSH check confirms connection and smooth scrolling.
  Private proof is in `.nodeterm/android-beta-build-6/`, artifacts in `.nodeterm/android-beta-6/`.
- Historical beta `0.1.0-beta.4` / code `5` built locally from
  `3cffb49d8cf64932260e914b42b3883331d0352d`, using the retained signer.
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
  At the beta-4 checkpoint the user reported missing momentum; beta 6 now has controlled and
  user drag/coast confirmation. Custom wheel bindings and the remaining `A86` checks stay open.
- Of the original 77 audit findings, 74 are fixed after the request-owned A56 follow-up.
  `A25` still needs backend FCM, `A50` has signed delivery with full validation open, and `A68`
  waits for a requested PR.
  QR pairing, cellular relay/SAS denial/revoke, actual outage/notification/answer behavior and
  the full 64-item pass remain open.
  Push is authorized; required checks precede each push and its Android workflow must be green.
  No PR should be opened unless asked; `A68` is last.

## Progress log

### Upstream PR conflict integration (2026-10-08)

Merge upstream `adde5e85` into the existing contribution branch without rewriting its published
commits. Resolve Android ownership/interop behavior alongside upstream v0.4.2 chat, pairing roles
and session backends. Keep new structured answer support on revision 6 because both parents used
revision 5 for different formats. Source regression and offline gates precede publication;
merged-source device checks remain next, with beta23's earlier source binding preserved.
No new finding or device-ledger promotion is claimed by conflict resolution.

### Pending Send outcome after remount (2026-10-08, A137)

Source tracing confirms that retained editor state outlives controller-local pending/outcome state.
The entry-owned attempt/guidance fix preserves original viewer/revision fences and uncertainty
across a later known refusal. Focused66/9, full1069/116, offline app and thirteen intended mutants
pass. Source `b9e4cbc7` is published with fresh1069/116/offline app and CI37740459063 five/ten passing;
retained-signer beta23/code24 passes 46 available artifact checks. Pre-install snapshot refusal means no
update was dispatched; beta22 is last verified installed and the controlled phone comparison remains
unverified. See [canonical scope](android.md#pending-send-outcome-after-remount-2026-10-08-a137).

### Beta22 publication, update and bounded remount (2026-10-08)

Source/Desktop `2ba0b142` passes fresh 1054/114/app and CI37732792493 all-five/ten-step.
Same-signer beta22/code23 installs in place with measured install time/full runtime grants held.
One fresh no-Send PairHost-cover/Back retains the exact draft and checked Ctrl; original native
controls stay equal except the qualified phone-client reattach. Owned cleanup and read-only 15000
timeout reconciliation pass, with the uncertain original restore result preserved; see
[the canonical scope](android.md#retained-terminal-editor-2026-10-08-a136).

### Retained terminal editor (2026-10-08, A136)

Original Pixel7a/beta21 draft/Ctrl loss is reproduced; own native panes/captures remain unchanged
and the fixture/profile/auth/reverse are retired. Full entry-retention/revision/retirement source
and mutation controls pass. [Canonical evidence](android.md#retained-terminal-editor-2026-10-08-a136);
beta22/code23 publication/update and one bounded remount pass; broader checks remain pending.

### Captured Ctrl consumption (2026-10-08, A135)

Immutable revision/viewer consumption is source fixed; policy and wiring mutation controls pass.
[Canonical evidence](android.md#captured-ctrl-consumption-2026-10-08-a135); source gates/CI and
beta22 installation pass; physical raw-input scheduling remains pending.

### Lost Send reply and newer draft (2026-10-08)

A fresh Pixel 7a/beta21 direct-SSH case loses the successful Enter receipt after one actual
execution. The exact newer draft and disabled Send are observed before loss, the draft remains
through automatic reconnect, and one original-TTY witness/ACK stays unique over 120 seconds
later. The original terminal/producer/whole sibling guard remain unchanged. Owned phone/host
cleanup and the original 15000-ms timeout restore pass. Android's internal composed status,
blackhole, whole-host loss, native-route loss and remount/Ctrl remain separate.
One real SSH/tmux regression loses only Enter's exit acknowledgement after execution; the
healthy/restored controls pass and a false-success mutant fails the intended status assertion.
Production source is restored exactly; the test addition requires fresh full protocol/app gates.
See
[the measured receipt loss](android.md#lost-send-reply-and-newer-draft-2026-10-08).

### Held Send reply and newer draft (2026-10-08)

A fresh Pixel 7a/beta21 direct-SSH case passes the measured post-execution receipt hold:
the exact newer draft and disabled Send are observed before release, then the same draft remains
with Send enabled. One original-TTY witness/ACK stays unique 168.735781 seconds later, with the
original terminal/producer/guard retained. Owned cleanup completes; original timeout 15000 ms is
confirmed after an uncertain restore without replay. At that checkpoint, lost reply, blackhole
and remount/Ctrl cases remained open. See [the measured receipt hold](android.md#held-send-reply-and-newer-draft-2026-10-08).

### Nine-second Send/newer-draft follow-up (2026-10-08)

A fresh `d361ce8f`/Desktop `0d8594a6` fixture with unchanged beta21 returns one Send and a suffix
input before its original peer resumes. The final new-draft/disabled-Send observation misses the
nine-second deadline, so the wrapper remains failed. Later the exact newer draft and visible suffix
remain with Send enabled; one original-TTY witness/ACK is still unique 125.310 seconds later.
Owned cleanup completes; that earlier case verifies no strict timed race or lost reply. See
[the bounded follow-up](android.md#nine-second-send-and-newer-draft-follow-up-2026-10-08).

### Silent SSH peer recovery (2026-10-08)

A fresh `04da9b9e`/Desktop `0d8594a6` fixture and unchanged beta21 recover automatically while
one old peer is paused for 45 seconds. Original shell/producer/server/socket/guard survive; the
unsent draft remains in XML and saved pixels. One later Send has one witness/real ACK, still unique
92.719 seconds later. Owned cleanup passes. Image-preview blankness was disproved by actual PNG
pixels, so no new rendering finding is established. Whole-host/network loss, cursor position and
lost replies remain untested. See [the bounded receipt](android.md#silent-ssh-peer-recovery-and-single-send-2026-10-08).

### Native Desktop consumer continuity (2026-10-08)

Fresh immutable Desktop/build `0d8594a6`, with docs-only checkout `98907171`, now verifies
two original native factories, both original producer lineages before capture, 200 retained
unique marker names/Unicode, normal renderer reload and exactly one `q`/`r` input/ACK to the
same original target. The sibling producer records no input and its whole capture is unchanged.
Source/tools/outputs hold and owned retirement is verified. Android native-history/Live,
canvas gestures and full rendered payload equality remain unverified; installed beta21 and
the 64-row ledger are unchanged. See the
[native consumer receipt](android.md#native-desktop-capture-and-renderer-reattach-2026-10-08).

### Direct SSH continuity (2026-10-08)

Desktop `0d8594a6` with the unchanged stock beta21 APK passes a controlled handler drop/automatic
recovery, two Home/resume cycles during active output, retained draft and one explicit Send.
Original producer/server/Bash/socket and the entire sibling guard stay unchanged. Phone cleanup
is verified; the supervisor stop and outer runner accounting negative stay separate. This does not
cover silent network outages, held replies or the native-history relay route. See the
[bounded continuity receipt](android.md#direct-ssh-reconnect-and-active-background-continuity-2026-10-08).

### Login-shell completion deadline (2026-10-08, A134)

The signed source/caller checkpoints `3f382367`/`0d8594a6` pass forced 1033/110/app/TypeScript,
161 affected tests with five Windows-only skips, and all-five/ten-step CI run `37702852854`.
A fresh source-built V14 diagnostic observes one original session-host create fulfill and its Bash
prompt without PTY input; exact owned retirement is verified. V13's child cause/fallback remains
unknown. Native history and its phone overlay stay pending; installed beta21 is unchanged. See the
[scoped source checkpoint](android.md#login-shell-probe-completion-deadline-2026-10-08-a134).

### Fresh native diagnostics and Browser/Share pilot (2026-10-08)

At unchanged `9b8bba2b`, the normal-Fedora discriminator records all rows and its marker while
original A132 attribution stays open; V8/V9 native readiness remains unclassified before input.
Installed beta 21/source `ef4caec2` opens the nonce URL in Vanadium and previews the selected Share
marker. Browser Back remains unverified; ordinary resume and chooser Back succeed. Exact owned
cleanup and original-timeout readback pass; Open-focus/restore uncertainties are retained without
replay. No A129/A130 or 64-row ledger promotion. See the
[scoped receipts](android.md#fresh-fedora-output-and-native-desktop-readiness-2026-10-08).

### Beta 21 clipboard and post-font link pilot (2026-10-07)

A fresh same-page ended SSH/tmux pane copies the exact final marker and one Unicode row through
normal clipboard paste into its disabled-Send composer. Both full OSC8/plain URLs are offered
after A-minus/A-plus changes; opening the sibling guard removes the old closed display. Exact
fixture/key/reverse/profile cleanup passes. The timeout restore has an uncertain post-write check;
guarded readback confirms the original 15000 ms without another write. Browser/Share/wider
TUI/lifecycle/native-history checks and the 10/22/32 ledger stay unchanged. See the
[bounded receipts](android.md#closed-sshtmux-exit-display-source-checkpoint-2026-10-07-a133).

### Beta 21 publication and closed SSH display (2026-10-07)

Signed `94c8d2c4` retains the last visible SSH/tmux pane at an owned EOF; `ef4caec2` preserves
same-view delayed Enter through layout changes. The 27-case renderer regression, focused
control/restored mutation checks, forced 1033/110 protocol, offline app/full TypeScript and
five-job/ten-step CI pass. Retained-signer beta 21/code 22 is installed. A fresh 1200-row/40-ms
output case crosses actual background/resume and reaches the phone with its completion marker.
A separate natural exit retains Unicode/wraps/final text; Copy-sheet filtering, original link
offers and font redraw pass. A later fresh same-page pilot copies the exact final marker and one
Unicode row into the ended composer and offers both exact URLs after smaller/restored fonts;
browser navigation, Share and the wider matrix remain unverified. All temporary phone/host admissions retire cleanly. The original A132 attribution and
10/22/32 ledger remain unchanged; see the [bounded receipts](android.md#closed-sshtmux-exit-display-source-checkpoint-2026-10-07-a133).

### Beta 20 output/background checks (2026-10-07)

Signed `11fbff08` passes fresh 1029/108, app/TypeScript and five-job/ten-step CI; retained-signer
beta 20/code 21 installs with unchanged first-install time and notification grant/flags. The
resumed screenshot contains later rows and keeps the sibling guard scoped; active-production
background overlap is unproven. A132 records the missing
completion marker in native capture; A133 records history absent after exit without claiming final
marker emission or an Android-only cause. Host/profile/public-key/reverse cleanup passes; the
timeout is already the original 15000 ms, with no restore write. The original 10/22/32 ledger
is unchanged. See [the canonical receipts](android.md#beta-20-publication-and-bounded-output-checks-2026-10-07).

### Pixel 7a A105/A106 and changed SSH key (2026-10-07)

At Desktop `e06b5547` / beta 19, original remembered-rule and two-question Send answers choices
pass real sibling CLI application. Saved-pin reuse and manual changed-key refusal pass too.
Both fixtures and the QA profile/key/reverse retire cleanly, with the original timeout restored.
[Receipts and limits](android.md#beta-19-publication-provider-and-emulator-checkpoint-2026-10-07)
retain the unchanged original 10/22/32 ledger; publication requires fresh exact-revision gates/CI.

### A105 real Desktop remembered-rule application (2026-10-07)

At `41406fef`, real Claude 2.1.292 in the sibling namespace uses the original captured node
environment and unchanged production hook. The shipped Desktop consumer chooses one original
`localSettings` rule: nine hooks, one consumed/removed hold, two Bash executions without a second
hold, and the exact CLI-saved allow rule; 8.648 seconds/$0.0166058. CLI and owned-host cleanup pass.
At that earlier checkpoint, no phone input or production-pane-child launch was claimed; Android A105, A106 and wider persistence
remained pending. [Canonical receipts](android.md#beta-19-publication-provider-and-emulator-checkpoint-2026-10-07)
retain the result and independent review. The original 10/22/32 ledger is unchanged.

### Beta 19 publication, provider inference and failed emulator calibration (2026-10-07)

Signed `5bda2c32` publishes A130 with fresh forced 1015/106 protocol, offline app/full TypeScript
and all-five/ten-step Android CI `37608652625`; retained-signer beta 19/code 20 is installed
with SDK-36 artifact verification. Its 6.18-second same-signer update preserves first-install
time and the notification grant/flags. The displayed public SSH identity matches its earlier
identity, and one fresh explicit-profile direct-SSH authentication pins the expected disposable
host key through an owned ADB reverse tunnel. Emacs/vi Send, brief background/resume draft
continuity, viewer-close/manual Reattach and controlled SSH-handler recovery pass with original
producer/guard/history retained; exact owned profile/key/route/timeout/host cleanup passes.
At that earlier checkpoint, saved-profile/pin reuse, changed-key refusal and actual A129/A130 native behavior remained pending.
At that earlier checkpoint, one normal authorized tool-free Claude inference passes in
3.865 seconds/$0.002988, while A105/A106 live application remains unverified. The owned API-30
emulator initially boots but remains offline after one provisioning reboot and one scoped
reconnect. The console responds, the framebuffer request times out and one debugger capture
detaches; none establishes app readiness. Exact supervisor/children/ports cleanup passes with base images and existing AVD
metadata unchanged. [Canonical raw receipts](android.md#beta-19-publication-provider-and-emulator-checkpoint-2026-10-07)
keep these layers separate. No app acceptance or ledger promotion is claimed here.

### A129 native history implementation (2026-10-07, published source; acceptance pending)

At `ce1121ba`, actual Kotlin/E2EE host calls through native and session-host emulators reproduce
five foreground SGR wheel writes for an up-three/down-two history scroll with mouse reporting
off. The native writer boundaries are recorders and the host PTY bridge is a component adapter;
there is no full Desktop, WebView gesture, kernel PTY, physical ConPTY or phone claim.
Receipt `/tmp/nodeterm-native-scroll-triage-ylpvdie0/receipt.json`, SHA-256
`c5d50310e539ad02d1c825ac12d19865b4c488184d1d50a8c809aad44b7cbb1a`.
[A129](android-audit-2026-09.md#a129) is **source-fixed and published** at signed `1add0408`,
including `0818bbed` and `2d693263`. Fresh mandatory gates and exact-head CI pass; actual
app/WebView and physical acceptance remain unverified. Advertised `pty.attach.scrollV1`
enables `pty.scrollV1` bounded
history pages scoped to the exact stream; existing tokens page immutable inert rows until
Live/input/resize/new intent closes them. New intents check actual headless mode after queued
output and follow the requested encoder, with exact backend generation/subscriber/socket
fences and no replay. Android's separate layer keeps the actual xterm 5.5 live parser and
rejects late pages through actor/page/display epochs; Copy/links use displayed rows.
The contract, resource limits and iOS @eneskirca adoption are
[documented together](android.md#native-history-scrolling).
The top checkpoint records passing leaf/backend/root and focused Android checks separately
from fresh 1012/105 protocol, offline app, 568/52 Vitest with four existing Windows skips, full
TypeScript and all-five/ten-step CI `37602046133`. At that earlier checkpoint, signed beta 18/code 19 was ready and not installed on the intended phone.
Existing tmux/direct-SSH scroll evidence, installed beta 17 and the original 10/22/32 ledger
are unchanged; regular Desktop deployment and a PR are not part of this checkpoint.

### A130 held Live-button touch (2026-10-07, focused source fix)

At `1add0408`, the shipped-source/stub/RAF probe shows a displayed Live-button touch held for
512 ms leaving the previous fling active: 20 further requests / 23 notches, matching the
no-touch control. Terminal-surface touch stops immediately; the Live click subsequently stops
and closes history. This original failure remains historical. Receipt
`a129-live-held-probe-h2m613ux/receipt.json`, SHA-256
`b89954c2f959b63df727b986ebcf260e64dac716dd20ef65cb76e0d370d624ea`.

[A130](android-audit-2026-09.md#a130) is source-fixed at the focused checkpoint: Live-button
touch-down calls `cancelScroll` before stopping propagation, preserving history and its
display epoch until click. Three new JVM behavior methods cover held/moved touch, normal
click/obsolete page, and cancelled press/current page. Control/restored runs pass 48 methods/7
suites with zero failures/errors/skips; three semantic mutants (old handler, premature history
close, parent gesture) fail assertions. Receipt `a130-live-touch-proof-3thll7zv/receipt.json`,
SHA-256 `7eae4fd3f280d945be7dae6544c6569cea9d931b7818dd91e78bceae01be9753`.
These are compiled JVM and shipped-page DOM/xterm/bridge-stub/RAF checks, not actual
WebView/transport/phone acceptance. Published `5bda2c32` passes fresh 1015/106 protocol,
offline app/full TypeScript and exact-head all-five/ten-step CI `37608652625`; retained-signer
beta 19/code 20 is installed. Actual app/phone behavior acceptance remains pending.

### A128 composed Send backend follow-up (2026-10-07)

Current local relay Send supports direct native Windows PTYs and session hosts advertising
`composed-input-v1`. The v2 internal prepare/write/cancel extension owns one-use 10-second
socket/generation-bound tickets and holds the per-terminal lock across paste and separately
guarded Enter at least 150 ms later. Subscriber registration and original socket are checked
inside the deferred client write. Lost transmitted-phase receipts/RPC errors stay uncertain,
with no replay; old live hosts refuse without restart. Busy/stale attachment failures do not
prescribe an update. The public Android action/result stays unchanged, with actual backend
producer-to-Kotlin coverage in the same change and an iOS availability note for @eneskirca.

See [the source and verification checkpoint](android.md#composed-send-backend-follow-up-2026-10-07-a128).
At that earlier checkpoint, installed beta 17 remained `a79375c3`; native Linux component proof and recorded backend byte
fixtures do not verify Windows ConPTY or a phone using these additional backends. Keep the
remaining device/provider/backend obligations and original paused ledger separate. Before
publication, run the mandatory offline protocol/app and affected Vitest/full TypeScript gates;
after push, manually dispatch beta preparation and verify all five jobs on that exact revision.

### Beta 17 installed; merged gates and bounded A127/A128 device cases (2026-10-06)

Exact signed `a79375c3` passes full forced offline **982 methods / 102 suites**, zero failures,
errors or skips, offline app Kotlin, **187 affected Vitest tests / 11 files** and full
TypeScript. Android [run `37523703627`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37523703627)
passes all five jobs and ten critical steps. Retained-signer beta 17/code 18 is installed on the
intended Pixel 7a in 5.48 seconds, with exact prepared/installed APK hash `c51433d4…`; actual
SDK-36 signing/verification is used and SDK-37 tools are unavailable.

The single saved temporary SSH profile/first-install time survives update without pin editing
or key readmission. A128 emacs copy-mode Send is native-verified exactly once on the original
producer, with copy mode cancelled and the guard unchanged. A127's viewer-only exit shows the
neutral notice, disables Send and retains the draft. Manual Reattach preserves the producer
and complete same-grid history; the retained draft submits once. Controlled vi transport
recovery preserves the draft/same pane/full capture, then explicit Send submits once and exits
copy mode. One raw Ctrl+C produces exactly `03`, without any additional byte in a bounded
0.8-second window. Actual phone-managed shell creation and exact owned SSH End pass too.
Only the temporary profile/admitted public-key line are retired; the original authorization
file is restored. The nonce-validated owned host stop passes with authentication removed,
source/tools/build outputs unchanged and both listeners closed; ordinary Quit is unverified.
The frozen physical report binds 303 raw hashes/nine bounded passes, SHA-256
`ece4fa48d31fab55a9f5158f475b4415e9c116c8a2f1683ec48295bf42e55e6b`. See [the bounded beta-17 checkpoint](android.md#pixel-7a-beta-17-upgrade-and-composed-send-2026-10-06).
The original Pixel 10 Pro ledger remains paused at **10 Pass / 22 Partial / 32 Pending**.

### A128 composed Send source fix and beta CI registration (2026-10-06)

`7e7d2c04` integrates explicit awaited actor submission on the captured viewer. Unsent momentum
is cancelled; host history mode is cancelled only for that exact viewer/pane generation.
Bracketed paste precedes a separate Enter by 150 ms with a fresh guard; Ctrl is one raw byte
without Enter. One delivered same-current-view completion clears only an unchanged draft
revision and preserves newly rearmed Ctrl. Refused, uncertain and stale outcomes retain the
draft; post-paste failure is uncertain and never replays. The receipt confirms pane/PTY
submission, not command execution. Direct Unix SSH and current local-tmux relay are supported;
legacy/unverifiable, native Windows/session-host and SSH-project relay routes explicitly refuse.

The additive `pty.submitComposed {streamId, input}` verb, Android client and actual interop fixture
land together in `7e7d2c04`; iOS **@eneskirca** needs the same action/receipt and draft-retention
rules. **170 distinct affected Kotlin methods / 8 suites**, **187 affected Vitest tests / 11
files**, full TypeScript and forced offline app compilation pass. All **26 isolated source
mutations** fail assertions, with control/restored runs passing. `5484ab9f` registers four host
suites in private-beta CI; nine actual Gradle/JUnit configuration methods pass and four
registration deletion mutants fail assertions, with passing control/restored checks. The total is **30 assertion-caught
mutations**, not a repaired phone pass.

The [source checkpoint](android.md#composed-send-source-checkpoint-2026-10-06-a128) binds aggregate
V2 `34a0044207b64b5627f0a8653a9969234430a51b697d8ef589220f9e9a26b68f` and the CI registration
receipt `6f5b956e6c4ff2d9c0f8a6c070ba429b1cfe8c1175852c56bf30be159c5720f9`.
Independent read-only review finds no material source/evidence issues. At that source-fix
checkpoint integrated full gates, exact-head CI, private beta packaging and repaired-device
checks were pending. The later beta-17 entry above records their bounded completion: merged
982/102/app and affected Desktop gates, five green CI jobs, the same-signer update, emacs Send
and A127 viewer-close/manual-Reattach. Later vi recovery/Send and raw Ctrl checks pass too;
exact owned End/cleanup and the final report are verified separately in the latest entry.
Wider physical/provider checks remain pending; the original 10/22/32 ledger is unchanged.

### Pixel 7a lifecycle and custom scrolling; A127/A128 discovered (2026-10-06)

Trusted Wireless debugging is restored and the intended Pixel 7a's beta 16 installation is
hash/signer verified. Actual Start→Back and Start→Home videos, native registration/pane proof,
background process restart, custom `-N7` emacs/vi held dragging and bounded momentum/touch-stop
checks pass against the disposable cached `59e4c93e` Desktop. Transport reconnect preserves the
pane/history and disables Send while disconnected. Offscreen Find and exact-owned SSH End pass.
These are bounded cases, not completed checklist rows.

A127 reports a failed viewer as a dead session while the producer survives. Signed source fix
`0d50075a` changes only the fallback wording and stream-exit documentation; three JVM methods,
offline app compilation, twelve callback cases and three assertion-caught mutants pass.
A128 loses composed input in copy mode on the installed beta 16: both vi after reconnect and
healthy emacs clear the draft with no submitted command/marker. Its later `7e7d2c04` source fix
and `5484ab9f` CI registration have the separate checks recorded in the entry above.
Neither fix had an updated-device pass at that beta-16 baseline; later bounded beta-17
repaired-device acceptance is recorded in the entry above.

The temporary phone profile and admitted public key are removed; the exact owned fixture stops
cleanly with authentication removed/listeners closed. This was a controlled SIGTERM stop,
not ordinary Quit acceptance. The original phone and regular Desktop remain untouched.
The [physical receipt](android.md#pixel-7a-lifecycle-scroll-and-input-follow-up-2026-10-06)
records artifact hashes and limitations; the original ledger stays 10 Pass /22 Partial /32 Pending.

### Inactive global-card owner and bounded park/adopt verified (2026-10-06)

One fresh Linux Desktop two-host soft/none case passes at `59e4c93e` in 27.39 seconds. Ordinary
native palette project switches preserve B's same quiet xterm/core/wrappers/subscriptions/API and
native client through park/adopt while its global card stays open. With A active and unchanged,
a B-only product master outage recovers that inactive card to a fresh warm selected viewer.
Three native `g` ACKs, two complete wrapped URL activations, zero unexpected input, one paint per
role, full same-grid retained remote history and exact owned cleanup pass. SID provenance is the
primary create/Canvas `g1` and carried original writer, not an adopted Canvas React ref or a
post-adopt Canvas input test. See [the bounded two-host follow-up](android.md#inactive-global-card-owner-and-bounded-parkadopt-2026-10-06) for the receipt/runtime hashes.
This extends acceptance of existing A125/A126 source; no repair/test/mutation count or physical
ledger is added. Phone/backend acceptance and wider platform/stress coverage remain separate.

### A126 duplicate terminal responses found after A125 (2026-10-06)

The historical `11e22453` stale-Modal negative and first `415dae9b` control retain their original
provenance. The latter creates replacement viewers but records 18 unexpected DA1/DA2 bytes after
ACK 1; ACK 2 is not attempted. Its unclassified wrapper/runtime exits 1/2 remain separate from the
later A126 diagnosis. Those failed controls are not rewritten as repaired-source positives.

A125 is source-fixed in `415dae9b`; A126 is committed in `5b7286b3`.
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
See [audit A126](android-audit-2026-09.md#a126) for the original failure and accepted matrix.
The later two-host follow-up above adds bounded quiet park/adopt and inactive global-card acceptance.
Phone/backend obligations and wider Server/cross-window/GPU/outage/platform checks remain separate,
with the paused phone ledger unchanged.

### Beta 12 prepared; merged release checks pass (2026-10-04)

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

### Owned SSH actions and remaining source gaps (2026-10-04)

A100–A109 are implemented in small signed commits. Retained-history matching, interrupted typed
read recovery, trusted project env/shell preparation, measured per-agent policy and offscreen wake
have regression and isolated mutation receipts. V2 held replies add exact remembered rule scopes
and complete question answers without guessed digits. Direct SSH Git supports the existing eight
verbs with physical jails and honest uncertain writes. The selected-profile SSH actions service
routes Board writes through the actual store; Desktop offers delivery-only node nudges. Server
serves local Board writes and, since A111, managed New when its local POSIX tmux backend is enabled.
Exclusive lifetime claims, monotonic retirement, bounded replies and immutable nonce
windows guard startup, shutdown and retries. The service's actual filesystem/FIFO, Desktop wiring
and headless Server checks pass 33 tests; 29 native and 29 client mutation variants are caught.
Real Node/Kotlin/generated-shell interop passes. The full merged release gates follow this source
checkpoint; no new device or live-Claude application result is claimed.

Current commits: A100 `2f693d83`/`97b8a9a4`/`4f1985f5`; A101 `fbaa535d`; A102 `e584586f`;
A103 `91e6a3f5`; A104 `2d6cb2cd`; A105/A106 `db4abccf`/`7c206ec5`; A107 `489c30a8`;
A108 `d716138c`/`585e726f`; A109 `4e2f877d`. The original A56 blind-digit proposal is superseded,
giving 74 of the original 77 source fixes. Historical records below retain their original scope.

The user intends an upstream PR contribution and cannot supply the backend repository. A25 FCM
and A93 fresh-different-desktop relay recovery remain maintainer dependencies. iOS implications
for @eneskirca include v2 held mirror/verbs/SSH answers, retained history, launch/policy facts and
the optional selected-profile SSH actions file contract. No PR opened; A68 remains deferred.

### Beta 10 installed: saved relay pairing survives update (2026-10-04)

**Current private beta and paired update (2026-10-04):** `0.1.0-beta.10` / code `11`,
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

### Phone Board move persists but mounted desktop stays stale (`A95`, 2026-10-04)

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

### Pixel checks resumed: relay mint refusal and completed-empty loading label (2026-10-04)

Genuine production pairing JSON was entered through the native Pair screen without reading or
changing either clipboard. This verifies code-text entry and parsing, not scanner or clipboard
mechanics. Pairing to a fresh isolated desktop with remote access on succeeds locally, but no
relay credential arrives. A bounded retry using the exact production mint request body confirms HTTP 403 reauth_required
(A93). The Pixel keeps its global identity; forgetting the prior fixture removed its saved
relay token, and the fresh desktop identity differs. Backend C2 policy is not proven by that
refusal. The complete original owned profile is under assessment for ordinary encrypted-keyring
restart and re-pairing; no identity/token fields or user credentials are transplanted.

The separate otherwise-empty OpenSSH fixture shows a completed error banner, Over SSH and
New terminal while “Loading sessions…” persists on installed beta 9. Source tracing identifies
the initial empty snapshot's zero fetch time (A94). Commit 3c217cba stamps authoritative empty
answers; five actual Kotlin regression methods and eight isolated mutants pass. Full Gradle
checks, a new APK and installed-fix verification remain pending. Before-fix proof is in
.nodeterm/android-beta-build-9/checklist-20261004/a91-initial-empty.json and .png.
The subsequent focused A91 flow passes on installed beta 9: New terminal creates/opens a first
Home shell, native End removes its exact row and Phone terminals group, SSH stays connected,
and New terminal creates/opens a second Home shell. That second shell is retained for the later
higher-code update check; no final cleanup is claimed. Proof:
.nodeterm/android-beta-build-9/checklist-20261004/a91-beta9-focused-results.json.
A94's label correction still awaits delivery. No full checklist promotion is claimed; the tally
remains 7 Pass /21 Partial /36 Pending.

### Desktop wrapped-link follow-up fixed in `127b6b28` (`A92`, 2026-10-04)

Re-read the recorded desktop gap and reproduced the actual exported `paragraphContaining`
behavior: below 32 continuing rows its downward window could omit the hovered row. Reserving
one row in the upward budget fixes containment and complete URL matching while preserving the
32-row cap. Three meaningful regressions cover all 80 requested hard/soft rows and the actual
URL provider's tail-row text/range/activation. Focused Vitest 24/24, all three affected link/dialect
files 54/54 and full `npm run typecheck` pass. Three isolated mutants are caught; control/restored
copies pass. Evidence is `/tmp/nodeterm-file-link-fix-verify/results.json` and per-variant logs.
Fixed in `127b6b28`; interactive desktop hover was pending at this original checkpoint. The later
Oct5 receipt verifies eight native Linux Desktop cases at `01b4a2f5` with A121's leave fix. The held isolated fixture retains
the unchanged `071735d6` desktop build; `out/` was not rebuilt. Android already has the `A32`
correction, so no Android/client contract or iOS adoption is owed. Installed beta 9/code 10 and
the 7 Pass / 21 Partial / 36 Pending ledger remain unchanged; no new phone evidence is recorded.

Newest first. Each entry says what landed, how it was checked, and where the fix differs from the
audit's proposal.

### Focused A90 Pixel flow passes; item 32 Partial (2026-10-03)

On beta 8/code 9 (`b88d1415`), Home, discovered project and custom-folder creation verify cwd/input
and 180 numbered history rows. Custom path spaces/apostrophe/dollar, rapid double Create without
duplicates, visible missing-folder refusal/no orphan and corrected retry pass. Same-pane reopen
shows pre-attach history; drag produces 14 positions, coast moves 65→137 and Esc exits copy mode.
New shells carry no managed-agent environment and retain 50000 history lines. Force-stop/restart
keeps three PIDs/history and SSH rediscovery. Beta9/code10 (`4d33a5b5`) update/reconnect/input to
the same pane pass. Native UI End of custom→project→Home removes only the chosen UUID, preserving
siblings' immutable fingerprints/PIDs, with counts 3→2→1→0 and final Phone terminals group removal.
All 11 desktop session IDs/pane PIDs and 9 protected project/workspace hashes are unchanged.
Owned shells, empty fixture folders and remote UI dumps are removed; Pixel is left on regular
host Sessions. No live managed agent/account or shared-file writes are involved.

Proof: `.nodeterm/android-beta-build-8/a90-pixel-check-20261003/final-focused-results.json` and
`beta9-exact-ui-end.json`. Only item 32 moves Pending→Partial; current tally 7 Pass / 21 Partial / 36 Pending.
Relay canvas/managed and cellular creation, A91 otherwise-empty-host last-End and the broader
release checklist remain unverified. Broader device work stays deferred.

### Beta 9 installed; empty-host fix delivered and owned shells retained (2026-10-03)

Private `0.1.0-beta.9` / code `10` uses clean source
`4d33a5b5366c99479b648086649205350c7752b1`. The actual release built in 43 seconds and the
same-signer update took 6.46 seconds on the exact intended Pixel. The pulled installed APK matches
SHA-256 `719cfeea1dcf27900dd35692a59004ca07e8261b3f14bd43922f0706b6b4ab54`.
Three owned shells created on beta 8 survived and were rediscovered on beta 9, then were ended
through verified exact-session cleanup; none remain. `A91` is delivered;
its otherwise-empty-host physical variant remains pending. Broader device checks stay deferred.
Independent SDK 36/37 artifact review verifies signatures/16-KB alignment, all 149 unsigned
payloads preserved after signing, four ELF alignments, expected R8/service metadata and provenance.
The non-debuggable update preserves install identity, notification grant and app data, without
uninstall/clear storage. Paired relay credential survival remains unverified. Proof:
`.nodeterm/android-beta-build-9/artifact-review.json` and
`.nodeterm/android-beta-build-9/device-install-20261003/receipt.json`; artifact:
`.nodeterm/android-beta-9/nodeterm-android-0.1.0-beta.9.apk`.

Historical source CI run `37144282865` failed `DeviceChecklistDocsTest`: `A91` lacked a checklist
mapping, and unrelated Known gaps bullets shared one paragraph. This revision adds the item 32
mapping and isolates the paragraph. Debug/release APK and
CodeQL jobs passed; private-beta packaging was skipped. The recorded prior all-green branch was
`19da35a2` / run `37140762345`; the next push needs its own required checks and green workflow.
The recorded local 688/67 source baseline predates these final docs; fresh full protocol/offline
app gates follow the frozen documentation. Final exact-head CI proof is retained separately.

### Historical empty-host stale listing host fix, before beta-9 delivery (`A91`, 2026-10-03)

Ending the last phone-owned shell on an otherwise empty SSH host yields `NothingFoundException`,
but `ConnectionManager.refreshNow` previously retained the cached row. The pure
`ListingFailure.snapshot` policy clears only that authoritative empty answer. Host refusals and
transport errors retain the previous snapshot; cancellation propagates before replacement.
Native wiring preserves the route-specific error and the existing connection rules, including
connected SSH/New terminal on an empty host. No RPC, projects blob, pairing, mirror or SSH-visible
file contract changes.

`ListingFailureTest` adds four methods for an actual parsed phone-terminal listing, generic-error
retention, cancellation identity and native error/connection wiring. The real full Gradle run
passes 688 tests in 67 suites, zero failures/errors/skips, in 52 seconds; offline app compile
passes in 6 seconds. All six isolated Kotlin 2.2/JDK 21 mutants are caught; ignored proof is in
`.nodeterm/android-beta-build-9/`. Independent review finds no blocker. At this checkpoint beta 9
was planned, not prepared or installed; beta 8/code 9 was bound to `b88d1415`. The previous
green branch is `19da35a2`, all five jobs in run `37140762345`; the fix's next push needs its own
gates and green workflow. Broader phone work remains deferred except explicitly authorized A90
checks. Incomplete new physical QA is not recorded here; the 7 Pass / 20 Partial / 37 Pending
ledger remains unchanged.

### Beta 8 installed on the intended Pixel with app data retained (2026-10-03)

The user supplied a new wireless-debugging address and authorized the update. The exact intended
Pixel 10 Pro / Android 17 was confirmed before a 28.05-second `adb install -r` of beta 8 / code 9.
The pulled pre-update APK matches known beta 6 / code 7; SDK 37 confirms the retained public
signer. The pulled post-update APK matches beta 8 SHA-256
`d373ad5c1790f714cb4464ad4a0a38c5ba9ab68e35103e54cf3aef5ce53081ce`, source
`b88d141528c1051964da07faf22cc7fa923c4846`. Package metadata confirms code 9/name beta 8 and
non-debuggable; `firstInstallTime` and granted `POST_NOTIFICATIONS` are preserved. The app starts
and the existing manual-SSH computer is still in All computers. Opening that exact host reconnects
over SSH and loads its real driven projects. The screenshot shows New terminal and own-app UI XML
confirms its FAB is enabled/clickable, without a TalkBack claim. No existing pane was touched and
no terminal was created or ended. Host configuration/reconnect/browse survives; item 32's actual
Create/cwd/history/reconnect/End and the 7 Pass / 20 Partial / 37 Pending ledger remain unchanged.
Broader device checks stay after the hike.

Private proof is `.nodeterm/android-beta-build-8/device-install-20261003/receipt.json`, with
package before/after, APK pulls/public certificate checks, `sessions.png` and `ui-sessions-ready.xml`. Recorded prior branch
`19da35a2` has all five CI jobs green in run `37140762345`; the APK remains bound to `b88d1415`.
The next documentation push needs its own checks/green workflow. For item 1, pair on current
beta 8 using desktop-issued JSON or QR and verify those pairing/relay credentials across a later
same-signer higher-code update, without downgrading or uninstalling the working app.

### Plain terminal creation for manual SSH/WireGuard implemented; beta 8 prepared (`A90`, 2026-10-03)

The user cannot start a new shell from their manual SSH host and authorizes adding it. The host
contains `nodeterm-rmt` sessions and SSH-visible project files from another desktop, with no own
workspace or relay to register into. The bounded solution is explicit plain-shell creation on
`nodeterm-phone`, chosen discovered cwd or Home, with session creation marker/metadata and a
synthetic Phone terminals group. Shells survive disconnect and End targets only the owned session.
No shared project.json, canvas registration, agent hooks/account identity or current RPC/blob/
pairing/mirror/SSH-visible file contract changes. Desktop and Server Edition retain their socket
ownership; @eneskirca can carry the isolated socket and marker/metadata design to iOS.

Protocol commit `bcc92367` and UI/model commit `b88d141528c1051964da07faf22cc7fa923c4846` implement
the path. Creation records ID/cwd/request/fingerprint atomically, so a process that dies before
option finalization leaves a rediscoverable shell. Validated fingerprints guard live attach,
typing and End; reserved IDs cannot create relay phantoms. Same-ID/folder retry retains the shell
even after a folder rename. The new pane clears stale managed identities and normalizes a warm
server's non-UTF-8 overrides. Host-owned jobs survive dialog dismissal/background; Main navigation
rechecks the current screen/ticket. Full protocol tests pass 684/66 with zero failures/errors/skips
in 48 seconds; offline app compile passes in 1 second. All 32 new mutations are caught: eleven
actual Gradle/Kotlin 2.2 protocol behavioral, twelve helper behavior and nine native wiring variants.

At this preparation checkpoint private `0.1.0-beta.8` / code `9` was **not installed**, from clean `b88d1415`.
The actual offline AGP release built in 49 seconds; R8 keeps and retained-signer packaging pass.
Independent SDK 36/37 tools verify v2/v3 signatures, one retained signer and 16-KB alignment;
all 149 unsigned payloads are byte-preserved (three signing entries added), four ELF PT_LOAD
alignments pass, and R8/service mapping and source/version/hash/build inputs agree. Terminal
assets/native libraries remain byte-identical to beta 6. APK SHA-256:
`d373ad5c1790f714cb4464ad4a0a38c5ba9ab68e35103e54cf3aef5ce53081ce`.
Private artifact: `.nodeterm/android-beta-8/nodeterm-android-0.1.0-beta.8.apk`; proof:
`.nodeterm/android-beta-build-8/`, including `artifact-review.json`.

At that point beta 6 / code 7 was installed and beta 7 / code 8 was prepared, unused; the seven
Pass / 20 Partial / 37 Pending ledger was unchanged. The later installation receipt above supersedes
the planned beta-6→8 update; item 1 now requires pairing on current beta 9 before a later higher-code
update. Use Sessions → New terminal → Home/project/custom absolute
folder → Create; verify real cwd/input/history, disconnect/app-restart rediscovery and exact owned
End under item 32, preserving other sessions and desktop files. At that checkpoint physical proof remained pending.
This separate feature keeps `A08` and `A26`'s canvas/relay decisions intact.

### Historical same-signer beta-7 update prepared, unused (2026-10-03)

Private `0.1.0-beta.7` / code `8` is prepared, **not installed**, from
`b53610deb3843b59fa6a1bed5bdc5f36da0f5146`. The local AGP release built in 47 seconds;
R8 and retained-signer packaging passed. APK SHA-256:
`5141c6484b422b236a98213731076be621c4d14a55f47c79bfd989fb23609e6a`.
Private proof is in `.nodeterm/android-beta-build-7/`, artifacts in `.nodeterm/android-beta-7/`.
At that point installed beta 6 / code 7 remained at `c4b1f6cf`; its physical evidence and the seven Pass /
20 Partial / 37 Pending tally are unchanged. No new runtime fix, finding or phone work was added.

At that stage code 8 was the planned paired-update candidate; it remains uninstalled and is now
superseded by beta 8 / code 9, later replaced by installed beta 9 / code 10. Debug migration remains a
conditional SKIP on the working Pixel. Recorded historical CI baseline `b53610de` has all five
jobs green in [run `37073041994`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37073041994);
the next documentation push requires its own checks and green workflow.

### Requirement audit corrects item 18; remaining device work deferred (2026-10-03)

A read-only review of all 64 requirements promotes item 18 to Pass on existing
`physical-chips-interior.json`, `keyboard-results.json` and `recovery-results.json`: all 17 sending
chips, four application-cursor arrows, real software input, A−/A+ and rotation preserve the SSH
connection. Its former extra route/geometry requirement belongs to other items; viewport/Fit
remains Partial under item 23. Item 1 stays Partial and requires a desktop-issued pairing and
relay credentials to survive a higher-code update; actual JSON or QR pairing is acceptable.
At this checkpoint the tally was seven Pass / 20 Partial / 37 Pending, with no other promoted row.

The user defers remaining Pixel release checks until after the hike. No new phone/service work,
runtime fix, test change or product finding accompanied this audit. Afterwards, finish the
remaining 64-item QR/cellular-relay/SAS/worker/outage and paired-update gates, then the remaining
scroll/viewport matrix. Full release readiness, hosted cellular relay and live-Claude verification
remain open. Existing APK/source/hash and user-confirmed cellular WireGuard SSH connection/smooth
scrolling are unchanged. Recorded historical CI baseline `92ab112df0e2b2bad1b77a1adf6b55dfa7c552a8`
has all five jobs green in [run `37071299440`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37071299440);
the next documentation push needs its own required checks and green workflow.

### Final cellular WireGuard check confirmed by the user (2026-10-03)

With WireGuard enabled and Wi-Fi off, the user confirms beta 6 / code 7 "Connects and scrolls
smoothly" in their usual manual-SSH terminal, confirming connection and smooth scrolling. This verifies the
regular cellular VPN route; hosted cellular relay remains untested. Item 20 stays Partial and
as of this checkpoint the table stood at six Pass / 21 Partial / 37 Pending. QR/scanner, cellular relay/SAS, worker/
notifications, actual outage and the rest of the 64-item matrix remain the next gates. No runtime
fix or phone command accompanied this check. Latest required protocol/offline app tasks pass in
50/1 seconds; the preceding 54/5-second QA checks are historical. Recorded green CI baseline stays `58a202be`;
each subsequent documentation push still needs required checks and its own green workflow.

### Mounted relay questions and scoped cleanup verified (2026-10-03)

On the desktop-mounted owned terminal, tapping single-select Green delivers actual application
option 2, and shipped PostToolUse resolves the desktop mirror question. The multi-select card
has read-only options, "Choose several — answer in session" and Open session; opening the owned
terminal and sending 2 plus Enter from the phone input bar reaches the synthetic application and
its actual PostToolUse. For a separate single-select case, the exact owned tmux pane is in copy
mode before PreToolUse. Tapping Blue delivers option 3; copy mode is false afterward, and actual
PostToolUse leaves the mirror working with its own question resolved. These are production hooks
and the actual mounted transport path, with a synthetic application and no live Claude account.
Item 41 remains Partial: offscreen/released/direct-SSH and missing/prefix-collision target device
variants are not verified; regression tests cover transport/target guards. Private desktop
`hook-qa-*.jsonl` and phone `relay-single-before/after`, `relay-multi-refreshed/multi-terminal/multi-input`,
`relay-copy-question-before/after` proof record the outcomes. At this checkpoint the 64-row table had six Pass,
twenty-one Partial and 37 Pending, with conditional SKIP variants.

Cleanup forgot only the disposable fixture host, returned the phone to its regular Sessions,
removed only the owned SSH fixture session, and stopped only the owned isolated desktop/CDP.
Fixture-device revoke/stop/remote-access-off cleanup left zero fixture devices; this is not a full
device revocation or backend assertion. The final user-confirmed beta-6 cellular WireGuard SSH
check is recorded above. APK/source/hash are unchanged; recorded CI baseline `58a202be` has all
five jobs green. The forthcoming documentation push needs its own checks and CI verification.

### Real relay terminal and shipped-hook approval lifecycle verified (2026-10-02)

The actual Pixel attaches through the hosted relay to an owned plain terminal and sends harmless
echo input to its real PTY (`relay-input-capture.json`: `hasExpectedEcho: true`; phone UI:
`relay-terminal.json`). The owned project/node was seeded through the production preload and
Canvas event, not phone New session or its folder picker. The production desktop is source
`58a202be` in the private home; the installed APK remains source `c4b1f6cf`, code 7.

A synthetic application invokes the desktop's shipped managed Claude hook for the owned node,
with its authenticated private-home endpoint. Pixel Inbox Approve returns actual allow JSON in
17.596 seconds; Deny returns actual deny JSON in 6.571 seconds. A 45-second expiry returns empty
output; a subsequent Approve visibly says "The request timed out on computer. Answer it in
session." and opens the owned terminal without false success. Item 39 passes this held-hook
lifecycle with an explicit producer limit: no live Claude CLI/account or requested Bash execution
was involved. Mounted question/copy-mode proof is recorded in the newer entry above; remaining
routes/target variants and notification actions remain unverified.
Private proof is in `hook-qa-*.jsonl` under the isolated desktop fixture's proof directory.

The latest required checks pass 658 protocol tests in 63 suites with zero failures/errors/skips
(54 seconds), plus offline app `compileKotlin` (5 seconds). At the question checkpoint, the 64-row table had six Pass,
twenty-one Partial and 37 Pending after the question follow-up above; original APK/hash/source
and the recorded green CI baseline are unchanged.
No production or interop contract changed and no new audit finding is added.

### Live hosted relay and encrypted paste pairing verified (2026-10-02)

The actual minified Pixel beta 6 pairs from the production PairingService's JSON through its
encrypted exchange, with remote access on, adding the fixture host alongside the retained manual
SSH host. Settings **Only through the relay** then opens the isolated empty Sessions workspace,
whose header says **"Through the relay · end-to-end encrypted"**. This proves the current
`{deviceToken, hostId}` request to hosted `POST /v1/relay/join` and its accepted response with the
real `wss://relay.nodeterm.dev` transport, beyond the interop fixture. The desktop is production
source `58a202be` in a private bwrap home overlay with actual DBus SecretService encrypted
credential storage; no user-profile credentials were copied. An initial Automatic SSH browse
listed the real sshd's files without opening a real node; relay-only was selected before any node
action. Remote access was enabled at pairing and the phone is already approved, so no SAS prompt
is expected for this path. QR/scanner, cellular relay and SAS denial/revoke remain unverified;
the newer entry above adds relay terminal/input and held-hook proof. Private phone UI proof:
`checklist-20261002/relay-first-connect.json`.

Checklist 7/8/12/16 gain partial evidence; this pairing step did not add a complete pass. The current
64-row record had six Pass, twenty-one Partial and 37 Pending at the question follow-up checkpoint, with
named conditional SKIP variants.
The APK source/hash, code 7 and recorded green CI baseline `58a202be` are unchanged. No production
or interop contract changed and no new audit finding is added.

### Real Pixel terminal/clipboard/lifecycle checklist follow-up (2026-10-02)

The unchanged signed minified beta 6 / code 7, source `c4b1f6cf1009f293a658b6331d2ed1ab80aa36c6`,
passes complete device items **19, 21, 22, 24 and 38**. The Pixel 10 Pro runs Android 17 / API 37
and Vanadium `154.0.8037.92.0`; its real SSH-driven Linux host is Fedora 44/kernel
`7.2.7-200.fc44` x86_64, OpenSSH `10.2p1-14`, tmux `3.7c`. The running desktop nodeterm version
is not recorded. All content is synthetic and scoped to owned test panes. Private proof is in
`.nodeterm/android-beta-build-6/checklist-20261002/`; [android.md](android.md#what-is-verified-and-how)
has the detailed evidence and the 64-row result table. After the live relay/hook/question follow-ups,
that checkpoint had six Pass, twenty-one Partial and 37 Pending, before the requirement audit above.

Rounded borders/accents/CJK/emoji render. Exactly 90000 clipboard characters copy; 150000 and
450000 show the app's size refusal, preserve the clipboard and do not crash. Invalid
base64/separator/query/selection/UTF8 are silent and preserve the known synthetic clipboard.
Phone-visible refusal does not itself prove the pre-bridge boundary, which remains distinct
bounded JVM/JS evidence. The keyboard chip passes all three focus states: real software `a`
and Enter reach the pane, not the native draft. Background `am kill` restores Inbox tab and
host back stack; force-stop/reopen retains manual SSH authentication without a key prompt.

At that checkpoint, partial checks included all 17 sending chips and four app-mode arrows, A+ 56×48→52×45 and A−
restoration, rotation/draft survival, wrapped HTTP/HTTPS links from first/middle/last rows,
accepted HTTP(S) OSC8 and rejected file/JavaScript. Copy sheet copies three exact Unicode lines
(lower box border plus synthetic A/B); Share preserves selection and overlay mouse events remain
zero. Browser Open/offer-interaction and Copy-sheet links/Open remain pending. Landscape with
IME open was 129×1 and portrait returned to 56×25; usable landscape height and larger-client Fit
remain untested. Real SSH background detach/foreground reattach and owned-client detach
recovery preserve the draft; armed Ctrl+c is exact with no Enter. Airplane/outage and disabled
states, QR/cellular-relay/notifications, custom bindings/FPS and remaining checklist variants
stay open. Driver coordinates/side-Back/Compose class assumptions are helper issues, not findings.

No APK, production or interop contract changed. Latest pushed
`58a202be84a6e07e0684584f978bb6346b3c3b52` passed all five jobs in
[run `37062631975`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37062631975).

### Beta-5 continuous swipe failure; stable touch target corrected (2026-10-02)

The user reports that continuous swiping stops and requires lifting before another move. On the
intended Pixel, a controlled beta-5 gesture updates history from 0 to 15 at 369 ms, 25 at 391 ms,
and 30 at 412 ms, then remains unchanged through 1.4 seconds after the ADB swipe command completes
at 561 ms. Command completion is not a measured physical touchend timestamp. This does not verify coast. `A89` records the concrete root cause: the DOM renderer replaces painted row spans,
removing the original touch target while touchmove/touchend still belong to it. Those events no
longer bubble to the live terminal handlers. The old tests dispatched directly on the host and
missed the real target's lifetime.

`c4b1f6cf` gives `.xterm-screen` `touch-action: none` and disables pointer events on `.xterm-rows`
and its descendants. Hit testing then chooses the stable screen behind the changing text. The
real xterm interaction regression confirms a redraw detaches the old span and loses later events;
with the page's computed CSS, the screen stays connected and receives continued moves and the
release. The existing velocity fling, ordered 20-notch calls and native stop barriers remain.
No host/payload/SSH-file contract changed; no iOS fixture change is owed.

All 658 protocol tests in 63 suites pass with zero failures/errors/skips (67 seconds); offline
app `compileKotlin` passes (8 seconds). The real-bundle redraw case delivers 24 notches with the
stable hit target versus one after detaching the original span. Thirty-five JS, eleven new native
and three CSS mutations are caught (49 total). A real Electron/Chromium probe also confirms
`elementFromPoint` hits the connected screen across redraws; original CSS hits a detached span.
This is desktop Chromium evidence, not Pixel touch/coast proof. Its log is retained in the private
beta-6 evidence. The probe used Electron 42.11.3 / Chromium 148.0.7778.280.

Private `0.1.0-beta.6` / code `7` uses source `c4b1f6cf1009f293a658b6331d2ed1ab80aa36c6`.
The actual AGP release built in 43 seconds and passed every R8 keep. Retained-signer packaging
verified non-debuggable metadata, signature, 16-KB alignment and source/hash provenance; all 149
ZIP payloads stayed unchanged, with only three signature metadata entries added. APK SHA-256:
`4947133a6ccf9c2b1e775e76d7c24f564e087cf036e59eac4dca08162a076d3c`.
The intended Pixel received a same-signer update preserving app data; notification permission is confirmed. Private
inputs/proof, full XML and mutation logs are in `.nodeterm/android-beta-build-6/`; signed artifacts
are in `.nodeterm/android-beta-6/`.

**Controlled Pixel proof:** SSH reopened with the retained key/pin in the owned 56×48 pane. A
1000-native-pixel/1200-ms swipe produced 23 observed history-position updates, from 0 to 110 over
about 1103 ms; its ADB command completed at 1535 ms. A 1000-pixel/200-ms swipe reached position
110 when its ADB command completed at 540.5 ms, then 250 at 1339 ms (about 799 ms later), with
29 observed updates overall. This verifies continued drag delivery and post-command coast.
Esc during coast left copy mode (`mode=0`) and remained out for 1.4 seconds.

New-touch stopping also passes with the keyboard already open and all sampled viewports at
56×25. After a 500-native-pixel/100-ms swipe, the DOWN command completed 152 ms after the swipe
command; the script then waited 1.2 seconds before issuing CANCEL. The last position change was at 503.6 ms, before DOWN completed at
588.8 ms; final position 100 remained unchanged through CANCEL. Earlier tap/DOWN checks opened
the IME and rebased tmux positions, so those results were inconclusive, not additional failures.
Evidence includes `beta6-stable-viewport-touch-stop.json` and `stable-touch-check.log` in the
private beta-6 proof. After these checks, Esc left copy mode, Header Back returned to Sessions
and detached the owned client. Only the exact owned `nt-term-000android-scroll-20261002-c`
session was killed; Sessions was refreshed and owned phone UI XML removed. The private
`device-summary.json` records completion.

**User confirmation:** after normal terminal use, the user answered “Both work now” for continuous
dragging and coast. This resolves the primary drag/coast complaint under `A86`; reversal/lifecycle
checks, custom wheel bindings, FPS and the full 64-item pass remain open. The user's final beta-6
cellular WireGuard SSH connection and smooth scrolling check is confirmed; hosted cellular relay is untested.
`A88` (`f5fd3821`) passes 39 tests per real SDK 36/37 and ten new tool mutations; CI4 failed
private packaging. [Run `37061593216`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37061593216)
at `c37798b6495b4b68df379d0ae80887c23104b66d` completed with all five jobs green, confirming the
observed packaging workflow repair. Any subsequent push still needs its own green workflow.

### Historical bounded kinetic implementation; private beta 5 installed (2026-10-02)

The user reports more delivered movement on beta 4 but no web-page-like momentum after finger
lift. This continues `A86`; it is not a new finding. `1ad2e944` samples the last 120 ms of touch
motion and permits a fling only within 80 ms of the last movement, at 0.45–3 CSS pixels/ms.
Animation frames integrate exponential decay with a 240-ms constant, stopping at 0.06 pixels/ms
or the hard 1000-ms/1200-pixel bounds. Calls still carry at most 20 notches; a gap over 250 ms
cancels movement. New touch/input/reset/font/lifecycle barriers clear it and use `onScrollStop`
(`53462f96`) to discard unsent native scrolls without typing into the pane. Accepted keys/replies
and the single in-flight operation are preserved. Bytes already handed to SSH's separate writer
or the network cannot be recalled. Automatic xterm reports retain the nonbarrier route fixed by
`A87`. No host verb, payload, mirror or SSH-file contract changed; no iOS fixture change is owed.

All 658 protocol tests in 63 suites passed with zero failures, errors or skips (59 seconds);
offline app `compileKotlin` passed (10 seconds). The strengthened new-touch/reverse-drag regression
passed all seven focused kinetic tests (8 seconds, `05cc6644`). The real xterm bundle exercises coast while
focus/query reports arrive. Thirty-five JS mutations (22 existing routing/batching plus 13 kinetic)
and eleven new native helper/wiring mutations were caught. Native stop preserves accepted input,
reply FIFO and in-flight budget while refusing obsolete/retired viewers.

Private `0.1.0-beta.5` / code `6` uses source `1ad2e94455a7adfb85d41212b12d36df39695324`.
The actual AGP release built in 47 seconds and passed every R8 keep. Retained-signer packaging
verified non-debuggable metadata, signature, 16-KB alignment and source/hash provenance. APK
SHA-256: `7cc68d384aeb21ab40800fa7c83f006dfbfefba16dd2e945967c8c5376f17655`.
The intended Pixel updated in place; installed code-6/non-debuggable metadata and notification
permission are confirmed. Private inputs/proof are in `.nodeterm/android-beta-build-5/` and the
APK/checksum/metadata in `.nodeterm/android-beta-5/`.

**Superseding phone failure:** continuous movement stops, with no demonstrated coast afterward;
the user must lift before moving again. The newer `A89` entry above records the real DOM-target
lifetime cause and beta-6 correction. These beta-5 build/tests establish implementation, not
successful momentum on the intended phone.

**Packaging CI follow-up (`A88`):** CI run `37058184031` at `9ced6781` passed protocol, debug,
release and CodeQL, but private packaging failed five of 32 tests at the same signer/v2 gate.
Official SDK 37 reproduces the failure with verification exit 0, v2 true and one certificate,
reported as `V3.0 Signer:`. `f5fd3821` accepts exact V2/V3.0 single labels and V3.0/V3.1
SDK ranges, keeps the pinned-certificate/v2 policy, and rejects extra/unknown/hybrid certificates.
Fixtures now use the explicitly installed SDK 36/platform 35 unless a reproduction override is
set; signature-gate failures include only disposable-fixture verifier diagnostics. All 39 Python
tests pass against each real SDK 36/37; six parser and four fixture-selection mutants are caught.
A real SDK-37 acceptance mutation also fails if the new single-label support is removed. The
follow-up run `37061593216` completed all five jobs green and confirms observed CI repair;
the original failed CI log did not capture raw tool output.

### Beta-3 user failure; report routing and gesture gain corrected (2026-10-02)

The user reports that beta 3 still has both lag and too little movement, on Wi-Fi and mobile-data
VPN. The historical controlled swipes below verify their measured distance/order, not satisfactory
feel. `3cffb49d` restores one measured row per notch and fixes `A87`: xterm's automatic mouse, focus
and parser replies use a nonbarrier native report path, while real keys, paste and IME input still
cancel unsent movement. The pinned xterm 5.5 bundle is exercised in real interaction regressions.
Ordered frame batching, lossless 20-notch chunks, the serial actor, lifecycle retirement and SSH
TCP_NODELAY remain. No external verb, payload, mirror or SSH-file contract changed; iOS needs no
payload fixture change. Recheck the internal input-origin adapter when upgrading the pinned xterm.

The controlled beta-3 phone trace records exactly one bridge invocation in each of 12 gesture intervals
and roughly one content presentation per gesture. First invocation is 84–90 ms after touchstart;
first presentation 170–196 ms is temporal correlation, not an SSH/action flow. Presented Chromium
scroll events are 36–56 ms; the >1-second aggregate mostly counts no-paint termination. Sparse FrameTimeline
and non-damaging jank records establish no terminal FPS or JIT/renderer cause. Named JS/native
methods and scheduler/V8 measurements are absent; newer extension fields have parser warnings.

All 646 protocol tests in 62 suites pass with zero failures, errors or skips (50 seconds); offline app `compileKotlin`
passes (8 seconds). Twenty-two JS and nine actor/native-wiring mutations are caught.
The matching beta-4 trace records 42 bridge invocations versus 12, 26 content commits versus 12,
and 25 distinct presentations versus 11 over twelve gestures. First invocations occur at 25–36 ms
versus 84–90 ms; this supports more frequent delivered updates, without establishing terminal FPS
or end-to-end SSH latency. Both traces and queries are retained in the private beta-4 evidence.

`fed68fb3` (`A88`) keeps one expected certificate and verified v2 while accepting newer SDK-range labels;
32 Python tests and ten mutations pass locally (32 tests, zero failures, 16.8 seconds). The observed CI packaging failure still requires a
successful subsequent workflow before claiming CI repair verified.

Private beta `0.1.0-beta.4` / code `5` uses source
`3cffb49d8cf64932260e914b42b3883331d0352d` and the retained signer.
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
At the beta-4 checkpoint, user follow-up remained open under `A86` and kinetic fling was absent.
Push is authorized,
with required pre-push checks and green Android workflow afterward; no PR is requested.

### Historical scroll mitigations implemented; private beta-3 updated on the intended Pixel (2026-10-02)

`e6bdb157` enables TCP_NODELAY on connected SSH sockets. `245b42e6` measures row height once per
gesture, accounts for stock tmux's five rows per wheel notch and batches same-direction movement
by animation frame, preserving fast-swipe distance in ordered calls of at most 20 notches.
`2c5d15a8` adds one bounded serial `TerminalActions` drain per accepted stream. Suspended relay
RPCs preserve direction/input order; input cancels unsent scroll and follows the in-flight call.
Retiring the viewer cancels/clears its queue, while native raw/resume writes cancel page scrolling
first and remain bound to the accepted stream. `40c4ee49` cancels page scrolling again immediately
before delayed paste Enter. No external host verb, payload or SSH-visible file contract changed;
this fix needs no iOS payload/interop fixture update.

The full restored-source protocol suite passed 638 tests in 61 suites, with zero failures, errors
or skips (51 seconds); the final offline app `compileKotlin` passed (7 seconds). Thirty mutations were caught:
two SSH socket-policy, fourteen JavaScript and fourteen actor/native-wiring mutations.
Private `0.1.0-beta.3` / code `4` from `40c4ee49592e2f92fc7e6e9b548ba88a33b1e2d3` built locally
in 49 seconds, passed every R8 keep and retained-signer packaging. Signature, alignment and
source/hash provenance were verified with all 149 ZIP payloads unchanged by signing. Its in-place
update preserved manual SSH registration/key/pin and notification permission; the app reopens the
Linux host over SSH with a 56×48 owned test terminal. Five identical controlled swipes finish at
history position 25 versus beta 2's 85; reversal moves 25 to 20 and the actual Esc chip leaves copy
mode. The phone returned to Sessions and refreshed; only the owned test session was removed, with
all user panes untouched. Private proof/screenshot/package checks are in
`.nodeterm/android-beta-build-3/`, including `device-checks.json`. The user subsequently reports that beta 3 still has both lag and too little movement; the
current correction and controlled phone trace are above. Custom tmux wheel bindings and kinetic
fling remain open. `A86` stays open for those checks. Push is
user-authorized, branch CI triggers remain enabled and every requested push requires a green
Android workflow verification. No PR is requested and `A68` remains deferred.

### Post-beta scroll responsiveness investigation (2026-10-02, before mitigation)

After beta checkpoint `cf0487a3`, the user reports slow scrolling on both Wi-Fi and mobile-data VPN
(`A86`), so a VPN-only cause is not supported. Controlled private
SSH/tmux measurements show five rows per wheel notch, coarse drag gain, no fling and clipping
above 20 notches per call. TCP_NODELAY improves some loopback output-tail measurements but does
not explain every rate. Desktop DOM replay shows no backlog at that load; the phone's renderer
and real-network timing are unmeasured. Next compare
gesture gain/coalescing/order, socket behavior and phone renderer traces. This is diagnosis only;
no source, phone setting or installed APK changed. The signed-beta evidence below still holds.

### Intended Pixel beta updated; direct SSH and pre-attach tmux history verified (2026-10-02)

The user supplied the intended phone's ADB endpoint: Pixel 10 Pro, Android 17 / API 37, Vanadium
WebView `154.0.8037.92.0`. Beta `0.1.0-beta.1` / code `2` installed, the user granted notifications
through Android's normal dialog, and `run-as` is denied. The phone's SSH public key was authorized
without replacing existing keys. Add SSH server connected to the intended Linux host, with its
Ed25519 pin matching the host's public key. The app lists 17 actual projects, and an `echo` sentinel
entered from the phone executed in a controlled temporary test tmux window. No user pane received
test input. This verifies basic manual direct-SSH registration, browse and input; QR/code or relay
pairing was not tested. The user subsequently confirmed mobile-data WireGuard terminal access;
reconnect/background/answer behavior and the full 64-item checklist remain open.

The terminal advertised 52/56 columns by one row despite a large viewport, including after a font
change (`A85`). Chromium forces zero CSS layout height when WebView layout parameters use
`WRAP_CONTENT`, even with large native bounds. `febe022a` supplies `MATCH_PARENT` width/height
before loading the terminal page, without CSS or JavaScript changes. The real Gradle
`TerminalWebViewLayoutTest` wiring guard passes and two layout-policy mutations are caught in a
temporary source mirror. Actual `0.1.0-beta.2` / code `3` from
`febe022ad2fc373f27ac11d9ad5f130f36f027a5` passed its offline AGP release build in 45 seconds,
retained-certificate signature/alignment/provenance verification and `adb install -r`. Host
configuration, phone SSH key, host pin and notification grant were preserved, and the app reopened
the intended Linux host over SSH. Inputs/logs are in `.nodeterm/android-beta-build-2/`;
APK/checksum/metadata are in `.nodeterm/android-beta-2/`. APK SHA-256:
`a022a399e23c81607a4a3664862b964ad781f0a589ab77dda902b4c2dc597eca`.

The controlled terminal now fills a 52×45 viewport, versus 52×1 before. A downward swipe entered
tmux copy mode at position 82, and a screenshot visibly showed the pre-attach ready/sentinel and
marker rows 001–039 from 120 rows printed before update/attach. This restores pre-attach tmux
history through the layout fix; production SSH scroll is unchanged. A− restores font 13 and 56×48;
showing the soft keyboard gives 56×25 with native bounds `[0,396][1280,1462]`, and hiding it returns
56×48. Esc leaves copy mode (`pane_in_mode=0`), and Send executes a second unique harmless draft
command with its whole output line visible. The app returned to Sessions; only the owned temporary
test window was removed, with the previous window restored and original Python process alive.
The intended phone's app/key/configuration remain. Device-check metadata and controlled screenshots
are retained in `.nodeterm/android-beta-build-2/`, including `device-checks.json`. The full 64-item
phone checklist remains open; user-reported mobile connection evidence follows.

**User-reported mobile check:** with WireGuard enabled and Wi-Fi off, the user confirmed that the
intended Linux host's terminal opens over mobile data. This is separate from the ADB-assisted LAN
checks above. Mobile reconnect, approvals/questions, background behavior and the full 64-item
checklist remain open.

History regressions in `d6619bf6` pass 47 focused real Gradle SSH/terminal/link tests with zero skips. Both JavaScript swipe-direction/disabled-scroll mutations, the real-SSH wheel-direction mutation and the two native layout-policy mutations were caught; production sources were restored. **Final verification:** all 609 protocol tests passed in 59 suites with zero failures, errors or skips (52 seconds); the offline app `compileKotlin` passed (7 seconds).

### First private beta built and signed; wrong-device launch rolled back (2026-10-02)

The actual release source `fa71cb08072f399f24a81bfb361ea852a0275f3b` builds with AGP 8.10.1,
Kotlin 2.2.0, wrapper Gradle 8.14.3 and JDK 21. The first AGP 8.9.1 build completed with many R8
Kotlin-metadata warnings (`A83`); the corrected release removes them. Final offline
`:app:assembleRelease` passed in 15 seconds and every R8 runtime keep matched. The toolchain guard
passes eight bounded tests and catches two mutations.

The retained signer signed and verified `0.1.0-beta.1` / code `2`, with expected certificate pin,
`debuggable=false` and same-build local source/APK/R8/hash provenance. Inputs/logs are in the
original workspace's ignored `.nodeterm/android-beta-build-1/`; the finished APK/checksum/metadata
are in `.nodeterm/android-beta-1/`. Installation on the MI8 (Android 15 / API 35) succeeded, and
the first cold start reached the notification permission dialog. With `POST_NOTIFICATIONS` granted,
the app shows an empty Computers screen, Pair button and Settings, with no crash markers. Installed
metadata confirms version code `2`, minSdk `26` and targetSdk `35`; `run-as` is refused because the
app is non-debuggable. WebView is `com.android.webview` `144.0.7559.76`. These are partial evidence
for checklist items 1 and 5 on that test device; neither entire item has passed.

The user identified the MI8 as the wrong phone. Only the newly installed app and its test UI dump
were removed. Its newly authorized SSH public key was removed, and the host's `authorized_keys`
was restored byte-for-byte to the pre-change state. No host was paired on the MI8 and no SSH
connection was attempted. At that point intended-phone installation and registration were open; the user's target
is this Linux host over their WireGuard VPN. A50's signed-artifact preparation is addressed, but
pairing, terminal use, mobile-data preflight and the full 64-item phone pass remain open.

Full `npm run typecheck` and 679 desktop tests passed, with three platform skips; the offline
Gradle app type-check and 23 Python beta-tool tests passed. The real Gradle protocol run executed
605 tests (603 pass, two real-SSH failures, zero skipped). The failures are test isolation faults
(`A84`): Fedora's login-shell command-not-found handler delays the literal `-R` command, and a
previous no-exit-status test leaves Escape in shared Readline state, changing the next `echo` to
`cho`. The test-only fix in `1d6b04cc` isolates a fresh non-login pane and initialization environment
per test. The final full rerun passed all 606 tests, with zero failures, errors or skips; both
harness mutations were caught and the fixed source restored before the rerun. App source/build
`fa71cb08` is unchanged by this test fix. The user authorized local
build/install instead of requiring Actions; no current CI pass or PR is claimed, and A68 remains
last. Earlier progress entries describe the restricted sandbox and have not been rewritten as
new validation results.

### Local host access restored; source reconciliation (2026-10-02)

The user authorized a local build instead of waiting for GitHub Actions. Restored host access
allowed fetching remote tip `82940e17`, whose six batch E follow-up fixes were reconciled in `990f90c6`. The host-side adb lists an MI8 phone on Android 35, with no installed
`dev.nodeterm.android`; no installation or device checklist result is claimed yet. Build the
unsigned minified APK and record APK/R8/source provenance from one successful local build, then
package with the retained signer. Required checks on the reconciled source, the actual APK and
phone validation remain pending. Earlier entries describe the prior restricted sandbox.

### First private signing identity prepared (2026-10-02)

The user confirmed this is their first private beta. A retained RSA-3072 PKCS12 signer, alias
`nodeterm-beta`, is prepared in the original workspace's Git-ignored
`.nodeterm/android-beta-signing/` (outside the temporary source checkout). The directory is `0700`
and every file is `0600`. Separate local password files feed `keytool`/the packager without putting
passwords in arguments or logs. The keystore contains a `PrivateKeyEntry` with a 3072-bit RSA key.
Its exported public certificate hashes to the locally recorded signer pin and differs from the
committed public debug certificate. Keep this directory in a private backup: source exports
deliberately exclude it.

At this stage the signer resolved one prerequisite of `A50`; no actual nodeterm APK had yet been
built or signed. GitHub DNS, Gradle's lock-service sockets and adb/USB access were still unavailable.
Next obtain one final green CI run's APK/R8/provenance, package with this retained signer, then
install and complete the mobile-data preflight/device checklist. No PR is opened; `A68` stays last.

### Private beta preparation (2026-10-02): local pipeline and reliability fixes

The user wants a privately sideloaded APK for their own phone. A signed APK is not published to
Actions or a public release: artifacts on a public repository are downloadable by other signed-in
users. `android/tools/package-beta.py` signs the unsigned AGP release locally, rejects the public
debug key and unexpected signer, checks release metadata, R8 keeps and APK alignment/signature,
then emits APK/checksum/provenance together. Version overrides leave ordinary builds unchanged.
Pushes to this exact takeover branch build versioned unsigned beta inputs and run **Private beta
checks**; optional manual **prepare_beta** inputs work once the workflow exists on the default branch
(a GitHub requirement; cached main has no Android workflow). The beta checks require the
protocol/release jobs, desktop type-check and delivery/ack tests, and
real-tool packaging regressions. See the [private-beta procedure](../android/README.md#private-beta).

- `A81` (`86390a49`, `7e11e93c`): relay join/device HTTP calls have a 30-second total deadline and finite I/O
  timeouts, including dispatcher queueing. Coroutine cancellation closes the call through
  response-body consumption and preserves a caller's shorter deadline. Six real
  OkHttp regressions pass over in-memory sockets; three initial and three follow-up mutation checks
  are caught. WebSocket reads remain
  long-lived and request/response shapes stay the same. Full Gradle/backend/device checks pending.
- `A82` (`010240e0`): read acknowledgments are consumed only by a positive owner. Local mirror ownership includes
  unresolved own inbox cards after restart; a retained foreign file is retried if ownership changes.
  Remote ownership aggregates every connected project on the host before the shell reads/removes
  files. Android's existing producer contract is covered in the same change and remains compatible
  with iOS; @eneskirca should verify the multi-desktop behavior on iOS.
- Packaging uses fixture APKs and disposable test keys for regression tests. Those fixtures are
  **not the nodeterm app**. At that stage no APK had been built, signed or installed for the user. Required
  full checks, latest-remote reconciliation, CI and all 64 device items remain open. `A68` is deferred.
  Packaging commits `d5f561ec`, `817fd923` pass 22 SDK-backed tests and 13 mutations. The selected
  beta-version environment guard passes 12 cases and catches its bypass. Ack verification passes
  225 desktop tests, three cached-compiler interop/path checks and eight mutations. CI config passes
  seven checks/six mutations in `6efde5f1`, and existing device/contributor docs pass nine checks. See `android.md`
  for the cached compiler/dependency limits; full required checks remain blocked before execution.

### Continuation (2026-10-02): local fixes, full checks and device pass still pending

This session started from the locally cached branch tip `6afd8f53`. GitHub access failed, so it
could not fetch a newer tip, download a CI APK, push or confirm a workflow run. Commit signing
also cannot access its key service here, so the continuation commits are unsigned local commits. The original
checkout's Git metadata is read-only; the working branch is in `/tmp/nodeterm-android-takeover`.

- `A78` (`bb5b3e54`): desktop quick answers resolve the exact session to a pane ID, cancel copy mode there,
  and deliver to that same pane. Mounted tmux sessions use that path too. Whole deliveries are
  ordered per node; a failed or unconfirmed operation is never retried on another channel.
- `A79` (`e64665c3`): Android's SSH quick answers also pin the pane ID and cancel copy mode before typing;
  lookup, cancellation, send failure and missing SSH exit status cannot report success.
- `A80` (`0f39c33f`): a control-mode client's startup attach reply is consumed before replies to queued
  commands. An attach failure retires the client and rejects queued work.
- At that stage no APK had been built or installed. See "What is verified" in `android.md` for
  the local checks and their limits. The full protocol suite, app type-check, desktop type-check,
  real tmux/SSH checks and device pass still need an environment that can run them.

### Batch E (follow-ups, desktop + phone): done on the branch, not device-verified

Six follow-ups from earlier batches. Each had one or two adversarial reviews and a follow-up commit
for every finding above "nit"; all were confirmed against the code before fixing. Four of them
change the desktop, and three add wire fields (all additive, so older phones and iOS are
unaffected until they read them).

| Item | Commits | What changed | Checked by |
|---|---|---|---|
| A12 (SSH projects) | `8430243` | `node.sendKeys` types into a node of the desktop's SSH project over that project's ControlMaster (`PtyManager.backgroundWriteOver`, `send-keys -H` to the exact `=nt-<id>:` pane, copy mode cancelled first). Master down, no remote support or a failed resolve answer `sent:false`; never the local socket. Wire unchanged. | vitest `host-node-actions.test.ts`, `pty-background-write-over.test.ts`, `remote-send-keys.realtmux.test.ts` (the generated line under real `/bin/sh` + tmux, mutation-checked); `RelayInteropTest`. |
| A07 (revoke) | `c199349`, `a988a30` | Revoking a paired phone closes its live relay sessions through the standing host's own Deny path and withdraws a pending consent for that key; other keys are untouched. An unpin that could not be written puts the device back in the list (Revoke retries) instead of reporting success; Settings says when the cut could not be confirmed. | vitest `standing-host.test.ts`, `pairing-service.test.ts`, `peer-revoke-wiring.test.ts`, `PhoneSection.revoke.test.tsx`. |
| A07 (late adoption) | `f66fddf`, `07b7276` | A phone paired while remote access was off is approved on its first relay handshake: the desktop pins a box key that a listed pairing recorded (sealed `/pair` body), re-asked inside the pin queue so a revoke cannot be undone. The `/pair` answer gains `relayApproved`. The host holds the phone's first requests (at most 5 s / 32 requests) until it has decided, so a phone about to be approved silently is not told "awaiting approval" first; a background dial may therefore make the first relay handshake for a pairing that answered `relayApproved`. No new SSH-visible file. | vitest `approved-devices.test.ts`, `pairing-core.test.ts`, `paired-phone-late-pin-wiring.test.ts`, `host-service.decision-hold.test.ts`; `PairingInteropTest`, `RelayInteropTest`. |
| A49 (anchor) | `513c166`, `402f139` | The sealed `/pair` answer carries the computer's SSH host key fingerprints (`sshHostKeyFingerprints`, read from `/etc/ssh` and sshd's `HostKey` lines; never in the QR or a plaintext answer). The phone's first SSH connect accepts only a named key (`HostKeyNotPairedException` otherwise, routed like a changed key with its own advice). | vitest `ssh-host-keys.test.ts`, `pairing-service.test.ts`; `HostKeyAnchorsTest`, `SshFallbackTest`, `PairingInteropTest`, `SshTransportTest`. |
| A74 (refresh) | `cb12f3b`, `898d937` | `projects.list` over the relay answers `{output, lan?}` with the computer's current LAN IPv4 and host key fingerprints beside the blob (not inside it). The phone takes them only from a RELAY listing: a new address replaces the stored one, and the reported keys become the anchors. A host certificate is named by the key it certifies, so it no longer flips the pin. | vitest `host-lan-report.test.ts`; `LanRefreshTest`, `HostCertificatePinTest`, `RelayInteropTest`, `SshTransportTest`. |
| Seen log per computer | `6afd8f5`, `a65e12f` | The notification seen log is keyed by computer, and an event that reaches the phone through two pairings (a desktop and the SSH host it drives) still notifies once (same id and node). The old store migrates as seen for every computer until it ages out; forgetting a computer drops its entries. | `SeenLogTest`, `LiveNotificationsTest`. |

### WP5 batch D (iOS parity features): done on the branch, not device-verified

Each item had an adversarial review and a follow-up commit; the review findings were all checked
against the code before fixing. Most rules live in pure `android/protocol` classes; the Compose
screens are type-checked and source-pinned only.

| Finding | Commits | What changed | Checked by |
|---|---|---|---|
| A26 | `9cdc4cf`, `1eeb5b8` | `LegRouting` decides per capability (board writes, git, node actions, register node, answer approvals) whether the primary leg serves it, the relay leg opened next to SSH does, or it is unavailable with a reason that names the fix (remote access not set up / off on the computer right now / not picked up yet / the "Only on my network (SSH)" route). The browse reports whether `~/.nodeterm/relay.json` is there, so a held token with remote access switched off reads as off. Availability is a presence check (`hasRelayToken`), never a Keystore decrypt while composing. New session and board controls are disabled with the reason instead of failing on tap. | `LegRoutingTest`, `HostBrowseTest`; source pins on the screens. |
| A29 | `0c5a1e1`, `a5f38f5` | A per-project Source Control screen over the desktop's `git.*` verbs (status, diff, stage/unstage, commit, history), routed by `LegRouting` (relay only; no SSH git). Merge conflicts get their own section (no Stage; Commit refuses until resolved), combined-diff markers are read, and long git operations get the desktop's own timeout. | `SourceControlTest`; `RelayInteropTest` drives the desktop's real `GitService` over a temp repository. |
| A32 | `7035bde`, `88beed2` | terminal.js ports the desktop's wrapped-row URL matcher (not addon-web-links), handles OSC 8 through `linkHandler`, and opens http(s) only behind a link bar; a "Copy lines" sheet reads `term.buffer`. Overlays over the terminal stop touches from reaching the WebView or the input bar (`blockTouchesBelow`). | `TerminalJsLinksTest` runs the real terminal.js under node; source pins. |
| A25 (in-app part) | `4ffb8b7`, `0d310cc` | Inbox notifications carry Approve/Deny and option actions, run by a worker through the same `QuickActions` re-checks as the in-app card, never making a first relay handshake. A stale notification cannot type into a newer prompt (the card must still be listed and unresolved), and an interrupted worker never sends an answer twice. A tap opens that session's terminal with the computer's Inbox one Back away; an action that cannot answer from outside the session updates the notification to say so (Android forbids starting the session from a worker or receiver). **FCM is still missing** (backend). | `NotificationActionsTest`, `QuickActionsTest`. |
| A55 | `71b592a`, `0772cbf` | Each computer row shows its needs-you count from the snapshot it already holds (no dialing); with two or more computers an "All computers" screen merges Inbox and Usage, with a per-computer status strip that shows a failed listing and its Try again. | `AllComputersTest`; source pins. |
| A59 | `57804cf`, `8020796` | A mic button in the terminal input bar uses `SpeechRecognizer`; the words go into the draft (cursor after them) and are never sent. No on-device Whisper and no `/v1/transcribe` (that endpoint does not exist yet). | `DictationTest`; source pins. |
| A27 | `8691e6d`, `9b5c342`, `1d8201f`, `c450e16` | (a) The direct-SSH browse reads a Server Edition (`~/.nodeterm-server`) and a host a desktop drives over SSH (both tmux sockets, the per-project status slices); a node no listing names is never offered the relay, so a phantom `nt-<id>` cannot be created. (b) "Add SSH server": add a computer by address, show the phone's public key line for `authorized_keys`, pin the host key after auth, SSH only; the `ssh-` id prefix keeps an added computer added across an older build's rewrite. | `HostBrowseTest`, `ManualHostTest`, SSH transport tests. |

### WP6 batch C (CI, test harness and docs): done on the branch

| Finding | Commits | What changed | Checked by |
|---|---|---|---|
| A60 | `67e6297` | The interop bundle aliases `electron` to a throwing stub instead of loading the real package (whose binary was downloaded at test time); a failed fixture start kills its node process. | `InteropHarnessTest` (no `require("electron")` in the bundle; a never-ready start leaves no process). |
| A62 | `77c760d`, `bf24cfc` | The SSH tests make a short, realpath'd tmux socket root (macOS's 103-character limit) and drive either util-linux or BSD `script`; POSIX-only helper tests skip elsewhere. | `SshTestHostTest`; not run on a Mac. |
| A70 | `68d5da6` | The fixture is bundled through esbuild's JS API by `node` (no `.bin` shim for CreateProcess); the pairing fixture pins its platform and the test isolates `USERPROFILE`. | Bundle byte-identical to the old CLI output; not run on Windows. |
| A67 | `696fd10` | `tsconfig.node.json` includes the interop fixture, so `npm run typecheck` checks it; `HostSessionOptions.pty` narrowed to `HostPtyManager`, removing the fixture's cast. | `npm run typecheck`; a guard test pins the include and bans the casts. |
| A63 | `b3d4c6e`, `9d19bd1` | `android.yml` runs on every file the fixture bundles (`src/core/**`, `src/shared/**`, `src/main/*.ts`, `src/main/remote/**`, `package*.json`, `tsconfig.json`) and on the docs the tests read; the list is derived from esbuild's metafile. | `WorkflowPathFilterTest` re-derives it. |
| A64 | `f9782da` | The relay `projects.list` blob comes from `buildProjectsListBlob` (one assembly for `index.ts` and the fixture); mirror entries from the real writer. Docs now say which contracts are still hand-copied. | vitest `projects-list-blob.test.ts`; a guard test refuses a hand-written blob. |
| A69 | `6f3a8da`, `4806b92`, `86d059d` | `setup-gradle` (wrapper validation, a read-mostly cache) in every Gradle job; Dependabot `gradle` for `/android` with the network/crypto stack in its own group; a Kotlin CodeQL job built under CodeQL (`build-mode: manual`), moved into `android.yml` by `86d059d` so a branch push runs it (`security.yml` has no `workflow_dispatch` and runs only on `main`/PRs/the queue). The gradle-8.14.3 distribution checksum is not pinned yet (no network here). | `GradleCiCoverageTest`. |
| A61 / A71 | `39e7995`, `9d19bd1` | Docs: an existing `npm install` is enough for the interop tests; `npm ci --ignore-scripts` is CI's and replaces `node_modules`. JDK 17–24 (Gradle 8.14.3 cannot start on 25). | `ContributorDocsTest`. |
| A65 / A50 | `33af5e7`, `d092639` | `docs/android.md` gets the numbered device checklist; the READMEs say the debug APK is debuggable, and that a phone exposed over adb needs a new identity (uninstall or clear storage) before re-pairing, not just re-pairing. A signed non-debuggable release is still open (`A50`). | `DeviceChecklistDocsTest`. |
| A66 | `61e218b` | The desktop's Android link reads "nodeterm for Android (build from source)" and is derived from `REPO_URL`. The link resolves once `android/` is on upstream `main`. | vitest `androidAppLink.test.tsx`. |

### WP6 batch B (app-only low-severity items): done on the branch, not device-verified

Most of the logic moved into pure, JVM-tested classes in `android/protocol` (the Compose wiring is
type-checked and source-pinned only). Every item had an adversarial review; the follow-up commits
are listed with it.

| Finding | Commits | What changed | Checked by |
|---|---|---|---|
| A40 | `a38d39d`, `5fb3aea` | `TerminalHandoff` (StreamLease, ViewerSlot, PhoneLaunch): a stream is installed only for the current attach ticket; a phone launch holds its own lease, so Back or backgrounding within the settle delay still writes the line and registers the node. Review follow-up: once a request is on the wire it is not cancelled, and both transports now detach a stream whose caller was cancelled (relay `pty.kill`, SSH client close). | `TerminalHandoffTest`; relay interop and SSH tests for the cancelled attach. |
| A41 | `94a558a`, `0507555` | `InputBar.plan`: Send keeps the draft while detached; byte-sending chips are disabled. The resume offer survives a reattach of the same screen and is re-checked against a fresh listing before it can be tapped. | `InputBarTest`, `ResumeOfferTest`. |
| A45 | `1901939`, `a371483`, `46b0897` | `onRenderProcessGone` handled: a kill reattaches automatically once a fresh WebView reports its size (bounded, visible screen only, monotonic clock); a crash offers "Reopen terminal", and the WebView is rebuilt only when something asks to attach. Renderer priority IMPORTANT, waived when not visible. | `TerminalPageTest`. |
| A46 | `17ee526` | The ⌨ chip clears Compose focus, focuses the WebView, blur/refocuses xterm, and asks the IME after a frame. | Source pins; device check owed. |
| A76 | `6966f25`, `4ef21f0` | "Wake <agent>" over direct SSH for a Sleeping node, only while a shell owns the pane (read before offering and again at the tap), with Ctrl-U first. **Desktop:** the mirror (and the renderer's self-heal report) now drops `hibernated` on a live state or session start, so a CLI resumed outside the desktop's own wake no longer stays Sleeping. | `ResumeOfferTest`; SSH transport test with a real tmux; vitest mirror + agentStatus tests. |
| A43 | `2be5e87` | `BackStack`: per-entry keys for `SaveableStateHolder`, retired keys removed (persisted across process death); Board project and Inbox archive toggle saveable. | `BackStackTest`. |
| A44 | `7988087`, `582bdae`, `46b0897` | `ApiBaseSetting`: system back saves like the arrow; an unedited address is not stored (the built-in default stays a default); leaving by a notification tap or a pairing link saves too; a refused or unusable stored address is flagged in the field. | `SettingsLeaveTest`. |
| A42 | `7debe67` | `NewSessionChoice`: the selection is derived from the current listing; Start is disabled when nothing is offered. | `NewSessionChoiceTest`. |
| A57 | `8dbeb48` | Multi-select questions list their options read-only with "answer in the session". | `QuestionChoicesTest`. |
| A47 | `52df0a3` | The host list asks `SecretStoreCore.contains` (no decrypt, no lock) keyed on a revision flow. | `SecretStoreCoreTest`. |
| A52 | `3780f5a`, `46b0897` | `InboxNotificationText`: no event text in notifications by default ("Show details in notifications" opts in); a public version for lock screens that hide sensitive content. | `InboxNotificationTextTest`. |
| A73 | `e055f37`, `27ee194`, `46b0897` | Live notifications for the watched computer: every successful listing announces, skipping what is on screen (the Inbox tab; the open terminal's node, except a held hook-reply approval, which is not painted). A computer the user left is not announced from pushes. | `LiveNotificationsTest`. |
| A51 | `9b4af70`, `46b0897` | `data_extraction_rules.xml` excludes everything from cloud backup and device transfer; a box key created anew drops the device id so a new one is minted with it. | `PhoneIdentityTest`; device check owed. |
| A77 | `0a2a1aa` | `Modifier.aboveKeyboard`: Scaffold padding, consume, then IME padding, on the terminal, Pair and Settings screens; no `enableEdgeToEdge()`. | Source pins; device check owed. |
| A37 | `ac0923a`, `e0a7883` | Real R8 rules (`-dontwarn` for what jdeps finds missing, keeps for the WebView bridge, name-loaded crypto classes, the worker); release is minified; CI builds `assembleRelease` and checks the named keeps matched. A missing `-dontwarn` fails CI, a missing keep for new reflection does not. | CI job "App release (R8, unsigned)" green on its first run; `R8RulesTest`. |

### WP4 remainder, WP5/WP6 batch A (desktop root causes, protocol-testable items): done on the branch, not device-verified

| Finding | Commit | What changed | Checked by |
|---|---|---|---|
| A13 (desktop) | `b718a04` | The app's own tmux client attaches with `-A` and no `-D` while a relay-served client of the same node is live in this process (found by walking the session table at spawn time: local tmux, sink attached, not over SSH, not the session host). With no phone attached the argv is unchanged. The remote (SSH-project) attach never used `-D`; now pinned by a test. | vitest `pty-relay-coattach.test.ts` (argv, both orders, remote) and `relay-coattach.realtmux.test.ts` (real tmux in the sandbox: `-A -D` kicks a control-mode client with exit 0, `-A` keeps both). Mutation-checked. |
| A72 | `71290de` | A phone-started session (A33's `projectId`/`agentId` on `pty.attach`) now gets the agent-gated hook env (`NODETERM_AGENT_ID`, the approval wait, canvas control by `canControlCanvas`) and a proven pane owner, resolved on the host from the index entry the project id matched. Resolver moved to `host-new-sessions.ts`. | vitest `host-new-sessions.test.ts`, `pty-relay-create.test.ts`, `remote-security.test.ts`. |
| A39 / A75 | `437e359`, `ea19490` | Additive `label`/`email` on the mirror's `settings.claudeAccounts`, written by one shared builder in both shells and the SSH slice. One protocol helper names accounts: settings label, usage label, email, then `Account <first 8>` — never the full UUID; an unlinked config dir shows its last path segment. Used by the picker, the sessions row and the usage card. | Protocol `AccountNamesTest`; vitest mirror test; the interop fixture's settings entry is built by the real desktop builder. |
| A38 | `5ff8f6c` | A ticketed approval is answered while the node is WAITING on a held parent question (the desktop's "gone" still guards an expired hold). The keyed paths keep their exact-state gates. | Protocol QuickActions tests. |
| A56 | `38fa6c4`, `45e21ec` | **Not built, by decision.** A static read of Claude Code 2.1.283 shows option 2 of the permission prompt is conditional: when there is no "don't ask again" row, `2` is "Yes, and switch to auto mode" or "No". A blind `2` can therefore deny or widen permissions. Documented in `docs/android.md` (Known gaps) and `docs/hook-reply-approvals.md`, including that **the iOS "Always allow" has the same hazard** (for @eneskirca). The safe route is a hook-level allow with `updatedPermissions`, which needs a cross-surface design. | Docs only. |
| A58 | `a44f16c`, `144bd40` | Usage pace line ("5h usage pace slower/faster", "on pace" within ±5 points), computed at the usage snapshot's own time, refusing stale or unknown windows; a context ring on approval, question and done cards. | Protocol `UsagePaceTest` (15 cases). |
| A48 | `d383e76` | The seen log is id → time, pruned by age past the 6 h announce window (+18 h margin), claimed and marked under one lock; the old string set migrates as "seen now". | Protocol `SeenLogTest`. |
| A53 | `af587ac`, `ec203db` | OSC 52: the `;` is required, a 16-character selection field at most, 100,000 characters of text (400,000 base64) at most, strict base64 and UTF-8; terminal.js applies the cap before the bridge; a failed or too-large clipboard write shows a toast instead of crashing. | Protocol `Osc52Test`; `TerminalJsOsc52Test` runs the real terminal.js under node. |
| A54 | `32330df`, `ec203db` | `/pair`: a negative, non-numeric or over-64 KiB Content-Length is refused, a length-less body stops at 64 KiB, a 45 s watchdog closes the socket (also on cancellation), and a refusal body is shown as one line of at most 300 characters. | Protocol `PairingClientBoundsTest`; an interop test measures the real answer (606 bytes with the fixture's short token). |
| A49 / A74 | `a40d11b` | The SSH host-key pin is persisted only after public-key auth succeeds. In Auto, a changed host key refuses SSH, shows a warning, and falls through to the relay leg; SSH_ONLY keeps the hard stop. The message points at Settings → "Only through the relay". | SSH transport test (a failed auth does not pin); protocol `SshFallbackTest`. |

### WP4 (medium bugs): done on the branch, not device-verified

| Finding | Commit | What changed | Checked by |
|---|---|---|---|
| A24 | `8e304db` | `SecretStoreCore` (protocol) replaces a stored secret only on positive evidence it is gone (nothing stored, malformed blob, `AEADBadTagException`); anything else is `SecretUnavailableException` and nothing is written. The identity's first write is durable. `SecureStore` generates the Keystore key only when the alias is absent. | `SecretStoreCoreTest` with real AES-GCM. |
| A20 | `d199f03` | `connectLocked` rethrows cancellation on both legs (state back to Idle, no "offline"), and closes an SSH connection that finished dialing after its caller was cancelled. | Type-check + CI build only. |
| A11 / A19 | `de1eded` | `onNewIntent` records the host id (and `setIntent`); a LaunchedEffect opens Hosts → that computer's Inbox. A re-navigated Host screen starts on the Inbox tab (the per-entry state holders of A43 now do what a `key(route)` did here). | Type-check + CI build only. |
| A34 / A36 | `2a273a7` | A34: an armed Ctrl applies to the input bar (`Keys.ctrl`, one control byte, no Enter). A36: a null exit (connection gone) reattaches automatically once the host connection is back — bounded (3 per flapping stretch), only while the screen is showing. | `KeysTest`; the controller is type-checked only. |
| A14 / A15 / A16 | `c58ad65` | A16: the project's `defaultPermissionMode` wins over the global one (both re-validated); its `defaultAccountId` is preselected only while the host still has it. A15: the resume offer is built like the desktop's cold restore (`cd`, `CLAUDE_CONFIG_DIR`, mode; portable `./` cwds resolved). A14: cwd-less projects are no longer offered, and a refused registration shows a notice. | `ModelTest` (4 new cases). |
| A12 | `ab1335c` | New additive desktop verb `node.sendKeys {nodeId, keys}` → `{sent}` via `PtyManager.backgroundWrite` (no throwaway client; short answers only; SSH-project nodes answer `sent:false`). The phone uses it; `sent:false` opens the session; an older desktop gets attach → wait for paint → write → 400 ms linger. | vitest `host-node-actions.test.ts`; relay interop incl. the older-desktop fallback. |
| A31 | `a622e71` | sshj `KEEP_ALIVE` (want-reply, 15 s × 3 misses) instead of `HEARTBEAT`; `run()` has a real deadline that tears the transport down; a command that cannot run drops the connection. HostScreen shows a listing error while connected. | SSH transport test: a hung command returns within its deadline and fires `onClosed`. The keepalive-miss path itself is not exercised. |
| A18 | `10de4b9` | `LifecycleStartEffect` in HostScreen and TerminalScreen: watching and the terminal stream stop on ON_STOP (WebView paused) and resume on ON_START. | Type-check (new stub) + CI build. |
| A21 | `daf15d3` | The switch shows On only when the pref is on AND `areNotificationsEnabled()`; switching on asks for the permission or opens the app's notification settings; the worker does nothing when nothing can be shown; the launch-time ask happens on a fresh start only. | Type-check + CI build only. |
| A22 | `ade7428` | The back stack is `rememberSaveable` (JSON Saver); pairing routes are not restored; routes naming a forgotten computer are dropped; the launch intent applies only on a fresh start. | Type-check + CI build only. |
| A13 | `68d0925` | **Phone side only.** An exit 0 while the session is still listed as live (another client attached with `-D`) reattaches instead of reading "ended". The later A13 host follow-up below fixes the root cause; physical checks remain pending. | Type-check + CI build only. |
| A33 | `0db0b6e` | New optional `pty.attach` fields `projectId`/`accountId`/`agentId` (additive). The desktop resolves the project folder and a local, logged-in managed Claude account itself, applied only when the attach creates the session. The phone sends them for a session it starts. | vitest `remote-security.test.ts` (3 new cases); relay interop through the real handler. |

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

**Phone system-theme compatibility passes (item 51, 2026-10-04).** On the installed beta 10
Pixel, Computers and Settings native screens remain readable under system dark and light modes,
including status/navigation bars; four captured PNGs have a matching visual-review receipt.
The app retains its fixed dark palette in both modes; an automatic light app palette is not claimed.
Original system night mode `yes` is restored and verified. Tablet/foldable is conditional SKIP
because neither is available. Proof: `beta10-system-theme-result.json`,
`beta10-system-theme-restored.json` and `beta10-system-theme-visual-review.json` in the Oct4 checklist
directory. Item 51 passes, giving the current 10 Pass / 22 Partial / 32 Pending ledger.

**Final phone cleanup and background watch remain pending (2026-10-04).** The intended Pixel's
wireless ADB endpoint is no longer reachable; its current endpoint has been requested. The guard
refused before the final phone Forget and portrait-lock restoration, so neither action is claimed.
Earlier rotation restoration belongs to the first test round; current final restoration is pending.
The isolated empty SSH service is stopped. Phone name/API and system night mode `yes` restoration
are verified. No natural-periodic background Done watch has started and no result is claimed.
The remaining phone cleanup and notification checks can continue when the correct Pixel returns.

### What is still open

**A137 follow-up:** source `b9e4cbc7`, fresh1069/116/offline app and exact-head CI five/ten pass;
retained-signer beta23/code24 is prepared and reviewed. Installation remains unverified after the
pre-install snapshot refusal, with no update dispatch. Once the intended Pixel route is admitted,
perform the guarded update and measure one fresh pending-Send cover/Back case with unique native
execution. The source gap does not establish physical duplication or automatic retry.

**A136 follow-up:** publication, beta22/code23 update and one no-Send remount comparison pass.
Owned cleanup is verified with the uncertain timeout result preserved and 15000 read back. Verify
selection/IME, activity recreation and pending-Send separately; process-death restoration is unsupported.

**A135 follow-up:** source publication and beta22 installation pass; measure raw-input rearm and pending-Send Ctrl
on the phone. JVM policy/source pins do not establish real Handler scheduling.

**Silent SSH peer pilot:** automatic recovery, retained draft text/glyphs and one explicit
Send/application ACK pass through one old-peer pause on shared loopback. Whole-host/network loss,
cursor position and native-route lost replies remain unverified. Separate fresh retained- and
lost-receipt cases pass the newer-draft/disabled-Send boundary, with automatic original-shell
recovery after loss and a unique application ACK/witness over 120 seconds later. Network blackhole,
whole-host loss and remount/Ctrl during pending Send remain next steps. The initial image-preview rendering
interpretation is withdrawn after raw-pixel comparison. See [the bounded case](android.md#silent-ssh-peer-recovery-and-single-send-2026-10-08).

**Login-shell probe (`A134`):** the source fix, caller controls, exact-revision gates/CI and one
fresh original session-host create/visible Bash prompt are verified. A separate fresh consumer
case now passes production native capture retention and ordinary renderer reload/input with the
original daemon/Bash/producer/socket and untouched sibling. Next cover A129/A130 on the phone
through their supported native route, silent network loss and native-route held/lost-reply races; canvas history
gestures, full rendered payload equality, the V13 child cause and whether fallback fired remain
unverified. Preserve the installed beta21 artifact.

**Viewer queue follow-up (`A131`):** source is fixed/published in `11fbff08`. Current
`ef4caec2` passes forced 1033/110/app/TypeScript and all-five/ten-step CI; retained-signer beta
21/code 22 is installed. Its bounded 1200-row/40-ms output case continues during backgrounding
and reaches the resumed phone with the confirmed completion marker. Wider lifecycle checks remain
unverified. [A132](android-audit-2026-09.md#a132)'s original Fedora completion loss remains open;
the clean native 2-ms controls, fresh normal-Fedora 40-ms discriminator and later direct-SSH
case do not locate its cause. The normal-Fedora result records all rows and the standalone marker,
with exact owned cleanup; it has no historical prompt parity or final-write/wait-status witness.
[A133](android-audit-2026-09.md#a133) is source-fixed/published at `ef4caec2` after native raw exit
discrimination. Final forced 1033/110/app/TypeScript and CI five/ten pass; beta 21/code 22 is
installed. Its bounded same-page retention, exact final-marker/Unicode clipboard paste and
post-font OSC8/plain link offers pass. The later normal browser/Share pilot records the exact
address-field nonce and selected chooser preview; browser Back remains unverified and ordinary
resume succeeds, while chooser Back returns to the owned terminal. Wider TUI/lifecycle checks remain
unverified. Do not
repeat a successful installation.
The user removed the Pixel 7a's screen lock and authorized ongoing tests; wake it normally without
repeating unlock questions. Already-dispatched WebView commands remain outside the queue fix.
A129/A130 need trusted HTTPS/WSS and real native/session-host relay; direct SSH cannot prove that
overlay. Separate V8/V9 native Desktop pilots stop at empty capture before producer input.
V8's eight-second gate is shorter than supported cold-create budgets. V9's 30-second gate still
has 280 empty captures; two complete ten-thread snapshots observe different empty daemon
generations, not proven original creation or attachment. The earlier passive V13 observation
reaches only the original PATH wait; after the A134 fix, fresh V14 observes its original create
fulfill and Bash prompt without input. Native history/phone acceptance and the V13 child cause
stay unverified. [Scoped receipts](android.md#fresh-fedora-output-and-native-desktop-readiness-2026-10-08)
retain both negatives and exact owned cleanup without product attribution or A129/A130 acceptance.
Controlled direct-SSH recovery, two active Home/resume cycles and explicit Send now pass as
[separately scoped](android.md#direct-ssh-reconnect-and-active-background-continuity-2026-10-08).
Native-route held replies, pending-Send remount/Ctrl races, silent network outages and wider
lifecycle/notification cases remain.

**Earlier beta-19 publication; current remaining `A129`/`A130` acceptance:** Signed `5bda2c32` is
published with fresh forced 1015/106 protocol, offline app/full TypeScript and all-five/ten-step
Android CI `37608652625`. Retained-signer beta 19/code 20 is installed with actual SDK-36
verification; SDK 37 is absent. The 6.18-second in-place update preserves first-install time and
notification grant/flags. Public SSH identity continuity and one fresh explicit-profile
authentication/first pin pass through an owned ADB reverse tunnel. Bounded known-tmux Send,
brief background draft retention, viewer/SSH-handler recovery and exact owned cleanup pass;
saved-profile/pin reuse and manual changed-key refusal now pass. A129 native/session-host history,
A130 held Live touch, physical ConPTY and wider lifecycle/notification acceptance remain pending. Preserve the immutable-view/new-intent
mode/ownership contract and known-tmux/direct-SSH gesture route. Coordinate additive page and
invalidation adoption with iOS @eneskirca. See the [current bounded receipts](android.md#beta-19-publication-provider-and-emulator-checkpoint-2026-10-07).

Normal existing Claude authorization passes both direct and sibling tool-free inference. At
`41406fef`, one original rule passes real Claude/Desktop application; the later `e06b5547` case
also verifies beta 19's original remembered-rule and single/multi question choices against real
CLI application. Rule persistence after CLI restart and production-pane-child launch remain pending. See the [application receipt](android.md#beta-19-publication-provider-and-emulator-checkpoint-2026-10-07). The disposable
API-30 emulator's one provisioning reboot and one scoped reconnect fail to restore live ADB;
console/framebuffer/debugger diagnostics add no app/CA/APK proof. Its exact owned cleanup passes.
Do not restart the stopped fixture or treat those observations as A129 acceptance. The original
10/22/32 ledger, regular Desktop deployment and no-PR status remain unchanged.

**Backend Send follow-up:** The current source adds negotiated session-host and direct native
Windows Send; physical ConPTY and phone acceptance remain pending. See the
[2026-10-07 checkpoint](android.md#composed-send-backend-follow-up-2026-10-07-a128).

**Earlier beta-17 acceptance checkpoint:** At that earlier checkpoint, beta 17/code 18 from `a79375c3` was installed; merged forced 982/102 protocol and app
and affected Desktop gates pass, and exact-head Android run `37523703627` has all five jobs/ten
critical steps green. A127's neutral viewer-close/manual-Reattach case and A128's emacs
copy-mode Send are physically verified on the intended Pixel 7a. The controlled vi transport
recovery/Send and single raw Ctrl+C cases pass too; actual managed creation, exact owned SSH End
and final profile/key/host cleanup pass, with the frozen report bound to 303 raw hashes/nine
bounded cases. Next device acceptance needs changed-host-key enforcement, deterministic
held-receipt draft edit/rearm/stale-completion and uncertain-ack cases, other control combinations
and broader lifecycle/Compose/WebView/provider flows where admitted. These existing gaps remain
separate from the completed bounded cases. The [beta-17 checkpoint](android.md#pixel-7a-beta-17-upgrade-and-composed-send-2026-10-06)
records the same-signer saved-profile update and bounded repaired-device cases; earlier beta-16
Start→Back/Home, process restart, custom dragging/momentum, reconnect, Find and exact-owned
SSH End evidence remains historical. Neither set completes the original checklist. Future
publication changes require their own mandatory gates and all five exact-head Android jobs.
No PR is opened.

A125 is source-fixed in `415dae9b`; A126 is committed in `5b7286b3`.
The controlled eight-case Linux Desktop reconnect matrix now verifies actual Canvas mounting and
selected-view native keyboard recovery, with retained remote identity/full same-grid history,
zero unexpected input, complete URL activations and exact owned cleanup. 294 affected tests,
full incremental TypeScript, 15 assertion-caught mutants and forced950/98/app compilation pass
on `5b7286b3`. Before any later publication HEAD, rerun the mandatory offline gates; after push,
verify all five Android jobs on that exact HEAD and retain the private CI receipt/final report.

One later two-host soft/none case at `59e4c93e` adds quiet park/adopt and inactive global-card
reconnect acceptance while active A remains unchanged; see [the bounded two-host follow-up](android.md#inactive-global-card-owner-and-bounded-parkadopt-2026-10-06). Next release acceptance needs the
intended phone for the remaining lifecycle/outage, answer/notification/permission and live-provider
checks, and hosted-backend maintainers for A25/A93. Additional host coverage includes streaming/
expiry/eviction while parked, repeated/broader outage/backoff, foreign-host attachment,
Server/cross-window responder ownership, GPU/full-frame display and macOS/Windows. Earlier
`11e22453` stale-Modal, unequal-grid refusals and `415dae9b` unclassified exits/18-byte DA failure
retain their own provenance. The paused phone ledger is not promoted by this native matrix.

Resume the [64-item device checklist](android.md#device-checklist) on the intended available phone
and record Pass/Fail/conditional Skip with model, Android/WebView version, Desktop revision and
route; turn each product failure into a finding. Prioritize lifecycle/reconnect, held answers,
notification permissions/actions and cellular routing. Live-provider checks additionally need
usable provider authorization; the earlier HTTP 401 is not acceptance. A fresh Pixel 7a does not
prove the original phone's same-signer update or key/pin survival. These physical and backend
obligations remain distinct from optional wider host/platform/stress coverage.

The A86 native regression verifies custom copy-mode gains, chunked distance and reversals in
two tmux key modes. The later Pixel 7a follow-up adds physical held-drag checks with custom
`-N7` bindings in both modes and bounded momentum/touch-stop sampling. FPS, the wider reversal/
gesture/lifecycle matrix and other platforms remain open. Recheck the phone connection and
focus before the next device action; the original phone's pause remains in effect.

A124 now passes a physical managed plain-shell creation/registration/input/reopen/app-restart
case on the separate Pixel 7a and frozen Desktop `40731381`. Retained-history Find and clipboard
checks pass too, and both owned QA profiles/hosts are cleaned up. Remaining background/lifecycle,
outage, answer/notification/permission and live-provider checks still need their own device
matrix. The original Pixel 10 Pro beta-10 checklist remains paused and unchanged.

A92/A121 now pass eight native Linux Desktop UI cases at `01b4a2f5` and eight genuine Linux
Server UI cases at `dcdf664a`, with both native mutants caught on each shell. This local
follow-up is finished. Later historical `972f7994` / built `01b4a2f5` runs also pass the
GPU-enabled eight-case matrix (four hardware Canvas WebGL2, four intentional DOM Modal), native
File-menu Quit, outside-terminal Ctrl+Q and one real tmux Canvas pilot. A122 fixes focused-terminal
native Quit in `9613cec5`; all four Linux native focused cases pass.
Later checks pass all eight tmux and eight actual SSH-project cases, plus separate single-context
GPU loss/restore controls and A123 retirement verification. A genuine Server retirement pilot at
`fa259f6e`, derived Desktop compositor cell comparison at `db83fb7d` and a single Desktop SSH reconnect
pilot also pass. Repeated/page-wide
GPU pressure, full-frame compositor/display output, reconnect scenarios beyond the controlled eight-case
matrix and bounded two-host global-card follow-up above, and macOS/Windows remain unverified.
A120 also passes native timing
and synthetic
installed-Fedora-PAM checks; real-user policy and Android setup/lifecycle remain pending.

Current source closes the launch/policy/offscreen-wake/history/held-answer/SSH-Git gaps,
and adds explicit SSH profile selection and confirmed one-time password enrollment (A119/A120);
A108 adds owned SSH Board and Desktop node nudges. The original phone checklist remains paused; the separate Pixel 7a results above cover only the named checks. The branch prepares the upstream Android contribution;
no PR has been opened. A25/A93 are maintainer backend dependencies with no source supplied.
A68 is source-fixed for readiness: main-only push, retained PR checks, no merge-group trigger,
and all-five-job opt-in manual beta preparation.
A111 implements host-owned managed New over SSH on current enabled local Linux/macOS tmux hosts;
Windows/non-tmux and third-machine creation remain unsupported. The A13 host follow-up also preserves direct-SSH viewers; eight Linux native checks pass, while physical SSH/phone and other-platform runtime checks remain unverified.

The user resumed broader Pixel release checks on 2026-10-04 after the hike. Beta 10 / code 11 is
installed with A90/A91 and A94's authoritative-empty completion fix. Item 1 paired-update passes;
A93 fresh-different-desktop refusal is open; A95 is fixed in `ec12ea9a` with actual phone-to-rebuilt
production desktop verification, completing item 36. Phone checks resumed after the earlier
other-app focus pause, then the user paused them explicitly. Final rotation restoration, phone cleanup
and the beta-11 search/live-refresh/Include checks wait until phone testing resumes.
A91/A94 full installed End/recreate/open/End
empty-screen flow passes, preserving the connected SSH route and error.
Focused A90 proof keeps item 32 Partial, giving 10 Pass / 22 Partial / 32 Pending. The otherwise-empty SSH host's last-shell End/empty-list/New-terminal
variant passes on beta 9 Oct4; relay plain-shell creation/input passes, while managed and cellular creation remain pending. Phone checks are paused; the ledger stays unchanged.

Continue the remaining Pixel 7a device matrix in fresh isolated Desktop/Server fixtures with
A124: background/lifecycle and outage recovery, held answers and notification/permission paths,
then provider-authenticated agent creation. The single managed plain-shell case is verified.
A same-signer beta-16 update and saved pairing/key/pin survival still need the original Pixel 10 Pro;
the fresh Pixel 7a installation supplies no update/migration proof. The
prepared APK includes A118–A120's Android changes. Keep the held older paired
fixture and its original terminal intact. Test A100–A120 and earlier A96–A99 on the intended Pixel;
source/build results do not promote physical checklist items.

**Next work when phone testing resumes:** continue the remaining lifecycle/outage, answer/notification/permission and live-provider matrix; the A124 single plain-shell case passes. **Original checklist work, in order** (item lists were written for this session's workflows; re-read each audit
section before starting, since the verifier corrections take precedence):

1. **Finish the remaining relay/session, notification and inset checks.**
   Commit `ec12ea9a` fixes core routing and actual Desktop preload delivery; nine suites/133 tests,
   full TypeScript checking, strict acceptance-test checking and four mutants pass. The same
   owned profile now runs the rebuilt production desktop; actual phone move/remove/re-add/create-label
   changes reach its mounted Board with matching persisted state and unchanged page time origin,
   completing item 36. Wake, Refresh repaint and the remaining matrix need their own evidence; exact owned phone End passes.
   A91/A94 beta 10 End/recreate/open/End completed-empty flow passes; continue the remaining
   managed creation, remaining relay routes, Board persistence and notification matrix. A91 first Home/exact last-End/empty-list/New-terminal
   passes on beta 9; the second Home shell survives the code10→11 update. Original complete-profile
   restart/re-pair restores relay credentials, and saved relay reconnect/input after updating
   passes item 1. A93 remains open for a fresh different desktop; iOS recovery needs verification
   for @eneskirca without resetting identities or transplanting credentials. Debug migration stays
   conditional SKIP. Beta 10 is installed on the intended Pixel; earlier betas verify manual SSH authentication, project listing,
   input, font/keyboard resizing and pre-attach tmux history. Historical code-7 proof reopens SSH with the retained
   key/pin and verifies continuous drag/coast/Esc. The user confirms final beta-6/code-7 cellular
   WireGuard connection and smooth scrolling with Wi-Fi off on regular manual SSH.
   Then repeat the verified A90 flow over cellular when authorized, using Sessions → New terminal → Home/project/custom absolute folder → Create:
   real cwd/input/history, disconnect/app-restart rediscovery and End of only the owned session,
   with existing desktop sessions/files/canvas unchanged (item 32). These are independent shells,
   without managed-agent/canvas registration. Check needed answers, actual airplane/outage recovery and relay/
   notification behavior. Ten complete items now pass (1/18/19/21/22/24/36/38/39/51); the 64-row table records
   remaining Partial/Pending items and conditional SKIP variants. Turn every actual failure into a
   finding. Paste pairing/hosted relay browse/input and synthetic shipped-hook approval lifecycle
   now work; mounted relay questions add partial proof. QR/cellular-relay/SAS/remaining question
   variants and the full checklist remain open. Future
   private betas retain the same signer and increase the version code above the installed beta.
2. **Finish remaining scroll matrix (`A86`, `A89`).** Code 7's historical SSH reopening with
   retained key/pin, continuous dragging, coast and Esc pass
   on the intended Pixel, and the user confirms normal drag/coast both work. Real SSH background/
   detach recovery and final cellular WireGuard SSH connection and smooth scrolling are also verified; finish reversal
   and remaining lifecycle checks.
   The dimension-stable 56×25 held-touch check also passes;
   earlier keyboard-resizing touch checks were inconclusive. Beta 5
   stopped mid-swipe; `c4b1f6cf` targets the stable screen and its bundle regression covers real
   span removal versus continued drag/release. Historical beta-6 protocol/type-check checks pass, with
   35 JS, eleven native and three CSS mutations caught; custom wheel bindings/FPS remain open.
   `A88` now reproduces and fixes
   SDK 37's actual scheme label, with 39 real-tool tests per SDK 36/37 and ten new mutations.
   CI4 still failed private packaging; follow-up [run `37061593216`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37061593216)
   at `c37798b6495b4b68df379d0ae80887c23104b66d` completed with all five jobs green, confirming
   observed CI repair. Each subsequent push still needs its own green workflow.
   Push is authorized: run required checks before each push and confirm Android CI afterward.
3. **Verify the new source flows and remaining known gaps.** Batch D/E and A103/A104 source
   changes are done. Remaining physical/live cases include relay cellular/SAS-denial/revoke,
   offscreen Sleeping wake and non-Claude permission policy. Verify retained history, structured
   hook answers, SSH Git, the selected-profile Board/node service and A111 managed SSH New too. Read-ack ownership is
   locally fixed in `A82`; finish its device verification.
   For iOS adoption, @eneskirca should read `relayApproved` and `sshHostKeyFingerprints` in the sealed
   `/pair` answer and `lan` beside `projects.list` output; iOS also needs to send `boxPublicKey`
   there for late-adoption approval and the revoke cut, and should key notification seen state
   by computer. Adopt the new held rule/question fields, verbs and v2 SSH marker together;
   `docs/hook-reply-approvals.md` lists the exact iOS changes.
4. **`A68` source readiness.** Android uses `push: branches: [main]` plus the retained
   `pull_request` path filters, with no `merge_group` (see the verifier). Branch pushes no longer
   trigger duplicate Android runs or beta preparation. Available manual runs with
   `prepare_beta=true` run all five jobs on the selected ref. Keep exact-head green CI before
   declaring the branch ready; PR creation remains separate from this checkpoint. A CI release
   path requires APK/R8/provenance from the same successful run.

**Known gaps and caveats:**

- **A13 coattachment is source-fixed in `ed2965be`.** Current hosts preserve external SSH/relay clients and selectively retire only verified same-profile app painters. Real tmux control-client checks and eight Linux native checks pass; physical SSH/phone and macOS/Windows runtime checks remain pending. Android retains exit-zero reattach for older hosts.
- **A56/A57 are source-fixed through v2 request-owned hook replies (A105/A106).** Bounded
  phone/real-CLI rule and question cases pass; restart persistence/wider scope remain open. Legacy unheld multi-select
  still opens the session. iOS adoption is owed to @eneskirca; see `hook-reply-approvals.md`.
- **A49 / A74 residuals.** Phones paired before batch E have no anchors and stay on
  trust-on-first-use until they pair again or get a relay listing. Recursive Includes are source-fixed in A99. A relative `HostKey` path remains unread, so SSH is refused for
  it (Auto falls back to the relay). A116 adds a Desktop network selector shared by the QR and
  authenticated relay address refresh; an unavailable chosen adapter never silently falls back.
  Actual multiadapter/VPN checks remain pending. A phone that only uses "Only on my network"
  never gets a relay address refresh.
- **A72 follow-up is source-fixed (A102/A103).** Trusted project env/shell is prepared before
  cold relay input; saved owner/account/agent wins. Per-agent launch/resume/wake policy uses actual
  host capabilities. Physical/live agent policy combinations remain open.
- **Quick-answer false-success hazards found during batch E.** Local desktop input previously
  used a prefix-matching target and did not cancel copy mode; direct-SSH phone input targeted
  exactly but did not cancel copy mode. Those continuation hazards are locally fixed in `A78`
  and `A79`: both paths pin the resolved pane ID and cancel copy mode before sending, desktop
  deliveries are ordered per node, and an unconfirmed operation never reports success. Full
  protocol/type-check checks pass; phone verification of those quick-answer cases remains open.
- **A33 on an older desktop.** An older desktop ignores the new attach fields, so a Windows host
  still starts phone sessions in the home folder until it is updated.
- **A07 for older pairings.** A device paired without a recorded `relayBoxKey` (before A07, or
  any phone that does not send `boxPublicKey`, which includes current iOS builds) has nothing to
  unpin or cut on revoke and is not approved on a late adoption. A113 now reports that relay
  revocation is unconfirmed, rather than promising remote access is gone. A118 now repairs an
  eligible association through approved relay plus exact retained SSH proof. It cannot recover
  missing SSH seeds/attribution or bypass first SAS approval; those cases still need re-pairing.
- **Remaining parity.** Current typed SSH Git and the A108 selected-profile service support
  Board writes and Desktop delivery-only node nudges without relay. Git works on admitted
  local/driven folders independently of the service; Server advertises Board and, with an
  enabled local POSIX tmux backend, managed New. Renderer node nudges remain Desktop-only. A manual
  SSH host has no relay fallback when a service capability is missing. The service admits only
  selected-profile ownership, including Desktop's own SSH-project metadata, never another
  desktop's driven projects. Managed canvas New is implemented in A111 for a current local
  POSIX tmux profile; Windows/non-tmux and another desktop's driven projects remain unsupported.
  Phone-owned plain SSH New remains separate, with historical focused Pixel proof.
  No immediate FCM or Live-Activity equivalent (A25); A93 needs the hosted relay maintainers.
  All-computers lifecycle/notifications and new source flows need physical verification. A114 adds
  a searchable dictation language picker; native language/model checks remain pending. SSH setup
  has controlled native OpenSSH enrollment/key-login evidence; Android UX, ordinary PAM accounts and macOS remain unverified. It
  offers public-key Copy/Share and an idempotent authorized_keys install command (A27). A120 adds optional one-time password setup after explicit host fingerprint comparison, with fresh
  retained-key verification before saving. Keyboard-interactive/MFA and the separate Server installer
  remain unsupported.
- **Desktop file-link follow-up (`A92`) is fixed in `127b6b28`.** `paragraphContaining` now reserves
  the hovered row within the 32-row window. Focused/affected Vitest suites, full TypeScript check
  and three isolated mutants pass; eight native Linux Desktop cases now pass at `01b4a2f5`
  with A121's leave fix. Separate eight-case Linux Server checks pass at `dcdf664a`;
  The later GPU-enabled eight-case matrix passes (Canvas4 hardware / Modal4 DOM). Separate
  single-terminal Desktop and genuine Server GPU recovery/retirement pilots now pass; broader GPU
  pressure and macOS/Windows remain unverified.
  Android already fixed this in `A32`; the held older paired fixture and shared `out/` remain
  unchanged. The four fresh `01b4a2f5` builds are separate disposable verification fixtures.
- **A10/A50 trade-off.** The debug key is public by the user's decision. The private-beta packager
  rejects it; a private signer is supplied locally and must be retained for updates. Moving from
  debug to private beta requires a deliberate uninstall/re-pair once. The first retained private
  key is retained in ignored local state; the first actual private beta is built, signed and
  updated on the intended Pixel with manual SSH registration/key/pin and notification grant
  preserved. The full phone pass remains open; the wrong-MI8 test install was removed.
- **Host record retirement is source-fixed (A115).** Replacement retires route/approval/creation preferences and tokens. Session admission and local record publication share a barrier; stale dials and callbacks cannot overwrite a new pairing. Physical replacement/background checks remain pending.
- **Earlier restricted-sandbox limits:** server-e2e and native-module vitest suites could not run there (`npm ci
  --ignore-scripts` skips the native builds, and there is no `ssh` client); the same 14 tests and 31
  files fail identically on the pre-session commit. Desktop CI does not run on branch pushes here,
  so those earlier desktop changes were checked by targeted vitest files + `npm run typecheck` only.
  Restored-host full desktop checks now pass; see the newest progress entry.

### WP2 (blockers with decisions): done on the branch, not device-verified

| Finding | Commit | What changed | Checked by |
|---|---|---|---|
| A05 / A17 / A23 / A30 | `3d36d60` | `RelayApprovalGate` (protocol): the background worker dials the relay only for a computer where a relay connect has succeeded (persisted `relayApproved.<id>`), and then with `requireApproved`, so a revoked pin gives up instead of waiting and clears the flag. A refused (Deny) or unanswered approval holds automatic dials until the user taps Try again / Refresh or opens the computer. `RelayConnector` reports typed `RelayApprovalRefused/Timeout/RequiredException`. | `RelayApprovalGateTest`; relay interop through the desktop's real host session: Deny reads as a refusal (fixture gained a reject mode), and a `requireApproved` dial fails fast without showing a code. |
| A07 | `0fa0646` | Option (b), additive. The phone sends its box key inside the SEALED `/pair` body; the desktop pins it (same `updateApprovedDevices`/`pinDevice` a SAS approval writes) when the relay leg was minted, answers `relayPinned: true`, records `relayBoxKey` on the device, and unpins it on revoke unless another pairing of the same phone remains. A plaintext body never pins. PairScreen says "Remote access is on" and tells the user after pairing whether one approval is still owed. | vitest `pairing-service.test.ts` (5 new cases); pairing interop through the real `createPairingService`. |
| A08 | `1cdd2f0` | Chose "refuse and route to the relay". SSH attach runs `attach-session` after a `has-session` check (exit 3), never `new-session`; a session that is not running raises `NeedsRelayException`, and the terminal offers "Open through the relay" (`HostSession.viaRelay`, a relay connection held next to the SSH one), where the desktop creates it with its hook env. | SSH transport tests: nothing is created by the transport or by the script itself. |
| A09 / A28 | `726271a` (desktop), `1cdd2f0` (phone) | **Desktop:** the relay `pty.attach` of an SSH-project node now attaches over that project's ControlMaster (`requireRemote`, host-side freshness and snapshot) or refuses with the host's name — never locally. **Phone:** over direct SSH, attach/keys/approvals/kill for those nodes raise `NeedsRelayException` and read-acks are skipped; the terminal, the Inbox and End session retry through the relay. | vitest `remote-security.test.ts` (4 new cases); SSH transport test for the refusals. |

The original A07 follow-ups (`adoptRelayIfAdvertised` and the live-session revoke cut) landed in batch E: late relay adoption approves a recorded box key,
and revoking a paired phone cuts its open relay session. Older pairings without a recorded key
still need foreground SAS approval. iOS can adopt `boxPublicKey`/`relayPinned` unchanged.

### WP1 (blockers): done on the branch, not device-verified

| Finding | Commit | What changed | Checked by |
|---|---|---|---|
| A01 / A04 | `af1f820` | `SshStream` owns one single-thread writer for write/resize/scroll; a non-IO exception out of sshj's write path tears the transport down and fires `onClosed` instead of being swallowed. `SshHostConnection.close()` and `HostSession.disconnect()` never touch the socket on the caller's thread, and a failed `SSH_MSG_DISCONNECT` still closes the socket. | `SshTransportTest`: a socket factory that throws when used from a thread marked "main" (a JVM stand-in for StrictMode) drives resize/write/close from that thread; a poisoned transport must surface as `onClosed`. Mutation-checked. |
| A02 | `e7c22eb` | Prelude probes `…/node-terminal` first, `…/nodeterm` as a legacy fallback. A listing with no userData dir is now an explicit error, not an empty computer. `scripts/uninstall.sh` + `docs/uninstall.md` remove `node-terminal` (and legacy `nodeterm`) data, caches, logs and either Keychain spelling. | Fixture uses the real name; new `SshScriptsTest` runs the prelude under `/bin/sh` on Linux, macOS, XDG, legacy and both-present HOMEs. |
| A03 | `cd69a1e` | Attach script exports a UTF-8 LANG by the desktop's `resolveLocaleLang` rule (`en_US.UTF-8` on macOS, `C.UTF-8` elsewhere) and passes `-u`. | Harness no longer leaks the JVM's LANG; `╭é` from ASCII input must arrive intact. Mutation-checked. |
| A06 / A35 | `16706f4` | Desktop writers check `<pendingId>.json` before writing (`fs.access`; `[ -f … ] \|\| exit 3` in the same SSH command) and return `sent \| gone \| failed`; only `sent` emits the synthetic answered event. `approvals.answer` adds `reason` (additive). Phone: `ApprovalOutcome.GONE`; if the node is still blocked, `QuickActions` returns `EXPIRED`, which opens the session with an explanation. | vitest (pending-approvals, ssh-project incl. the remote command under a real `/bin/sh`, host inbox verbs); SSH transport test; relay interop through the desktop's real verb. |
| A10 | `fcda932` | `android/app/debug.keystore` committed and wired as the debug signing config. **Departs from the verifier's advice** (it warned that a public key lets anyone sign an update that inherits the app's data); the user chose it for sideloading. The trade-off is written in `build.gradle.kts` and both READMEs. | CI build (AGP cannot run in the sandbox). |

The iOS-facing part of A06: `approvals.answer` now replies `{answered:false, reason:"gone"|"failed"}`
when it did not deliver. iOS can adopt `reason` unchanged; an older phone keeps reading `answered`.

## Where things are

| | |
|---|---|
| Repo / branch | `CPlusPlus17/nodeterm`, branch `claude/android-ios-parity-75kfem` (pushed) |
| Commits | `a0c07e6` protocol module + the two desktop relay verbs; `2f58918` the Compose app, docs, CI, desktop copy; `2dd539f` this handover; then every fix and feature in the progress log, newest first (`git log` on the branch) |
| PR | none (do not open one unless asked) |
| CI | `.github/workflows/android.yml`: **Protocol**, **App** (`assembleDebug`), **App release** (R8, unsigned), **CodeQL (Kotlin)** and **Private beta checks**. Android-relevant `main` pushes and pull requests retain their filters; takeover-branch pushes do not trigger Android. Use `workflow_dispatch` with `prepare_beta=true` on the exact published HEAD for all-five-job feature-branch verification and CI beta inputs. Each requested push still requires green exact-head Android verification. |

What is in the tree:

- `android/protocol` is pure Kotlin/JVM with no Android dependency. It holds the NaCl port, the relay
  client, the host RPC, pairing, direct SSH over sshj, the parsers, and the pure rules the app's
  screens use (most app logic lives here so it can be tested). The remote branch had 589 tests
  before these continuation additions; full forced offline checks at `2a6e005b` pass **982 methods /
  102 suites**, with zero failures, errors or skips. Its JVM tests
  include desktop interop and SSH harnesses. The
  interop tests run the desktop's own `connectHostSession` / `createPairingService` through
  `android/protocol/src/test/interop/host-fixture.ts`; the SSH tests use Apache MINA sshd with a
  sandboxed tmux.
- `android/app` is the Compose app: pairing, hosts, the Sessions/Board/Inbox/Usage tabs, the
  terminal (xterm.js in a WebView), settings, and WorkManager notifications.
- `android/tools/typecheck` is an offline Kotlin type-check of the app for sandboxes without Google
  Maven. See its README for what it can and cannot catch.
- Desktop side:
  - `src/main/remote/host-service.ts` gained the relay verbs **`approvals.answer`** and
    **`inbox.ack`**, tested in `src/main/remote/host-inbox-verbs.test.ts`.
  - `src/main/index.ts` extracted `answerPermission` and wired `hostBridge.inbox`.
  - Later additive changes the phone uses: `node.sendKeys` (`A12`, SSH-project nodes over their
    ControlMaster since batch E), the `projectId`/`accountId`/`agentId` fields on `pty.attach`
    (`A33`/`A72`), `relayPinned`, `relayApproved` and `sshHostKeyFingerprints` in the sealed `/pair`
    answer (`A07`, `A49`), `lan` beside the `projects.list` output (`A74`), additive account
    `label`/`email` in the mirror (`A39`), the `-D`-free attach while a relay phone is attached
    (`A13`), the hibernated self-heal in the mirror (`A76`), and the revoke cut (`A07`).
  - The renderer copy now names both phone apps (`PhonePairPopover.tsx`, `PhoneSection.tsx`,
    `lib/links.ts`).
  - CLAUDE.md gained an Android paragraph under Conventions → three surfaces, and CONTRIBUTING.md
    and README.md gained notes.

**A111 — managed New over direct SSH (2026-10-04).** The host creates a genuine local tmux
pane through normal PTY preparation, registers canonical project/local execution facts, and
submits its own planned agent command once. Request UUIDs and public attachment receipts persist
on the phone before dispatch and until an actual SSH viewer is confirmed. The private host phase
journal has file/directory sync barriers; after uncertainty/restart it permits inspection, never
blind replay. The shared recovery marker contains only an inert notice, not an expanded command.
Managed canvas End still needs the relay; closing an SSH viewer leaves it running.
System account selection stays explicit; removed/pending/remote accounts and changed folders are
refused at spawn. Current runtime, kernel process birth and selected-profile service identity are
required for the first attach. Non-tmux/Windows and third-machine creation remain unsupported.
Actual isolated native-PTY/tmux creation with a fixture agent passes; live CLI and Pixel checks
remain open. Companion interop, mutation checks and beta-13 local release gates pass. iOS adoption
of the new advertised action and receipt is owed to @eneskirca.

## What is verified, and what is not

A137's source fix keeps exact attempt/notice identities through retained-entry remount while
preserving original positive-clearing fences. Local66/9, full1069/116, offline app and thirteen
intended mutants pass. Published source `b9e4cbc7` also passes fresh1069/116/offline app and CI five/ten;
retained-signer beta23/code24 passes its 46 available artifact checks. Installation and the controlled
phone case remain unverified: the pre-install snapshot refused before any update dispatch. Beta22 is
last verified installed; A136's no-Send pass provides no pending-Send credit.
See [canonical scope](android.md#pending-send-outcome-after-remount-2026-10-08-a137).

A136 original-beta loss stays historical. Source/policy/mutation and beta22 installation pass;
one fresh no-Send PairHost/Back retains the exact draft/checked Ctrl. Original native controls
stay equal except the qualified phone-client reattach. Owned cleanup and read-only 15000 timeout
reconciliation pass; cursor/IME, activity recreation and pending-Send remain unverified. See
[canonical evidence](android.md#retained-terminal-editor-2026-10-08-a136).

A135 source/policy/mutation, exact source gates/CI and beta22 installation pass; physical
raw-input timing remains pending. See
[canonical evidence](android.md#captured-ctrl-consumption-2026-10-08-a135).

Verified:

- Fresh beta21/direct-SSH lost successful Enter receipt: exact newer draft and disabled Send
  before loss, retained draft through automatic original-shell recovery, one original-TTY
  witness/ACK still unique over 120 seconds later and owned cleanup. Android internal status,
  blackhole, whole-host loss and native-route loss remain separate; see
  [the measured receipt loss](android.md#lost-send-reply-and-newer-draft-2026-10-08).

- Fresh beta21/direct-SSH successful-receipt hold: exact newer draft and disabled Send before
  release, the same draft retained/enabled afterward, one original-TTY witness/ACK still unique
  168.735781 seconds later, unchanged original terminal/guard and owned cleanup. At that checkpoint,
  lost reply, blackhole, remount/Ctrl and native TLS/history were unverified; see
  [the measured receipt hold](android.md#held-send-reply-and-newer-draft-2026-10-08).

- `A131` final focused control/restored passes 71 methods/8 suites, zero failures/errors/skips:
  11 new behavioral queue/page methods, three app source pins and existing lifecycle/input tests.
  Ten unchanged queue/page behavioral mutants and four final app source-pin mutants fail assertions.
  Fresh full publication and beta-20 installation pass; bounded background/output checks are partial
  with A132/A133 open. No physical queue race is claimed. See [the scoped checkpoint](android.md#viewer-output-lifetime-source-checks-2026-10-07-a131).

- Exact merged `a79375c3` executes full forced 982/102 with zero failures/errors/skips plus app
  Kotlin, affected 187/11 and full TypeScript; Android run `37523703627` has all five jobs/ten critical
  steps green. Retained-signer beta 17/code18 is installed on the Pixel 7a, preserving the single
  saved temporary SSH profile/first-install time without pin edit/key readmission. Bounded emacs
  composed-Send, vi transport recovery, raw Ctrl and A127 viewer-close/manual-Reattach pass;
  actual managed creation, exact owned End and cleanup/report pass too. The wider physical matrix
  remains pending; the original Pixel 10 Pro 10/22/32 ledger is unchanged.

- `A91` clears only an authoritative empty SSH listing, retaining uncertain cached listings and
  propagating cancellation without changing route/error/connection policy. Four new regressions,
  full protocol 688/67, offline app compile and six new isolated mutants pass. Historical beta9
  delivery and its Oct4 first Home/exact last-End/row-and-group removal/connected SSH/second Home
  creation pass. That second shell was retained for the beta 10 update; the owned SSH pane survived and exact sole-End now shows completed empty, no
  Loading/row/group, with SSH/error retained. Home recreation opens a new actual bash pane
  and its exact End restores completed empty. Final fixture/service cleanup is pending.
- `A90` plain SSH shells are implemented in `bcc92367` / `b88d1415` and host-verified by the full
  684-test/66-suite protocol run, offline app compile and 32 new behavioral/wiring mutations.
  Atomic interrupted-creation rediscovery, frozen retry, fingerprint guards, dedicated sockets,
  reconnect/history/End and relay phantom refusal are covered. Beta10/code11 is installed;
  its AGP/R8/signing/alignment/provenance and independent SDK 36/37 review pass. Focused real
  Pixel Home/project/custom creation/history/restart/update/reconnect and exact End promote
  item 32 to Partial; item 1 paired update and later item 36 Board verification give the current 10 Pass / 22 Partial / 32 Pending.
  Relay plain-shell creation/input/End pass; managed and cellular creation remain pending.
  The A91 otherwise-empty-host variant passes on Oct4.
- The protocol against the desktop's real code: the relay handshake, SAS, approval wait (and the
  host's decision hold), `projects.list` with its `lan` report, attach/snapshot/input/resize/exit,
  scroll, node actions (quick answers into SSH-project nodes through a fake remote writer), board
  verbs, `git.*` through the real `GitService`, `approvals.answer`, `inbox.ack`, registration, and
  pairing (E2EE `/pair`, the key landing in `authorized_keys`, the relay pin, the SSH host key
  fingerprints from a fixture key directory).
- Relay security properties: no re-key, reflection, replay/reorder, and a foreign key.
- SSH transport against a real SSH server with tmux, including the pin anchors, a host
  certificate, and the Server Edition / driven-host browse.
- The remote `send-keys` line the desktop generates for SSH-project nodes, under a real `/bin/sh`
  and tmux (not over a real ControlMaster).
- The debug APK builds with AGP in historical CI runs. The installed private AGP 8.10.1 release
  built locally, passed R8 keeps, and runs on the intended Pixel with real direct-SSH browse/input
  proof. The wrong-MI8 test installation and SSH key were removed. See the newest progress entries.
- The historical beta-6 correction passes 658 protocol tests in 63 suites, zero failures/errors/skips
  (67 seconds), and offline app type-check (8 seconds). Thirty-five JS, eleven native and three
  CSS mutations are caught. Code-7 AGP/R8/signing/same-signer update passes, preserving app data;
  notification permission is confirmed. SSH reopened with its retained key/pin at 56×48, and
  controlled continuous drag/coast/Esc checks pass. A held touch stops coast at a stable 56×25
  viewport. Historical beta-4 controlled movement/reversal/Esc passed; the user confirmed more movement but missing
  momentum. `A88` packaging passes 39 Python tests against each real SDK 36/37 and ten new
  parser/fixture-selection mutations; [run `37061593216`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37061593216)
  at `c37798b6495b4b68df379d0ae80887c23104b66d` completed with all five jobs green, confirming
  observed workflow repair. The user confirms normal continuous dragging and coast both work.

- Requirement-audited real Pixel QA completes checklist 18/19/21/22/24/38/39 (SSH key/input/font/
  rotation survival, Unicode, large/invalid OSC52,
  keyboard-focus states, process-kill tab/back-stack restoration and synthetic shipped-hook
  Approve/Deny/expiry). Copy sheet,
  links and SSH background/detach recovery have additional partial evidence; the 64-row table
  records exact scope. Those results remain historical beta-6/code-7 proof; beta 10 / code 11 is now
  installed. Recorded prior all-green branch `19da35a2` passed all five CI jobs in run `37140762345`;
  historical beta9 APK source `4d33a5b5` failed its documentation checklist mapping in run `37144282865`;
  current beta 10 source `e3ce041c` has all five jobs green in run `37194375778`.
  Desktop-issued beta9 pairing/relay credentials survive the code10→11 update and saved relay
  reconnect/input. A93 fresh-different-desktop refusal remains open; A91/A94 full focused physical cycle passes. Each later push still requires
  its own green workflow.
- Encrypted paste pairing and forced relay-only browse on the real Pixel succeed against the
  actual hosted backend and production desktop source `58a202be` in an isolated private home.
  The current `{deviceToken, hostId}` join request and accepted reply are verified beyond interop.
  The approved-at-pairing path expects no SAS dialog; QR, cellular relay and denial/revoke variants
  remain device checks.
- Actual relay terminal attach/echo input and item-39 held-hook lifecycle pass on the owned
  production-preload/Canvas node. No phone New session, live Claude CLI/account or requested Bash
  execution was involved. Approve/Deny return actual hook JSON within 45 seconds; expiry returns
  empty and the phone reports timeout/opens the terminal. At that stage protocol/offline app checks passed
  in 54/5 seconds.
- Mounted relay single-select, multi-select Open-session/input and copy-mode answers reach the
  actual synthetic application and shipped PostToolUse/mirror. Item 41 stays Partial; remaining
  transport/target device variants stay open. Only disposable fixture resources were cleaned up,
  and the phone returned to regular Sessions; the final cellular WireGuard SSH check is now
  user-confirmed: "Connects and scrolls smoothly" in beta 6 / code 7.

**Not verified:**

- **Remaining phone behavior.** The intended Pixel has beta 10 / code 11. Its same-signer installation,
  install identity, notification permission, owned SSH pane and saved desktop-issued pairing/relay
  reconnect/input survive the update. A91/A94 full installed End/recreate/open/End empty-screen flow passes. Focused A90 Home/project/custom creation/history/restart/update/reconnect and
  exact End pass; beta 10 relay plain-shell creation/input/End also pass, while managed and cellular creation remain pending. A91 empty-host flow passes on Oct4.
  Historical code-7 controlled continuous drag/coast/Esc are verified. Earlier pre-attach history and Wi-Fi-off
  mobile-data WireGuard access are verified. Historical beta-6 real SSH background/detach recovery and
  process-kill restoration, paste pairing, hosted relay browse/input and the synthetic shipped-hook
  approval lifecycle are verified; QR, cellular relay, SAS denial/revoke, actual outage/notification/
  remaining question/copy-mode routes/target variants and the full 64-item checklist remain
  unverified. Beta 4 lacked momentum; beta 5 lost
  continuous touch events. `A89` corrects that target lifetime. New-touch stopping passes with a
  held touch at a stable 56×25 viewport; earlier keyboard-resizing checks were inconclusive.
  The user confirms normal drag/coast both work. Reversal/remaining lifecycle checks, custom wheel
  bindings and FPS remain open under `A86`; the final beta-6 manual-SSH cellular WireGuard
  connection and smooth scrolling check is user-confirmed, separate from untested cellular hosted relay.
- Release/minified builds on a device. R8 runs for release in CI (`A37`: `assembleRelease` plus
  `tools/check-r8-output.sh`). The first private minified APK is signed and installed on the intended
  Pixel; direct-SSH crypto/browse/basic input and code-3 `A85` sizing/history work. Remaining
  relay action/cellular/SAS variants and worker behavior stay open.
- **Interop coverage:** relay `projects.list` and mirror use actual producers; session-list and
  settings-provider inputs remain fixture data. Server-profile SSH
  cases also read actual config/platform, workspace and mirror publications through private SSH;
  they do not boot a full Server or install hooks/account probes. SSH actions/managed creation and
  Android `.seen` files have producer/consumer interop too, with their fixture boundaries named.
  Two new relay-advertisement methods exercise the actual account-level writer/remover and Kotlin
  SSH parser through a private fixture-only OS-home adapter. Legacy/adversarial browse, held files
  and driven-status-slice cases remain hand-maintained. Advertisement shape coverage does not prove
  standing-host publication, token mint, adoption, SAS approval or revoke.

## Environment notes for a cloud session

These restrictions describe the earlier cloud sandbox. Host access has since been restored, a
phone is available, and the user authorized a local AGP release build instead of waiting for CI.
Use the [local private-beta procedure](../android/README.md#private-beta) on that host; the remaining
notes still apply to a restricted cloud session. Current local build/test results are recorded in
the progress log, and do not establish any phone result until the checklist is run.

- **Google Maven is blocked** (`dl.google.com` / `maven.google.com` answer 403 from the egress
  proxy). AGP cannot resolve, so `./gradlew :app:assembleDebug` does not work in the sandbox. Do not
  retry it or route around it. Instead:
  - Type-check the app with `cd android/tools/typecheck && gradle compileKotlin`. It passed on the
    handover commit.
  - Rely on CI for the real AGP build: push, then read the Android workflow run.
- Maven Central sometimes answers 429. Retrying works.
- System `gradle` is 8.14.3 on JDK 21 in the sandbox; the wrapper pins 8.14.3 and CI uses JDK 17.
- The protocol tests need the repo's `node_modules` (an existing `npm install` is enough; on a
  machine without the native toolchain use `npm ci --ignore-scripts`, as CI does — it replaces
  `node_modules`, so a desktop checkout then needs `npm install` or `npm run rebuild`) and a `tmux`
  on PATH. Run them with
  `cd android/protocol && gradle test --offline`, or `cd android && ./gradlew -p protocol test`.
  Without node the interop tests skip.
- Desktop checks for any change to `src/main/remote/*`:
  - `npx vitest run src/main/remote/host-inbox-verbs.test.ts`
  - `npm run typecheck`
- Test-writing traps already hit once:
  - A JUnit 5 test whose body returns non-Unit is silently skipped. Use `runBlocking<Unit> { … }`.
  - In the SSH test harness, closing stdin on a pty command sends ^D and kills tmux.
  - An exact-match tmux **pane** target is `=name:`, not `=name`. tmux 3.4 answers "can't find
    pane".

## The findings in one page

77 findings survived verification, and none were refuted. Merging the duplicates (`A01`=`A04`,
`A05`=`A17`=`A23`, `A09`=`A28`, `A11`=`A19`) leaves 72 distinct items. The severity counts below are
over all 77: 8 high and 2 medium release blockers, 26 other medium, and 41 low. The work packages
below use the audit IDs.

### WP1: unambiguous blockers (small, do first)

| ID | Problem | Fix direction |
|---|---|---|
| A01 / A04 | `SshStream.write/resize` do socket I/O on the **main thread**. That throws `NetworkOnMainThreadException`, which `runCatching` swallows after sshj has advanced its cipher state, so the next packet kills the connection. Keyboard open, rotation, A−/A+ and the key chips all trigger it. `SshHostConnection.close()` from click handlers (`HostsScreen` Forget, `SettingsScreen` route change, `PairScreen`) leaks the socket the same way. | Give `SshStream` one single-thread executor. Route write, resize and scroll through it: this keeps ordering between main-thread chips and JavaBridge-thread input. Run `close()` / `client.disconnect()` off the main thread (`Dispatchers.IO`). Catch `RuntimeException` by closing the transport, not by swallowing it. |
| A02 | The SSH prelude looks for the desktop's data in `…/nodeterm`, but the desktop's userData is **`…/node-terminal`** (package `name`, no top-level `productName`). Confirmed: `src/core/agents/hook-endpoint-failover-sh.ts:79-80` uses `node-terminal`. | Probe `node-terminal` first and keep `nodeterm` as a fallback, in `SshScripts.kt:38` and its KDoc at :18-19. Fix the `SshTransportTest` fixture (:154) to the real name. The same wrong path is in `docs/uninstall.md:24` and `scripts/uninstall.sh:64` on the desktop side; fix those too. |
| A03 | The SSH tmux client starts without a UTF-8 locale, so ╭, accents, CJK and emoji come out as `_`. | In the attach script, export `LANG=en_US.UTF-8` unless LC_ALL/LC_CTYPE/LANG already says UTF-8 (the rule of `resolveLocaleLang` in `pty-manager.ts`). Add `-u`. Add a test with LANG unset. |
| A06 (+A35) | **Desktop:** `approvals.answer` writes the answer even after the hook's 45 s hold ended, then reports success and emits the synthetic answered event, which clears NEEDS YOU everywhere. The canvas button has the same pre-existing gap. `answered:false` cannot tell "gone" from "write failed". | In `answerPermission` (`src/main/index.ts`), check that `<pendingId>.json` still exists before writing (`fs.access` locally, `test -f` in the same remote command over SSH). Return false and skip the synthetic event when it is gone. Reply with a reason (`gone` / `failed`). On the phone, map `gone` for a still-blocked node to "open the session". |
| A10 | CI debug APKs are signed with a fresh debug key each run, so updating means uninstalling, which wipes pairings. | Commit a debug keystore (`android/.gitignore` already has `!debug.keystore`), point `signingConfigs.debug` at it, and say in the README that it is a public debug key. |

### WP2: blockers that need a decision (recommendations in bold)

| ID | Problem | Options |
|---|---|---|
| A05 / A17 / A23 (+A30) | The background `InboxWorker` can make the phone's **first** relay handshake, which raises the desktop's SAS approval dialog while the phone shows nothing. It repeats every 15 min, and pressing Deny is not respected: the phone re-dials about 8 s later. | **Add a per-host "relay approved" flag, set only after a foreground relay connect succeeds. The worker never enters the relay leg until it is set.** After "Awaiting approval" or a refusal, back off and stop re-dialing until the user acts. (Aborting on AwaitingApproval does NOT help: the desktop raises the dialog at handshake completion, `standing-host.ts:256-261`.) |
| A07 | Pairing never pins the phone's relay (box) key, and Auto prefers SSH on the LAN. So the one-time relay approval never happens while the user is at the desk, and the first remote connect waits 5 min and fails. The desktop design has the same gap, so iOS likely shares it (`standing-host.ts:424-434`). | **(b) Send the phone's persistent box public key inside the sealed `/pair` body and have `pairing-service.ts` pin it (the standing host's `isPinned` store) when pairing succeeds.** This is additive: an older desktop ignores the field. Raise it for iOS with @eneskirca. Interim alternative (a): right after pairing, run one relay handshake on the LAN and show the SAS on PairScreen. Either way, PairScreen must stop saying "✓ Reachable from anywhere" before approval. |
| A08 (+A72) | A cold attach over direct SSH (`new-session -A` with no `-e` env) creates the desktop's tmux session **without the hook env**. An agent resumed there never reports status, the desktop never repairs it, and if the desktop's client started the tmux server the session inherits **another node's** `NODETERM_NODE_ID` (misattribution). | **Do not cold-create over SSH. When `hasSession` says no, offer "Open on your computer" and use the relay when available, where `attachDetached` injects the env.** The alternative is to pass the full hook env with `-e` (NODETERM_NODE_ID, NODETERM_HOOK_ENDPOINT, NODETERM_HOOK_VERSION, …); that duplicates desktop logic and drifts. |
| A09 / A28 | Nodes of the desktop's **SSH projects** live on a third machine, but over direct SSH the phone attaches to the desktop's LOCAL tmux. That creates an empty phantom session and offers to resume on the wrong machine. | **Over direct SSH, don't attach nodes whose project is an ssh-ref. Show them with "open via remote access" and use the relay.** Check first how the desktop's `pty.attach` handles a remote node. |

### WP3: device test pass (after WP1 + WP2)

Install the CI APK (from the new stable debug key) on a real phone and walk the numbered checklist in
[`android.md` → Device checklist](android.md#device-checklist) (64 items, each naming the finding it
checks).
Record results in `docs/android.md` → "What is verified". Anything that fails becomes a new finding.

### WP4: medium bugs (after the device pass)

`A11`/`A19` notification tap ignores the target computer · `A12` relay `sendKeys` into a pty that
does not exist yet · `A13` registering while attached lets the desktop attach with `-D` and detach
the phone · `A14` inline (cwd-less) project sessions never registered · `A15` resume drops the
Claude account (and cwd over relay) · `A16` project permission mode/default account ignored ·
`A18` no lifecycle handling (8 s poll + relay stream keep running in background) · `A20` cancelled
connect leaks SSH and counts as failure · `A21` denied notification permission never re-requested ·
`A22` back stack not saved across recreation · `A24` SecureStore overwrites identity on any decrypt
error (**data loss: fix early**) · `A31` silently dead SSH peer wedges "On your network" ·
`A33` Windows host new-session cwd/account · `A34` Ctrl chip not applied to input-bar text ·
`A36` terminal stays "Disconnected" after auto-reconnect.

### WP5: iOS parity gaps

`A25` real push (needs an FCM leg in the backend; also notification actions) · `A26` new session
and board edits over direct SSH · `A27` connect straight to a Linux host / Server Edition (also
probe `~/.nodeterm-server`) · `A29` source-control screen (verbs already in `HostConnection`) ·
`A32` link opening and text selection in the terminal · `A55` merged inbox/usage across computers ·
`A56` "Always allow" · `A57` multi-select questions · `A58` pace line / context indicator ·
`A59` dictation · `A75` account picker shows UUIDs · `A76` wake/resume for Sleeping sessions over SSH.

### WP6: low-severity, docs and CI

The rest of `A37`–`A77`: R8 rules, lock-screen notification content, OSC 52 size cap, pairing
response size cap, SSH TOFU pin timing, device-to-device migration, the CI path filters and trigger
conventions, dependabot/CodeQL/wrapper validation, test gates on macOS/Windows, doc claims, the
tsconfig coverage of the interop fixture, and `ANDROID_APP_URL` pointing at a folder not on the
default branch yet. `A65` is partly obsolete (CI did build the APK).

### WP7: PR

When the user asks: open a PR from this branch, following the repo's `pr-writing` rules and any PR
template. Mention @eneskirca for the mobile implications: the pairing-key pin from `A07`, and
`approvals.answer` / `inbox.ack`, which the iOS app can adopt.

## Decisions made (2026-09-26)

1. **A07**: pin the phone's relay key at pairing (desktop + protocol change, additive). Done.
2. **A08**: refuse cold-create over direct SSH and route to the relay. Done.
3. **A09**: relay-route SSH-project nodes; the desktop attaches them over the project's ControlMaster.
   Done.
4. **Distribution**: a committed public debug key for sideloading (`A10`). Done. A real release
   key/store listing were deferred. The 2026-10-02 continuation prepares a private sideloaded beta:
   sign locally with a retained private key; no public release or store listing is requested.

## Device checklist

Moved to [`android.md` → Device checklist](android.md#device-checklist) (`A65`): one numbered list,
grouped by area, each item naming the finding it checks, including every device check the fix
commits asked for. Its ledger is 10 Pass / 22 Partial / 32 Pending; new source features need their own checks.

## Conventions for whoever continues

- Develop on `claude/android-ios-parity-75kfem`, and push with
  `git push -u origin claude/android-ios-parity-75kfem`. Commit messages end with the session's
  attribution trailer lines.
- CLAUDE.md → Conventions → three surfaces has the Android rule. A change to a `host-service.ts`
  verb, the `projects.list` blob, the pairing payload, the mirror file or the `~/.nodeterm` file
  contracts owes the Android client and its interop fixture **in the same change**.
- Every fix gets a regression test where the layer allows. The protocol layer is JVM-testable, and
  the WP1 SSH fixes are testable against the MINA/tmux harness. Fix the test fixtures that
  hand-copied wrong shapes (`A02`, `A64`) so they would have failed.
- Before pushing, run:
  - the protocol tests;
  - the offline type-check;
  - for desktop changes, the affected vitest files and `npm run typecheck`.

  After pushing, confirm the Android workflow is green.
- Update this file, `docs/android.md` and the audit index when work lands. Mark a finding as fixed
  by editing its index row, e.g. `A02 ✅ fixed in <sha>`.
- Never claim device verification that did not happen.

## Follow-up prompt

Continue Android work on `claude/android-ios-parity-75kfem` of CPlusPlus17/nodeterm.
Read this handover, `docs/android.md`, the audit index and `android/README.md`; re-read current
source before editing. A100–A120 close retained history, typed read recovery, project launch settings,
agent policy, offscreen wake, held rule/question replies, SSH Git, owned Board/node actions and
host-owned managed New over SSH, revoke reporting, dictation language, host retirement, pairing
adapter choice, relative private-key Include exclusions and eligible legacy relay identity proof.
Retained-signer beta22/code23 from `2ba0b142` is installed on the separately authorized Pixel 7a.
Current source passes fresh forced1054/114/offlineapp and CI37732792493 all-five/ten-step.
The earlier beta21 source passed1033/110/app/TypeScript and CI37678829862. A fresh owned
40-ms/1200-row direct-SSH flow completes with its marker visible after Home/resume/scroll; the
original A132 negative remains historical. A133 source is published and its bounded same-page
retention, exact final-marker/Unicode clipboard paste and post-font OSC8/plain link offers pass.
The later normal browser/Share pilot records Vanadium's exact address-field nonce and the selected
chooser marker, with no recipient action. Browser Back remains unverified; ordinary resume succeeds,
while chooser Back returns to the owned terminal. Wider A131/TUI/lifecycle checks remain unverified.
Both copy/link and browser/Share fixtures are retired with exact owned cleanup. The original
15000-ms timeout is confirmed by read-only reconciliation after the sole restore's post-focus
uncertainty; no second write occurs. Current docs-only `9b8bba2b` also passes all-five/ten-step
CI `37690764287`; keep future publication receipts distinct from installed artifact source `ef4caec2`.
At Desktop `e06b5547`, its original A105 remembered-rule and A106 single/nonadjacent-multi choices
pass real sibling Claude application. Saved manual SSH profile/pin reuse after app process restart
and changed-host-key refusal pass. Both fresh fixtures, the QA profile/public-key admission and
owned reverse are retired with exact cleanup; the original phone timeout is restored. The original
Pixel 10 Pro ledger remains **10 Pass / 22 Partial / 32 Pending**, with testing paused. These
fresh-phone cases do not establish migration survival or wider acceptance on that original phone.

At the earlier beta 17 checkpoint, `a79375c3` passed 982/102 protocol/app and affected Desktop
gates plus all-five CI. Its nine-case physical report binds 303 raw hashes for emacs/vi Send,
transport recovery, raw Ctrl, viewer-close/manual Reattach, managed creation and exact owned
End/cleanup. Those dated results and A128's source/configuration mutations remain historical.
The installed beta22 APK/runtime provenance is `2ba0b142`, separate from later docs-only
publication heads. Publish documentation only after fresh exact-revision offline gates and
all-five/ten-critical-step CI, keeping those receipts private. Preserve the installed beta22 APK.

Use only the authorized Pixel 7a, verifying its serial and app focus before input. The user's
current availability/wake authorization persists; do not repeatedly request unlock while the
trusted endpoint and usable foreground are valid. Obtain a current main Wireless debugging
endpoint only if that trusted connection is unavailable. Every new physical case requires a fresh
owned fixture and untouched sibling guard; never restart a retired fixture. Resume the expanded
64-item checklist without inheriting older passes for new flows. A134's exact-revision gates/CI
and fresh original native create/visible prompt pass. A separate fresh consumer verifies native
capture retention and normal renderer reload/input with the same original kernel tuple and
untouched sibling; canvas gestures and Android history remain unverified. The controlled shell
comparison does not establish V13's child cause or whether fallback fired.
A135/A136 signed-source gates/CI and beta22/code23 update pass. One fresh no-Send A136 cover/Back
retains draft/Ctrl and its fixture/profile/auth/reverse are retired. Original15000 is independently
read back after the sole restore uncertainty without replay. Original beta21 loss stays historical.
Selection/IME/activity recreation and pending-Send/Ctrl follow-ups still need measurement.
A137 now identifies a source-confirmed pending/outcome visibility gap across retained-entry remount.
The exact-attempt/retained-guidance fix is published at `b9e4cbc7`; fresh1069/116/offline app,
CI37740459063 five/ten and retained-signer beta23/code24 artifact review pass. No update was dispatched
after the read-only pre-install snapshot refused. Revalidate the intended Pixel route, perform the
guarded in-place update, then measure a fresh pending-Send cover/Back case. Do not remove original
viewer/revision fences, replay an old command or treat A136's no-Send pass as pending-Send acceptance.
Next are A129/A130 native app history/held Live-touch acceptance, whole-host/network loss,
wider lifecycle/notification, native-route lost replies, network blackhole and remount/Ctrl during
pending Send. The measured held- and lost-successful-receipt/newer-draft cases pass separately. A105 rule
persistence after CLI restart, genuine production-pane-child launch and the wider question/layout/
platform matrix remain pending. The bounded sibling CLI passes do not cover those paths. Beta22 is last verified installed; preserve historical proofs and all unrelated profiles/panes during the guarded update.

Immediate FCM (A25) and fresh-different-desktop relay refusal (A93) need the hosted backend maintainers;
the user has no backend repository to supply. A111 implements a host-owned launch API on current
enabled local Linux/macOS tmux hosts; ordinary missing-session SSH attach remains attach-only.
Windows/non-tmux and third-machine creation are unsupported. Source is intended for an upstream
PR; none has been opened. A68 is source-fixed: push on main only, keep pull_request, no merge_group;
opt-in manual prepare_beta runs all five jobs. Flag all new mirror/verb/SSH contracts for @eneskirca's iOS client.

Commit small logical changes with regression tests and isolated mutation checks. Before each push:
protocol `gradle test --offline`, offline app `gradle compileKotlin --offline`, affected Vitest and
`npm run typecheck` for desktop changes. Confirm the exact-head Android workflow green afterwards.
Local offline APK builds are authorized; keep the retained signer, APKs and private proofs out of Git.
Google Maven is blocked: use existing cached local tools or the real CI build, never try to reach it.

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
hover/leave assertions after trusted mouse delivery. Separate Linux Server execution now passes at
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

## Pixel 7a beta-16 check and A124 host repair (2026-10-05)

A fresh beta 16/code 17 installation on the separate Pixel 7a passes installed APK hash,
signature and non-debuggable checks. Normal manual explicit-profile, high-port SSH and bounded
existing-terminal input/cwd/Unicode history/held-drag/coast/new-touch-stop checks pass.
The original `15dd1341` **New session → Start** attempt retained default Claude because its
nonclickable label did not select the shell; shared shell validation exposed A124 before CLI lookup.
The repaired wrong-label attempt's unavailable-Claude-CLI refusal is expected, not a new finding.
Actual shell-radio selection on frozen Desktop `40731381` creates and registers `/bin/bash`.
Phone input executes once in the expected cwd; viewer reopen and an Android-process restart with
saved SSH reconnect retain the same pane/marker and leave the other original terminal untouched.

Host-retained Find locates two offscreen matching lines in 155 retained lines after 150 additional
output lines; native visible-screen capture independently excludes the old marker. History-line
clipboard paste matches. Local Copy-sheet search correctly has no offscreen-marker match; its
public URL offer and URL clipboard roundtrip pass. External browser opening is unverified.
Both QA profiles are removed through the app, which returns to the initial Computers/Add screen;
beta 16 and global identity remain. The repaired V5 host stops cleanly: app/sshd exit, closed
listeners and generated private-auth cleanup pass. The earlier host's source-binding failure stays
historical and separate.

At `40731381`, offline protocol passes **949 methods / 98 suites** with zero failures/errors/skips;
38 affected Vitest tests, full TypeScript and three assertion-caught isolated guard mutants pass
(five platform Vitest cases skip on Linux). The frozen full Desktop build passes in 29.3 seconds.
First-push [Android run `37375870878`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37375870878)
passes all five jobs against exact head `40731381c646ccd3425af597b116b5371daf0a63`.
See [the verification notes](android.md#what-is-verified-and-how) and [audit A124](android-audit-2026-09.md#a124) for precise evidence and scope. Private physical proof:
`.nodeterm/android-pixel7a-device-y0ia4hm_/physical-repair-result.json`.
The original Pixel 10 Pro beta-10 ledger stays paused at **10 Pass / 22 Partial / 32 Pending**.
No wire/file contract changes; @eneskirca can note the shared host benefit for iOS.

Next: continue the remaining background/lifecycle/outage, notification/answer/permission and
live-provider device matrix using fresh owned fixtures. Single-case success does not verify
managed End, power loss, original Pixel update/migration, QR/relay/cellular routes, FPS or all
64 checklist items. A25/A93 backend dependencies and other-platform checks remain separate.

## Native custom wheel checks (2026-10-06)

A86 adds one real SSH/tmux regression covering both copy key modes, asymmetric host wheel gains,
distance across 20-notch chunks and FIFO-sensitive queued reversals. The eight native positions
settle for 300 ms; original mouse/mode overrides and wheel bindings are restored. Targeted control
and isolated control/restored runs pass. Three transport mutations fail the exact distance assertion;
the earlier idle-copy-mode setup failure remains separate and is not a product finding.
See [the native receipt and exact positions](android.md#native-custom-wheel-checks-2026-10-06).
Only test/docs change; APK, production transport and iOS wire/file contracts are unchanged.
The Pixel 7a is offline, so remaining phone custom-binding/lifecycle/FPS and release checks still
need a reachable device. The original phone stays paused at **10 Pass / 22 Partial / 32 Pending**.
Before push, run both required offline gates; after push, verify all five Android jobs against the
exact head. Continue physical checks when the intended phone returns; A25/A93 remain backend work.

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
subscriptions/client; no adopted Canvas-input/current SID-ref result is claimed. See [the bounded two-host follow-up](android.md#inactive-global-card-owner-and-bounded-parkadopt-2026-10-06)
for exact source/proof hashes and the remaining scope; no new repair or product test count is added.

Actual Canvas mounting and selected-view native keyboard recovery pass in the eight-case matrix;
one additional two-host soft/none case verifies a quiet park/adopt cycle and inactive global-card
recovery with the active host unchanged. See [the bounded two-host follow-up](android.md#inactive-global-card-owner-and-bounded-parkadopt-2026-10-06). Remaining Android release acceptance needs a
reachable intended phone for lifecycle/outage, answer/notification/permission and live-provider
checks; A25/A93 need hosted-backend maintainers. Further host coverage includes streaming/expiry/
eviction while parked, repeated or broader outage/backoff, Server/cross-window response ownership,
GPU pressure/full-frame display output and macOS/Windows. The synthetic key-only hosts do not
establish real-user PAM, power-loss, agent-launch or ordinary Quit behavior. Unsupported private
xterm shapes warn and retain input but may duplicate replies; legacy onBinary is unchanged.
No Android wire/file or iOS client change is required. The original Pixel 10 Pro ledger remains
paused at **10 Pass / 22 Partial / 32 Pending**.

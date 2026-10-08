# nodeterm for Android

The Android companion to nodeterm: pair your phone with nodeterm on your computer, then watch your
agents, answer their questions and open any terminal on the canvas — on your network over SSH, or
from anywhere through the end-to-end encrypted relay. It is the Android counterpart of the iOS app
and speaks the same protocol to the same desktop; nothing on the computer needs to know which phone
it is talking to.

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
The original **10 Pass / 22 Partial / 32 Pending** ledger is unchanged. See [the scoped finding](../docs/android.md#pending-send-outcome-after-remount-2026-10-08-a137).

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
[the scoped evidence](../docs/android.md#retained-terminal-editor-2026-10-08-a136).

**Captured Ctrl consumption (2026-10-08, A135 — source fixed).** Delayed raw-keyboard
consumption now checks the captured Ctrl revision as well as its viewer. Five policy and three
wiring regressions pass; three policy mutants and one wiring mutant are caught. Source publication
and beta22 installation pass; a physical scheduling reproduction remains pending. See
[the scoped evidence](../docs/android.md#captured-ctrl-consumption-2026-10-08-a135).

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
See [the measured receipt loss](../docs/android.md#lost-send-reply-and-newer-draft-2026-10-08).
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
See [the measured receipt hold](../docs/android.md#held-send-reply-and-newer-draft-2026-10-08).

**Earlier nine-second Send/newer-draft follow-up (2026-10-08 — bounded partial).** A fresh `d361ce8f`
fixture uses unchanged Desktop/build `0d8594a6` and stock beta21/APK source `ef4caec2`.
One Send and a draft suffix return before the same SSH peer resumes, but the final newer-draft/
disabled-Send XML observation misses the pause deadline; the original wrapper remains failed.
Later XML retains the exact newer draft and saved pixels show its suffix; Send is enabled and one
original-TTY witness/real ACK stays unique 125.310 seconds later. At that earlier checkpoint, the
strict timed race and lost-reply cases were unverified; the failed wrapper remains preserved.
See [the bounded follow-up](../docs/android.md#nine-second-send-and-newer-draft-follow-up-2026-10-08).

**Silent SSH peer recovery (2026-10-08, Pixel 7a / beta21 — bounded pass).** Fresh owned checkout
`04da9b9e` uses unchanged Desktop/build `0d8594a6` and installed APK/source `ef4caec2`. Only the
admitted old SSH peer is stopped for 45.000 seconds on shared loopback; automatic recovery creates
a new viewer while it is paused, preserving the original shell, producer, tmux server/socket and
guard. The unsent draft and its saved rendered text remain; one later explicit Send executes once
and receives a real ACK. At that checkpoint, whole-host/network loss, cursor position and
lost-reply races remained unverified. Owned cleanup passes; the original **10/22/32** ledger stays
unchanged. See
[the bounded receipt](../docs/android.md#silent-ssh-peer-recovery-and-single-send-2026-10-08).

**Native Desktop continuity (2026-10-08 — scoped verification).** A fresh private Desktop/build
`0d8594a6`, observed with the docs-only `98907171` checkout, passes two original session-host
factories, retained capture of all 200 unique numbered markers with Unicode, one normal renderer
reload and input to the same original shell before/after it. The complete sibling capture and
original daemon/Bash/producer/socket generations stay unchanged; owned retirement is verified.
Android native-history/Live-overlay acceptance, silent network loss and native-route held/lost replies remain open.
Installed beta21 and the original **10 Pass / 22 Partial / 32 Pending** ledger are unchanged.
See [the native consumer receipt](../docs/android.md#native-desktop-capture-and-renderer-reattach-2026-10-08).

**Login-shell deadline (2026-10-08, A134 — published; original create verified).**
Signed, pushed `3f382367`/`0d8594a6` pass forced **1033 methods / 110 suites**, offline app compilation,
full TypeScript and **161 tests in nine affected Vitest files**, with five known Windows-only skips.
[Run `37702852854`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37702852854), attempt 1, passes all five jobs and ten required steps.
A fresh source-built Desktop observes one original Linux session-host create fulfill and display
its Bash prompt, with zero PTY input. V13's child cause and whether fallback fired remain unknown;
native history and its phone overlay remain pending. Installed beta21/source `ef4caec2` and the
original **10 Pass / 22 Partial / 32 Pending** ledger are unchanged.
See [the scoped source checkpoint](../docs/android.md#login-shell-probe-completion-deadline-2026-10-08-a134).

**Direct SSH continuity (2026-10-08, Pixel 7a / beta21).** Desktop `0d8594a6` with the unchanged
stock APK/source `ef4caec2` passes controlled SSH-handler recovery, two active Home/resume cycles,
draft retention and one explicit Send to the original tmux pane. The producer/server/socket and
sibling guard remain unchanged. Phone cleanup is verified; the outer runner stop-accounting
negative is preserved. Native-history/relay/notification and wider lifecycle cases stay open.
See [the bounded continuity receipt](../docs/android.md#direct-ssh-reconnect-and-active-background-continuity-2026-10-08).

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
[the scoped evidence](../docs/android.md#fresh-fedora-output-and-native-desktop-readiness-2026-10-08).

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
absent there too ([A132](../docs/android-audit-2026-09.md#a132), attribution pending). After a separate
phone Send/exit, the terminal shows `[exited]` and an exit-0 overlay without the previously displayed
history ([A133](../docs/android-audit-2026-09.md#a133), cause pending); final-marker emission was not captured.
A131's focused **71/8** and **10 behavioral/four app source-pin mutants** remain source evidence,
not full lifecycle acceptance. Already-dispatched WebView JavaScript, A129/A130 native history,
wider lifecycle/notification cases and the original **10 Pass / 22 Partial / 32 Pending** ledger
remain outside these observations. See [the bounded receipts](../docs/android.md#beta-20-publication-and-bounded-output-checks-2026-10-07).

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
owned cleanup add no app/CA/APK acceptance. See [the scoped evidence](../docs/android.md#beta-19-publication-provider-and-emulator-checkpoint-2026-10-07).

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
ledger, which stays **10 Pass / 22 Partial / 32 Pending**. See [the bounded beta-17 receipt](../docs/android.md#pixel-7a-beta-17-upgrade-and-composed-send-2026-10-06).

**Composed Send source checkpoint (2026-10-06, A128).** `7e7d2c04` awaits submission through
the captured viewer's input actor, exits history on that exact pane and separates paste from a
freshly guarded Enter by 150 ms. Ctrl remains one raw byte without Enter. Only one delivered
receipt for the same current viewer clears an unchanged draft; edited drafts, rearmed Ctrl,
refusals and uncertainty are preserved, with no replay or legacy raw/`node.sendKeys` fallback.
Direct Unix SSH and current local-tmux relay are supported; legacy, native Windows/session-host
and SSH-project relay routes explicitly refuse. A positive receipt means pane/PTY submission,
not command execution. **170 distinct Kotlin methods / 8 suites**, **187 Vitest tests / 11
files**, full TypeScript and offline app compilation pass; **26 source mutations fail assertions**.
`5484ab9f` adds four private-beta CI registrations: nine actual Gradle configuration methods
pass and four deletion mutations fail assertions, with passing control/restored checks
(**30 assertion-caught mutations** total). The subsequent merged `a79375c3` passes 982/102 protocol and app
and affected Desktop gates plus all five CI jobs; retained-signer beta 17/code 18 is installed.
Bounded emacs/vi Send, vi transport recovery, raw Ctrl and A127 viewer-close/manual-Reattach
phone cases, actual managed shell creation, exact owned SSH End and cleanup pass. Nine bounded
cases/303 raw hashes do not complete the original checklist; broader physical/provider acceptance
remains pending. Installed APK/runtime provenance remains `a79375c3`; later docs-only publication
checks do not represent another installed build. See [the source proof](../docs/android.md#composed-send-source-checkpoint-2026-10-06-a128)
and [the bounded beta-17 checkpoint](../docs/android.md#pixel-7a-beta-17-upgrade-and-composed-send-2026-10-06).
The additive `pty.submitComposed` contract includes the Android client and actual interop fixture
in the same source commit; **iOS @eneskirca** needs the same action, receipt and retention rules.

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
complete URL activations**, retained same-grid history and exact owned cleanup. See [the bounded two-host follow-up](../docs/android.md#inactive-global-card-owner-and-bounded-parkadopt-2026-10-06).
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
open. See [the native checks](../docs/android.md#native-custom-wheel-checks-2026-10-06) and the physical receipt above.

**Current source checkpoint (2026-10-05, A100–A124).** The branch adds retained terminal history search,
trusted project env/shell and per-agent launch policy, offscreen Sleeping wake, remembered hook
rules and complete held Claude questions. Direct SSH supports Source Control, selected-profile
Board writes and Desktop wake/refresh/rename. New session can now ask a current Desktop/Server
with an enabled Linux/macOS tmux backend to create and register a managed shell or agent in an
open local folder project (A111); the host resolves its command, account, environment and hooks.
Older hosts retain the relay New flow. The actual producer fixture also exposed and fixed Android CI/local incremental coverage for `src/session-host/**` (A112). Current source also adds truthful legacy revoke outcomes (A113), a dictation language picker (A114), exact connection/record retirement (A115) and a saved LAN/VPN adapter choice (A116). Managed canvas End still requires the relay;
closing the SSH viewer leaves the session running. This prepares the upstream Android contribution; no PR
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

**New work after beta 10 (2026-10-04):** the branch adds Sessions search by name, agent and folder;
live refresh on All computers while visible; and captured-output Copy-sheet search,
with highlighted matches and Previous/Next. The computer now discovers SSH host-key anchors through
recursive configuration Includes. Beta 11/code 12 is prepared locally; the Pixel still runs
beta 10/code 11. Phone checks remain paused, so none of these additions has a physical pass.

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

> **Status (2026-10-04): beta 10/code 11 is installed; paired update passes.** Focused
> plain-SSH creation/history/reconnect and exact End pass on the Pixel (item 32 Partial).
> Fresh-desktop pairing received no relay credential after an observed backend refusal (A93);
> the empty-host loading correction (A94) is delivered and its full focused empty-host flow passes. CI builds the debug APK. The
> private minified beta is installed on the Pixel 10 Pro (Android 17 / API 37); manual SSH lists real
> projects after the update. Historical proof retained through beta 6 covers basic terminal input,
> the code-3 viewport/history correction (`A85`), user-confirmed terminal access with Wi-Fi off over
> mobile-data WireGuard, real SSH background/detach recovery and Inbox/back-stack restoration.
> Encrypted paste pairing and live hosted relay browsing also have historical beta-6 proof. QR pairing, cellular relay,
> actual outage/answer behavior and the full device pass remain unverified. A95's desktop Board fix passes actual phone-to-mounted-desktop verification (item 36). The plan and what is still open are in
> [`docs/android-handover.md`](../docs/android-handover.md); the findings are in
> [`docs/android-audit-2026-09.md`](../docs/android-audit-2026-09.md).

**Historical beta-10 paired update (2026-10-04):** `0.1.0-beta.10` / code `11`,
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

**Desktop continuation (`A92`, 2026-10-04):** the shared Desktop/Server renderer now keeps the
hovered row inside its capped wrapped-link paragraph. The focused 24-test Vitest file, all 54
affected link/dialect tests, full TypeScript check and three isolated mutants pass. Fixed in
`127b6b28`; all eight native Linux Desktop UI cases now pass at `01b4a2f5` with A121's leave fix.
Separate Linux Server checks pass at `dcdf664a`. The later GPU-enabled eight-case matrix passes
(Canvas4 hardware / Modal4 DOM). Those earlier runs did not verify GPU recovery; later individual
loss/restore pilots are recorded in the final follow-up. macOS remains unverified. Android already
fixed this in `A32`; no APK or host
contract change, iOS adoption or new phone result follows. This desktop fix alone does not change the installed APK or checklist tally.

**Fresh-desktop relay pairing refusal (A93, open; 2026-10-04).** The same Pixel identity
paired with a fresh isolated production desktop whose remote access was on, but the saved
pairing had no relay credential. A bounded retry using the exact unchanged production request body
returned HTTP 403 reauth_required. Forgetting the old fixture removed its phone-side relay
token; the new desktop has a different identity. The refusal is measured. Original
same-desktop recovery succeeds after ordinary restart of the complete original owned fixture
profile: unchanged host/device identity, genuine beta-9 re-pairing and actual relay credentials.
No backend repository was reviewed, phone identity reset or user credentials copied. This
measures one legitimate recovery case; fresh-different-desktop refusal remains open.
**iOS follow-up for @eneskirca:** verify prior-token lookup and recovery messaging for the same
persistent phone identity after Forget; no new wire field is introduced here.

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

**Beta 6 verifies continuous dragging, coast, Esc and new-touch stopping (`A86`, `A89`).** SSH
reopened on the intended Pixel with its retained key/pin at 56×48. `c4b1f6cf` targets the stable
screen behind changing text, fixing beta 5's detached touch target. Code 7 passes 658 protocol tests and
release/R8/signing checks. A held touch stops coast at a stable 56×25 keyboard-open viewport;
earlier resizing tap checks were inconclusive. The user confirms normal dragging and coasting
both work now. Remaining lifecycle checks, FPS and custom bindings remain open.

**Requirement-audited real Pixel QA:** complete checklist passes are **1, 18, 19, 21, 22, 24, 36, 38, 39 and 51**:
SSH software input/key chips/font/rotation survival, Unicode rendering,
large/invalid OSC52 handling, all three keyboard-focus states, and background-process tab/back-stack
restoration and the shipped managed-hook Approve/Deny/expiry lifecycle. The hook producer is
synthetic; no live Claude CLI/account or requested Bash execution was involved. Seventeen sending
chips plus four app-mode arrows and font/rotation complete item 18 on the existing proof;
wrapped/OSC8 links, Copy-sheet Unicode/Share and real SSH recovery have partial evidence. Landscape with IME open
was 129×1; usable-height and larger-client Fit checks remain open. The [64-row result table](../docs/android.md#what-is-verified-and-how)
records ten Pass, 22 Partial and 32 Pending items with conditional SKIP variants. Item 1 adds
paired-update proof; the focused A90 proof leaves item 32 Partial. The earlier 7/20/37 checkpoint used beta6/code7. Encrypted PairingService JSON paste and **Only through the relay**
browse succeed against production desktop source `58a202be`, with the actual hosted API/relay;
the current `/v1/relay/join` shape is verified beyond interop tests. Remote access was already
enabled, so this pairing approves the phone without a first SAS prompt. The desktop uses an
isolated home and real SecretService encrypted credential storage; no user credentials were copied.
The phone also attaches and sends echo input through the relay to an owned real PTY, created by
production preload/Canvas events rather than phone New session. At that stage checks passed all 658
protocol tests in 63 suites (54 seconds) and offline app `compileKotlin` (5 seconds).
Mounted relay single-select answers and multi-select Open-session/input reach the synthetic
application and its actual PostToolUse/mirror. A one-tap answer from copy mode also reaches the
application, leaves copy mode and resolves the question. Item 41 stays Partial: offscreen/released,
direct-SSH and target-guard variants lack device proof. No live Claude CLI/account was used.
QR/scanner, cellular relay, SAS denial/revoke, remaining node actions, remaining question routes,
notifications
remain open. Recorded prior all-green branch CI is `19da35a2`, all five jobs in [run `37140762345`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37140762345). Installed beta 9 is separately bound to `4d33a5b5`, whose source CI failed the documentation checklist mapping. Each later push still requires its own green workflow.
Only disposable fixture resources were removed and the phone returned to regular Sessions;
cleanup does not establish the full revoke matrix. **Final beta-6/code-7 cellular check:** with
WireGuard enabled and Wi-Fi off, the user confirms "Connects and scrolls smoothly" in their usual
manual-SSH terminal, confirming connection and smooth scrolling. Cellular hosted relay remains untested;
item 20 stays Partial and the full 64-item pass remains open. No runtime change or phone command
was needed. The 50/1-second protocol/offline app tasks at that stage are historical; current A90
checks are recorded below. Each subsequent push still requires green CI.

The user resumed remaining Pixel release checks on 2026-10-04 after the hike. The requirement review adds
item 18's Pass without new phone work; viewport/Fit remains item 23's open scope. Item 1 requires
desktop-issued pairing/relay credentials through a higher-code update, using JSON or QR. Full
release readiness, hosted cellular relay and live-Claude checks remain unverified.

Historical private `0.1.0-beta.7` / code `8` was **prepared, never installed**, from
`b53610deb3843b59fa6a1bed5bdc5f36da0f5146`, using the retained signer. Local AGP built in
47 seconds; R8 and packaging passed. APK SHA-256:
`5141c6484b422b236a98213731076be621c4d14a55f47c79bfd989fb23609e6a`.
Ignored proof/artifacts are in `.nodeterm/android-beta-build-7/` and `.nodeterm/android-beta-7/`.
Beta 8 below replaced it and is now installed; beta-7 preparation added no runtime
fix or device pass.

**Plain SSH terminals (`A90`) are implemented and host-verified.** On the Linux SSH host, use
**Sessions → New terminal → Home folder / project folder / custom absolute folder → Create**.
The shell appears under **Phone terminals**, persists when the viewer/app closes, and can be
reopened or stopped with that row's **End session…**. These are independent shells, with no
automatic desktop-canvas registration or managed-agent identity. Protocol `bcc92367` and UI/model
`b88d1415` preserve existing cold-agent SSH refusal and relay canvas creation. All **684 protocol
tests in 66 suites pass with zero failures/errors/skips** (48 seconds), offline app `compileKotlin`
passes (1 second), and **32** protocol/helper/native-wiring mutations are caught (11/12/9).
Desktop and Server Edition retain their own sockets and canvas behavior; existing RPC, projects
blob, pairing, mirror and SSH-visible file contracts are unchanged. **iOS follow-up for @eneskirca:**
adopt the isolated phone socket and atomic creation marker/session metadata for independent shells.

**Focused physical A90 checks pass on the intended Pixel.** Beta8/code9 creates Home, discovered
project and custom-folder shells (spaces/apostrophe/dollar), with verified cwd/input/pre-attach
history, continuous dragging/coast/Esc, rapid double-Create without duplicates and visible
missing-folder refusal followed by a corrected retry. Force-stop/restart retains three PIDs and
history; beta 9/code 10 update, reconnect and same-pane input also pass. Native UI End of custom,
project then Home removes only each selected UUID, retains sibling fingerprints/PIDs and clears
the final Phone terminals group. Eleven desktop sessions/PIDs and nine project/workspace hashes
are unchanged; owned shells/folders/UI dumps are removed and the phone returns to regular Sessions.
Proof: `.nodeterm/android-beta-build-8/a90-pixel-check-20261003/final-focused-results.json` and
`beta9-exact-ui-end.json`. **Item 32 remains Partial; this Oct3 checkpoint was 7 Pass /21 Partial /36 Pending.**
Relay canvas/managed and cellular creation remain pending. The separate A91 otherwise-empty-host
variant passes on beta 9 on 2026-10-04. Broader release checks resumed on 2026-10-04; new outcomes are recorded separately.

**Empty-host refresh fix (`A91`) is delivered in beta 9/code 10.** Ending the last phone shell
on an otherwise empty SSH host returns an authoritative "nothing found" answer. Beta 8
kept its stale cached row; `4d33a5b5` now clears that listing while preserving the error and
connected SSH route. Other failed refreshes keep the last listing, and cancellation propagates.
The full real Gradle suite passes **688 tests / 67 suites**, zero failures/errors/skips (52 seconds),
offline app `compileKotlin` passes (6 seconds), and six isolated Kotlin 2.2/JDK 21 mutants are caught.
Proof is in `.nodeterm/android-beta-build-9/`. No shared host contract changes.
**Physical empty-host variant passes (2026-10-04).** On installed beta 9, the otherwise-empty
private SSH fixture creates and opens a first Home shell. Native End removes its exact row and
Phone terminals group while SSH stays connected. New terminal then creates and opens a second
Home shell, then retained for the beta 10 update and subsequently ended in the A91/A94 flow above. This is not final fixture cleanup.
Proof: `.nodeterm/android-beta-build-9/checklist-20261004/a91-beta9-focused-results.json`.
A94's loading-label correction is delivered in beta 10 and the full installed empty-screen End/recreate/open/End cycle passes.
Item 32 stays Partial; item 1 separately brings the current tally to 10 Pass / 22 Partial / 32 Pending.

**Historical beta-9 delivery:** `0.1.0-beta.9` / code `10`, clean source
`4d33a5b5366c99479b648086649205350c7752b1`, built in 43 seconds and updated the exact intended
Pixel with the retained signer in 6.46 seconds. The pulled installed APK matches SHA-256
`719cfeea1dcf27900dd35692a59004ca07e8261b3f14bd43922f0706b6b4ab54`.
Three owned beta-8 shells survived the update and were rediscovered on beta 9, then all were
ended through verified exact-session cleanup. Historical source CI
[run `37144282865`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37144282865) failed the
device-checklist documentation mapping; debug/release APK and CodeQL jobs passed, private-beta
packaging was skipped. Do not treat it as green; the next push needs its own passing workflow.
This revision maps A91 into item 32 and isolates its Known gaps paragraph. The recorded local
688/67 source baseline predates the final documentation; fresh required gates follow the frozen
docs, and the final exact-head CI receipt is retained separately after pushing.
Independent SDK 36/37 signature/alignment, unchanged signed payloads, R8/service metadata and
source/hash provenance checks pass. The non-debuggable installation preserves install identity,
notification grant and app data; paired relay survival was unverified at that checkpoint and
is now proven by beta9→10 above. Historical receipts:
`.nodeterm/android-beta-build-9/artifact-review.json` and
`.nodeterm/android-beta-build-9/device-install-20261003/receipt.json`; private APK:
`.nodeterm/android-beta-9/nodeterm-android-0.1.0-beta.9.apk`.

**Historical installed beta 8, now superseded by beta 9:** private `0.1.0-beta.8` / code `9`, from clean source
`b88d141528c1051964da07faf22cc7fa923c4846`, using the retained signer. Offline AGP built in
49 seconds; R8 keeps, signature, 16-KB alignment and source/hash provenance checks pass.
Independent SDK 36/37 signature/alignment, unsigned-payload preservation and R8 service-mapping
checks also pass. APK SHA-256:
`d373ad5c1790f714cb4464ad4a0a38c5ba9ab68e35103e54cf3aef5ce53081ce`.
Private APK: `.nodeterm/android-beta-8/nodeterm-android-0.1.0-beta.8.apk`; proof is in
`.nodeterm/android-beta-build-8/`. The exact Pixel 10 Pro / Android 17 received a 28.05-second
same-signer update without uninstalling. Pulled before/after APKs match beta 6 / beta 8, the public
signer matches, and code 9/name beta 8/non-debuggable metadata is confirmed. Install identity and
notification permission remain; the app starts and the existing manual-SSH host entry is present.
Opening that host reconnects over SSH and loads real driven projects. **New terminal** is visible
and enabled/clickable; no existing pane was touched and no terminal was created or ended. This
does not establish creation/persistence/End or paired relay-credential survival. Receipt:
`.nodeterm/android-beta-build-8/device-install-20261003/receipt.json`.
The later beta9→10 paired update above passes item 1 without uninstalling the working app.
Future private betas retain the same signer and increase the version code. Verify real SSH creation/cwd/input/history, disconnect/app-restart
rediscovery and exact End ([item 32](../docs/android.md#device-checklist)). Historical beta-6 proof
and its historical **7 Pass / 20 Partial / 37 Pending** checkpoint are preserved; focused A90
proof changes item 32 to Partial. Item 1 and later item 36 pass, giving current **10 Pass / 22 Partial / 32 Pending**. Debug migration stays
conditional SKIP on the working Pixel.

## What it does

The APK is built by CI. The signed minified beta has real Pixel terminal/copy/keyboard and partial
SSH/link/lifecycle evidence; the feature rows below still require the full device pass. ✓ means the code is written for it and
tested where the layer allows, and the numbered
[device checklist](../docs/android.md#device-checklist) is what will check it.

| | Android | Notes |
|---|---|---|
| Pair by QR (or pasted code, or a `nodeterm://pair` link) | ✓ | E2EE-sealed `/pair`, Ed25519 key made on the phone |
| Add a computer by its SSH address ("Add SSH server") | ✓ | For a computer with no pairing code: a headless Server Edition, or a macOS / Linux host you reach only over SSH. Shows the phone's key line (copy, share, or a one-line command) to add to `~/.ssh/authorized_keys`; Connect pins the SSH host key once the computer accepts that key, and shows the fingerprint to compare. **SSH only**: reachable by LAN/VPN, with no hosted push or relay fallback. Direct Git works on admitted local/driven folders independently of the actions service. A live selected-profile service supplies owned Board writes on Desktop/Server and delivery-only node nudges on Desktop. Current enabled local Linux/macOS tmux hosts also provide managed canvas New over SSH (A111); older hosts need the relay. Phone-owned plain SSH New is separate. Optional saved SSH profile folder supports custom Server data directories (A119). Optional one-time password setup confirms the SSH fingerprint before authentication, installs only the retained public key and verifies a fresh key-only login (A120). No keyboard-interactive/MFA or Windows |
| Direct connection on your network (SSH + tmux) | ✓ | Host key checked against the keys the computer names at pairing, then pinned (trust on first use with a desktop that names none); the tmux socket of the nodeterm on the computer, and the one a desktop that drives the computer over SSH uses (its sessions, project files and status slices are read there too). Finds a Server Edition's data dir |
| From anywhere (relay, E2EE, SAS approval) | ✓ | A current desktop approves the phone at the scan (its relay key rides the sealed `/pair` body), also when remote access is turned on only after pairing; an older one shows a code on the first relay connect |
| Late relay adoption (paired while remote access was off) | ✓ | Reads `~/.nodeterm/relay.json` over SSH, mints its own device token |
| Sessions, grouped like the desktop sidebar | ✓ | Needs you / Running / Sleeping, activity + context % |
| Terminal (co-attach to the live tmux session) | ✓ | xterm.js renderer, native input bar, special keys, swipe = tmux scroll. Tap a link (also one wrapped over several rows, or an OSC 8 link): the phone names its host and opens it only when you confirm, and only an http(s) one. The Copy chip opens a sheet of the screen's lines and links to select and copy or share. A copy the pane sends itself (OSC 52, e.g. vim's `"+y`) reaches the clipboard too, but tmux's copy-mode is out of easy reach on a touch screen |
| Retained terminal history search | both | Find searches all retained host output on the exact stream/pane, literal case-sensitive matches with line numbers and explicit caps; captured Copy search stays local |
| Dictation into the input bar | ✓ | A mic beside Send: Android's speech recognizer writes into the draft and never sends it. Settings → Dictation offers searchable languages/regions and System default; availability depends on the phone's speech service/models. The microphone permission is asked on the first tap; no mic shows on a phone without a recognizer. Not the on-device Whisper of iOS and the desktop (see [Known gaps](../docs/android.md#known-gaps)); the keyboard's own voice typing works too |
| Sleeping (Eco) session opened | ✓ | Relay wakes an eligible owned offscreen/closed-project node without switching tabs. Direct SSH offers an explicit wake tap. Both apply the agent's measured policy and preserve Pause/owner/process guards |
| Cold-start resume offer (the computer rebooted) | relay | Offers the agent's own `--resume <id>`; never types it unasked. Over SSH a session that is not running is never created (it would lack its hook environment): the phone offers to open it through the relay when it is the computer's own; a session another computer's nodeterm runs there, or one no listing names, is not offered the relay |
| Terminal access to the computer's SSH projects | relay | They run on another host; the computer attaches them over its SSH connection. Direct terminal access through this computer needs relay; a current Desktop's SSH actions service can separately handle its owned SSH-project Board metadata and node nudges |
| New session (agent / shell) → registered on the canvas | SSH / relay | Current Linux/macOS tmux hosts create and register the session themselves over SSH (A111). Choose an open local folder project, agent or shell and an available account. Older hosts use the relay route. An uncertain creation is inspected, never sent again automatically; one Pixel 7a manual-SSH plain-shell creation/input/reopen/restart case passes at `40731381`; live-agent and other-route checks remain pending. |
| New plain terminal on an SSH host | ✓ (`A90`, installed beta 10/code 11) | Focused Pixel Home/project/custom cwd/input/history, restart/update/reconnect and exact End pass. Independent Phone terminals group; no desktop canvas/agent registration. Item 32 Partial: relay plain-shell creation/input/End pass, managed and cellular creation pending; A91 empty-host variant passes |
| Wake / refresh / rename / end session | relay and current Desktop SSH service (end: both) | Typed node verbs; SSH service acknowledges nudge delivery. Server has no renderer/node nudges; inspect actual wake/rename result |
| Kanban board, move cards, labels | both on current Desktop/Server | Typed selected-profile SSH service uses the actual WorkspaceStore save queue and mounted change broadcasts. Server serves local owned projects; Desktop can serve its own SSH-project metadata. Older hosts need an allowed relay |
| Source control: status, diffs, stage/unstage, commit, push/pull, recent commits | both | Eight typed verbs, admitted physical folder/repository-root jail, literal filenames and bounded results. Third-machine/no-folder projects refuse; uncertain writes never replay. Resolve merge conflicts on the computer or in a terminal |
| Inbox: approvals, questions, finished turns | ✓ | Request-owned held approvals; Always allow confirms a concrete original rule and scope. Full held Claude questions submit every single/multi selection through hook JSON. Legacy unheld multi-select opens the session; context % when known |
| Read-ack (reading a finished session clears it on the computer) | ✓ | `inbox.ack` over the relay, `~/.nodeterm/acks` over SSH |
| Usage (rate limits per account) | ✓ | From the agent-status mirror, with a pace line ("5h usage pace faster") when the reset time is known |
| All computers: every paired computer's Inbox and Usage on one screen | ✓ | With two or more computers paired: cards newest first across computers, each naming its computer and answered on it; one Usage section per computer that reports usage. Each computer's row shows how many of its approvals and questions are open, from saved snapshots in the host list; All computers watches and refreshes hosts while visible |
| Notifications | local | See "Notifications" below |

## Before using it away from your computer

**Native history scrolling is source-fixed and published at `1add0408`
([A129](../docs/android-audit-2026-09.md#a129), acceptance pending).** Host/Android
source adds negotiated `scrollV1` history pages. Native mouse-off gestures browse a bounded,
viewer-owned snapshot with zero foreground bytes; a valid view stays inert while the live app
changes mouse mode. Live, user input, resize or an explicit new intent closes it, and the next
new intent follows the application's actual requested mouse encoding. Copy and links use the
visible history rows while xterm continues parsing live output underneath. Unsupported/stale
hosts refuse, and uncertain input never replays. Existing known-tmux/direct-SSH wheel and
momentum checks keep their original scope. Leaf/backend recorder tests do not establish
physical Windows ConPTY or phone acceptance. Fresh 1012/105 protocol and offline app checks,
568/52 affected Vitest tests with four existing Windows process-tree skips, full TypeScript and
all-five/ten-step Android CI `37602046133` pass. At that earlier checkpoint, signed beta
18/code 19 was ready but not installed; beta 17 remained installed and the physical
checklist was unchanged. Actual app/WebView acceptance remains unverified.
See [the contract and evidence](../docs/android.md#native-history-scrolling).
iOS adoption of the additive host capability/pages is required for @eneskirca.

**Held Live-button touch ([A130](../docs/android-audit-2026-09.md#a130), focused source fix).**
Touch-down now stops momentum and native pending movement, preserving history and its
display epoch until click. Three new JVM cases pass within 48/7 control/restored checks, and
three semantic mutants fail assertions. The earlier 512-ms/20-request/23-notch failure is
historical. Final gates/CI pass on published `5bda2c32`, and beta 19/code 20 is installed with
measured update preservation. Actual WebView/device behavior acceptance remains pending.

The full device pass is still outstanding. The intended Pixel has the private beta and basic SSH
listing/input works. Its corrected code-3 update (`A85`) fills a 52×45 viewport and shows pre-attach
tmux history after swiping; font and keyboard changes resize the host correctly. The user's intended connection is to this Linux host over their
WireGuard VPN; the user confirms its terminal opens over mobile data with Wi-Fi off.
The user authorized local builds and pushing this branch. Each requested push requires green
Android workflow verification, with no PR requested and `A68` deferred. The beta-3 controlled
scroll checks did not satisfy the user; verify the corrected beta on the intended phone before
calling responsiveness resolved. Beta 5 implements momentum/native stopping but actual drag
still loses its touch target; beta 6 corrects that (`A89`). The SDK-37
packaging follow-up `f5fd3821` passes 39 Python tests against each SDK 36/37 and ten new mutations;
CI4 still failed private packaging. [Run `37061593216`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37061593216)
at `c37798b6495b4b68df379d0ae80887c23104b66d` completed with all five jobs green, confirming
observed CI repair. Any later push still requires its own green workflow.

1. Prepare and install the [private beta](#private-beta) below from a successful local build or CI
   run of the current branch. The desktop must also include the host-side fixes you want to test. Future private beta
   updates use the same private signer and a higher version code, preserving pairings.
2. For a VPN/SSH route, connect the VPN, use Add SSH server and compare the host-key fingerprint
   with the computer. For the relay route, turn on remote access in Settings → Phone, pair, and open the computer in the
   app. If either screen asks for a first relay approval, compare and approve its code there.
3. Turn the phone's Wi-Fi off. Open a terminal over mobile data, send a harmless command, answer a
   question and a held approval, then reconnect after briefly enabling airplane mode. Confirm the
   answers on the computer. For SSH, keep the VPN active and confirm the route stays SSH; for the
   relay route this checks cellular connectivity and action/recovery behavior; the current live
   join contract already passed the controlled relay-only browse check.
4. Keep the computer awake, nodeterm running, and the intended project/session mounted and awake.
   For the relay route, keep remote access on. Current hosts support offscreen Sleeping wake
   (A104); its remaining physical checks are pending. Background notifications use Android's periodic worker and may take longer than 15 minutes; there is no FCM.
5. Record these results, then finish the [64-item device checklist](../docs/android.md#device-checklist).
   A successful build or cold start alone does not verify pairing, input or connectivity on the phone.

## Build

```bash
cd android
./gradlew :app:assembleDebug          # → app/build/outputs/apk/debug/app-debug.apk
./gradlew -p protocol test            # the wire layer; see below
```

Needs JDK 17–24 and the Android SDK (Android Studio's, or `ANDROID_HOME`). `minSdk` 26, `targetSdk` 35.
Android Studio's bundled JDK works, and CI uses 17. JDK 25 does not: the wrapper's Gradle 8.14.3 cannot
run on it (its embedded Kotlin compiler rejects the version while compiling the build scripts, so
`./gradlew` stops before configuring anything); that needs Gradle 9.1 or newer. Point `JAVA_HOME` at a
17–24 JDK if your default is 25.
CI builds the debug APK on every change under `android/` or to the desktop code the protocol tests
run (`.github/workflows/android.yml`; its path filter says which) and attaches it to the run. The
debug APK is not minified. Only the release build type runs R8 (`app/proguard-rules.pro`), and CI
builds it too, attaching unsigned build inputs
(`./gradlew :app:assembleRelease`, then `tools/check-r8-output.sh`). A missing `-dontwarn` therefore
fails CI rather than a first release (R8 reports the missing class), and so does one of the keeps the
script checks when it stops matching (the WebView bridge, the worker, BouncyCastle's provider tables,
one exception name). A keep that NEW reflection needs is not detected, because R8 renames or drops
such code without a word; add the keep and a line in `tools/check-r8-output.sh`. None of this proves
a minified APK fully works on the intended phone. The private beta has listed actual projects and
delivered basic terminal input over SSH; the corrected update exposes pre-attach tmux history.
The full device pass remains open.

## Private beta

This path prepares an APK for your own phone. The private signing key and signed APK stay on your
machine. The user authorized a local build for this first beta. The first unsigned release built
with AGP 8.9.1 emitted R8 Kotlin-metadata warnings (`A83`). The corrected AGP 8.10.1 release at
`fa71cb08072f399f24a81bfb361ea852a0275f3b` completed, including an offline rebuild and every R8 keep
check, with those warnings gone. The privately signed `0.1.0-beta.1` (code `2`) was installed on an
MI8 running Android 15 / API 35; after its first notification permission dialog, it showed the empty
Computers screen, Pair button and Settings with no crash markers. Installed metadata and refused
`run-as` confirm it is non-debuggable (minSdk 26, targetSdk 35). Its WebView is
`com.android.webview` `144.0.7559.76`. The user then identified this as the wrong phone. Only the
newly installed app and its test UI dump were removed; its newly authorized SSH key was removed
and the host's `authorized_keys` was restored byte-for-byte. It had no paired host, and no SSH
connection was attempted. At that stage the same code-2 beta was installed on the intended Pixel 10 Pro,
Android 17 / API 37, Vanadium WebView `154.0.8037.92.0`. The user granted notifications normally;
`run-as` is denied. Manual Add SSH server connects to this Linux host, with the authorized phone
key preserving existing authorized entries and the Ed25519 pin matching its public key. The app lists 17
actual projects and a harmless terminal command entered on the phone executed in a controlled
temporary tmux window. The intended route is this host through the user's WireGuard VPN; the user
confirms its terminal opens over mobile data with Wi-Fi off. That code-2 terminal was one row (`A85`), and swiping did not expose old
history. The fix in `febe022a` supplies `MATCH_PARENT` WebView layout parameters; its Gradle
wiring guard and two mutations pass. Actual beta `0.1.0-beta.2` (code `3`) passed its offline AGP
release build in 45 seconds, retained-signer verification and in-place update. Host configuration,
SSH key/pin and notification grant stayed intact. The controlled terminal now fills 52×45, and a
downward swipe entered tmux copy mode and visibly showed rows printed before update/attach.
Inputs/logs are in `.nodeterm/android-beta-build-2/`; APK/checksum/metadata are in
`.nodeterm/android-beta-2/`. APK SHA-256:
`a022a399e23c81607a4a3664862b964ad781f0a589ab77dda902b4c2dc597eca`.
A− restores 56×48, the keyboard changes it to 56×25 and hiding the keyboard returns 56×48.
Esc leaves copy mode, and Send executes a second harmless draft command with its whole output line.
Only the owned temporary test window was removed; the original window/process and intended-phone
configuration remain.

**User-reported mobile check:** with WireGuard enabled and Wi-Fi off, the user confirmed that the
intended Linux host's terminal opens over mobile data. This is separate from the ADB-assisted LAN
checks above. Mobile reconnect, approvals/questions, background behavior and the full 64-item
checklist remain open.

History regressions in `d6619bf6` pass 47 focused real Gradle SSH/terminal/link tests with zero skips. Both JavaScript swipe-direction/disabled-scroll mutations, the real-SSH wheel-direction mutation and the two native layout-policy mutations were caught; production sources were restored. **Beta-2 verification:** all 609 protocol tests passed in 59 suites with zero failures, errors or skips (52 seconds); the offline app `compileKotlin` passed (7 seconds).

**Historical A86 beta-3 update:** private `0.1.0-beta.3` / code `4` from
`40c4ee49592e2f92fc7e6e9b548ba88a33b1e2d3` built locally in 49 seconds, passed every R8 keep
and retained-signer packaging. Signature, alignment and source/hash provenance passed, with all
149 ZIP payloads unchanged by signing. APK SHA-256:
`dda44df7ebb541afccd18b428634d66246349ccb62fd202917b77a333fbadba3`.
The intended Pixel updated in place and preserved manual SSH registration/key/pin and notification
permission. It reopens the Linux host over SSH with a 56×48 test terminal. Five identical controlled
swipes finish at history position 25 versus beta 2's 85; reversal moves 25 to 20 and Esc leaves
copy mode. The phone returned to Sessions and refreshed; only the owned test session was removed,
with user panes untouched. Private proof/screenshot/package checks are in
`.nodeterm/android-beta-build-3/`, including `device-checks.json`. These verify drag gain/order/input
cancellation, not perceived smoothness or FPS. The user subsequently reports both lag and too
little movement; the current `A87` correction supersedes this gain policy. At that checkpoint,
restored-source checks passed all 638 protocol tests in 61 suites with zero failures, errors or skips (51 seconds),
and the final offline app `compileKotlin` (7 seconds). Thirty SSH/JavaScript/actor/wiring mutations were
caught. The later controlled phone trace records sparse updates and does not establish terminal FPS.
At that checkpoint, actual feel, custom wheel bindings and kinetic fling remained open under `A86`.
Push is authorized; each requested push requires green
Android workflow verification.
The matching phone trace records 42 bridge invocations versus 12 and 25 distinct presentations
versus 11 over twelve gestures; first invocations occur at 25–36 ms versus 84–90 ms. These show
more delivered updates, without establishing terminal FPS or end-to-end SSH latency.

**Historical stable-touch beta (`A89`):** `0.1.0-beta.6` / code `7` uses source
`c4b1f6cf1009f293a658b6331d2ed1ab80aa36c6`. It targets the stable xterm screen behind changing
rows. Real-bundle redraw regression delivers 24 notches versus one with a detached touch target.
All 658 protocol tests in 63 suites and offline app `compileKotlin` pass; 35 JS, eleven native
and three CSS mutations were caught. Actual AGP release built in 43 seconds and passed every
R8 keep. Retained-signer packaging verifies non-debuggable metadata, signature, 16-KB alignment
and source/hash provenance; all 149 ZIP payloads remain unchanged by signing. APK SHA-256:
`4947133a6ccf9c2b1e775e76d7c24f564e087cf036e59eac4dca08162a076d3c`.
The intended Pixel received a same-signer update preserving app data; notification permission
is confirmed. SSH reopened with the retained key/pin at 56×48. A slow swipe produced 23 position
updates; a fast swipe kept moving for about 799 ms after its ADB command completed, and Esc
left copy mode for the following 1.4 seconds. A held touch stops coast at a stable 56×25 viewport,
with position unchanged through CANCEL after 1.2 seconds. Earlier keyboard-resizing touch checks
were inconclusive. The user confirms normal continuous dragging and coast both work now.
The final user check also confirms beta-6 manual-SSH connection and smooth scrolling on cellular WireGuard with
Wi-Fi off; cellular hosted relay remains untested. Reversal/lifecycle, FPS/custom-binding checks
and full device validation remain open
in the [handover](../docs/android-handover.md#progress-log).
Testing returned the app to Sessions, detached the owned client and removed only its exact owned
tmux session and phone UI XML; private `device-summary.json` records cleanup.

**Historical kinetic beta (`A86`):** `0.1.0-beta.5` / code `6` uses source
`1ad2e94455a7adfb85d41212b12d36df39695324`. A fast release starts bounded decaying movement;
new touch/input/reset/font/lifecycle barriers discard unsent scrolling, preserving accepted
keys/replies and the in-flight operation. Bytes already handed to SSH's writer/network cannot
be recalled. All 658 protocol tests in 63 suites and offline app `compileKotlin` pass; 35 JS and
eleven new native mutations were caught. Its actual AGP release built in 47 seconds and passed
every R8 keep. Retained-signer packaging verifies non-debuggable metadata, signature, 16-KB
alignment and source/hash provenance. APK SHA-256:
`7cc68d384aeb21ab40800fa7c83f006dfbfefba16dd2e945967c8c5376f17655`.
The intended Pixel updated in place with notification permission intact, but its continuous
swipe still stops and shows no coast after the ADB swipe command completes. This actual failure led to `A89`; it is
not momentum-success proof. The newer beta-6 checks and user confirmation above establish
drag/coast success.

**Packaging CI (`A88`, `f5fd3821`):** CI run `37058184031` passed its four main jobs but failed private
packaging. Real SDK 37 reproduces the new `V3.0 Signer:` format; the follow-up accepts exact
scheme labels while retaining one pinned certificate and verified v2. All 39 Python tests pass
against each SDK 36/37, and ten new parser/fixture-selection mutations are caught. The fixture
now uses CI's installed SDK 36/platform 35 explicitly. [Run `37061593216`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37061593216)
at `c37798b6495b4b68df379d0ae80887c23104b66d` completed with all five jobs green, confirming
observed packaging repair.

**Historical beta-4 correction:** source `3cffb49d8cf64932260e914b42b3883331d0352d`, version
`0.1.0-beta.4` / code `5`, retains the same signer. All 646 protocol tests in 62 suites pass with
zero failures, errors or skips; offline app `compileKotlin` passes (8 seconds). Real xterm
focus/mouse/query reports preserve gestures, while actual keyboard/paste/IME input cancels them;
22 JavaScript and nine actor/native-wiring mutations were caught. `fed68fb3` verifies newer SDK
signer labels without relaxing the expected-certificate/v2 policy; 32 Python tests and ten
mutations pass locally. At that checkpoint, CI repair still required confirmation; the later
`f5fd3821` follow-up and green run above provide it.
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

The original workspace holds the input provenance in `.nodeterm/android-beta-build-1/` and the
first finished APK/checksum/metadata in `.nodeterm/android-beta-1/`. At that first-beta checkpoint,
QR/code pairing, relay and mobile reconnect/background/answer checks remained open. The initial full protocol run passed 603 of 605 tests; the two SSH
harness-isolation failures (`A84`) are fixed in tests only (`1d6b04cc`). The earlier A84 full rerun passed
all 606 tests with zero failures, errors or skips, and both harness mutations were caught. CI was waived for the first local build;
every newly requested push still requires green Android workflow verification. Actions
artifacts on a public repository are downloadable by other signed-in users, so they contain only
unsigned build inputs and checks.

1. Obtain verified unsigned release inputs, using the authorized local build or CI. Each later
   beta update needs a higher version code and the same private signer.

   **Local build:** use JDK 21, the Android SDK and a clean committed source revision. From
   `android/`, select the beta versions, build with the pinned wrapper, and check the R8 keeps:

   ```sh
   NODETERM_ANDROID_VERSION_CODE=13 \
   NODETERM_ANDROID_VERSION_NAME=0.1.0-beta.12 \
     ./gradlew :app:assembleRelease --stacktrace
   sh tools/check-r8-output.sh app/build/outputs/mapping/release
   ```

   After both commands succeed, record the actual APK/R8 hashes in `beta-build-inputs.json`. The
   packager requires these keys; `buildOrigin: "local"` distinguishes this from CI. From the same
   `android/` directory, the following records version `13` / `0.1.0-beta.12`:

   ```sh
   python3 - <<'PYTHON'
   import hashlib, json, pathlib, subprocess
   def sha(path):
       with path.open('rb') as stream:
           return hashlib.file_digest(stream, 'sha256').hexdigest()
   apk = pathlib.Path('app/build/outputs/apk/release/app-release-unsigned.apk')
   r8 = pathlib.Path('app/build/outputs/mapping/release')
   pathlib.Path('app/build/outputs/beta-build-inputs.json').write_text(json.dumps({
       'schemaVersion': 1,
       'buildOrigin': 'local',
       'sourceRevision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
       'versionCode': 13,
       'versionName': '0.1.0-beta.12',
       'unsignedApkSha256': sha(apk),
       'r8MappingSha256': sha(r8 / 'mapping.txt'),
       'r8SeedsSha256': sha(r8 / 'seeds.txt'),
       'signed': False,
   }, indent=2) + '\n')
   PYTHON
   ```

   Keep those files from that same successful build together. Require the full protocol tests,
   app/desktop type-checks and relevant desktop tests; a completed AGP build alone is not proof of
   their results. AGP 8.10.1 supports this build's Kotlin 2.2 metadata (`A83`); do not use the earlier
   warning-producing APK as the final beta.

   **CI alternative:** dispatch registered workflow `366764274` through the GitHub API or CLI
   on the intended branch ref with **prepare_beta=true** and explicit beta version code/name.
   Verify the resulting run's exact `head_sha` matches the source commit. Registered workflows
   can use API/CLI dispatch on other refs; the UI Run button has a separate default-branch rule
   ([GitHub workflow_dispatch documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)).
   Feature-branch pushes do not prepare beta inputs. Wait for all five jobs: **Protocol**, **App**,
   **App release (R8, unsigned)**, **Private beta checks** and **CodeQL (Kotlin)**.
2. For CI, download `nodeterm-android-release-unsigned`, `r8-release-outputs`, and
   `nodeterm-android-beta-build-inputs` from that same run and extract them into separate directories.
   For either path, use the exact `sourceRevision` and version fields in `beta-build-inputs.json`.
   The unsigned APK cannot be installed.
3. Use a private Android signing keystore you keep outside version control, preferably outside the
   checkout. This first-beta session has prepared one in the original workspace's already ignored
   `.nodeterm/android-beta-signing/`: alias `nodeterm-beta`, certificate pin in
   `signing-identity.json`, and separate password files. Keep that entire directory backed up
   privately; it is not included in the source bundle or patch. If starting on another machine
   without an existing private signer, create one with JDK `keytool -genkeypair` and retain it for
   all later updates.
   Record the certificate's SHA-256 fingerprint using `keytool -list -v`; this public fingerprint
   is the expected signer pin. The committed `app/debug.keystore` is public and the packager rejects
   it. Keep the keystore and passwords backed up privately; changing the signer prevents updates.
4. Put each password in a separate local file with permissions `0600`, containing one password line.
   On Linux or macOS with Python 3.11+, a JDK, and Android build-tools 36.0.0, run the following from
   the checked-out repository. Replace the local paths and fingerprint with yours; take the versions
   and revision from the local-build or downloaded input metadata.

   ```sh
   python3 android/tools/package-beta.py \
     --apk /path/to/unsigned/app-release-unsigned.apk \
     --r8-dir /path/to/r8-release-outputs \
     --build-inputs /path/to/beta-build-inputs.json \
     --keystore /private/path/android-beta.p12 --key-alias nodeterm-beta \
     --store-password-file /private/path/store-password \
     --key-password-file /private/path/key-password \
     --expected-signer-sha256 YOUR_CERTIFICATE_SHA256 \
     --version-code 13 --version-name 0.1.0-beta.12 \
     --source-revision FULL_COMMIT_SHA_FROM_BETA_BUILD_INPUTS \
     --build-tools-dir "$ANDROID_HOME/build-tools/36.0.0" \
     --output-dir /private/path/nodeterm-beta-1
   ```

   The output directory must be new or empty. The tool matches the APK and R8 checksums to the input
   metadata from that local build or CI run, and checks the package, versions, SDK levels,
   `debuggable=false`, R8 runtime keeps, alignment and the APK signature. Only after those checks
   pass does it produce the APK, its `.sha256`, and `beta-metadata.json` with the signer and source
   revision. This verifies packaging; it does not prove the app works on a phone.
5. Verify the checksum in the output directory (`sha256sum -c *.sha256` on Linux, or
   `shasum -a 256 -c *.sha256` on macOS). Sideload that APK onto your phone, then run the mobile-data
   preflight above and the [device checklist](../docs/android.md#device-checklist), including item 5
   on this minified build.

If the public debug build is already installed, Android will reject the private signer as an update
to it. Moving to the private beta requires a deliberate one-time uninstall through Android
settings; uninstalling deletes every pairing and the phone's identity. Revoke the stale
phone entries on the computers and pair again. The packager never uninstalls or installs anything.
Clearing storage alone does not change an installed APK's signing certificate; uninstall the debug
APK before installing the private one.

Every CI job that runs `./gradlew` first checks `gradle/wrapper/gradle-wrapper.jar` against Gradle's
published checksums (`gradle/actions/setup-gradle`, which also caches `~/.gradle`). Dependabot opens
weekly Gradle update PRs for `android/`, the protocol build and the wrapper included (not for
`tools/typecheck`, whose pins follow the app's by hand). The protocol's network and crypto libraries
(okhttp, sshj, eddsa, BouncyCastle) come in a PR of their own, so an androidx bump the app cannot take
yet (one that demands a higher `compileSdk`, say) does not hold them back. CodeQL analyses the app's
and the protocol module's Kotlin (`.github/workflows/android.yml`, job `CodeQL (Kotlin)`) whenever
that workflow runs: on a `main` push or a pull request that changes an Android-relevant file,
and by hand (`workflow_dispatch`). There is no `merge_group` trigger. A pull request that changes none is
compared with `main`'s analysis. There is no weekly re-scan of unchanged Kotlin, and the job is not a
required check. `GradleCiCoverageTest` pins all of this. The wrapper properties carry no
`distributionSha256Sum` yet, so the Gradle distribution itself is not pinned.

**Debug builds are signed with a public key that is committed on purpose**
(`app/debug.keystore`, password `android`). That is what lets you install a newer CI or local
debug APK over an older one without uninstalling — uninstalling wipes every pairing. The other side
of "public": anyone can sign an APK that installs as an update over a debug build and inherits its
data, including the keys your computers trust. **Install debug APKs only from this repository's CI
or your own build.** Private release builds use their own retained signer; this first-beta session
has prepared it in ignored local state and installed the signed beta; full phone validation is pending. Debug builds
are also debuggable, which hands the phone's pairing credentials to anyone with adb access to it
(see [Security](#security)).

## Layout

- **`protocol/`** — everything that goes on the wire, as a plain Kotlin/JVM library with no Android
  dependency, so it is tested on a JVM: NaCl box (a TweetNaCl port), the relay client, the host
  RPC vocabulary, pairing, the direct-SSH transport, and the parsers for what the computer serves.
  Its tests run the **desktop's own code** on the other end of the wire — `connectHostSession` and
  `createPairingService` through a local relay broker (`src/test/interop/host-fixture.ts`, bundled
  with the repo's esbuild and type-checked by the repo's `npm run typecheck` against the desktop
  interfaces it implements), and the SSH transport against a real SSH server and a sandboxed tmux.
  They need node and the repo's `node_modules` (esbuild, ws, tweetnacl) and skip without them; a
  desktop checkout's existing `npm install` is enough. `npm ci --ignore-scripts`, which CI runs, is only
  for a machine without the native toolchain: `npm ci` deletes `node_modules` first and the flag skips
  the node-pty patch and build, so over a working desktop checkout it leaves node-pty unpatched (on
  Linux, where node-pty ships no prebuild, not built at all) and `src/main/node-pty-patch.test.ts` red
  until you run `npm install` or `npm run rebuild` again (`bootstrap-windows.bat` on Windows). The
  SSH tests need tmux and `script(1)` (util-linux on Linux, BSD on macOS) and skip without them.
- **`app/`** — the Compose UI on top: pairing, adding a computer by its SSH address, the computers
  list (each with its needs-you count),
  a computer's Sessions / Board / Inbox / Usage tabs, the All computers screen (every computer's
  Inbox and Usage), the terminal screen (with dictation into its input bar), a project's source
  control, settings, background notifications.

## Notifications

The background check never makes a first relay connection (that would put the approval dialog on
an unattended computer): it uses the relay only for a computer that has already approved this
phone. After Deny, or an approval nobody answered, the app stops re-dialing the relay until you tap
Try again or open that computer.


The iOS app is woken by APNs pushes the nodeterm backend sends. That backend has no Android (FCM)
leg, so this app polls instead: checked about every 15 minutes in the background (WorkManager's
floor), and live while the computer or All computers is on screen. An individual computer or
terminal refreshes its host every 8 seconds; All computers refreshes every paired host while visible.
Other paired computers are not polled while you look at one individual computer, so their notifications still come from
the background check only. That includes a computer you just left: the app may still hold its
connection for a while, but no longer re-lists it when it pushes a change. All computers stops its
polls when it leaves the screen and closes connections after their last active user finishes.
Real-time push on Android needs an FCM leg in the backend. A computer added by its SSH address is
polled the same way, over SSH: the push a Server Edition gives an iOS phone is APNs-only.

The live check leaves out what you are looking at: nothing of a computer is announced while its
Inbox tab (or the All computers Inbox) is on screen, and nothing a session's terminal shows while it
is attached. Those events count as seen, so no later check announces them either. An approval the
computer is holding for an answer (a hook-reply approval) is still announced with its terminal open,
because Claude paints that prompt only once the hold ends. A terminal that shows an error, a relay
offer or an approval code instead of the session hides nothing, and one still connecting leaves the
session's events for the next check.

Tapping a notification opens that session's terminal; Back from it lands on the computer's Inbox. An
approval's notification carries **Approve** and **Deny**, and a question's carries its options when it
has at most three ("Option 1", "Option 2", …, or their text with **Show details in notifications**
on), wherever the Inbox card could answer it in one tap: a held approval (any agent's) or a Claude
prompt, a single-select question. Anything else carries **Open**. An answer needs an unlocked phone
(Android 12 and later ask for the unlock; on older versions the notification says to unlock first).
It goes over your network or through a relay that has already approved this phone, never through a
first relay connection, for the same reason as the background check. The phone cannot tell in
advance whether it is on the computer's network, so a computer paired with an SSH key always gets
the answers: tapped away from that network, the answer goes through the relay if it has approved
this phone, and otherwise is not sent ("couldn't reach"). The notification then says how it went
("Approved.", "Already handled.", or why nothing was sent, with a tap that opens the session). An
answer is sent at most once: if Android interrupts it and runs it again, the second run sends nothing
and the notification says the answer could not be confirmed. A notification left in the shade after
its request was settled and dropped from the computer's list (after 6 hours, or 50 later events)
types nothing into whatever prompt the session shows by then: it says to answer in the session.

Each Inbox event raises at most one notification: only events younger than 6 hours are announced,
and the phone remembers, for each computer, the ones it has announced, you have read or you had on
screen for a day after it last saw them (longer when the computer's clock runs ahead), so nothing
still eligible is forgotten. Forgetting a computer forgets that too; pairing it again keeps it. One
event can reach the phone through two computers: a paired desktop lists the sessions of its SSH
projects, and so does the SSH server they run on when you added that one too. It is still one event:
announcing, reading or looking at it under either computer counts for both.

A notification names the session, the computer and the kind of event ("Needs you — build-bot",
"Needs approval"), but not the event's own text: the command, file or question, or the agent's last
message. Android shows a notification's full content on a secure lock screen unless you hide
sensitive content there. **Settings → Show details in notifications** (off by default) adds that
text. A lock screen set to hide sensitive content shows only the title ("Needs you — <session>", or
"Completed — <session>" for a finished or interrupted turn) and the computer's name either way. The
iOS app does receive the detail, in the push the desktop sends.

## Security

- The phone's relay identity (a Curve25519 box key) and SSH identity (an Ed25519 seed) are
  generated on the device and stored encrypted under an Android Keystore AES-GCM key. Only their
  public halves are ever sent anywhere; the next point is how the private halves can still be taken.
- **The debug APK is debuggable.** AGP marks every debug build
  `android:debuggable`, so anyone with adb access to your unlocked phone while USB debugging is on
  (from a computer the phone has authorized, or by accepting the prompt on it) can read the app's
  files with `adb shell run-as dev.nodeterm.android` and attach a debugger to the running app. The
  Keystore never hands out the key those files are sealed under, but it lets any code running as the
  app use it, so that is enough to pull the phone's pairing credentials: the SSH private key your computers
  accept, the relay box secret and the relay device token. A signed, non-debuggable release build
  has been built and privately signed through the [private-beta path](#private-beta). Its wrong-test-device
  installation was removed; the intended Pixel now has the same private beta, with `run-as` denied.
  Real Pixel paired update, SSH/input/font/history, clipboard and keyboard checks work; ten complete checklist
  items pass, and encrypted paste pairing/live relay browse/input plus synthetic shipped-hook
  Approve/Deny/expiry and mounted relay question/copy-mode answers also work. QR/cellular-relay/SAS/worker
  and remaining device variants remain unverified. Keep USB and wireless debugging off when not using them.
- **If someone else may have had adb access, pairing again is not enough.** The phone keeps its SSH
  key, its relay box key and its relay device id through a re-pair, so each computer would trust the
  same keys again. Give the phone a new identity before it pairs:
  1. Revoke every entry for this phone on each computer (nodeterm → Settings → Phone → Revoke).
  2. Uninstall the app, or clear its storage (Android Settings → Apps → nodeterm → Storage → Clear
     storage; the names vary by phone). Either one deletes the app's stored keys and every pairing,
     and the app then makes a new SSH key, relay box key and relay device id.
  3. Pair each computer again.

  A computer without Pro cannot revoke the old relay device token at the relay (that request is
  signed with the Pro entitlement), so whoever took it may still reach that computer through the
  relay with the old box key. For a confirmed recorded last-key revoke, the computer unpins that key and refuses it until restart, then requires approval again. Missing key association/revoker is unconfirmed; another pairing authorizing the same key is retained (A113). Read the Settings outcome before assuming remote access ended. Approve only while your own phone shows the same code.
- Dictation (the terminal input bar's mic) goes through the phone's speech recognition service,
  which on most phones is Google's and may send what you say to its servers; it is not the on-device
  Whisper of the desktop and iOS. The microphone is used only after a tap on the mic, until the
  sentence ends or the terminal screen leaves, and the app keeps no audio. Type anything you would
  rather not send to that service.
- Nothing of the app's goes into a backup or a phone-to-phone transfer. `allowBackup="false"` stops
  cloud backup, and the manifest's data extraction rules stop the Android 12+ device-to-device
  transfer, which ignores `allowBackup`. A new phone starts unpaired; pair it again.
- The relay device id goes with the relay key: from this build on, if the key ever has to be
  created again (it was lost), a new device id is minted with it, so the phone does not present an
  old device id with a new key. A phone whose key an older build already replaced keeps its device
  id until the app is reinstalled.
- Relay traffic is end-to-end encrypted (NaCl box under a per-session HKDF key) and checked exactly
  as the desktop checks it: role byte (no reflections), strictly increasing sequence numbers (no
  replays), no re-key once ready, and the host key pinned from pairing.
- The computer names its SSH host keys in the sealed pairing answer, and the phone's first connect
  must present one of them; a server that does not is refused before the phone's key is offered. An
  older desktop names none, and the first connect is then trust on first use. Either way the key is
  pinned on the first connect that authenticates (a server that refuses the phone's key is never
  pinned). A changed key is never used over SSH; in Auto the phone goes on to the relay, which
  verifies the computer separately, and shows a warning. If the computer's SSH server uses a host key
  nodeterm on the computer cannot read (one with no readable `.pub` beside it, or one named only in a
  config file that only root can read), SSH to it stays refused even after pairing again, which re-reads the
  same keys; the relay still reaches it (see Known gaps in `docs/android.md`).
- Over the relay (and only there) a current desktop also reports its LAN address and SSH host keys
  as they are now, and the phone updates the computer from that: the address it dials on your
  network, and the pin, but only for a key the phone was just refused on your network that the
  computer confirms is one of its own (the next connect then has to present one of its keys). A pin
  that still works is kept, even when the computer does not list it. So a moved address or a
  reinstalled computer's new key needs no new pairing; the new key is accepted on the connect after
  the one that met it. Nothing learned over SSH ever changes them. A host certificate is pinned as the
  key it certifies, so a renewed certificate is not a changed key.
- A computer added by its SSH address has no pairing behind its first connect, so compare the
  fingerprint the Add screen shows with the computer's own (the screen gives the `ssh-keygen`
  command). A changed key stops it; forget it and add it again only if you know why it changed. To
  revoke the phone there, remove the line ending in `nodeterm-android` from that user's
  `~/.ssh/authorized_keys` (the same key every pairing installs, under another comment). The phone
  can use a password once for explicit key setup, after you confirm the displayed host fingerprint
  (A120). It never saves that password; ordinary connections use the retained phone key.
- No cleartext HTTP anywhere; the LAN `/pair` POST runs over a raw socket and is sealed to the host
  key from the QR. Its answer is read as untrusted: at most 64 KiB, within 45 seconds.

Design notes, the protocol mapping and known gaps: [`docs/android.md`](../docs/android.md).

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
See [the verification notes](../docs/android.md#what-is-verified-and-how) and [audit A124](../docs/android-audit-2026-09.md#a124) for precise evidence and scope. Private physical proof:
`.nodeterm/android-pixel7a-device-y0ia4hm_/physical-repair-result.json`.
The original Pixel 10 Pro beta-10 ledger stays paused at **10 Pass / 22 Partial / 32 Pending**.
No wire/file contract changes; @eneskirca can note the shared host benefit for iOS.

Next: continue the remaining background/lifecycle/outage, notification/answer/permission and
live-provider device matrix using fresh owned fixtures. Single-case success does not verify
managed End, power loss, original Pixel update/migration, QR/relay/cellular routes, FPS or all
64 checklist items. A25/A93 backend dependencies and other-platform checks remain separate.

## Native custom wheel checks (2026-10-06)

A86 now has a real SSH/tmux regression for both copy key modes, custom host gains, chunked distance
and queued reversals. All eight settled native positions and control/restored runs pass; three
transport regressions fail the intended distance assertion. Original bindings/options are restored.
See [the native receipt](../docs/android.md#native-custom-wheel-checks-2026-10-06).
This adds test coverage without changing beta 16, production transport or iOS wire/file contracts.
Phone custom-binding/lifecycle/FPS, the broader release matrix and A25/A93 backend work remain open.
The original Pixel checklist remains paused at **10 Pass / 22 Partial / 32 Pending**.

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
See [audit A125](../docs/android-audit-2026-09.md#a125) and [audit A126](../docs/android-audit-2026-09.md#a126) for exact evidence.

**Two-host follow-up (2026-10-06).** One Linux Desktop soft/none case at `59e4c93e` passes in
27.39 seconds: an ordinary quiet B park/adopt cycle, then inactive B's continuously open global
card reconnects while A remains active and unchanged. Three native `g` ACKs, two complete URL
activations, zero unexpected input, one paint per role, same-grid retained history and exact owned
cleanup pass. Carried SID provenance is primary create/native Canvas `g1` plus unchanged writer/
subscriptions/client; no adopted Canvas-input/current SID-ref result is claimed. See [the bounded two-host follow-up](../docs/android.md#inactive-global-card-owner-and-bounded-parkadopt-2026-10-06)
for exact source/proof hashes and the remaining scope; no new repair or product test count is added.

Actual Canvas mounting and selected-view native keyboard recovery pass in the eight-case matrix;
one additional two-host soft/none case verifies a quiet park/adopt cycle and inactive global-card
recovery with the active host unchanged. See [the bounded two-host follow-up](../docs/android.md#inactive-global-card-owner-and-bounded-parkadopt-2026-10-06). Remaining Android release acceptance needs a
reachable intended phone for lifecycle/outage, answer/notification/permission and live-provider
checks; A25/A93 need hosted-backend maintainers. Further host coverage includes streaming/expiry/
eviction while parked, repeated or broader outage/backoff, Server/cross-window response ownership,
GPU pressure/full-frame display output and macOS/Windows. The synthetic key-only hosts do not
establish real-user PAM, power-loss, agent-launch or ordinary Quit behavior. Unsupported private
xterm shapes warn and retain input but may duplicate replies; legacy onBinary is unchanged.
No Android wire/file or iOS client change is required. The original Pixel 10 Pro ledger remains
paused at **10 Pass / 22 Partial / 32 Pending**.

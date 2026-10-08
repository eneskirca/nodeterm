# Android companion: audit findings (2026-09-25)

Generated from the adversarially verified audit run `wf_cfa3d2db-264` (170 agents). Six auditors covered build, protocol, runtime, security, iOS parity and CI/docs; a completeness critic ran afterwards. Refuters checked every finding against the source (two refuters for high/critical findings), then an impact judge re-rated its severity. **All 77 findings survived and none were refuted.** Treat that with some caution: a fix session should re-read the cited code before changing it. Line numbers refer to commit `2f58918`.

Severity is the impact judge's rating, not the auditor's claim. **BLOCK** means the judge said it blocks a first sideloaded release. Effort is the judge's estimate.

Prioritised plan and handover: [`android-handover.md`](android-handover.md).

**Status of fixes.** A fixed finding is marked `✅ fixed in <sha>` in the index, and a finding
deliberately not built is marked `📝` with the reason; its section below
keeps the original audit text (line numbers still refer to `2f58918`). Continuation findings
`A78`–`A80` were confirmed against cached branch tip `6afd8f53` on 2026-10-02; their local
fix commits were initially checked only within a restricted sandbox. Later local AGP work found
`A83`, and the first full local protocol run found the test-isolation fault `A84`; current build,
full-suite and phone verification are tracked in the handover. The private APKs use authorized
local builds; each requested push requires green Android workflow verification. Where the fix departs from
the audit's proposal, the handover's progress log says how and why.

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

## Index

**Native custom-wheel checkpoint (2026-10-06, A86).** Both tmux copy key modes pass eight
settled positions over real SSH and the input actor; three native distance mutants are caught.
The [native receipt](android.md#native-custom-wheel-checks-2026-10-06) distinguishes this coverage
from the later bounded Pixel 7a custom-binding/lifecycle cases; the wider gesture/reversal,
lifecycle and FPS matrix remains open.

| ID | Sev | Block | Effort | Area | Title |
|---|---|---|---|---|---|
| [A01](#a01) | high | BLOCK | small | build/bug | ✅ fixed in `af1f820` · Direct-SSH terminal writes and resizes run on the Android main thread, which breaks the SSH connection as soon as the keyboard opens |
| [A02](#a02) | high | BLOCK | small | protocol/bug | ✅ fixed in `e7c22eb` · SSH browse looks for the desktop's userData under 'nodeterm', but the desktop writes it under 'node-terminal', so every direct-SSH listing comes back empty |
| [A03](#a03) | high | BLOCK | small | protocol/bug | ✅ fixed in `cd69a1e` · The direct-SSH tmux client starts without a UTF-8 locale, so tmux replaces every non-ASCII character with '_' |
| [A04](#a04) | high | BLOCK | small | runtime/bug | ✅ fixed in `af1f820` · SSH terminal writes and resizes run on the main thread, and the NetworkOnMainThreadException that runCatching swallows leaves sshj's cipher state out of sync, which drops the whole SSH connection |
| [A05](#a05) | high | BLOCK | small | runtime/risk | ✅ fixed in `3d36d60` · The background InboxWorker can open a never-approved relay handshake and raise the desktop's SAS approval dialog while the phone shows no code |
| [A06](#a06) | high | BLOCK | small | security/bug | ✅ fixed in `16706f4` · approvals.answer reports success for a hold that already timed out, and clears NEEDS YOU on every surface |
| [A07](#a07) | high | BLOCK | medium | critic/bug | ✅ fixed in `0fa0646`; follow-ups `c199349`, `a988a30` (revoke closes a live relay session), `f66fddf`, `07b7276` (a late-adopting paired phone is approved on its first handshake) · Remote access fails the first time you are away from the computer: Auto never does the first relay handshake while the phone is at the desk, and pairing does not pin the phone's relay key |
| [A08](#a08) | high | BLOCK | small | critic/bug | ✅ fixed in `1cdd2f0` · A cold attach over direct SSH creates the desktop's tmux session with no hook environment, so an agent resumed there never reports status, and the desktop never repairs it |
| [A09](#a09) | medium | BLOCK | small | protocol/bug | ✅ fixed in `726271a,1cdd2f0` · Nodes of SSH projects open against the desktop's LOCAL tmux, creating an empty phantom session and offering to resume the conversation on the wrong machine |
| [A10](#a10) | medium | BLOCK | small | ci-docs/risk | ✅ fixed in `fcda932` · Debug APKs from CI change signature from run to run; README offers them as the install route, and updating means uninstalling, which wipes pairings |
| [A11](#a11) | medium |  | small | build/bug | ✅ fixed in `de1eded` · Tapping an Inbox notification while the app is in the background does not open that computer |
| [A12](#a12) | medium |  | medium | protocol/bug | ✅ fixed in `ab1335c`; follow-up `8430243` (SSH-project nodes typed over their ControlMaster) · Relay sendKeys (question answers, legacy approvals) writes into a pty that does not exist yet and then kills it immediately, so the keystroke can be lost while the UI reports success |
| [A13](#a13) | medium |  | medium | protocol/bug | ✅ fixed in `68d0925` (phone), `b718a04` / `ed2965be` (desktop, both routes); seven real tmux methods, eight Linux native checks and 24 distinct assertion mutants, physical pending · Registering a phone-started node while the phone is attached lets the desktop's own client attach with `-D`, which detaches the phone; Android then reports the session as ended |
| [A14](#a14) | medium |  | small | protocol/bug | ✅ fixed in `c58ad65` · New sessions in cwd-less (inline) projects are never registered: the desktop refuses them, the refusal is ignored, and the session is orphaned |
| [A15](#a15) | medium |  | small | protocol/bug | ✅ fixed in `c58ad65` · The cold-attach resume offer drops the node's managed Claude account (and on the relay, its cwd), so the resume fails with 'No conversation found' |
| [A16](#a16) | medium |  | small | protocol/gap | ✅ fixed in `c58ad65` · The phone's launch ignores the project's own permission mode (and default account), so a project the user set to a stricter mode starts in the global mode |
| [A17](#a17) | medium |  | small | protocol/risk | ✅ fixed in `3d36d60` · The background inbox worker dials the relay for unapproved phones, putting the desktop's SAS approval dialog up every 15 minutes with no code on the phone to compare it against |
| [A18](#a18) | medium |  | small | runtime/bug | ✅ fixed in `10de4b9` · No lifecycle handling: a backgrounded app keeps the 8 s poll and its relay terminal stream alive indefinitely |
| [A19](#a19) | medium |  | small | runtime/bug | ✅ fixed in `de1eded` · Tapping an inbox notification while the activity is alive ignores the target computer |
| [A20](#a20) | medium |  | small | runtime/bug | ✅ fixed in `d199f03` · Cancelling an in-flight connect leaks the SSH connection and records the cancellation as a connection failure |
| [A21](#a21) | medium |  | small | runtime/bug | ✅ fixed in `daf15d3` · A denied POST_NOTIFICATIONS is never re-requested, and the Settings switch still reads On |
| [A22](#a22) | medium |  | small | runtime/bug | ✅ fixed in `ade7428` · The Navigator back stack is not saved across activity recreation, and the original launch intent is re-applied |
| [A23](#a23) | medium |  | small | security/risk | ✅ fixed in `3d36d60` · Background inbox worker opens unapproved relay connections, raising desktop SAS approval dialogs the phone never shows |
| [A24](#a24) | medium |  | small | security/bug | ✅ fixed in `8e304db` · SecureStore treats ANY decrypt error as 'absent', so getOrCreate32 permanently overwrites the phone's identity |
| [A25](#a25) | medium |  | medium | parity/gap | 🟡 in-app part fixed in `4ffb8b7`, `0d310cc` (notification actions, the tap opens the session); FCM push is still a backend gap · No real push notifications: 15-minute background polling, no notification actions, no Live-Activity equivalent, and the desktop's phone-push switches are ignored |
| [A26](#a26) | medium |  | medium | parity/gap | ✅ fixed in `9cdc4cf`, `1eeb5b8` · New session and board edits were unavailable on the LAN (direct-SSH) connection that Auto picks first; iOS does both over SSH. A108 now serves owned Board writes and Desktop delivery-only nudges over SSH; A90 adds separate plain SSH shells. Canvas registration remains relay-routed |
| [A27](#a27) | medium |  | large | parity/gap | ✅ fixed in `8691e6d`, `9b5c342`, `1d8201f`, `c450e16` · Cannot connect straight to a Linux dev host or a headless Server Edition (iOS's "phone SSHes into the host" setup) |
| [A28](#a28) | medium |  | small | parity/gap | ✅ fixed in `726271a,1cdd2f0` · SSH-project sessions over direct SSH are attached, approved and resumed on the wrong machine |
| [A29](#a29) | medium |  | medium | parity/gap | ✅ fixed in `0c5a1e1`, `a5f38f5` · No source-control screen, although the protocol layer already implements the git verbs iOS uses |
| [A30](#a30) | medium |  | small | critic/bug | ✅ fixed in `3d36d60` · Pressing Deny on the desktop is not respected: the phone re-dials about 8 s later and the SAS approval dialog reappears |
| [A31](#a31) | medium |  | small | critic/bug | ✅ fixed in `a622e71` · A silently dead SSH peer (laptop asleep, desktop IP or VPN change) wedges the host as 'On your network' for many minutes: no detection, no relay fallback, and the error is never shown |
| [A32](#a32) | medium |  | medium | critic/gap | ✅ fixed in `7035bde`, `88beed2` · No way to open a URL or copy text from the phone terminal: no link detection, no touch selection, and the WebView cannot show xterm's link confirm |
| [A33](#a33) | medium |  | medium | critic/bug | ✅ fixed in `0db0b6e` · On a Windows computer, 'New session' starts the agent in the user's home folder instead of the project, and silently drops the chosen Claude account while still registering it |
| [A34](#a34) | medium |  | small | critic/bug | ✅ fixed in `2a273a7` · The Ctrl key-row chip does not apply to text sent from the input bar: arming Ctrl and sending 'z' submits a literal 'z' plus Enter |
| [A35](#a35) | medium |  | small | critic/bug | ✅ fixed in `16706f4` · approvals.answer returns `answered:false` both for 'already handled' and for 'the write failed'; the phone always says 'Already handled.' |
| [A36](#a36) | medium |  | small | critic/gap | ✅ fixed in `2a273a7` · After any connection drop the terminal stays on 'Disconnected. [Reattach]' even though the host connection reconnects by itself |
| [A37](#a37) | low |  | small | build/risk | ✅ fixed in `ac0923a` · proguard-rules.pro would not survive turning on minification (R8 missing-class errors) |
| [A38](#a38) | low |  | small | protocol/bug | ✅ fixed in `5ff8f6c` · Quick approve requires the node to be exactly 'blocked', but the desktop publishes approval tickets while the node stays 'waiting' on a held question |
| [A39](#a39) | low |  | small | protocol/bug | ✅ fixed in `437e359` · The account chip reads `account.label`, which the mirror never writes, so it falls back to the raw account UUID |
| [A40](#a40) | low |  | small | runtime/bug | ✅ fixed in `a38d39d` · The pending-launch path and the attach hand-off never re-check `disposed`: a stream can stay attached forever, or a phone-started node gets registered with no agent launched |
| [A41](#a41) | low |  | small | runtime/bug | ✅ fixed in `94a558a` · The composed prompt is cleared even when no stream is attached, so the text is silently lost |
| [A42](#a42) | low |  | small | runtime/bug | ✅ fixed in `7debe67` · NewSessionDialog crashes if the selected project disappears while the dialog is open |
| [A43](#a43) | low |  | small | runtime/bug | ✅ fixed in `2be5e87` · The HostScreen tab and scroll position reset after returning from a terminal |
| [A44](#a44) | low |  | small | runtime/bug | ✅ fixed in `7988087` · System back discards Settings edits (device name, relay API base) |
| [A45](#a45) | low |  | small | runtime/risk | ✅ fixed in `1901939` · No onRenderProcessGone handler on the terminal WebView |
| [A46](#a46) | low |  | small | runtime/bug | ✅ fixed in `17ee526` · The ⌨ key-row chip only focuses the DOM textarea, which cannot raise the soft keyboard |
| [A47](#a47) | low |  | small | runtime/bug | ✅ fixed in `52df0a3` · The Keystore decrypt runs on the main thread in the host list's composition, once per row per recomposition |
| [A48](#a48) | low |  | small | runtime/bug | ✅ fixed in `d383e76`; follow-up `6afd8f5`, `a65e12f` (the seen log is keyed by computer) · The seen-events set is trimmed in hash order and updated without synchronization, which can produce duplicate notifications |
| [A49](#a49) | low |  | small | security/risk | ✅ fixed in `a40d11b`; follow-up `513c166`, `402f139` (the pin is anchored in the sealed pairing answer); manual beta-19 saved-pin reuse/changed-key refusal verified at `e06b5547`, QR/relay matrix pending · SSH host-key TOFU pin is saved during key exchange (before auth) and is not tied to the pairing |
| [A50](#a50) | low |  | medium | security/risk | 🟡 private beta10/code11 installed from clean e3ce041c with verified signer/APK/non-debuggable metadata; desktop-issued pairing/relay survives same-signer update and real saved relay reconnect/input pass; A91/A94 full physical empty-host flow passes, 10 Pass / 22 Partial / 32 Pending ledger and broader minified/device validation pending · Debuggable builds expose Keystore-protected credentials over adb/JDWP |
| [A51](#a51) | low |  | small | security/gap | ✅ fixed in `9b4af70` · allowBackup=false does not stop device-to-device migration at targetSdk 35: hosts, pins and deviceId are cloned |
| [A52](#a52) | low |  | small | security/gap | ✅ fixed in `3780f5a` · Approval and finish notifications put command text and the agent's last message on the lock screen |
| [A53](#a53) | low |  | small | security/bug | ✅ fixed in `af587ac` · OSC 52 handler has no size cap (the desktop caps at 1,000,000) and setPrimaryClip is unguarded |
| [A54](#a54) | low |  | small | security/bug | ✅ fixed in `32330df` · PairingClient trusts an unbounded Content-Length / EOF body from the pairing endpoint |
| [A55](#a55) | low |  | medium | parity/gap | ✅ fixed in `71b592a`, `0772cbf` · Inbox and Usage are per computer; iOS merges them across all paired computers |
| [A56](#a56) | low |  | small | parity/gap | ✅ fixed in `db4abccf`, `7c206ec5` (A105): original concrete hook rules, never blind `2`; physical persistence remains open · Approval cards lack iOS's "Always allow" answer |
| [A57](#a57) | low |  | small | parity/gap | ✅ display fixed in `8dbeb48`; full held answers in `db4abccf` (A106) · Multi-select AskUserQuestion cards fall back to "Open session" |
| [A58](#a58) | low |  | small | parity/gap | ✅ fixed in `a44f16c` · Usage and feed cards omit iOS's pace line and the context indicator on event cards |
| [A59](#a59) | low |  | small | parity/gap | ✅ fixed in `57804cf`, `8020796` · No built-in dictation (iOS has on-device Whisper plus a Cloud engine) |
| [A60](#a60) | low |  | small | ci-docs/bug | ✅ fixed in `67e6297` · Interop fixture needs the Electron binary, which is downloaded at test time inside the 20 s ready window, despite the workflow saying 'not Electron' |
| [A61](#a61) | low |  | small | ci-docs/bug | ✅ fixed in `39e7995` · Following CONTRIBUTING / android/README (`npm ci --ignore-scripts`) wipes a desktop developer's patched node_modules |
| [A62](#a62) | low |  | small | ci-docs/bug | ✅ fixed in `77c760d` · SSH transport tests fail, not skip, on macOS: the gate checks only that /usr/bin/script exists, then runs util-linux-only flags |
| [A63](#a63) | low |  | small | ci-docs/gap | ✅ fixed in `b3d4c6e` · Android workflow path filters miss files that change the tested wire behavior, contrary to CLAUDE.md |
| [A64](#a64) | low |  | small | ci-docs/gap | ✅ fixed in `f9782da`; actual relay-file round trip verified 2026-10-05 · Docs say the protocol tests check the mirror, the projects.list blob and the ~/.nodeterm files against desktop code, but those shapes are hand-copied in the tests |
| [A65](#a65) | low |  | small | ci-docs/gap | ✅ fixed in `33af5e7` · User-facing docs and desktop UI present the Android app as working, but it has never been built by AGP or run on a device, and no device checklist exists |
| [A66](#a66) | low |  | small | ci-docs/gap | ✅ fixed in `61e218b` · ANDROID_APP_URL points at a folder that exists on neither upstream nor fork main yet, and it points at source code rather than an installable |
| [A67](#a67) | low |  | small | ci-docs/gap | ✅ fixed in `696fd10` · The interop fixture is excluded from every tsconfig, so `npm run typecheck` never checks it against the desktop interfaces it implements |
| [A68](#a68) | low |  | small | ci-docs/risk | ✅ source-fixed in `7e91785c`; tests, mutations and exact-head CI route recorded below · Android uses main-only push + pull_request, no merge_group; manual prepare_beta=true runs five jobs |
| [A69](#a69) | low |  | small | ci-docs/gap | ✅ fixed in `6f3a8da` · The Gradle/Kotlin code has no dependency-update, CodeQL or wrapper-validation coverage |
| [A70](#a70) | low |  | small | ci-docs/bug | ✅ fixed in `68d5da6` · On Windows the interop tests fail with CreateProcess instead of skipping |
| [A71](#a71) | low |  | small | ci-docs/gap | ✅ fixed in `39e7995` · android/README says 'JDK 17+', but the pinned Gradle 8.14.3 cannot run on JDK 25 |
| [A72](#a72) | low |  | medium | critic/gap | ✅ fixed in `71290de` · Phone-started sessions are created without the agent-specific env, so for their whole life they get no hook-reply approvals, no canvas control and no pane ownership |
| [A73](#a73) | low |  | small | critic/bug | ✅ fixed in `e055f37` · Notifications are documented as 'live every 8 seconds while a computer is open', but the in-app poll never posts a notification |
| [A74](#a74) | low |  | small | critic/bug | ✅ fixed in `a40d11b`; follow-up `cb12f3b`, `898d937` (the relay refreshes the LAN address and host keys); manual beta-19 mismatch refuses SSH at `e06b5547`, physical relay refresh/fallback pending · The LAN leg dials a DHCP IPv4 frozen at pairing time; when another SSH host answers at that address, the host-key 'hard stop' also blocks the relay fallback |
| [A75](#a75) | low |  | small | critic/gap | ✅ fixed in `437e359` · The New session account picker lists managed Claude accounts by raw UUID |
| [A76](#a76) | low |  | small | critic/gap | ✅ fixed in `6966f25` · Over direct SSH, opening a Sleeping (Eco-hibernated) session lands on a bare shell with no wake or resume offer |
| [A77](#a77) | low |  | small | critic/bug | ✅ fixed in `0a2a1aa` · IME insets are not handled for Android 15's enforced edge-to-edge (targetSdk 35): the terminal gets double bottom padding when the keyboard opens, and other screens have no IME padding at all |
| [A78](#a78) | medium | | small | protocol/bug | ✅ locally fixed in `bb5b3e54`; protocol658/app type-check pass; phone verification pending · Desktop quick answers can hit a prefix-matched or newly selected pane, be swallowed by copy mode, or reorder concurrent writes |
| [A79](#a79) | medium | | small | protocol/bug | ✅ locally fixed in `e64665c3`; protocol658/app type-check pass; phone verification pending · Direct-SSH quick answers can be swallowed by copy mode and an absent SSH exit status can report success |
| [A80](#a80) | medium | | small | protocol/bug | ✅ locally fixed in `0f39c33f`; protocol658/app type-check pass; phone verification pending · The control client's startup attach reply consumes the first queued command's reply slot |
| [A81](#a81) | medium | | small | runtime/bug | ✅ locally fixed in `86390a49`, `7e11e93c`; protocol658/app type-check pass; phone verification pending · Relay join and device mint can hang on stalled mobile connections and ignore coroutine cancellation |
| [A82](#a82) | medium | | medium | protocol/bug | ✅ locally fixed in `010240e0`; protocol658/app type-check pass; phone verification pending · Read-ack sweeps delete files owned by other desktops and lose acknowledgments |
| [A83](#a83) | medium | | small | build/risk | ✅ fixed in `fa71cb08`; actual release/R8 verified, full phone validation pending · AGP 8.9.1 R8 cannot parse Kotlin 2.2 metadata during a successful release build |
| [A84](#a84) | low | | small | tests/bug | ✅ fixed in `1d6b04cc`; full protocol 606/606 pass, two mutants caught · Real SSH tests share Readline state and inherit a login-shell command-not-found hook |
| [A85](#a85) | medium | | small | terminal/bug | ✅ fixed in `febe022a`; code-3 update verifies viewport/font/keyboard resizing and pre-attach tmux history; final protocol609/app type-check pass · WRAP_CONTENT WebView layout parameters force a one-row terminal despite a large native viewport |
| [A86](#a86) | medium | | medium | performance/gap | 🟡 primary drag/coast complaint user-confirmed resolved in code 7; cellular WireGuard SSH connection and smooth scrolling confirmed; Pixel drag/coast/Esc/stable-viewport new-touch stop pass, protocol658/49 gesture mutants pass; native two-mode custom-binding distance/chunk/reversal checks and three mutants pass; Pixel 7a adds bounded custom-binding/lifecycle cases, wider gesture/reversal/lifecycle/FPS matrix remains open · Scroll responsiveness is poor despite reachable tmux history |
| [A87](#a87) | medium | | medium | runtime/bug | ✅ fixed in `3cffb49d`; protocol658/type-check pass, 31 routing JS/actor/wiring mutations caught; normal drag/coast user-confirmed in beta 6; remaining device checks open · Automatic xterm reports cancel a swipe and discard queued movement |
| [A88](#a88) | medium | | small | tooling/bug | ✅ fixed in `fed68fb3`, `f5fd3821`; actual V3.0 label reproduced, 39 Python tests per SDK36/37 and ten new mutations pass; all five CI37061593216 jobs green · New SDK signer labels make private-beta verification reject the expected certificate |
| [A89](#a89) | medium | | small | runtime/bug | ✅ fixed in `c4b1f6cf`; real xterm redraw/hit-target regression and three CSS mutants pass; protocol658/type-check/code-7 delivery and Pixel continuous drag/coast/Esc/stable-viewport new-touch stop and user drag/coast confirmation pass; other device checks open · Repaint detaches the touched text span and loses continued drag/release events |
| [A90](#a90) | medium | | medium | parity/gap | ✅ implemented in `bcc92367`, `b88d1415`; protocol 684/66 and 32 mutants pass; beta 8/9 focused Pixel Home/project/custom cwd/input/history/restart/update/reconnect/exact End pass; beta 10 relay plain-shell creation/input/exact End also pass; item 32 Partial for managed/cellular variants; beta-9 Oct4 A91 empty-host flow passes · Manual SSH/WireGuard host has no way to create a new plain terminal without a local desktop/relay |
| [A91](#a91) | medium | | small | runtime/bug | ✅ fixed in `4d33a5b5`; protocol 688/67, offline app compile and six mutants pass; beta 9/code 10 installed with verified hash; beta-9 Oct4 physical empty-host first Home/exact last-End/row-group removal/connected SSH/second Home flow pass; A94 delivered full installed End/recreate/open/End flow passes · Ending the last phone shell on an otherwise empty SSH host leaves its cached row visible |
| [A92](#a92) | low | | small | desktop/bug | ✅ fixed in `127b6b28` · Desktop/Server terminal link lookup can exclude the hovered row after 32 continuing rows; 24 focused Vitest tests, full TypeScript check and three isolated mutants pass; eight native Linux Desktop cases now pass at `01b4a2f5` with A121's leave fix; eight Linux Server cases also pass at `dcdf664a`; GPU-enabled matrix Canvas4 hardware / Modal4 DOM verified; tmux8/SSH8 and separate GPU recovery pilots verified; wider GPU pressure/macOS pending |
| [A93](#a93) | medium | | medium | interop/backend | OPEN · Fresh-desktop remote-on pairing succeeds without relay credentials; bounded retry using the exact production mint request body returns HTTP 403 reauth_required; original same-desktop recovery succeeds; fresh-different-desktop failure remains open |
| [A94](#a94) | medium | | small | runtime/bug | ✅ fixed in `3c217cba`; five Kotlin methods/eight mutants and full689/67 pass, beta 10 delivered; full physical completed-empty End/recreate/open/End flow passes · Authoritative empty SSH listing remains labelled Loading sessions |
| [A95](#a95) | medium | | small | desktop/interop | ✅ fixed in `ec12ea9a`; actual beta 10 phone move/remove/re-add/create-label updates reach rebuilt production desktop Board with unchanged page time origin and matching persisted state; item 36 Pass; nine suites/133 tests, full TypeScript and four mutants pass · Held desktop Board remained stale after phone moves/labels |
| [A96](#a96) | low | | small | phone/UX | ✅ fixed in `f73633fb`; 12 bounded JVM checks / 21 isolated mutants, protocol730/70 and app checks pass; beta 11 prepared, physical follow-up pending · Sessions have no local search |
| [A97](#a97) | low | | small | parity/gap | ✅ fixed in `8443e71e`; isolated control/restored 25-method runs / 31 mutants and protocol730/70/app checks pass; beta 11 prepared, physical follow-up pending · All computers does not refresh live while visible (A55 residual) |
| [A98](#a98) | low | | small | terminal/UX | ✅ fixed in `1b1872f1`; 9 bounded JVM checks / 13 isolated mutants, protocol730/70 and app checks pass; beta 11 prepared, physical follow-up pending · Captured terminal output cannot be searched |
| [A99](#a99) | low | | small | security/risk | ✅ fixed in `e07071e9`; actual Linux control/restored 19 tests / 16 isolated mutants and protocol730/70/app/desktop checks pass; physical included-key pairing pending · SSH host-key discovery ignores recursive external Includes (A49 residual) |
| [A100](#a100) | medium | | medium | terminal/gap | ✅ source fixed in `2f693d83, 97b8a9a4, 4f1985f5`; Pixel 7a retained-history Find and selected-line clipboard paste verified on `40731381`, wider device matrix pending · Retained host history search |
| [A101](#a101) | medium | | small | runtime/bug | ✅ source fixed in `fbaa535d` · Interrupted typed session-host reads reconnect; source regression verified |
| [A102](#a102) | medium | | medium | protocol/gap | ✅ source fixed in `e584586f` · Cold relay attach retains trusted project launch settings; new physical checks pending |
| [A103](#a103) | medium | | medium | protocol/gap | ✅ source fixed in `91e6a3f5` · Agent approval policy survives launch, resume and wake; new physical checks pending |
| [A104](#a104) | medium | | medium | runtime/gap | ✅ source fixed in `2d6cb2cd` · Offscreen Sleeping nodes can wake without switching projects; new physical checks pending |
| [A105](#a105) | low | | medium | parity/gap | ✅ source fixed in `db4abccf, 7c206ec5` · Original localSettings rule verified with beta-19 Android choice and real Claude at `e06b5547`; restart persistence/wider matrix pending |
| [A106](#a106) | low | | medium | parity/gap | ✅ source fixed in `db4abccf` · Original single/nonadjacent-multi choices verified with beta-19 Android and real interactive Claude at `e06b5547`; wider matrix pending |
| [A107](#a107) | medium | | medium | parity/gap | ✅ source fixed in `489c30a8` · Typed source control works on direct SSH; new physical checks pending |
| [A108](#a108) | medium | | medium | parity/gap | ✅ source fixed in `d716138c`, `585e726f` · Owned SSH Board and Desktop session actions; new physical checks pending |
| [A109](#a109) | low | | small | tests/bug | ✅ source fixed in `4e2f877d` · Three-digit findings retain device coverage; source regression verified |
| [A110](#a110) | low | | small | tests/bug | ✅ test fixtures fixed in `8c57016c`, `b2e41255` · SSH profile isolation and actual unsafe-directory mode; merged gates verified |
| [A111](#a111) | medium | | medium | parity/gap | ✅ fixed in `d652b96c`–`ba64f628`; beta-13 local checks pass; one Pixel 7a manual-SSH plain-shell create/register/input/reopen case verified on `40731381`, live agent CLI and wider device matrix pending · New session needs genuine host-owned create/launch/register over direct SSH |
| [A112](#a112) | low | | small | tests/bug | ✅ fixed in `9675c4d1`; producer/input regressions and mutations pass · Managed producer imports session-host files missing from CI and incremental test inputs |
| [A113](#a113) | medium | | small | desktop/bug | ✅ fixed in `349b791a`; 111 affected tests / 11 assertion mutants · Legacy relay revoke lacks a confirmed remote-access receipt |
| [A114](#a114) | low | | small | phone/UX | ✅ fixed in `6b989e59`; 39 focused methods / 18 assertion mutants; physical pending · Dictation has no language picker |
| [A115](#a115) | medium | | medium | phone/bug | ✅ fixed in `0a71c028`; 73 assertion mutants and one equivalent survivor; physical pending · Replaced records and late connections retain stale preferences/credentials |
| [A116](#a116) | medium | | medium | pairing/UX | ✅ fixed in `a6b3e88b`; six real HTTP / five interop methods, 56 assertion mutants; physical pending · Multiadapter pairing/refresh has no network choice |
| [A117](#a117) | medium | | small | pairing/bug | ✅ fixed in `227a7262`; 22 reader methods, seven reader mutants and actual pairing/Android regression · Relative private HostKey names can enter Include reads |
| [A118](#a118) | medium | | medium | pairing/gap | ✅ eligible legacy association fixed in `aa902d0a`; actual host/Android proof and mutation checks pass; physical pending · Legacy entries cannot revoke their unassociated relay key |
| [A119](#a119) | medium | | small | SSH/setup | ✅ source-fixed in `3a68e42b`; actual Server/SSH and mutation checks pass; Pixel 7a manual explicit-profile Desktop SSH verified, remaining physical profile matrix pending · Explicit saved SSH profile folder for custom Server data directories |
| [A120](#a120) | medium | | medium | SSH/setup | ✅ source-fixed in `2723845e`; 17 JVM methods / seven assertion mutants, 28 native OpenSSH checks, four timing cases / 76 assertions and 17 synthetic installed-PAM checks; physical pending · One-time password setup with human fingerprint confirmation and retained-key verification |
| [A121](#a121) | low | | small | desktop/bug | ✅ fixed in `01b4a2f5`; eight native Linux Desktop cases and the synchronous-blur mutant verified · next-task Canvas blur preserves mouseleave; eight Linux Server cases also pass at `dcdf664a`; GPU-enabled matrix Canvas4 hardware / Modal4 DOM verified; tmux8/SSH8 and separate GPU recovery pilots verified; wider GPU pressure/macOS pending |
| [A122](#a122) | medium | | small | desktop/bug | ✅ source-fixed in `9613cec5`; 133 focused / 218 affected tests and six assertion-caught mutants; four Linux native cases pass · Focused Canvas/Modal xterm consumes the advertised native Quit chord |
| [A123](#a123) | low | | small | desktop/bug | ✅ fixed in `db83fb7d`; 44 budget / 301 affected tests, two helper assertion mutants and Desktop native control/sole-call-removal/restored proof pass; later genuine Server 0/3/0 and derived Desktop compositor cell evidence verified · Restored addon context remains live after disposal and budget retirement |
| [A124](#a124) | medium | | small | host/bug | ✅ fixed in `651f46da`; 38 affected tests / full TypeScript and three assertion-caught isolated mutants; one Pixel 7a manual-SSH shell creation/input/reopen/app-restart case passes on `40731381` · Managed SSH New rejects an available absolute default shell as unavailable |
| [A125](#a125) | medium | | small | desktop/bug | ✅ source-fixed in `415dae9b`; eight bounded Linux Desktop reconnect cases pass at `5b7286b3` with A126; historical negative, 13 new/100 affected tests and six mutants retained; one two-host inactive-global native case passes at `59e4c93e`; phone/wider scope open · Open SSH card does not replace its lost viewer after automatic reconnect and inactive cards resolve through the active owner |
| [A126](#a126) | medium | | small | desktop/bug | ✅ source-fixed in `5b7286b3`; 16 new/294 affected tests, full TypeScript, nine assertion mutants and eight bounded native reconnect cases pass; forced950/98/app gates pass; one quiet native park/adopt + inactive-global case passes at `59e4c93e`; wider park/Server/cross-window/phone/platform open · Co-view xterms send duplicate automatic terminal replies into the retained process |
| [A127](#a127) | medium | | small | phone/bug | ✅ source-fixed in `0d50075a`; three JVM methods/twelve callback cases/three mutants; beta 17 and beta 19 Pixel 7a neutral viewer-only exit, retained draft and same-producer manual Reattach/input verified; wider scope pending · Viewer exit falsely reports that the retained host session ended |
| [A128](#a128) | high | BLOCK | medium | input/bug | ✅ source-fixed in `7e7d2c04`; CI registration `5484ab9f`; 30 mutants, merged 982/102 protocol and app and affected 187/11/full TypeScript gates plus all-five CI pass at `a79375c3`; beta 17 emacs/vi Send exactly once, controlled vi reconnect and raw Ctrl verified; beta 19 copy-mode Send and controlled SSH-handler recovery reconfirmed; beta21 direct-SSH held and lost successful Enter receipt/newer-draft cases verified within their documented scope; exact beta-17 End and owned cleanup verified, negotiated session-host/direct-native follow-up described below, physical ConPTY and wider device scope pending · Composed Send clears a draft without submitting it while tmux history is open |
| [A129](#a129) | medium | | medium | input/bug | ✅ source-fixed in `0818bbed` / `2d693263`, published at `1add0408`; leaf 34/3 + 20 mutants, backend 343/37 + four existing Windows-only skips + 21 mutants, root 13 + 18 mutants, cleanup 1 + 1 mutant; focused Android 99/11 + 14 variants (13 behavioral/one source pin), separate CI-reader 11 + eight config deletions; fresh 1012/105 protocol, app, 568/52 Vitest with four existing Windows skips, full TS and all-five/ten-step CI `37602046133` pass; beta 18/code 19 was ready/not installed at that earlier checkpoint; beta 19/code 20 installation was an earlier checkpoint; beta 21/code 22 is now installed, native/session-host physical acceptance pending; original `ce1121ba` finding retained · Native history swipes send wheel input to the foreground instead of browsing retained history |
| [A130](#a130) | medium | | small | input/bug | ✅ source-fixed in `9da36320`, published in `5bda2c32`; three new JVM cases, 48/7 control/restored zero skips and three semantic assertion mutants; fresh 1015/106/app/TypeScript and five-job/ten-step CI pass, beta 19/code 20 installed with measured update preservation; original `1add0408` failure retained; actual app/WebView/physical acceptance pending · Held Live-button touch does not stop the previous fling until click |

| [A131](#a131) | medium | | small | phone/bug | ✅ source-fixed/published in `11fbff08`; focused 71/8 plus ten behavioral/four app source-pin mutants, full 1029/108/app/TS and CI five/ten pass; beta 20 was installed at that checkpoint; beta 21 passes bounded active-output/background, controlled direct-SSH recovery/draft/explicit Send and A133 same-page checks; original A132 attribution and wider lifecycle acceptance remain pending · Buffered output and unready-page commands outlive their terminal viewer |
| [A132](#a132) | medium | | unknown | verification/gap | **OPEN** · Original completion marker absent after all 1200 rows; fresh normal-Fedora 40-ms raw/capture discriminator passes, historical attribution pending |
| [A133](#a133) | medium | | small | phone/bug | ✅ source-fixed in `94c8d2c4`, refined/published at `ef4caec2`; 27 renderer cases, prior semantic/pin mutants plus the delayed-Enter follow-up mutation; full 1033/110/app/TS and CI five/ten pass, beta 21/code 22 installed; bounded same-page retention, final-marker/Unicode clipboard paste and post-font OSC8/plain link offers pass; normal browser/Share pilot measured as separately scoped; wider matrix unverified · Closed SSH/tmux exit erases the last visible pane |
| [A134](#a134) | medium | | small | desktop/bug | ✅ source/caller checkpoints `3f382367`/`0d8594a6` published; seven caught mutants, full 1033/110/app/TS, affected 161/nine files/five Windows skips and CI five/ten pass; original create/Bash prompt plus fresh native 200-marker capture/reload/input continuity verified; V13 cause/fallback and native-history phone/gesture acceptance unverified · Login-shell probe can outlive its child timeout |
| [A135](#a135) | medium | | small | input/bug | ✅ source fixed; five policy/three wiring methods and three policy/one wiring mutants pass; published/installed beta22; physical timing acceptance pending · Delayed raw-input consumption can clear newly armed Ctrl |
| [A136](#a136) | medium | | small | phone/bug | ✅ source fixed; original beta21 loses draft/Ctrl on retained-entry remount; nine policy/three wiring methods and seven policy/one wiring mutants pass; published/installed beta22; one no-Send remount retains draft/Ctrl, broader acceptance pending · Retained terminal entry loses its editor when composition is removed |
| [A137](#a137) | medium | | small | input/bug | ✅ source fixed; twelve behavior/three wiring methods, ten behavior/three wiring mutants, full1069/116/offline app and exact-head CI five/ten pass; published `b9e4cbc7`, beta23/code24 prepared; install/phone unverified; no physical duplicate or automatic retry claim · Retained terminal remount loses pending Send state and outcome guidance |

## A01

**Direct-SSH terminal writes and resizes run on the Android main thread, which breaks the SSH connection as soon as the keyboard opens**

- Severity: **high** (BLOCKS first release); claimed by auditor: high; effort: small; area: build; kind: bug
- Location: `android/protocol/src/main/kotlin/dev/nodeterm/protocol/ssh/SshHostConnection.kt:221`
- Note: Same bug as A04 (reported by two auditors). Fix once, in SshStream.

**Evidence**

SshStream.write/resize are plain (non-suspend) calls that write to the socket synchronously: `override fun write(text: String) { synchronized(this) { runCatching { stdin.write(...); stdin.flush() } } }` (l.221-228) and `override fun resize(...) { runCatching { (session as Session.Shell).changeWindowDimensions(...) } }` (l.230-233). TerminalController calls them on the MAIN thread: `main.post { ... if (s != null) s.resize(c, r) ... }` (TerminalController.kt l.124-132, fired by xterm's fit whenever the WebView resizes, and TerminalScreen.kt l.77 `.imePadding()` / adjustResize resize it when the soft keyboard opens), `main.post { ... s.resize(cols, rows) }` (l.216), `fitHere()` (l.279), `acceptResume()` -> `stream?.write` (l.270), and `raw()` -> `stream?.write` (l.290) from the ^C/^D/^R/^L key chips (TerminalScreen.kt l.163-166). On Android, socket writes on the main thread throw NetworkOnMainThreadException, a RuntimeException. `javap` of sshj 0.39.0 `TransportImpl.write` shows `Encoder.encode` (offset 108) runs before `OutputStream.write/flush` (131/141). The only handler around the socket write is `java/io/IOException` (range 112-144), and `Encoder.encode` does `putfield seq`, so the sequence number and cipher state have already advanced. The exception escapes sshj and SshStream's runCatching swallows it silently. The next packet (the user's next keystroke, from the JavaBridge thread) is encrypted with a state the server does not expect, so sshd drops the connection. The terminal ends with 'Disconnected.', and the shared SSHClient used for listing and the Inbox dies with it. The relay path is unaffected: RelayHostConnection.Stream.write/resize only enqueue on OkHttp's `ws.send`. The same NetworkOnMainThreadException hits `SshHostConnection.close()` -> `client.disconnect()` when it runs from click handlers (HostsScreen.kt l.145 Forget, SettingsScreen.kt l.109 route change). There it escapes sshj's `sendDisconnect` before `finishOff()`, which leaks the socket and the sshj reader thread. JVM tests cannot see any of this because the JVM has no BlockGuard, and nothing in app/ or protocol/ relaxes StrictMode.

**Proposed fix**

Keep all sshj I/O off the main thread while preserving write order. Give SshStream a single-thread writer, e.g. `Executors.newSingleThreadExecutor()`, and have write/resize enqueue onto it. Alternatively, have TerminalController route every stream.write/resize/raw/acceptResume/fitHere call through one serial off-main dispatcher, such as `Dispatchers.IO.limitedParallelism(1)`. Run `HostSession.disconnect()` / `SshHostConnection.close()` on `Dispatchers.IO` as well.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The line numbers and root cause are accurate. Three refinements:
> (a) One more main-thread caller of `close()`: `PairScreen.kt:152` (`graph.connections.forget`), alongside `HostsScreen.kt:145` and `SettingsScreen.kt:109`. `InboxNotifier.kt:127` runs in the worker and is fine.
> (b) Moving sshj writes off the main thread matters even apart from StrictMode. `TransportImpl.write` takes `writeLock` and can block in `kexer.waitForDone()` during a rekey. `ChannelOutputStream.flush` can block in `win.awaitExpansion`. On the main thread either one is an ANR risk.
> (c) The fix must preserve ORDER across two producers: main-thread resize/raw/acceptResume and JavaBridge-thread onInput. So route both `SshStream.write` and `resize` through ONE serial executor inside `SshStream` (e.g. a single-thread executor created per stream and shut down on detach/exit). Fixing each call site separately would leave the ordering unguaranteed. Also make `HostSession.disconnect()` run `c?.close()` on `Dispatchers.IO` (e.g. `graph.scope.launch(Dispatchers.IO)`). For defense, catch `RuntimeException` around `client.disconnect()` and fall back to closing the socket, so a failed `SSH_MSG_DISCONNECT` cannot leak the socket and reader thread.

> The finding is accurate. Four refinements:
> 
> 1. The finding lists the keyboard, rotation, A−/A+ and 'Fit this screen' as triggers. The A−/A+ path is the only one that fires even with a hardware keyboard and no rotation, because TerminalController.setFontSize -> terminal.js `setFontSize` -> `doFit(true)` forces onResize.
> 
> 2. What gets corrupted is broader than the sequence number. Encoder.encode advances both `seq` (putfield at offset 274) and the cipher stream (Cipher.update at 334/381), so every negotiable cipher desyncs.
> 
> 3. For close(): the DisconnectListener fires before the failing sendDisconnect, but it is a no-op because close() already set closedFired=true. The keepalive is interrupted first, so the leaked socket is idle rather than kept alive.
> 
> 4. Put the fix in the protocol layer, not in TerminalController. The TerminalStream contract is non-suspend and callers cannot know that SSH blocks. Give SshStream a single-thread executor and route write, resize and scroll through it; this also serializes main-thread raw()/resize with JavaBridge-thread onInput, keeping them in order. Make SshHostConnection.close() hand client.disconnect() to that executor, or to a background thread. For defense in depth, catch RuntimeException in SshStream by closing the channel/transport instead of silently swallowing it, since the transport is unusable after any exception thrown mid-write.

## A02

**SSH browse looks for the desktop's userData under 'nodeterm', but the desktop writes it under 'node-terminal', so every direct-SSH listing comes back empty**

- Severity: **high** (BLOCKS first release); claimed by auditor: high; effort: small; area: protocol; kind: bug
- Location: `android/protocol/src/main/kotlin/dev/nodeterm/protocol/ssh/SshScripts.kt:38`
- Note: Related: A27 (the Server Edition data dir is not probed either).

**Evidence**

Android PRELUDE: `for d in "$HOME/Library/Application Support/nodeterm" "${XDG_CONFIG_HOME:-$HOME/.config}/nodeterm"; do if [ -f "$d/workspace.json" ]; then NT_UD="$d"; ...`. On the desktop, userData is `app.getPath('userData')`, which is appData/<app.name>. package.json has `name: "node-terminal"` and NO top-level productName (only `build.productName: "nodeterm"`). electron-builder's `modifyMainPackageJson` (node_modules/app-builder-lib/out/fileTransformer.js:88-106) merges only `config.extraMetadata` into the packaged package.json, and this repo sets none, so at runtime app.name is `node-terminal`. The desktop's own runtime shell agrees: src/core/agents/hook-endpoint-failover-sh.ts:79-80 walks `"$HOME/.config/node-terminal/hook-endpoint.env"` and `"$HOME/Library/Application Support/node-terminal/hook-endpoint.env"`, and node-token-sh.ts:93-94 uses the same `node-terminal` dirs. Repo tests use the same path as a realistic example (ssh-agent.test.ts:59, codex-relay-daemon.test.ts:925). The mirror is written to `path.join(platform().userDataDir, 'agent-status.json')` (agent-status-mirror.ts:1436). Only scripts/uninstall.sh and docs/uninstall.md say `nodeterm`, and the Android prelude copied that. I ran the prelude under /bin/sh against a fake HOME that had `~/.config/node-terminal/workspace.json`: it printed `ud=` (empty). SshTransportTest.kt:154 passes only because its fixture creates `.config/nodeterm`.

**Proposed fix**

Probe `$HOME/Library/Application Support/node-terminal` and `${XDG_CONFIG_HOME:-$HOME/.config}/node-terminal` first, keeping `nodeterm` as a fallback. Change the SshTransportTest fixture to the real directory name so the test would have caught this.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The core claim and root cause are correct. Two refinements:
> 
> 1. The fix should probe `node-terminal` first on both platforms: `$HOME/Library/Application Support/node-terminal` and `${XDG_CONFIG_HOME:-$HOME/.config}/node-terminal`. Keep the existing `nodeterm` dirs as fallbacks. Also consider `$HOME/.nodeterm-server`, the Server Edition's default data dir (src/server/config.ts:108), which the prelude does not probe either. Update the header comment at SshScripts.kt:17-19 and the SshTransportTest fixture (line 154) to `node-terminal`.
> 
> 2. docs/uninstall.md:24 and scripts/uninstall.sh:64 carry the same wrong `nodeterm` path. That is a separate desktop-side doc/script bug, but it is where the Android prelude copied the path from.

> Mostly correct. A few refinements:
> 
> (a) The KDoc at SshScripts.kt:18-19 states the wrong path too, and should be fixed along with line 38.
> 
> (b) The `nodeterm` spelling appears in more places than scripts/uninstall.sh and docs/uninstall.md. It is also in the src/main/remote-ssh/ssh-agent.ts:76-77 comment, which wrongly says the installed app is "nodeterm". Illustrative paths use it in docs/codex-shared-identity.md:72 and in claude-accounts-core.test.ts / claude-skill-share-core.test.ts. The desktop repo is internally inconsistent, and the Android author followed the wrong half.
> 
> (c) The proposed fix is right. Probe `node-terminal` first in both the macOS and XDG locations, keep `nodeterm` as a fallback, and change the SshTransportTest.kt:154 fixture to `.config/node-terminal` so the test catches this.
> 
> (d) Not strictly needed, but: because the listing is empty rather than failing, ConnectionManager never falls back to the relay even when one is paired. A browse that returns `ud=` with no workspace should be treated as a failed or degraded SSH route rather than a legitimately empty host.

## A03

**The direct-SSH tmux client starts without a UTF-8 locale, so tmux replaces every non-ASCII character with '_'**

- Severity: **high** (BLOCKS first release); claimed by auditor: high; effort: small; area: protocol; kind: bug
- Location: `android/protocol/src/main/kotlin/dev/nodeterm/protocol/ssh/SshScripts.kt:92`

**Evidence**

The attach script sets only `TERM=xterm-256color; export TERM` and then `exec "$NT_TMUX" -L node-terminal "$@" new-session -A -s ...`. It never sets LANG/LC_ALL and never passes `-u`, and nothing in the Android code calls sshj `setEnvVar` (grep for LANG/LC_ALL/setEnvVar/` -u ` in android/ finds nothing). tmux marks a client UTF-8-capable only when LC_ALL/LC_CTYPE/LANG contains UTF-8 (or with -u). The desktop solves this for its own clients: pty-manager.ts:512 `resolveLocaleLang()` forces `en_US.UTF-8` into the spawn env ('rounded borders come out as `_`/`|`'), and passes `-e LANG=` per session (pty-manager.ts:3249-3251). An sshd exec channel on a stock macOS host carries no LANG: sshj sends no env, and the `zsh -c` wrapper sources no locale. Measured in the sandbox with tmux 3.4: a client started without LANG received `_ box` instead of `╭ box`; the same client with LANG=en_US.UTF-8 received the real glyphs.

**Proposed fix**

In the attach script, export a UTF-8 locale when the inherited one is not UTF-8 (the same rule as resolveLocaleLang), or add `-u` to the tmux client invocation. Add an SshTransportTest case that runs with LANG unset.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The line and root cause are correct (SshScripts.kt:92-93, with the exec on line 93). Two refinements:
> 
> 1. Not every character becomes `_`. Box-drawing characters that have a DEC ACS mapping (─ │ ┌ ┐ └ ┘ and the like) are converted by tmux to `ESC(0` + an ACS letter, and xterm.js renders those correctly. Characters with no ACS mapping become width-many underscores: rounded corners ╭╮╰╯, accented Latin letters, CJK (two underscores each), and symbols and emoji such as ✻ ⏺ ⎿.
> 
> 2. The better fix is to export a UTF-8 LANG in the attach script, using the desktop's `resolveLocaleLang` rule (keep an inherited LC_ALL/LC_CTYPE/LANG that already says UTF-8, otherwise `LANG=en_US.UTF-8`), rather than only adding `-u`. `-u` fixes this client's rendering but not the pane environment when the phone's attach starts the tmux server; exporting LANG covers both. Adding `-u` on top is harmless.
> 
> The regression test should attach under an env with no LANG, LC_ALL or LC_CTYPE and assert that a non-ASCII glyph (e.g. `é`) arrives as UTF-8 bytes, not `_`.

> The line is right (92-93) and so is the root cause. Two additions and a sharper fix:
> 
> (a) The impact is mainly stock macOS hosts, plus Linux hosts without a pam_env locale. Debian/Ubuntu normally get LANG through PAM.
> 
> (b) SshTransportTest.kt:57 hides the bug by passing the JVM's own environment, LANG included, to the fake sshd. The new test must clear LANG, LC_ALL and LC_CTYPE in `childEnv()` and assert that a non-ASCII glyph such as `╭` comes through the attach.
> 
> (c) Fix: add `-u` to the tmux client invocation in `attach()`. That makes the client UTF-8 whatever locale the host has installed. Also export LANG only when LC_ALL, LC_CTYPE and LANG are all non-UTF-8, so that panes of a server the phone starts don't inherit a C locale. Use `en_US.UTF-8` on Darwin, where it is always present and matches the desktop's resolveLocaleLang, and `C.UTF-8` elsewhere. Forcing en_US.UTF-8 on a Linux host that lacks it makes shells print setlocale warnings. `-u` alone fixes rendering but not the pane locale of a phone-created server.

## A04

**SSH terminal writes and resizes run on the main thread, and the NetworkOnMainThreadException that runCatching swallows leaves sshj's cipher state out of sync, which drops the whole SSH connection**

- Severity: **high** (BLOCKS first release); claimed by auditor: high; effort: small; area: runtime; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/TerminalController.kt:131`
- Note: Same bug as A01.

**Evidence**

Main-thread callers of TerminalStream.write/resize:
- TerminalController.kt:125-131: `main.post { ... val s = stream; if (s != null) s.resize(c, r) ... }`. This runs on every WebView resize: the soft keyboard (TerminalScreen.kt:77 `Column(...imePadding())` shrinks the WebView), rotation, and A−/A+ (`nt.setFontSize` → `doFit(true)` → `bridge.onResize`).
- :216 `main.post { ... s.resize(cols, rows) }`; :279 fitHere `s.resize(cols, rows)`; :270 acceptResume `stream?.write(offer.second + "\r")`; :290 `fun raw(data: String) { stream?.write(data) }`, which the ^C/^D/^R/^L chips call (TerminalScreen.kt:163-166).

SSH side, SshHostConnection.kt:221-233: `synchronized(this) { runCatching { stdin.write(...); stdin.flush() } }` and `runCatching { (session as Session.Shell).changeWindowDimensions(...) }`. Both write to the socket on the calling thread.

In the sshj 0.39.0 jar, TransportImpl.write calls `Encoder.encode(packet)` at bytecode offset 108; that increments the sequence number and runs cipher.update/MAC. Only then does it call `connInfo.out.write` at offset 131 (a raw java.net.Socket stream, from SocketClient.onConnect). The exception table catches only IOException.

On Android the main thread has StrictMode death-on-network (targetSdk ≥ 11), and SocketOutputStream.socketWrite calls `BlockGuard.getThreadPolicy().onNetwork()`. So the write throws NetworkOnMainThreadException, a RuntimeException that runCatching silently swallows.

**Proposed fix**

Never call TerminalStream.write/resize on the main thread. Either give SshStream a per-stream single-thread executor that does write+flush and changeWindowDimensions (this keeps keystrokes in order), or route raw/acceptResume/fitHere/onResize/the attach-time resize through a serial background dispatcher (e.g. Dispatchers.IO.limitedParallelism(1)). Also stop runCatching-ing a RuntimeException out of sshj: at that point the transport state is corrupt, so close the connection.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The substance is correct. Three refinements:
> 
> (a) Ordinary typed input is NOT affected. `Bridge.onInput` (`TerminalController.kt:136-144`) runs on the WebView's JavaBridge background thread, and so do `submit()`/`key()`, which go through `nt.submit`/`nt.key` → `bridge.onInput`. Only these main-thread paths break: the resize at `:131` and `:216`, `fitHere` at `:279`, `acceptResume` at `:270`, and the KeyRow chips at `:290`. Opening the keyboard alone is enough, because `adjustResize` plus `imePadding` shrinks the WebView, xterm's rows change, and `onResize` fires.
> 
> (b) The fix has to serialize with the JavaBridge-thread `onInput` writes as well. Otherwise ^C from a chip could overtake or interleave with typed bytes. So put the executor or `limitedParallelism(1)` dispatcher inside `SshStream` itself, covering write+flush and `changeWindowDimensions`, rather than in the controller.
> 
> (c) `runCatching` in `write`/`resize` also hides an `IOException`/`TransportException` from a dead socket. Any exception out of `Transport.write` should close the stream or connection, not be ignored.

> The finding is accurate. Three refinements:
> 
> (a) Line 235 (afterAttach) is NOT on the main thread: it runs on graph.scope, which is Dispatchers.Default. Typed keystrokes via Bridge.onInput (:143) run on the WebView JavascriptInterface thread and are also unaffected. The main-thread offenders are exactly :131, :216, :270, :279 and :290.
> 
> (b) The disconnect does not need further user activity. After one swallowed main-thread write, the next packet on the transport breaks the connection. That can be the HostSession poll's exec (every 8 s) or sshj's keep-alive (set to 20 s at SshHostConnection.kt:353). So the terminal drops within about 8 to 20 s of the first keyboard-open, rotation, A−/A+, chip tap, Resume or Fit.
> 
> (c) Fix details:
> - Move SshStream.write and resize onto one per-stream single-thread executor (or a `Dispatchers.IO.limitedParallelism(1)` dispatcher) so writes and resizes keep their order.
> - On any non-IOException thrown from sshj's write path, close the connection: `client.disconnect()` plus `fireClosed`. Do not swallow it.
> - Narrowing runCatching to IOException alone is not enough: the cipher has already advanced before the throw.
> - Optionally, move the controller's main.post resize and raw calls off the main thread as well, which protects any future TerminalStream implementation.

## A05

**The background InboxWorker can open a never-approved relay handshake and raise the desktop's SAS approval dialog while the phone shows no code**

- Severity: **high** (BLOCKS first release); claimed by auditor: medium; effort: small; area: runtime; kind: risk
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/notify/InboxNotifier.kt:124`
- Note: Same issue as A17 and A23 (three auditors). Related: A07, A30.

**Evidence**

- NodetermApp.kt:45 schedules InboxWorker on every app start.
- InboxNotifier.kt:121-127 runs `withTimeoutOrNull(45_000) { session.refreshNow() }` for every paired host.
- refreshNow → connectLocked (ConnectionManager.kt:99-125) falls through to the relay when SSH fails (phone off the LAN). It then runs RelayConnector.connect, which holds the handshake open and polls projects.list while the desktop waits for approval (RelayConnector.kt:67-86).
- Pairing never pins the phone's box key: the PairingClient body is `{token, publicKey(ssh), deviceName, deviceId, priorDeviceToken}`. standing-host.ts:12-13 says "the first connect from a given phone (its box public key) prompts the host human via the shared SAS dialog".
- A phone paired on the LAN with route AUTO connects over SSH in the foreground, so its first relay connect is usually the worker's, in the background.
- The SAS is rendered only in HostScreen's ConnectionBanner.

**Proposed fix**

Store a per-host "relay approved" flag after the first successful foreground relay connect, and have the worker skip the relay leg until it is set. Alternatively, abort on RelayConnectStatus.AwaitingApproval in background mode and post a notification asking the user to open the app.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The root cause is right. The second proposed fix is not: aborting on `RelayConnectStatus.AwaitingApproval` in background mode would not prevent the desktop prompt. The desktop raises its SAS dialog in `onPeerReady`, as soon as the E2EE handshake completes (`standing-host.ts:256-261`). The phone only learns it is awaiting approval later, when its first `projects.list` fails with "Awaiting host approval." (`RelayConnector.kt:72-80`). Even if the phone closed immediately, the desktop would keep the approvable dialog for 120 s (`phone-approval.ts`).
> 
> The fix that actually prevents the prompt is the first proposal: never enter the relay leg from the background worker until a foreground relay connect for that host has completed. Record a per-host "relay approved" flag when `RelayConnector.connect` returns successfully in the foreground, and have `InboxWorker` pass a background/`allowRelayHandshake=false` mode to `connectLocked`.
> 
> Optionally, when the worker skips a host whose relay leg is unapproved, it can post a local notification asking the user to open the app and approve this phone. One more precision: the prompt does not repeat forever. It recurs every 15 minutes only while the phone is off the LAN and the key is still unpinned.

## A06

**approvals.answer reports success for a hold that already timed out, and clears NEEDS YOU on every surface**

- Severity: **high** (BLOCKS first release); claimed by auditor: high; effort: small; area: security; kind: bug
- Location: `src/main/remote/host-service.ts:690`
- Note: Related: A35 (answered:false is ambiguous).

**Evidence**

The new verb's doc (host-service.ts:690) promises "`answered:false` is an ANSWER (the hook already timed out, the host could not write)". It cannot return that for a timeout. The relay leg reaches `answerPermission` (src/main/index.ts:2774), which calls `writePendingAnswerLocal` (src/core/agents/pending-approvals.ts:42-58: `mkdir` + `writeFileAtomic(file, decision)`, then `return true`). The SSH-project leg is `ssh-project.ts:1823-1845` (`remoteAtomicWrite`, then `code === 0`). Neither checks that `<pendingId>.json` still exists. The hook deletes that file and stops polling when its hold ends: managed-script.ts:423-425, `# Timed out: clean up the request + payload files and print nothing → Claude shows its normal prompt`. On `ok`, answerPermission then emits `syntheticAnsweredEvent`, so the mirror marks the card resolved and flips the node to working (agent-status-mirror.ts:1492-1496). The phone's own SSH leg does check: SshScripts.kt:136 `if [ ! -f "$d/$pendingId.json" ]; then echo gone; exit 0; fi`. On timeout the hook POSTs nothing, so the inbox card keeps its dead `pendingId` (only a `working` event with that id resolves it). QuickActions.stillWaiting still sees BLOCKED and takes the relay path. The hold is `PERM_WAIT_SECS_DEFAULT = 45` (hook-server.ts:65). Android's only background alert path is the 15-minute WorkManager poll (InboxNotifier.kt:64). So an Approve or Deny tapped from an Android notification almost always arrives after the hold has ended.

**Proposed fix**

In answerPermission, check that the request still exists before writing: locally, `fs.access(<pendingDir>/<id>.json)`; over SSH, a `test -f` in the same remote command. Return false otherwise, and skip the synthetic event on false. On the phone, map a 'gone/false' result for a node that is still BLOCKED to OPEN_SESSION (the prompt is now on screen) rather than 'Already handled.'

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The core claim is right. Some details need adjusting:
> 
> 1. **Where the tap happens.** The Android notification has no Approve/Deny actions; it only sets a content intent that opens the app (InboxNotifier.kt:97-113). Approve/Deny live in the Inbox tab (InboxTab.kt:111-114). So the late answer comes from a user who opens the app, from that notification or just by browsing, and taps a card that is still unresolved. The 15-minute poll (InboxNotifier.kt:64) is why that usually happens after the 45 s hold, but any in-app tap more than 45 s after the request hits the bug.
> 
> 2. **The gap is not new, but its reach is.** The writer was extracted unchanged from the pre-existing canvas IPC handler in commit a0c07e6. The desktop canvas Approve/Deny has always had the same problem: the renderer keeps `pendingId` on blocked (agentStatus.ts:558), so the buttons stay after a timeout. On the desktop, though, the prompt is on screen in front of the user. What commit a0c07e6 adds is exposure to a remote phone, plus a doc/test contract (host-service.ts:690, host-inbox-verbs.test.ts:6-7) that the code cannot meet.
> 
> 3. **Severity.** High is defensible, because a phone answer usually lands after the hold. Medium would also be defensible, since it only bites when the phone answers after the 45 s hold.
> 
> 4. **The fix.** The proposed fix is right in substance, with these points:
>    - Check `<pendingDir>/<id>.json` exists before writing, locally and in the same remote command over SSH.
>    - Return false and skip the synthetic event when it is missing.
>    - A small race between the check and the write remains, as it does in SshScripts.kt:136. It is harmless apart from an orphaned `.answer` file that the sweep removes.
>    - On the phone, prefer OPEN_SESSION over "Already handled." when `answered:false` comes back and the node is still BLOCKED, because the interactive prompt is then on screen.

> 1. **Approve/Deny are not notification actions.** The notification built at `InboxNotifier.kt:95-117` only has a content intent that opens the app. The buttons are in the Inbox tab (`InboxTab.kt:109-117`), reached after opening the app or a notification. The timing argument still holds.
> 
> 2. **The root cause is older than this branch.** Commit a0c07e6 only extracted the canvas IPC body into `answerPermission`. The canvas Approve/Deny button (`IPC.agentAnswerPermission`) has had the same no-existence-check behaviour all along. The new relay verb inherits it and documents a `false` result it can never produce. What this branch adds is exposure: the phone's minutes-late tap is now the common case.
> 
> 3. **Severity is arguably medium-high rather than high.** It is limited to relay-only Android phones answering Claude hook-reply approvals. Within that path, it is the dominant outcome.
> 
> 4. **The fix belongs in the writers:**
>    - `writePendingAnswerLocal`: `fs.promises.access(path.join(dir, pendingId + '.json'))` before writing; return false if it is missing.
>    - `SshProjectManager.writePendingAnswer`: put `test -f <dir>/<id>.json || exit 3` in the same remote command.
>    - `answerPermission` already skips the synthetic event when the result is false.
>    - A small race remains: the hook can time out between the check and the write. Closing it fully would need the hook to POST a "timed-out" event, which the mirror would use to strip the `pendingId` from the card. That would also let the desktop badge stop offering dead Approve/Deny buttons.
> 
> 5. **Map the Android dead-ticket results to OPEN_SESSION.** Both the relay `answered:false` and the SSH `gone` currently map to ALREADY_HANDLED. When the fresh status still says BLOCKED, the prompt is now on screen, so the result should be OPEN_SESSION. A claude-only legacy `1`/Esc send-keys would also work there, but only after re-confirming the pane.

## A07

**Remote access fails the first time you are away from the computer: Auto never does the first relay handshake while the phone is at the desk, and pairing does not pin the phone's relay key**

- Severity: **high** (BLOCKS first release); claimed by auditor: high; effort: medium; area: critic; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/conn/ConnectionManager.kt:76`
- Note: Related: A05, A30. Partly a desktop design gap (the relay key is never pinned at pairing), so iOS likely shares it.

**Evidence**

connectLocked tries direct SSH first whenever `route != RELAY_ONLY && host.sshAvailable` (lines 76-87) and returns on success. The relay is only tried when SSH fails (lines 99-125). After pairing, PairScreen goes straight to Route.Host, which connects over SSH on the LAN. adoptRelayIfAdvertised returns early when a relay leg and token already exist (ConnectionManager.kt:167). So a phone paired on the LAN never does a relay handshake while its owner is at the computer. Nothing else can pre-approve it. The /pair body the phone sends is `{token, publicKey(ssh), deviceName, deviceId, priorDeviceToken}` (PairingClient.kt:45-50), with no box key. The desktop /pair handler never calls pinDevice (grep: pairing-service.ts has no approved/pin reference). The standing host approves a relay peer only if `isPinned(store, pub)` (standing-host.ts:250); otherwise it raises the SAS dialog (standing-host.ts:258). The first relay connect therefore happens off-LAN, usually with nobody at the desktop. RelayConnector waits 5 minutes and then fails with "Nobody approved this phone on your computer in time." (RelayConnector.kt:82). Meanwhile PairScreen told the user "✓ Reachable from anywhere (remote access is on)" (PairScreen.kt:123).

**Proposed fix**

Complete the pin-once approval while the user is at the computer. Either (a) run one relay handshake plus approval right after pairing (and after late adoption), while the phone is still on the LAN, and show the SAS on PairScreen; or (b) send the phone's persistent box public key inside the E2EE-sealed /pair body and have the desktop pin it when pairing succeeds. Until then, PairScreen should say that remote access needs one approval at the computer.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The behaviour is as described, but four things need adjusting.
> 
> (1) Root cause and scope. This is not only an Android client bug. The desktop design itself has no way to pin a phone's relay key at pairing time. The desktop's own documented flow in the standing-host.ts:424-434 comment (put the phone on cellular, "FIRST connect: the desktop shows the SAS approval dialog") treats the first relay connect as the approval moment. So iOS very likely has the same gap; that part is inferred, since the iOS repo is not visible. android/README.md:15 even documents it ("Pin-once: approve the phone on the computer the first time").
> 
> (2) Severity. Medium fits better than high. It is one-time setup friction, not a broken steady state. Workarounds exist: switch the route to Relay-only in Settings (SettingsScreen.kt:104) or connect over cellular while at the desk; approving within the 5-minute wait or the 120 s retention after the phone gives up also pins the key. Windows hosts are not affected, because they have no SSH and their first connect after pairing goes through the relay while the user is still at the desk.
> 
> (3) A related side effect. While the owner is away, the background inbox poll (InboxNotifier.kt:122-124) runs refreshNow under a 45 s timeout. An unapproved phone therefore raises the SAS dialog on the unattended desktop, then gives up on that attempt after 45 s — repeated noise, never an approval.
> 
> (4) Choice of fix. Fix (a) needs only an Android change, and it is enough: after pairing, and after late adoption, run one relay handshake plus approval while still on the LAN, and show the SAS on PairScreen. Fix (b) is cryptographically sound, because the /pair body is sealed to the QR's host key and gated by the one-time QR token. But it needs a desktop change in pairing-service.ts, and it changes the phone trust model that docs/ios-protocol-migration.md §7 leaves as an open question to settle with iOS. At minimum, PairScreen.kt:123 should say that remote access needs one approval at the computer.

> Facts and line numbers are correct.
> 
> Severity should be medium, not high. This is the desktop's documented pin-once design (standing-host.ts:12-14 and the smoke test at 426-434; docs/android.md:23). The iOS app very likely shares it, so it is a real, inherited product gap rather than an Android-only bug that breaks a feature. It is also a one-time cost: approving once from the desk with the phone off the LAN, or with the route set to Relay-only, fixes it permanently. The problem is that nothing tells the user this.
> 
> Root cause: the only way a phone key gets pinned is the standing host's interactive SAS approval (standing-host.ts:180/250), and the Android route order means that approval never happens while the user is at the computer.
> 
> Better fix order:
> (a) Android-only, no desktop or iOS change needed. After a successful pair that returned a relay leg (and after late adoption in adoptRelayIfAdvertised), run one RelayConnector.connect while the user is still at the desk and show the SAS on PairScreen. Use the same flow as HostScreen's AwaitingApproval banner, then close that connection. The user stays at the desk until they approve or skip.
> (b) The desktop-side option is sound but must land together with iOS. It would add the phone's persistent box public key to the E2EE-sealed /pair body. That body is authenticated by the on-screen one-time token and sealed to the QR's hostKey. pairing-service would then pin that key through updateApprovedDevices/pinDevice.
> 
> Interim: PairScreen:123 should say remote access needs one approval at the computer, rather than "✓ Reachable from anywhere".
> 
> Secondary: InboxWorker should not start a relay approval in the background. When state would be AwaitingApproval and nobody is watching, it should skip, so it does not raise unattended SAS dialogs on the desktop every 15 minutes.

## A08

**A cold attach over direct SSH creates the desktop's tmux session with no hook environment, so an agent resumed there never reports status, and the desktop never repairs it**

- Severity: **high** (BLOCKS first release); claimed by auditor: medium; effort: small; area: critic; kind: bug
- Location: `android/protocol/src/main/kotlin/dev/nodeterm/protocol/ssh/SshScripts.kt:93`
- Note: Related: A72 (phone-started sessions lack agent env).

**Evidence**

SshScripts.attach runs `exec tmux -L node-terminal [-f conf] new-session -A -s nt-<id> [-c cwd]` (line 93) with no `-e NODETERM_NODE_ID=… -e NODETERM_HOOK_ENDPOINT=…`. When the session is gone (the reboot case the app detects via `hasSession`, SshHostConnection.kt:172), this CREATES it bare. The managed hook script is gated on the variable (`if [ -z "$NODETERM_NODE_ID" ]; then` exit — managed-script.ts:153). An agent started in that pane, including via the phone's own cold-start 'Resume' offer (TerminalController.kt:247-254), therefore reports nothing. When the desktop later mounts the node, the session already exists, so `fresh:false`: no cold restore, and tmux ignores `-e` for an existing session. The relay path does not have this problem, because the desktop's attachDetached injects the hook env from persistKey (pty-manager.ts:2892-2896).

**Proposed fix**

Do not cold-create over SSH. When `hasSession` says no, offer to 'open on the computer' via the relay, or ask the user to open the node on the desktop first. At minimum, pass the hook env the desktop would pass (NODETERM_NODE_ID, NODETERM_HOOK_ENDPOINT pointing at `<userData>/hook-endpoint.env`, NODETERM_HOOK_VERSION) with `-e` when creating.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The root cause and the file:line are correct (`SshScripts.kt:93` has no `-e` hook env when `new-session -A` creates the session). The impact statement is incomplete. The session is only fully "dark" when the phone's attach is what starts the tmux server. When the desktop's tmux client started the server, the bare session inherits the tmux GLOBAL env, which the desktop seeded with another node's `NODETERM_NODE_ID`, `NODETERM_HOOK_ENDPOINT` and possibly `NODETERM_AGENT_ID` / `NODETERM_CANVAS_CONTROL` (`pty-manager.ts:2897` merges `hookEnv` into the client process env, and `NODETERM_*` is not in `update-environment`). That was verified with tmux 3.4. The resumed agent's status, verified token and session id are then attributed to the wrong node, and `Canvas.tsx:13242` overwrites that node's persisted `sessionId`.
> 
> This is also an iOS parity gap. iOS passes `NODETERM_HOOK_ENDPOINT` and `NODETERM_NODE_ID` (`phone-spawned-identity.test.ts:4`, `docs/node-identity.md:185-187`). Severity is at least medium, arguably high, given the cross-node corruption.
> 
> Better fix: when creating, ALWAYS pass `-e NODETERM_NODE_ID=<raw nodeId>` and `-e NODETERM_HOOK_ENDPOINT=<userData>/hook-endpoint.env`, as iOS does. This also overrides any leaked global value. For agent nodes, also pass `-e NODETERM_AGENT_ID=<agentId>`. For a plain terminal, unset the inherited agent/canvas-control vars; `-e` cannot unset, so wrap the command with `env -u NODETERM_AGENT_ID -u NODETERM_CANVAS_CONTROL` or similar. The node id alone is enough to heal the endpoint through the hook's failover (`managed-script.ts:146-152`). `-e` is safe to send on every call because it is ignored when the session already exists.

## A09

**Nodes of SSH projects open against the desktop's LOCAL tmux, creating an empty phantom session and offering to resume the conversation on the wrong machine**

- Severity: **medium** (BLOCKS first release); claimed by auditor: medium; effort: small; area: protocol; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/SessionsTab.kt:141`
- Note: Same issue as A28.

**Evidence**

SessionsTab lists every project's sessions, including ones labelled "on user@host" (sshTarget != null), and `onClick` pushes Route.Terminal for any node. Over SSH, SshScripts.attach runs `tmux -L node-terminal new-session -A -s nt-<id>` on the DESKTOP. Over the relay, host-service calls `attachDetached(nodeId, sinks, { cols, rows })` with no sshRemote/requireRemote; pty-manager.ts:2254-2259 says the relay host 'passes only {cols, rows}', so the spawn is local. Neither path finds the session, so `fresh=true`, and TerminalController:253 offers `claude --resume <sid>` in a local shell. CLAUDE.md states 'A remote node is NEVER spawned locally'. The desktop expects phones to reach those sessions on their own host: the mirror pushes per-project slices to `~/.nodeterm/agent-status-<projectId>.json` on the SSH host (docs/mobile-usage-inbox.md), and index.ts's ack sweep notes 'a Mac→SSH node's acks land on the REMOTE fs'. For the same nodes, SshScripts.answerApproval checks for `$HOME/.nodeterm/pending/<id>.json` on the desktop, but the managed hook writes it on the SSH host, so the phone prints `gone` and reports ALREADY_HANDLED for a live approval.

**Proposed fix**

Until the phone can reach the SSH host itself, disable open/resume for nodes whose project has an sshTarget (say why in the row). On the SSH transport, route approvals for those nodes to the relay verb (the desktop writes over the ControlMaster) or show "open on computer".

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Three small corrections, plus a better fix:
> 
> - **"Neither path finds the session, so fresh=true" is not always true.** On the relay, `sessionExists` first checks `liveSessionForPersistKey` (pty-manager.ts:2583). If the SSH node is mounted on the desktop at that moment, the answer is "exists", so `fresh=false`. The phone then gets a blank local shell with no resume offer and no indication that anything is wrong.
> - **The orphan session sticks.** After the first open, the orphan `nt-<id>` stays on the local `node-terminal` socket. Later opens attach to it as a warm session. `listNodetermSessions` also lists it, so the phone starts reporting the SSH node as running.
> - **More entry points than line 141.** The same unguarded open exists at SessionsTab.kt:148, BoardTab.kt:172 and InboxTab.kt:81. "End session" over the relay (SessionsTab.kt:219-220) also attaches first, which creates the orphan before destroying it. Over SSH, `sendKeys` quick answers for these nodes hit a local session that does not exist, so tmux exits 1 and the app shows an error.
> 
> **Better fix — two layers:**
> 1. **Phone:** block open, resume and key-based quick actions for nodes whose project has an `sshTarget`, and say why ("runs on user@host — open it on the computer"). On the SSH transport, send approvals for those nodes to the relay verb when a relay connection exists, otherwise show "open on computer".
> 2. **Desktop:** in `handleAttach`, refuse `pty.attach` for a node where `workspaceStore.sshProjectIdForNode(nodeId)` is set, instead of letting `attachDetached` create a local session. This applies the existing "a remote node is never spawned locally" invariant to the relay attach path as well. It also protects the iOS relay path, which this repo cannot see.

## A10

**Debug APKs from CI change signature from run to run; README offers them as the install route, and updating means uninstalling, which wipes pairings**

- Severity: **medium** (BLOCKS first release); claimed by auditor: medium; effort: small; area: ci-docs; kind: risk
- Location: `README.md:228`

**Evidence**

README.md:227-228 says 'Android — build it from android/ ...; CI also attaches a debug APK to every run of the Android workflow.' android/README.md:37-38 says the same. The app job uploads `android/app/build/outputs/apk/debug/*.apk` (android.yml:77-80). app/build.gradle.kts has no `signingConfigs`, and no debug keystore is committed. android/.gitignore has a `!debug.keystore` exception, but no such file exists and nothing would use it. So each APK is signed with whatever ~/.android/debug.keystore the ephemeral runner has; AGP generates a fresh one when none exists, and runner images are rebuilt regularly. Installing a later run's APK over an earlier one then fails with a signature mismatch (INSTALL_FAILED_UPDATE_INCOMPATIBLE). The only way forward is uninstall. The manifest sets `android:allowBackup="false"` (AndroidManifest.xml:13), so uninstalling irrecoverably drops every paired computer and the Keystore-held relay/SSH identities. Workflow artifacts also require a GitHub login and expire after the default retention period.

**Proposed fix**

Commit a debug keystore and wire `signingConfigs.getByName("debug").storeFile` to it (the .gitignore exception suggests this was intended), or publish consistently signed APKs as release assets. Until then, drop the 'CI attaches a debug APK' install advice or warn that updates need an uninstall and re-pair.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The root cause and citations are right. One refinement: the per-run key change comes mainly from each GitHub-hosted job running on a fresh VM with an empty `~/.android` (nothing in android.yml caches or injects a keystore), not from image rebuilds.
> 
> The first proposed fix is unsafe as written. Committing `debug.keystore` to this public repo, which the `!debug.keystore` .gitignore exception invites, makes the signing key public. Anyone could then build an APK that installs as an in-place update over users' installs. An update keeps the app UID, so that APK inherits the app's data dir and its AndroidKeyStore key. It could then decrypt the SecureStore secrets, including the SSH private key that paired computers trust in authorized_keys and the relay identity.
> 
> Safer options:
> - Sign CI builds with a key held in GitHub Actions secrets (a `signingConfig` fed from env vars, used only in CI), and publish those APKs as release assets.
> - Or, until then, reword README.md:227-228 and android/README.md:37-38. Say CI artifacts are for testing only, that each one needs an uninstall and fresh pairing, and that a locally built APK is the route to keep for updates. A local build is stable because it uses the developer's own `~/.android/debug.keystore`.
> 
> Also drop the `!debug.keystore` exception, so nobody commits a public signing key by accident.

## A11

**Tapping an Inbox notification while the app is in the background does not open that computer**

- Severity: **medium**; claimed by auditor: medium; effort: small; area: build; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/MainActivity.kt:67`
- Note: Same issue as A19.

**Evidence**

The notification's PendingIntent carries `putExtra(MainActivity.EXTRA_HOST_ID, host.id)` with `FLAG_ACTIVITY_NEW_TASK or FLAG_ACTIVITY_CLEAR_TOP` (InboxNotifier.kt l.97-104). MainActivity is `android:launchMode="singleTask"` (AndroidManifest.xml l.24). So when the activity already exists (the common case: app backgrounded with Home), Android delivers the intent to `onNewIntent`, not `onCreate`. `onNewIntent` only does `super.onNewIntent(intent); takePairLink(intent)` (l.67-70), and takePairLink ignores anything that is not a `nodeterm://pair` VIEW intent. EXTRA_HOST_ID is only read in onCreate (`val openHost = intent?.getStringExtra(EXTRA_HOST_ID)`, l.83), and it is consumed inside `remember { Navigator(...) }`, which never re-runs.

**Proposed fix**

In onNewIntent, read EXTRA_HOST_ID into a Compose state, as incomingPairCode already is, and push `Route.Host(hostId, tab = 2)` from a LaunchedEffect keyed on it. Call setIntent(intent) as well.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The diagnosis and line numbers are correct, but the proposed fix is incomplete.
> 
> HostScreen.kt:62 creates the tab as `var tab by rememberSaveable { mutableIntStateOf(initialTab) }`, keyed on neither `hostId` nor `initialTab`. AppContent (MainActivity.kt:112-118) renders every `Route.Host` from the same `when` branch. So if the user is already on a Host screen when the notification arrives, pushing `Route.Host(hostId, tab = 2)` recomposes the same HostScreen slot and keeps the old tab value. The Inbox tab would not open.
> 
> The fix therefore needs a second part. Either:
> - key the state, e.g. `rememberSaveable(hostId, initialTab) { mutableIntStateOf(initialTab) }`, or
> - wrap each destination in `key(...)`, or
> - rebuild the stack with `nav.replaceAll(Route.Hosts); nav.push(Route.Host(id, 2))`.
> 
> The rest of the proposed fix is right: store the extra in a Compose state from `onNewIntent`, call `setIntent(intent)`, and check `graph.hosts.get(id) != null` the same way `onCreate` does.
> 
> Minor: `FLAG_ACTIVITY_CLEAR_TOP` has no effect on a singleTask root activity. It is harmless but does not help here.

## A12

**Relay sendKeys (question answers, legacy approvals) writes into a pty that does not exist yet and then kills it immediately, so the keystroke can be lost while the UI reports success**

- Severity: **medium**; claimed by auditor: medium; effort: medium; area: protocol; kind: bug
- Location: `android/protocol/src/main/kotlin/dev/nodeterm/protocol/host/RelayHostConnection.kt:266`

**Evidence**

Android: `val stream = attach(nodeId, 80, 24, sink); try { stream.write(keys) } finally { stream.detach() }`. The Input frame goes out as soon as the attach RESPONSE arrives, and `pty.kill` follows immediately. Desktop host-service.ts: the response goes first (`socket.respond(req.id, true, { streamId, fresh: !existed })`, line 423). Only after an async `captureSnapshot` does it set `stream.sessionId = pty.attachDetached(...)` (line 432), which spawns a brand-new tmux client (relay ptys are never co-attached: pty-manager.ts:3446-3450, 'Detached (relay-served) ptys are deliberately NOT indexed'). An Input that arrives first hits `pty.write(getClientId(), '', data)`. PtyManager.write (pty-manager.ts:3909-3911) finds no session for '' and falls through to `backgroundWriteBySessionId('')`, which matches nothing, so the input is dropped. If the client was spawned in time, the `pty.kill` processed right after it calls releaseClient → `releasePty` → `proc.destroy()` on a tmux client that has only just been spawned, before it is known to have read and forwarded the byte. The interop fixture's fake `write` accepts any sessionId, so this is not covered by tests. The throwaway 80x24 client also becomes tmux's latest client (the generated conf sets no window-size), so the desktop pane briefly resizes as the key lands.

**Proposed fix**

Don't write until the stream is live: wait for the first OP.Output after SnapshotEnd, which proves attachDetached ran and the tmux client painted. Then write, and delay the detach briefly (or until the pane echoes). Attach at the phone's normal size, not 80x24.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The finding is right on substance. Corrections and additions:
> 
> (a) The kill-after-write loss is worse than "before it is known to have read and forwarded the byte". In node-pty 1.1.0, `write` is an async threadpool `fs.write`, while `destroy()` closes the master straight away (unixTerminal.js:215-225, 296-341). So the byte may never reach the pty at all. Closing the master also hangs up the slave, which likely discards input tmux has not read yet.
> 
> (b) The Esc Deny fallback (QuickActions.kt:37) is lost almost every time, not just sometimes. tmux holds a lone ESC for `escape-time 10` ms (pty-manager.ts:299), and the client is killed well inside that window.
> 
> (c) In the pre-attach race, `attachDetached` never runs, because `handleKill` drops the stream first and the capture continuation returns at host-service.ts:428. It is a clean drop, not a late write.
> 
> Better fix: add a desktop relay verb such as `node.sendKeys {nodeId, keys}`, backed by PtyManager's existing background write / tmux send-keys path. That is the same deterministic route the SSH transport uses, and it needs no throwaway tmux client. Gate it by capability ("not served" means open the session). The PR already adds desktop verbs (`approvals.answer`, `inbox.ack`), so this fits.
> 
> If you stay client-only instead:
> - attach at the phone's real size;
> - wait for the first OP.Output after SnapshotEnd (proof that attachDetached ran and the tmux client is painting) before writing;
> - keep the stream open for well over escape-time, or until the pane echoes, before sending `pty.kill`.
> 
> Either way, `sendKeys` should report failure instead of Unit so that QuickActions does not return SENT unconditionally.

## A13

**Registering a phone-started node while the phone is attached lets the desktop's own client attach with `-D`, which detaches the phone; Android then reports the session as ended**

- Severity: **medium**; claimed by auditor: medium; effort: medium; area: protocol; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/TerminalController.kt:238`

**Evidence**

afterAttach types the launch line and then calls `conn.registerNode(...)` while its relay stream is still attached. Desktop side: `appendRemoteNodeNow` broadcasts `IPC.workspaceExternalChange` (workspace-store.ts:1629). The active project reloads silently, the new TerminalNode mounts and calls create(). create() cannot co-attach to the relay's session, because relay ptys are not in `byPersistKey` (pty-manager.ts:3446-3450). So it spawns a painter with `tmuxAttachFlags(false)` = `['-A', '-D']` (pty-manager.ts:751). `-D` detaches every other client, including the relay-served one. That client exits 0, host `onExit` sends `OP.Error {exitCode:0}`, and Stream.accept calls `sink.onExit(0)`. TerminalController turns that into `TermState.Ended("The session ended (exit 0).")`.

**Proposed fix**

Treat an exit that comes back while the tmux session still exists (re-check isLive / has-session) as a detach, and re-attach automatically instead of showing Ended. Separately, ask the desktop side to co-attach relay viewers instead of `-D`-kicking them.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The mechanism is right, but the impact is overstated in three ways:
> 
> 1. It is recoverable with one tap. The Ended screen has a "Reattach" button (TerminalScreen.kt:89-95) that calls `controller.attach()`. Once the desktop client is attached, that re-attach co-attaches without `-D` and works. The real harm is a false "The session ended (exit 0)." message and a lost view, not a lost session. Medium is borderline; medium-low fits better.
> 
> 2. The immediate kick needs the target project to be the ACTIVE tab on the desktop, not merely open. A background project only gets `replaceProject()`, and its node mounts later on a project switch. That switch then kicks the phone if it is still attached.
> 
> 3. Line refs:
>    - the no-index code is pty-manager.ts:3418 (the `indexKey` line) plus the comment and `set` at 3446-3449;
>    - the renderer spawn with undefined sinks is in `spawnNew` around line 2290.
> 
> Better fix: fix the root cause on the desktop, which also covers iOS. When PtyManager spawns a renderer client for a persistKey that has a live detached (relay) session, it should attach with `-A` and no `-D`. Either track detached sessions by persistKey, or have the renderer spawn check for a live relay pty, as the comment at pty-manager.ts:740-748 already intends. This does not cover the SSH-transport phone's client, which is not in this process's session table, so the Android-side guard below is still needed for that case.
> 
> On Android, as a fallback, treat an exit code of 0 as a possible detach rather than an end. If the node is still in the next snapshot or listing, or a has-session check succeeds, re-attach once automatically. Otherwise show a "Detached — another viewer took over" state instead of "ended".


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

## A14

**New sessions in cwd-less (inline) projects are never registered: the desktop refuses them, the refusal is ignored, and the session is orphaned**

- Severity: **medium**; claimed by auditor: medium; effort: small; area: protocol; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/SessionsTab.kt:289`

**Evidence**

NewSessionDialog offers `snapshot.openProjects().filter { it.sshTarget == null }`, which includes cwd-less canvases. The desktop registrar only handles folder refs: `const e = this.index?.entries.find((x) => x.id === projectId && x.cwd); if (!e?.cwd) return false` (workspace-store.ts:1607-1608), so the answer is `{registered:false}`. TerminalController.afterAttach wraps the call in `runCatching { conn.registerNode(...) }` and never reads the Boolean. host-service documents a refusal as an answer: 'the phone opened its session either way and just stays unregistered'.

**Proposed fix**

Only offer projects that have a cwd, and check `registered`. On false, tell the user and offer to end the session (or keep it reachable from a phone-local list).

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Two corrections to the impact, and one to the fix.
> 
> - **Not wholly invisible on the desktop.** The canvas never shows the session, but the desktop's session-memory panel (RAM pill) lists every `nt-*` session. It labels unowned ones as orphans and offers a kill button. So the tmux session can still be found and ended from the desktop; it is not a completely invisible leak.
> - **Two lines to cite.** The offer is at `SessionsTab.kt:289` (and the FAB gate at `HostScreen.kt:71-72`). The ignored refusal is at `TerminalController.kt:236-239`.
> - **The fix has two parts.**
>   1. Filter the dialog and the FAB gate on `it.cwd != null` as well as `it.sshTarget == null`.
>   2. Read the result of `registerNode` instead of swallowing it. This is still needed after the filter, because a folder project can also be refused: its `project.json` may be unreadable or corrupt, or the account binding may be refused. On `false` or an exception, tell the user the session was not added to the project, and offer to end it or keep it reachable (for example, a phone-local list of unregistered live sessions).
> 
> Registering before typing the launch line is not an option: the code comment says registering first would let the desktop cold-mount the node and launch the agent a second time.

## A15

**The cold-attach resume offer drops the node's managed Claude account (and on the relay, its cwd), so the resume fails with 'No conversation found'**

- Severity: **medium**; claimed by auditor: medium; effort: small; area: protocol; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/TerminalController.kt:253`

**Evidence**

On `s.fresh` the phone offers `Launch.resumeCommand(agent, sid)`, which is bare, e.g. `claude --resume <sid>`. It ignores `node.accountId` (parsed in ProjectsParser.parseNode) and settings.claudeAccounts[].dir. The desktop's cold restore runs inside a pty spawned with the node's account env (`CLAUDE_CONFIG_DIR` via tmux `-e`, pty-manager accountTmuxEnvArgs) and the node's cwd, and wraps the command in `withPermissionMode`. A relay cold attach creates the session with only `{cols, rows}`: no account env and cwd = $HOME (pty-manager.ts:2254-2259). A managed account's transcript lives under `<accountDir>/projects/…`, so running under the default `~/.claude` finds nothing.

**Proposed fix**

Build the resume line the way launchCommand builds a first launch: `cd '<node cwd>' && CLAUDE_CONFIG_DIR='<dir of node.accountId>' claude --resume <sid>`, plus the permission-mode flag as the desktop's cold restore would add it.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Mostly accurate. Four refinements:
> 
> 1. **Impact on the relay is probably wider than managed accounts.** Relay cold attach also drops the cwd, and Claude finds a transcript at `<configDir>/projects/<encoded cwd>/<id>.jsonl` (the CLAUDE.md measurement). So `claude --resume <sid>` typed into a relay-recreated pane in $HOME likely fails for system-account Claude nodes too, not only managed ones. That part is inferred from the CLAUDE.md note, not measured here. On direct SSH the cwd is already supplied through `new-session -c`, so there only the account (and permission mode) is missing.
> 
> 2. **The fix belongs in `Launch`.** Add a resume builder that shares `launchCommand`'s prefix logic: `cd '<abs node cwd or project cwd>' &&` gated on `SAFE_DIR`, then `CLAUDE_CONFIG_DIR='<dir>'` only for CLAUDE and only when `node.accountId` matches a `settings.claudeAccounts` entry. Call it from TerminalController.kt:253 with `node?.accountId` and `node?.cwd ?: project cwd`.
>    - The cwd must be absolute. Portable `./` cwds are only resolved on the SSH listing path, in `SshHostConnection`.
>    - Add the same Claude-only permission-mode flag.
> 
> 3. **It remains a partial fix.** It cannot reproduce the desktop's `AUTH_ENV_STRIP` removal of an inherited `ANTHROPIC_API_KEY`. The relay-created pane also still gets no hook env, so status reporting from that pane stays dark.
> 
> 4. **Codex is not fixable from the phone.** Managed Codex accounts (`CODEX_HOME`) are dropped the same way, but the mirror does not advertise Codex account homes.

## A16

**The phone's launch ignores the project's own permission mode (and default account), so a project the user set to a stricter mode starts in the global mode**

- Severity: **medium**; claimed by auditor: medium; effort: small; area: protocol; kind: gap
- Location: `android/protocol/src/main/kotlin/dev/nodeterm/protocol/model/Agents.kt:59`

**Evidence**

Android: `val mode = settings?.claudePermissionMode?.takeIf { it in PERMISSION_MODES } ?: "manual"`, i.e. the global mirror value only. The desktop resolves `resolvePermissionMode(project, settings)`, 'the project override, else the global setting' (shared/agents/config.ts:754). `defaultPermissionMode` is carried through project.json into the assembled workspace that `projects.list` serves (workspace-files.ts:377/540), and so is the machine-local `defaultAccountId`. ProjectsParser.parseProject reads neither, and NewSessionDialog defaults the account to System.

**Proposed fix**

Parse `defaultPermissionMode` and `defaultAccountId` in ProjectInfo, and resolve project → global exactly as resolvePermissionMode does (keeping the claude-only autoSupported degrade).

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The finding is correct. Three points to make it more precise:
> 1. The loosening to `auto` happens only when the mirror's `autoSupported` is true. Otherwise the global `auto` degrades to the bare command, which is manual, so a stricter project is not loosened in that case. It does still happen when the global mode is `acceptEdits` or `bypassPermissions`, because those modes are emitted without any version gate. The reverse direction also exists: a project override that is looser than the global mode is ignored as well. That is a parity gap, not a security issue.
> 2. More file:line locations for the fix:
>    - SessionsTab.kt:293 (accountId initialised to null)
>    - SessionsTab.kt:330 (launchCommand is not given the project)
>    - ProjectsParser.kt:52-61 (neither field is parsed)
>    - Models.kt:31-42 (ProjectInfo has neither field)
> 3. Fix:
>    - Parse `defaultPermissionMode` and `defaultAccountId` into ProjectInfo.
>    - Pass the project, or the resolved mode, into `launchCommand`, and resolve project → global → default using the same `isPermissionMode` re-validation the desktop uses. Keep the claude-only `autoSupported` degrade after resolving.
>    - Preselect `project.defaultAccountId` in NewSessionDialog, but only when it matches an entry in the mirror's `claudeAccounts`. That mirrors how the desktop validates an account id before stamping it on a node; a stale id should fall back to System.

## A17

**The background inbox worker dials the relay for unapproved phones, putting the desktop's SAS approval dialog up every 15 minutes with no code on the phone to compare it against**

- Severity: **medium**; claimed by auditor: low; effort: small; area: protocol; kind: risk
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/notify/InboxNotifier.kt:124`
- Note: Same issue as A05.

**Evidence**

InboxWorker runs `withTimeoutOrNull(45_000) { session.refreshNow() }` for every paired host. refreshNow calls ensureConnected, which calls RelayConnector.connect and then polls `projects.list` while the host answers 'Awaiting host approval.'. On the desktop, standing-host.ts onPeerReady sends `remoteHostPeerPending` for any unpinned key, and the consent record outlives the socket by 120 s (#819). A reject pins nothing, so the next run prompts again.

**Proposed fix**

Skip relay connects from the worker until this phone's key has been approved once in the foreground (record that locally after the first successful relay listing).

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The cited line (InboxNotifier.kt:124) and the mechanism are right. Two refinements:
> 
> 1. The trigger is broader than "never approved or rejected" phones. On a macOS/Linux computer, every phone that paired on the LAN and has only ever connected over SSH still has an unpinned box key, because pairing-service does not pin it; only standing-host's SAS approval does. That includes phones that picked up a relay block through the QR or through adoptRelayIfAdvertised (ConnectionManager.kt:165-187). The first time such a phone is off the LAN, the SSH attempt fails (4 s AUTO timeout) and the background worker dials the relay. The desktop then gets an unexpected SAS dialog whose code nobody can see. For this app that is the common first-off-LAN path, not an edge case.
> 
> 2. The fix has to be "don't dial the relay at all from the worker until approved". An early abort would not help: the desktop raises the dialog in onPeerReady as soon as the handshake completes, before any request, and keeps it for 120 s after close. Concretely:
>    - Persist a per-host `relayApproved` flag in HostStore when RelayConnector.connect returns (a successful projects.list means the key is pinned).
>    - Skip the relay leg in background runs until that flag is set, e.g. by passing an `allowRelayApproval=false` / background mode into connectLocked.
>    - If the host later answers AWAITING_APPROVAL_MESSAGE (the pin was revoked), clear the flag.
> 
> Side note found while verifying: connectLocked's `catch (e: Exception)` at ConnectionManager.kt:123 also catches the worker's timeout CancellationException (it is an Exception subclass) and rewrites it as a HostException. It is harmless here, because withTimeoutOrNull still returns null, but cancellation is not propagated cleanly.

## A18

**No lifecycle handling: a backgrounded app keeps the 8 s poll and its relay terminal stream alive indefinitely**

- Severity: **medium**; claimed by auditor: medium; effort: small; area: runtime; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/TerminalScreen.kt:58`

**Evidence**

- TerminalScreen.kt:57-63 and HostScreen.kt:65-68 call `session.startWatching()` (and the terminal attaches) inside DisposableEffect. DisposableEffect disposes only when the composable leaves composition, not on ON_STOP.
- Nothing under android/app references Lifecycle, onPause/onResume or WebView.onPause (grep).
- ConnectionManager.kt:211-222: pollJob runs on graph.scope, looping `refreshNow(); delay(POLL_MS)` while watchers > 0. Its own KDoc calls this "the iOS foreground cadence".
- Desktop side: host-service.ts:397-402 calls `remoteViewer?.attached(nodeId)` for the relay stream's whole lifetime. index.ts:3970-3978 says this set makes "Eco's isNodeWatched stop hibernating a session someone is watching from a phone". On the session host a relay sink is bounding (pty-manager.ts:3701 `const bounding = session.sizes.has(null) && !session.sinkAdapts`).
- InboxNotifier.kt:127 never disconnects a session whose isWatched is still true.

**Proposed fix**

Tie watching to the Activity lifecycle: use a LifecycleEventObserver on LocalLifecycleOwner, or repeatOnLifecycle(STARTED). On ON_STOP call stopWatching, detach the terminal stream and call webView.onPause(). On ON_START watch again and reattach.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> 1. **"Indefinitely / until the OS kills the process" is overstated.**
>    - When the screen is off and no wakelock is held, the CPU sleeps. Doze and app-standby later cut network access.
>    - On Android 14+ (and some 12/13 builds), the cached-app freezer stops a process once it drops to the cached state.
>    - The accurate claim: the loop keeps running for as long as the process is not frozen or asleep. That covers the whole Home or app-switch window, and screen-lock until the device sleeps. While the process is alive, the phone's keepalives stop the desktop from dropping the stream, so an agent streaming output keeps waking the radio.
>    - The desktop effects (Eco shielding, the session-host size ceiling) are real, and they apply specifically to the relay stream: `remoteViewer` exists only in `host-service`. On SSH, a tmux client simply stays attached.
> 2. **The terminal attach is not inside the `DisposableEffect`.** It is triggered by the JS `Bridge.onResize` in `TerminalController.kt`; only `startWatching` and `dispose` are in the effect. The conclusion is unchanged.
> 3. **Better fix, using the dependency already declared.**
>    - `lifecycle-runtime-compose` 2.9.1 provides `LifecycleStartEffect`. Use `LifecycleStartEffect(hostId) { session.startWatching(); onStopOrDispose { session.stopWatching() } }` in `HostScreen` and `TerminalScreen`.
>    - In `TerminalController`, add a stop/start pair. On ON_STOP: detach the stream and null `stream`, keeping the WebView, then call `webView.onPause()`. On ON_START: call `webView.onResume()` and re-`attach()`.
>    - Optionally, `InboxWorker` could also disconnect when `ProcessLifecycleOwner` reports the app is not STARTED.

## A19

**Tapping an inbox notification while the activity is alive ignores the target computer**

- Severity: **medium**; claimed by auditor: medium; effort: small; area: runtime; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/MainActivity.kt:67`
- Note: Same issue as A11.

**Evidence**

InboxNotifier.kt:97-104 builds the PendingIntent as `Intent(context, MainActivity::class.java).putExtra(MainActivity.EXTRA_HOST_ID, host.id).addFlags(FLAG_ACTIVITY_NEW_TASK or FLAG_ACTIVITY_CLEAR_TOP)`. The activity is `android:launchMode="singleTask"` (AndroidManifest.xml:24), so a live instance receives the intent in onNewIntent. MainActivity.kt:67-70 is `override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); takePairLink(intent) }`, and takePairLink (:60-65) only reads a nodeterm://pair data URI. EXTRA_HOST_ID is read once, in onCreate (:83 `val openHost = intent?.getStringExtra(EXTRA_HOST_ID)`), into the initial Navigator (:89).

**Proposed fix**

In onNewIntent, call setIntent(intent), read EXTRA_HOST_ID into a mutableState (as incomingPairCode does), and have a LaunchedEffect push Route.Host(hostId, tab = 2).

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The line citations and root cause are correct. The proposed fix has one gap. HostScreen keeps its tab in `var tab by rememberSaveable { mutableIntStateOf(initialTab) }` (HostScreen.kt:62), and AppContent renders every Route.Host from the same `when` branch (MainActivity.kt:116). So pushing Route.Host(hostId, tab = 2) while the current route is already a Route.Host keeps the existing saved tab and ignores `initialTab`. That covers two cases: the user is on that computer's Sessions or Board tab, or they are on a different computer's host screen, which also reuses the slot and its state. The fix needs three parts:
> 1. In `onNewIntent`, read EXTRA_HOST_ID into a mutableState, as `incomingPairCode` does (and optionally call `setIntent`).
> 2. In a LaunchedEffect, validate the id with `graph.hosts.get(id)` and push or replace to Route.Host(id, 2).
> 3. Make HostScreen honour the new route: wrap the branch in `key(r) { … }` or use `rememberSaveable(hostId, initialTab)`. Otherwise the navigation does nothing when a host screen is already showing.

## A20

**Cancelling an in-flight connect leaks the SSH connection and records the cancellation as a connection failure**

- Severity: **medium**; claimed by auditor: medium; effort: small; area: runtime; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/conn/ConnectionManager.kt:94`

**Evidence**

- ConnectionManager.kt:79-96: `val ssh = withContext(Dispatchers.IO) { SshHostConnection.connect(...) }` ... `} catch (e: Exception) { errors += "On your network: ..." }`. CancellationException is an Exception, so this swallows it. withContext's prompt-cancellation guarantee then discards the SshHostConnection that the blocking connect returned, and nothing closes it (keepalive is enabled at SshHostConnection.kt:353).
- The catch at :123 swallows cancellation on the relay leg too, and :132-134 then set `ConnState.Failed("...was cancelled...")`.
- The cancellation comes from stopWatching (:225-231, `pollJob?.cancel()` when watchers reaches 0).
- watchers reaches 0 on every Host→Terminal push as well: Compose dispatches onForgotten before onRemembered (checked in the runtime-desktop 1.8.2 RememberEventDispatcher.dispatchRememberObservers bytecode). So HostScreen.kt:67 `stopWatching()` runs before TerminalScreen.kt:58 `startWatching()`.

**Proposed fix**

Rethrow CancellationException in connectLocked before the generic catches. Make the SSH dial close its result when the caller was cancelled, for example by running it as an async in graph.scope and awaiting it, closing the connection if the awaiting coroutine was cancelled. Also consider keeping one watch token across the Host→Terminal hand-off so the poll job is not cancelled on every navigation.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The finding is correct on mechanism and cause. Refinements:
> 
> (a) The leak site is ConnectionManager.kt:79-85: the discarded result, with `adopt` never reached. :94 is where the cancellation is swallowed. The relay leg swallows it again at :123, and :132-134 set `ConnState.Failed` and throw.
> 
> (b) The wrong "offline" state is not always brief. When the user backs out of HostScreen, nothing else is watching, so no new pollJob replaces it. `ConnState.Failed` stays until the host is reopened: HostsScreen.kt:168/175 shows " — offline" in the attention colour, and `_lastError` holds "StandaloneCoroutine was cancelled". It is brief only on the Host→Terminal hand-off, where TerminalScreen's new pollJob reconnects. That reconnect is a second dial, while the first connection stays leaked.
> 
> (c) There are more cancellation sources than the poll job. BoardTab.kt:98-99 and InboxTab.kt:83-84 call `session.ensureConnected()` inside a `rememberCoroutineScope()` launch. That scope is cancelled when the tab or screen leaves composition, which triggers the same leak if that coroutine holds the mutex during the dial.
> 
> (d) Fix. Rethrow CancellationException before both generic catches in connectLocked. Also close a dial that finished after cancellation. Two ways:
> - Record the result inside the IO block (`.also { dialed = it }`) and, in a `catch (e: CancellationException) { dialed?.close(); throw e }`, close it. withContext does not resume the caller until the blocking block has returned, so `dialed` is set by then.
> - Run the dial as `graph.scope.async(Dispatchers.IO)`. If the await is cancelled, close the result in `invokeOnCompletion`.
> 
> Keeping one watch token across the Host→Terminal hand-off, or delaying the cancel in `stopWatching`, would avoid needlessly cancelling the pollJob. It does not fix the back-out case or the rememberCoroutineScope callers, so the close-on-cancel change is the real fix.
> 
> (e) Severity medium is reasonable. The leak needs the cancel to land during a dial that then succeeds. Each occurrence leaves one live SSH session to the desktop for the life of the process.

## A21

**A denied POST_NOTIFICATIONS is never re-requested, and the Settings switch still reads On**

- Severity: **medium**; claimed by auditor: medium; effort: small; area: runtime; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/SettingsScreen.kt:89`

**Evidence**

- MainActivity.kt:72-82 requests POST_NOTIFICATIONS once, in onCreate, with an empty callback commented `/* the Settings switch reflects it */`.
- SettingsScreen.kt:51 is `var notify by remember { mutableStateOf(graph.hosts.notificationsEnabled) }`. The switch at :89-93 only writes the pref and calls InboxNotifier.schedule; it never checks or requests the runtime permission.
- InboxNotifier.kt:74-76 returns 0 silently when the permission is not granted. Meanwhile the worker still dials every paired computer every 15 minutes.

**Proposed fix**

Show the switch as on only when `notificationsEnabled && permission granted`. When the user turns it on, or opens Settings while permission is denied, launch the permission request. If it is permanently denied, deep-link to Settings.ACTION_APP_NOTIFICATION_SETTINGS. Don't run the worker without the permission.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The permission is not requested "once" or "never re-requested". MainActivity.kt:78-81 runs in every onCreate: every cold start, and every activity recreation such as rotation. It fires whenever the pref is on and the permission is not granted. What actually happens:
> 1. On Android 13+ the system stops showing the dialog after the user denies it twice. From then on `launch()` fails silently, and the app has no path to recover.
> 2. Flipping the Settings switch off and on never requests the permission, and nothing opens the system notification settings.
> 3. The launch-time prompt can repeat on every rotation or cold start until that system cutoff.
> 
> The same "switch says On, nothing arrives" state also happens on API 26-32 when the user blocks notifications or a channel in system settings. There `nm.notify` is a silent no-op and the switch still reads On, so the fix should check `NotificationManagerCompat.areNotificationsEnabled()` (and the channel importance), not only the runtime permission.
> 
> Side effect: `announce` returns before `markSeen` when the permission is missing. After a later grant, every unresolved event from the last 6 hours is posted at once (up to 5 per host, via `fresh.takeLast(5)`).
> 
> Better fix:
> - Derive the displayed state as `pref && areNotificationsEnabled()`, re-checked on resume.
> - Request the permission from the switch, and after pairing the first computer rather than in onCreate.
> - Fall back to `Settings.ACTION_APP_NOTIFICATION_SETTINGS` when `shouldShowRequestPermissionRationale` is false after a denial.
> - Skip or cancel the WorkManager job while notifications are disabled.

## A22

**The Navigator back stack is not saved across activity recreation, and the original launch intent is re-applied**

- Severity: **medium**; claimed by auditor: low; effort: small; area: runtime; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/MainActivity.kt:87`

**Evidence**

- :87 `val nav = remember { Navigator(Route.Hosts)... }` uses plain remember, not rememberSaveable, and Route has no Saver.
- AndroidManifest.xml:26 configChanges covers orientation/screenSize/uiMode but not density, fontScale, locale or layoutDirection, so those changes (and process death) recreate the activity.
- onCreate reads `intent` again each time (:83-84), and onNewIntent never calls setIntent.

**Proposed fix**

Save the route stack with rememberSaveable and a listSaver. Only apply the intent's extras/data when savedInstanceState == null, or clear them once consumed.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The finding is accurate. Two refinements:
> 
> (a) Re-opening the Pair screen does not re-submit the used token. PairScreen only pre-fills the parsed payload, and the user must tap "Pair" again, which would then fail on the server. So the impact is a stale screen and a confusing error, not a duplicate pairing.
> 
> (b) A related, more impactful bug sits on the same lines. With launchMode="singleTask" (Manifest:24), a notification tap while the activity already exists is delivered to onNewIntent. That PendingIntent is built with NEW_TASK|CLEAR_TOP in InboxNotifier.kt:99-103. onNewIntent (MainActivity.kt:67-70) only calls takePairLink, which returns early because the intent has no data, so EXTRA_HOST_ID is ignored. Tapping a "Needs you" or "Completed" notification while the app is alive in the background just brings it forward on whatever screen it was on, without opening that host's inbox. Only a cold start honours the extra (:83, :89).
> 
> Fix for both:
> - Save the stack with rememberSaveable and a listSaver, or make Route @Parcelize.
> - In onCreate, consume the intent extras/data only when savedInstanceState == null, or clear them after use (setIntent(Intent(intent).setData(null).removeExtra(...))).
> - In onNewIntent, call setIntent(intent) and route EXTRA_HOST_ID into the same state-holder mechanism as incomingPairCode, so the Compose side pushes Route.Host(hostId, tab = 2).

## A23

**Background inbox worker opens unapproved relay connections, raising desktop SAS approval dialogs the phone never shows**

- Severity: **medium**; claimed by auditor: medium; effort: small; area: security; kind: risk
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/notify/InboxNotifier.kt:124`
- Note: Same issue as A05.

**Evidence**

InboxWorker.doWork calls `withTimeoutOrNull(45_000) { session.refreshNow() }` for every paired host (line 124). That goes to ensureConnected → connectLocked, which in Auto falls to `RelayConnector.connect(...)` (ConnectionManager.kt:99-122). There is no 'already approved' gate. For an unpinned phone key, the standing host raises the approval prompt on every connect: standing-host.ts:250-261 `if (pub && isPinned(store, pub)) { s.approve() ... }` else `send(IPC.remoteHostPeerPending, { sas: s.sas(), ... })`, and the consent record lives 120 s after the socket closes (#819). On the phone, the AwaitingApproval SAS only lands in `_state` (ConnectionManager.kt:114), which nothing renders while no screen is open. This is the common first relay use: a Mac user who paired and used SSH at home first reaches the relay when the phone leaves the LAN, typically from this worker.

**Proposed fix**

Track a per-host 'relay-approved' flag, set after the first successful RelayConnector.connect in the foreground. In background refreshes, refuse to proceed on AWAITING_APPROVAL_MESSAGE: close immediately, and instead post a notification such as 'Open nodeterm to approve this phone on <computer>'.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Two corrections.
> 
> **1. The 120 s window is timed from the prompt, not from the socket close.** `PHONE_APPROVAL_TTL_MS` starts in `approvals.add()` (phone-approval.ts:38-45), which runs when the prompt is raised. It is not 120 s "after the socket closes": the desktop dialog lives about 120 s from when it appears, and the phone's socket closes at about 45 s.
> 
> **2. The proposed fix does not work.** "Refuse to proceed on AWAITING_APPROVAL_MESSAGE: close immediately" is too late. The desktop raises the dialog in `onPeerReady`, as soon as the E2EE handshake completes (standing-host.ts:233-261), before the phone sends any request. So the phone first sees AWAITING_APPROVAL_MESSAGE only after the prompt is already on screen, and closing then still leaves a live dialog for 120 s.
> 
> **A fix that works:**
> - **Skip the relay leg in the background.** Persist a per-host "relay approved" flag and set it after the first successful relay `listProjects` (RelayConnector.kt:72-74). In background (worker) refreshes, do not dial the relay at all while the flag is unset. Post a notification instead, such as "Open nodeterm to approve this phone on <computer>".
> - **Show the code on the phone at any time.** The SAS is derived from the static ECDH `baseKey` (relay-socket.ts:168-170, 236, 602-603 and e2ee.ts `sasFromSharedKey`), so it is stable for a given phone key and host key. The app can compute it from `graph.boxKeys` plus `host.relayHostKeyB64` without connecting. It could then show the code in that notification or on the host screen, so a desktop prompt can always be verified. Today the phone only shows the code during a foreground relay connect, and while the phone is on the LAN the foreground connect goes over SSH and never shows it.

## A24

**SecureStore treats ANY decrypt error as 'absent', so getOrCreate32 permanently overwrites the phone's identity**

- Severity: **medium**; claimed by auditor: medium; effort: small; area: security; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/data/SecureStore.kt:60`

**Evidence**

getBytes wraps key lookup, `cipher.init` and `doFinal` in `catch (_: Exception) { null }` (lines 55-64). That catches KeyStoreException, ProviderException, IllegalStateException and other transient keystore failures, not only 'key wiped / wrong device'. getOrCreate32 (lines 77-82) then writes fresh random bytes over the stored value: `getBytes(name)?.takeIf { it.size == 32 }?.let { return it }; val fresh = ...; putBytes(name, fresh)`. AppGraph uses it for both BOX_SECRET and SSH_SEED (NodetermApp.kt:144-147).

**Proposed fix**

Regenerate only on positive evidence: the alias is absent (a new key was just generated), or decrypt fails with AEADBadTagException / KeyPermanentlyInvalidatedException. For any other exception, rethrow or retry and never overwrite. Consider `commit()` for the first write of the identity secrets.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> 1. Wrong location: the AppGraph uses are at NodetermApp.kt:25 and NodetermApp.kt:28, not lines 144-147 (the file has only 51 lines).
> 
> 2. The impact is overstated. The desktop does not "stop accepting" the phone. A relay connect with a new box key reaches standing-host.ts onPeerReady (lines 249-262). The key is not pinned, so the desktop raises a new SAS approval dialog: `approvals.add(pub)` + `remoteHostPeerPending`, and the phone shows AwaitingApproval (ConnectionManager.kt:111-113). The relay device token is not tied to the phone's key; it is minted from deviceId, hostDeviceId, hostPublicKeyB64 and label. So the real cost is:
>    - every paired computer has to re-approve the phone, which needs someone at the desk, and that is the one thing a phone user usually cannot do;
>    - direct SSH fails authentication until the phone is re-paired, because authorized_keys still holds the old public key.
>    In AUTO route, ConnectionManager.kt:75-95 catches the SSH failure and falls back to the relay; SSH_ONLY hosts are simply broken. The stale authorized_keys lines are harmless leftovers: the old seed has been overwritten, so nothing can use them.
> 
> 3. The trigger is narrower than implied. Kotlin's `lazy` does not cache a thrown exception. So if `key` fails to initialise in both `getBytes` and the `putBytes` that follows it, `putBytes` throws out of `getOrCreate32`, the lazy `boxKeys`/`sshIdentity` throws, and the result is a failed connection with no overwrite. An overwrite needs one of two things:
>    - (a) a failure specific to decryption (in `init` or `doFinal`) while encryption, a moment later in the same synchronized call, succeeds; or
>    - (b) `ks.getKey(ALIAS, null)` briefly returning null.
>    Case (b) is worse. Line 31 then calls `KeyGenerator.generateKey()` under the same alias, which replaces the Keystore key itself, so every stored secret becomes undecryptable, the relay tokens included. How often Android Keystore actually does either was not measured here. Without that, severity is medium at most, arguably low.
> 
> 4. The fix needs adjusting. KeyPermanentlyInvalidatedException cannot happen here, because the key has no user-authentication requirement (no `setUserAuthenticationRequired` in lines 34-38). The positive evidence of loss is:
>    - the alias was absent when the key was created (check `ks.containsAlias(ALIAS)` explicitly, and generate only in that case);
>    - AEADBadTagException on `doFinal`;
>    - a malformed blob: IllegalArgumentException from Base64, or a blob shorter than IV + tag.
>    Every other exception should propagate, like the desktop's PeerKeyLockedError, and never lead to a write. `getBytes` should return a three-way result (absent / value / unreadable-now) instead of `ByteArray?`. The relay-token readers (ConnectionManager.kt:101, HostsScreen.kt:121) have the same null-on-error behaviour. For them it only produces a misleading "Remote access isn't set up" message and deletes nothing.

## A25

**No real push notifications: 15-minute background polling, no notification actions, no Live-Activity equivalent, and the desktop's phone-push switches are ignored**

- Severity: **medium**; claimed by auditor: high; effort: medium; area: parity; kind: gap
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/notify/InboxNotifier.kt:64`
- Note: Related: A73.

**Evidence**

iOS gets server-sent pushes that wake the app: src/core/push-notify.ts:1-8 ("Desktop → paired-phone APNs push … a paired iPhone should get a real APNs push even with the app backgrounded/killed"). Those pushes carry actions: push-notify.ts:57-58 ("The backend renders them as numbered notification actions"). They also drive Live Activities: push-notify.ts:455 ("`POST {apiBase}/v1/push/live-update`, feeding iOS Live Activities"). The user controls them per host and per kind: src/shared/types.ts:1770-1786 (`mobilePushNeedsYou`, `mobilePushDone`, `mobileLiveActivities`, `mobilePushPresenceAware` "Hold phone ALERTS while you're actively at this computer"), and push-notify.ts:92-97 describes a per-host mute (#435). Over plain SSH, iOS drops a grant at `~/.nodeterm/push-grants/<deviceId>.grant` (src/core/remote-push-grants.ts:1-12). Android only polls: `PeriodicWorkRequestBuilder<InboxWorker>(15, TimeUnit.MINUTES)` (InboxNotifier.kt:64). `build()` (InboxNotifier.kt:105-116) creates a plain notification with no `addAction` for Approve/Deny/options, and its tap opens the computer (`putExtra(MainActivity.EXTRA_HOST_ID…)`, :101), not the session. `announce()` posts every unresolved kind with one global switch (`graph.hosts.notificationsEnabled`), so the desktop's Needs-you/Done toggles, presence deferral and per-host mute do not apply.

**Proposed fix**

Add an FCM leg to the backend's `/v1/push/notify` and `/v1/push/live-update`, sharing the existing host-identity and grant auth. Then register an FCM token and write a push grant from the phone. Until that exists: add notification actions (Approve/Deny through `QuickActions`, numbered option actions), deep-link the tap to the node's terminal, and honor the mirror's push preferences if they are published.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Downgrade to medium and restate it as three app-side gaps plus one backend dependency that is already documented:
> (a) Backend (documented at InboxNotifier.kt:31-39, android/README.md:52-57, docs/android.md:90-91): with no FCM leg in `/v1/push/notify` and `/v1/push/live-update`, the app can only poll with WorkManager every 15 minutes, and there is no Live Activity equivalent.
> (b) InboxNotifier.kt:105-114: no notification actions. Add Approve/Deny for APPROVAL and numbered options for QUESTION, handled by a BroadcastReceiver that calls the existing `QuickActions.answerApproval` / `answerQuestion`.
> (c) MainActivity.kt:67-70 and :83-90: with `launchMode="singleTask"`, a tap while the app is alive goes to `onNewIntent`. That only handles the pair link, so the notification's `EXTRA_HOST_ID` is dropped and nothing navigates. Handle it in `onNewIntent`, and add the node id so the tap can open `Route.Terminal` or the Inbox entry.
> (d) Only one global switch (HostStore.kt:83), with no per-host mute.
> Drop the claim that desktop toggles are ignored. `mobilePushNeedsYou`, `mobilePushDone` and `mobilePushPresenceAware` are not in `MirrorSettings` (agent-status-mirror.ts:173-197), so no phone can read them. They only gate the desktop's own APNs send. Android already has separate attention and done channels (InboxNotifier.kt:41-55) for per-kind control.

> Mostly correct, with these fixes:
> 
> **Severity: medium, not high.** The gap is documented (InboxNotifier.kt:31-39, android/README.md:54-57, docs/android.md:90-91), and its root cause is that the backend's `/v1/push/*` is APNs-only. That backend is outside this repo.
> 
> **The deep-link claim is wrong; replace it with the real bug.**
> - The tap does go to the Inbox tab: `Route.Host(openHost, tab = 2)` (MainActivity.kt:88), and tab 2 is Inbox (HostScreen.kt:112).
> - The actual defect: MainActivity is `singleTask` (AndroidManifest.xml:24), and `onNewIntent` (MainActivity.kt:67-70) handles only pair links.
> - `EXTRA_HOST_ID` is read only in `onCreate` (MainActivity.kt:83).
> - So with the app task alive, a notification tap does not navigate at all.
> - Fix: handle `EXTRA_HOST_ID` in `onNewIntent`, e.g. through a state flow the navigator observes. Also consider adding a node id so the tap can open that session directly.
> 
> **Desktop toggles: the proposed fix won't work as written.** The toggles are not published: `MirrorSettings` (src/core/agent-status-mirror.ts:173-197) has no push fields, so "honor them if published" is not possible today.
> - Doing it needs a desktop change: add the needs-you/done/presence flags to `MirrorSettings`.
> - Android already offers per-kind muting through its separate `attention`/`done` channels (InboxNotifier.kt:48-55).
> 
> **Live Activities:** not an independent gap. The Android equivalent (an ongoing notification) would also need FCM or a foreground service.
> 
> **Fixable in-app now:**
> - Add `addAction` Approve/Deny and numbered options in `InboxNotifier.build`, handled by a BroadcastReceiver or worker that calls the existing `QuickActions` (QuickActions.kt:23-48). Only claude approvals can be answered this way (QuickActions.kt:35-37); others return OPEN_SESSION.
> - Fix the `onNewIntent` deep link.

## A26

**Current follow-up:** A107 serves direct Git on admitted local/driven folders independently of
the actions service. A108 adds selected-profile SSH Board on Desktop/Server and delivery-only
node nudges on Desktop. A manually added SSH host has no relay fallback for a missing service
capability. A111 adds host-owned managed New on current enabled local Linux/macOS tmux hosts;
physical verification remains pending. Another desktop's driven projects retain only
machine-local operations, including direct Git, rather than this profile's Board/node actions.

**New session and board edits are unavailable on the LAN (direct-SSH) connection that Auto picks first; iOS does both over SSH**

- Severity: **medium**; claimed by auditor: high; effort: medium; area: parity; kind: gap
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/HostScreen.kt:71`

**Evidence**

iOS registers phone-started sessions over direct SSH: src/core/project-node-append.ts:2-3 ("the phone's twin of this logic lives in nodeterm-ios ProjectNodeRegistrar and writes over direct SSH") and :23 ("the DIRECT-SSH registration path has always written it"). It also moves cards and edits labels over SSH: src/main/index.ts:3940 ("`setCardColumn` moves one card. The phone could already do this over direct SSH") and CLAUDE.md:4784 ("The iOS direct-SSH path has a Swift twin of the transform for projects on the host it dials"). Android: `val canCreate = (state as? ConnState.Connected)?.kind == TransportKind.RELAY && …` (HostScreen.kt:71), so the New-session FAB is hidden on SSH. SshHostConnection sets `HostCapabilities(boardWrites = false, git = false, nodeActions = false, registerNode = false, …)` (SshHostConnection.kt:61-63), and `registerNode`/`setCardColumn`/`editCardLabels` are `relayOnly(...)` (:254-258). BoardTab then shows "Read-only here — board edits need the relay connection." (BoardTab.kt:127-129). The `Auto` route tries SSH first and keeps it when it works (`if (route != RoutePreference.RELAY_ONLY && host.sshAvailable)`, ConnectionManager.kt:76), and the app never opens the relay for a relay-only verb even when the computer has a relay leg.

**Proposed fix**

When connected over SSH, lazily open the relay leg (if the computer has one) for `projects.registerNode` / `ensureBoard` / `setCardColumn` / `editCardLabels` / `node.*`. Or implement the SSH writes the way iOS does, but stream the file over stdin rather than argv so it avoids MAX_ARG_STRLEN.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Real, but the claim is overstated in four places, and I would rate it medium rather than high.
> 
> 1. **Documented, deliberate decision.** docs/android.md:95-98 says: "Direct SSH is POSIX-only by design (like iOS): board writes, node actions and new sessions need the relay. iOS writes `project.json` over SSH for some of these; Android deliberately does not." android/README.md:20-22 also marks these as relay-only / read-only on SSH. Neither doc considers the finding's first fix, which is to open the relay just for these verbs. That fix is still valid.
> 
> 2. **A user-facing workaround exists.** Settings → "How to reach each computer" → "Only through the relay" (SettingsScreen.kt:100-111) forces the relay route. New session and board writes then work on the LAN. The real defect is that the default Auto route hides them, and the missing FAB comes with no explanation (the board tab at least shows a hint).
> 
> 3. **"A phone paired while remote access was off can never do either" is too strong.** If the user later turns on remote access, `adoptRelayIfAdvertised` (ConnectionManager.kt:165-187) mints a relay token over SSH. From then on, "Only through the relay", or being off the LAN, enables both features. The phone stays stuck only while remote access remains off.
> 
> 4. **iOS's SSH parity is narrower than implied.** src/main/index.ts:3940-3942 says the iOS direct-SSH card move works "only for a project whose folder is on THIS machine and only while the whole file still fits in one argv string". CLAUDE.md:4789 measured this repo's own project.json at 114,695 bytes, about 15 KB under the 128 KB MAX_ARG_STRLEN ceiling. So the gap covers local folder projects under that size, not every project.
> 
> **Better fix.** Keep SSH as the primary transport. For `registerNode`, `ensureBoard`, `setCardColumn`, `editCardLabels` and `node.*`, open the relay leg on demand when `host.relay` and a token exist. Where no relay leg exists, show why New session is unavailable instead of silently hiding the FAB.

> Four corrections to the finding:
> 
> 1. **Severity.** I would rate this medium, not high. It is a documented, deliberate gap (docs/android.md:95-98). A user whose computer has remote access on can work around it by setting the route to "Only through the relay" (SettingsScreen.kt:104).
> 
> 2. **"Can never" is overstated.** A phone paired while remote access was off is not stuck forever. Late adoption (ConnectionManager.kt:165-187) mints a relay token from `~/.nodeterm/relay.json` once remote access is turned on. After that, relay-only routing or being off the LAN enables these features. Only while remote access stays off does the phone lose them for good. In that case iOS still has them over SSH.
> 
> 3. **Two UX problems add to it.**
>    - The FAB just disappears on SSH, with no reason shown.
>    - The relayOnly error text (SshHostConnection.kt:261), "turn on remote access in nodeterm → Settings → Phone", is wrong when remote access is already on. The real problem is that the phone picked the SSH leg.
> 
> 4. **Better fix.** In HostSession, when a relay-only verb is needed while `conn` is SSH and `host.relay` plus a stored relay token exist (often already minted by `adoptRelayIfAdvertised`), open a secondary relay connection lazily for `registerNode`, `ensureBoard`, `setCardColumn`, `editCardLabels` and `node.*`. Also show the FAB and board controls disabled with the reason, not hidden. The fallback is an SSH write that streams over stdin to a temp file, then does an atomic mv. That would also work with remote access off, but it must re-implement the kanban and node-append transforms, and it cannot reach SSH-project refs.

**Continuation scope (`A90`, 2026-10-03):** the original `A26` relay-routing fix remains.
The user now needs an explicit plain shell on a manual SSH/WireGuard host with no local
workspace/relay. `A90` adds a phone-owned `nodeterm-phone` session and independent listing,
without registering on the desktop canvas or writing its shared project file. That A90 change
alone did not restore cold managed-agent sessions or supply Board/node/Git verbs over SSH.
At that checkpoint, implementation/tests/build/device verification were pending. The focused
plain-shell flow later passed on the Pixel; A107/A108 now provide the separate typed Git and
owned service paths described above. Their new physical matrices remain pending.

## A27

**Cannot connect straight to a Linux dev host or a headless Server Edition (iOS's "phone SSHes into the host" setup)**

- Severity: **medium**; claimed by auditor: high; effort: large; area: parity; kind: gap
- Location: `android/protocol/src/main/kotlin/dev/nodeterm/protocol/ssh/SshScripts.kt:38`

**Evidence**

iOS reaches plain SSH hosts on its own: src/core/remote-push-grants.ts:7 ("phone --SSH--> Linux dev host <--SSH-- macOS nodeterm", called "the common desktop setup"). src/main/remote-ssh/remote-status-push.ts:5-9 says the per-project slice `~/.nodeterm/agent-status-<projectId>.json` exists because "a phone browsing the host directly sees live tmux sessions but no agent states". docs/SERVER.md:81 describes a headless host that "gives a phone SSHing into it full push / Live-Activity coverage", and :142 says "the phone offers this per connection (it installs under whichever user its SSH session logs in as)". The mirror's `server` block is "surfaced to the phone so it can show the installed version / commit" (agent-status-mirror.ts:156-161). Android can only add a computer by scanning a desktop QR (PairScreen.kt; the only entry points are Scan / paste code). Its SSH browse looks for userData only in `~/Library/Application Support/nodeterm` and `~/.config/nodeterm` (SshScripts.kt:38), not the Server Edition's `~/.nodeterm-server` (src/server/config.ts:108). It lists only the `-L node-terminal` socket (SshScripts.kt:56), never `nodeterm-rmt` (Models.kt:228: "never the phone's target"), and never reads `agent-status-<projectId>.json`. `serverVersion` is parsed (ProjectsParser.kt:138) but never shown.

**Proposed fix**

Add a manual "Add SSH server" flow (host, user, port; install the phone's Ed25519 key). Extend the SSH browse to find `~/.nodeterm-server`, list the `nodeterm-rmt` socket, and read `~/.nodeterm/agent-status-*.json` slices, treating a stale `updatedAt` as no data. Show the `server` block (version, commit, installedAt), and offer the install-server.sh one-liner per connection.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The core claim stands, but three details need adjusting.
> 
> 1. **Severity should be medium, not high.** The headline Android flow is pairing with a desktop, and that works. The gap is complete only for SSH-only users and headless Server Edition users. That is a meaningful parity gap in a narrower case, not a feature broken for most users.
> 
> 2. **"Cannot use the Android app with that machine at all" is too strong for the Mac-driven dev host case.** host-service.ts:157-159 notes that in some setups the phone has no credentials for the SSH host. A user whose Mac is paired can still reach that Mac through the relay (and through direct SSH to the Mac) and browse its projects, SSH projects included. The statement is fully true only for:
>    - a headless Server Edition, which has no pairing service anywhere under src/server;
>    - a user who only has SSH access to the dev host.
> 
>    Also, the iOS "add SSH host manually" flow is inferred from the desktop's SSH-only-phone code paths (index.ts:2136-2143, push-notify.ts:92-99). The nodeterm-ios source is not visible to confirm it.
> 
> 3. **The proposed fix needs three refinements:**
>    - **Track the socket per session.** Both `node-terminal` and `nodeterm-rmt` can exist on one host at once (the session-memory notes in CLAUDE.md).
>    - **Make attach on `nodeterm-rmt` attach-only.** `SshScripts.attach` uses `new-session -A`. On `nodeterm-rmt` that would create a missing session without the desktop's hook and account `-e` environment and its remote tmux.conf.
>    - **Discover projects differently on a Mac-driven host.** There is no `workspace.json` there. Node ids would come from the `agent-status-<projectId>.json` slices, the `tmux ls` output and `<remoteCwd>/.nodeterm/project.json`, with a stale `updatedAt` read as "no data" (STATUS_HEARTBEAT_MS = 60 s).
> 
>    `~/.nodeterm-server` is only the default location. It can be changed with `--data-dir` or `NODETERM_DATA_DIR`, so the browse should check the default and treat a miss as "unknown", not as "no nodeterm here".

> Real, with these corrections:
> 
> - **Anchor.** The "only QR/paste" claim belongs at PairScreen.kt:97-115 (accept() at :67-75), not at SshScripts.kt. SshScripts.kt:38 is correct only for the userData probe.
> - **Stronger root cause for the Server Edition.** The issue is not only the missing `~/.nodeterm-server` probe. src/server has no pairing service at all, so no QR exists to scan and Android has no route whatsoever.
> - **Severity.** "High" is defensible for users of these two topologies. Everyone who pairs with a desktop by QR is unaffected, though, so medium–high (a whole-topology parity gap) is more precise than "headline feature broken for most users".
> - **Fix: key install.** The phone cannot install its own Ed25519 key before it can authenticate. The manual "Add SSH server" flow needs a bootstrap: a one-time password login, or showing the public key line for the user to add to authorized_keys. It also needs TOFU host-key pinning like the paired path.
> - **Fix: push.** `~/.nodeterm/push-grants` and the backend's /v1/push fan-out are APNs-only (docs/android.md Known gaps). Adding the host would give Android browse, terminal, status slices and polling, but not headless push. Do not promise the "full push / Live-Activity coverage" from docs/SERVER.md:81.
> - **Fix: status slices.** Reading the `agent-status-<projectId>.json` slices should treat an `updatedAt` older than about 2× STATUS_HEARTBEAT_MS (60 s, remote-status-push.ts:22) as no data.
> - **Fix: nodeterm-rmt targets.** Attaching to nodeterm-rmt sessions must use that socket for attach, has-session, send-keys and kill as well, not only for list.

## A28

**SSH-project sessions over direct SSH are attached, approved and resumed on the wrong machine**

- Severity: **medium**; claimed by auditor: medium; effort: small; area: parity; kind: gap
- Location: `android/protocol/src/main/kotlin/dev/nodeterm/protocol/ssh/SshScripts.kt:93`
- Note: Same issue as A09.

**Evidence**

SSH-project sessions run on the remote host. The desktop routes their approval answers there (`writePendingAnswer` writes `~/.nodeterm/pending/<id>.answer` "on the project's host over its ControlMaster", src/main/remote-ssh/ssh-project.ts:1814-1823). CLAUDE.md also states "A remote node is NEVER spawned locally". iOS reaches such sessions on their own host (see the dev-host finding). Android lists them (SessionsTab.kt:111 keeps every open project; :236-238 labels them "on user@host"). Over the direct-SSH connection to the Mac it then runs `exec "$NT_TMUX" -L node-terminal … new-session -A -s 'nt-<id>'` on the Mac (SshScripts.kt:93). That creates an empty local shell, reports `fresh=true`, and TerminalController offers `claude --resume <id>` in it. Approvals take the same wrong path: SshScripts.answerApproval checks the Mac's `~/.nodeterm/pending/<id>.json` and prints `gone` when it is missing (:136). That maps to `ApprovalOutcome.ALREADY_HANDLED` (SshHostConnection.kt:268), and the UI toasts "Already handled." (InboxTab.kt:88) while the remote hook is still holding the request.

**Proposed fix**

Over SSH, refuse or relay-route nodes whose project has `sshTarget` (the relay's `approvals.answer` already routes through the desktop's `answerPermission`). Longer term, reach them by connecting to that host directly, as iOS does.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The root cause and all cited lines are correct, but the proposed fix is only half right.
> 
> **Approvals: relay-routing does fix them.** `approvals.answer` goes through `answerPermission`, which routes to the project's host.
> 
> **Attach: relay-routing does NOT fix it.** The relay `pty.attach` has the same wrong-machine behaviour on the desktop side, where it pre-existed:
> - `host-service.ts` `handleAttach` (:419-432) calls `pty.sessionExists(nodeId)` and then `pty.attachDetached(nodeId, sinks, {cols, rows})`.
> - `PtyManager.attachDetached` (pty-manager.ts:2661-2667) passes only `persistKey`, with no `sshRemote` or `requireRemote`. `spawnSession` therefore runs a local `tmux new-session -A` on the Mac's `node-terminal` socket.
> - It is arguably worse on the relay. When the canvas holds a live remote session, `sessionExists` answers true via `liveSessionForPersistKey`, so the phone gets `fresh:false` over a brand-new empty local shell.
> 
> **Better fix:**
> 1. On BOTH transports, refuse to attach to nodes whose project has `sshTarget`. Show something like "runs on user@host — open it there". The same applies to End session over SSH, which would kill a local `nt-<id>` that never existed.
> 2. For approvals of such nodes, use the relay `approvals.answer` when a relay leg exists. Otherwise tell the user it must be answered on the computer. Do not fall through to OPEN_SESSION or "Already handled."
> 3. Separately, the desktop's relay attach path should refuse (or route over the ControlMaster) for nodes that `workspaceStore.sshProjectIdForNode` resolves to an SSH project.
> 
> A precision note on wording: the resume is only offered, never typed automatically. Accepting it launches the agent CLI on the Mac, where the transcript does not exist.

## A29

**Current follow-up:** A107 adds the same eight typed verbs over direct SSH with a physical project/repository jail and no uncertain replay.

**No source-control screen, although the protocol layer already implements the git verbs iOS uses**

- Severity: **medium**; claimed by auditor: medium; effort: medium; area: parity; kind: gap
- Location: `android/protocol/src/main/kotlin/dev/nodeterm/protocol/host/HostConnection.kt:95`

**Evidence**

The phone vocabulary includes a source-control sheet: src/main/remote/host-service.ts:117-120 ("the jailed core bridge that lets a relay-only phone (no direct SSH) run the source-control sheet in ONE round trip per operation instead of N ssh execs"). src/main/index.ts:3903 ("The jailed core bridge both phone hosts serve: typed git verbs") and host-git-bridge.test.ts:1 ("The jailed core bridge for the PHONE vocabulary: typed `git.*` verbs") agree. "instead of N ssh execs" shows iOS also does source control over SSH. Android declares `suspend fun git(verb: GitVerb, cwd: String, …)` (HostConnection.kt:95; `GitVerb` STATUS/DIFF/STAGE/UNSTAGE/COMMIT/PUSH/PULL/HISTORY at :103), and RelayHostConnection advertises `git = true` (RelayHostConnection.kt:55). But no app code calls `.git(` (grep finds 0 call sites under android/app), and SSH throws `relayOnly("Source control")` (SshHostConnection.kt:258).

**Proposed fix**

Add a per-project Source Control screen over `conn.git(...)`: status list, diff viewer, stage/unstage, commit box, push/pull, history, with the host's error messages shown as returned. Add an SSH implementation that runs `git -C <cwd>` inside the project roots.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Three refinements:
> 
> 1. **The gap is also undocumented.** docs/android.md has a protocol mapping table (lines ~33-45) and a "Known gaps" section (lines 88-104). Neither mentions git or source control, even though the doc says it records "what is not done". The fix should document the gap as well as close it.
> 
> 2. **Better fix: relay first, then SSH.** Ship the screen over the relay first, following the pattern the app already uses for board writes, node actions and new sessions: gate it on `conn.capabilities.git` and hide it or show the relay-only reason on SSH. The relay path already exists (RelayHostConnection.kt:280). Its error contract is explicit: host-service.ts:514-523 answers "git is not served on this host." / "cwd is outside the shared project roots.", and the UI should show those strings as returned. An SSH leg (`git -C <cwd>` over the session) can follow as a separate step. If it is built, restrict cwd to the project roots from `projects.list`, to match the desktop's `isWithinRoots` jail, and use typed verbs only. Otherwise document it in Known gaps, the same way board writes are documented as relay-only.
> 
> 3. **Line and evidence details.** The capability flag is at RelayHostConnection.kt:54-56 (the `HostCapabilities(...)` constructor, `git = true` on :55), and the implementation is at :280-281. The claim that iOS does source control over SSH is inferred from a desktop comment and is not verified.

## A30

**Pressing Deny on the desktop is not respected: the phone re-dials about 8 s later and the SAS approval dialog reappears**

- Severity: **medium**; claimed by auditor: medium; effort: small; area: critic; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/conn/ConnectionManager.kt:212`
- Note: Related: A05, A07.

**Evidence**

Desktop side: on Deny, standing-host.ts:398-404 (`ipcMain.on(IPC.remoteHostReject…)`) only calls removeFromPool(p) → session.close() and ensurePool(). There is no deny list. Phone side: the close surfaces in RelayConnector as the generic `HostException("The connection closed while waiting for approval.")` (RelayConnector.kt:70), so the phone cannot tell a rejection from a network drop. It becomes ConnState.Failed. While any screen watches the computer, the poll loop `while (isActive) { refreshNow(); delay(POLL_MS) }` (ConnectionManager.kt:212-221) calls refreshNow → ensureConnected → connectLocked again, with no backoff and no memory of the refusal. When SSH is unavailable (off-LAN, a Windows host, or the Relay-only route), each attempt does a fresh /v1/relay/join plus handshake on the replacement listener, and onPeerReady raises a new SAS dialog (standing-host.ts:258). The same loop re-raises the dialog every ~5 min 8 s after an unanswered approval times out (RelayConnector.kt:82).

**Proposed fix**

Treat a close during the approval wait as a terminal refusal for this HostSession. Stop the auto-reconnect and show "The computer declined this phone" with an explicit retry button. Back off after an approval timeout. On the desktop, remember a rejected key for some time instead of prompting again.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The claim is right but understates the scope in one respect, and a few details need adjusting.
> 
> 1. The poll loop is not the only thing that redials. `InboxWorker.doWork` (InboxNotifier.kt:118-129) is a 15-minute `PeriodicWorkRequest` (:64). It calls `withTimeoutOrNull(45_000) { session.refreshNow() }` for every paired host, whether or not a screen is watching. A denied phone on the relay route therefore raises the SAS dialog again about every 15 minutes indefinitely, even with the app closed. Each of those prompts is abandoned 45 s later, when the timeout cancels the connect. A phone-side fix limited to `HostSession` or the poll loop would not stop this. The worker must also skip a host whose last relay attempt was refused or is still unapproved.
> 
> 2. The timing depends on the real relay. "About 8 s" assumes the relay closes the phone's socket when the host closes its side. The test broker does (host-fixture.ts:76-78). If the real relay does not, the phone fails through the 30 s RPC timeout instead (RelaySocket.kt:326), so the redial comes after about 38 s. Either way the dialog comes back.
> 
> 3. Line numbers: the loop body is ConnectionManager.kt:214-219, and :212 is the `startWatching` declaration.
> 
> 4. The fix belongs mainly on the desktop. Any client can simply redial, so the security mitigation is to remember a rejected public key for a while in standing-host.ts or phone-approval.ts and not prompt for it again. Relatedly, `mintDevice` needs only the host's public key and hostDeviceId, which are advertised in relay.json. On the phone, the fix is UX: treat a close during the approval phase as a refusal, stop auto-reconnect in both the poll loop and the worker until the user taps retry, and back off after an approval timeout.
> 
> 5. Severity: medium is reasonable. The case is limited to the relay route and a phone that was denied or left unanswered, but the effect is repeated prompting on a security dialog.

## A31

**A silently dead SSH peer (laptop asleep, desktop IP or VPN change) wedges the host as 'On your network' for many minutes: no detection, no relay fallback, and the error is never shown**

- Severity: **medium**; claimed by auditor: medium; effort: small; area: critic; kind: bug
- Location: `android/protocol/src/main/kotlin/dev/nodeterm/protocol/ssh/SshHostConnection.kt:84`

**Evidence**

(1) Keepalive: `client.connection.keepAlive.keepAliveInterval = 20` (line 353) configures sshj's DefaultConfig provider. That provider is KeepAliveProvider.HEARTBEAT (javap of sshj-0.39.0 DefaultConfig), and Heartbeater.doKeepAlive only writes an SSH_MSG_IGNORE and never expects a reply, so it cannot detect a dead peer. The sshj Reader also catches SocketTimeoutException and continues, so `client.timeout = 30_000` does not help either. (2) run(): `val out = cmd.inputStream.readBytes()` runs before `cmd.join(timeoutSec…)` (lines 88-89), and ChannelInputStream.read uses a bare Object.wait(). The timeout never bounds the read, so a command in flight when the peer vanished blocks forever. (3) Every other failure, such as startSession timing out, is wrapped as `HostException("The SSH connection failed…")` (line 96). fireClosed runs only `if (!isConnected)`, which stays true. ConnectionManager.refreshNow treats any HostException as an 'answer' and does NOT disconnect (ConnectionManager.kt:195-203), so the dead connection is reused on every poll and connectLocked's relay fallback is never reached. (4) The only error sink, `_lastError` (ConnectionManager.kt:53-54, 198), is never read by any UI (grep: no reference outside ConnectionManager.kt).

**Proposed fix**

Use `KeepAliveProvider.KEEP_ALIVE` (keepalive@openssh.com with a max missed count) in the SSHClient config. Bound run() with a real deadline (read on a worker thread, or close the channel on timeout). In run() and refreshNow, classify channel-open and transport timeouts as transport failures and disconnect, so Auto falls back to the relay. Surface lastError in HostScreen.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Three refinements, none of which changes the verdict.
> 
> (a) "Heartbeater cannot detect a dead peer" is slightly overstated. Its IGNORE writes are exactly what make the kernel eventually time out an otherwise idle connection. Detection does happen, but only after the TCP retransmission timeout (about 15 minutes), never within an app-level bound. It is not "never".
> 
> (b) A laptop that wakes inside the retransmission window resumes the same TCP connection, so the sleep case is a long stale window rather than a permanent wedge. The desktop IP-change and VPN cases really are dead until the kernel gives up.
> 
> (c) The InboxWorker impact is narrower than stated. For an unwatched host it calls `session.disconnect()` after every run (InboxNotifier.kt:127), and a fresh `connect()` uses a 4 s connectTimeout under Auto, so it falls back to the relay correctly. It only loses time when it reuses a dead conn that was left open: stopWatching does not disconnect. It hangs past its 45 s timeout only if a read was in flight.
> 
> Fix details. Set `KeepAliveProvider.KEEP_ALIVE` on the DefaultConfig BEFORE constructing SSHClient. KeepAliveRunner sends keepalive@openssh.com with want-reply and calls `transport.die()` after `maxAliveCount` misses, which fires the existing disconnectListener → fireClosed → relay fallback. Also bound the read in run() by closing the session or channel from a timer: channel close/notifyError unblocks the wait. Treat a channel-open timeout (ConnectionException) as a transport failure that disconnects, rather than as an "answer" HostException. Show lastError in the HostScreen banner.

## A32

**No way to open a URL or copy text from the phone terminal: no link detection, no touch selection, and the WebView cannot show xterm's link confirm**

- Severity: **medium**; claimed by auditor: medium; effort: medium; area: critic; kind: gap
- Location: `android/app/src/main/assets/terminal/terminal.js:22`

**Evidence**

terminal.js loads only the FitAddon (`term.loadAddon(fit)`, line 22). There is no WebLinksAddon and no `linkHandler`, so plain URLs in agent output are never linkified. OSC 8 links fall back to xterm's default activate, which calls confirm(). The WebView gets only a WebViewClient and no WebChromeClient (TerminalController.kt:175), so that dialog cannot appear and the link does not open. The shouldOverrideUrlLoading branch that 'opens links in the browser' (TerminalController.kt:177) is effectively unreachable. Selection is also unavailable: the vendored xterm.js handles touchstart/touchmove only for viewport scrolling, disables its selection service while mouse events are active (tmux runs `mouse on`), and xterm.css sets `.xterm { user-select: none }`. terminal.js additionally calls `e.preventDefault()` on every single-finger touchmove (line 80). The only copy path is OSC 52 emitted by the host, and on a touch phone the only way to trigger it is tmux copy-mode driven by mouse drag or prefix keys, neither of which is reachable. README.md:18 nevertheless advertises 'OSC 52 copy'.

**Proposed fix**

Load @xterm/addon-web-links with a handler that calls the bridge to open http(s) URLs. Set a linkHandler that skips confirm(), or install a WebChromeClient. Add a long-press 'select / copy screen' mode, e.g. capture the visible buffer via `term.buffer` and offer copy/share of lines, since tmux mouse mode makes xterm's own selection unusable.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Four parts of the finding need correcting.
> 
> 1. Two copy paths do exist, but neither is practical. The finding says OSC 52 copy can't be reached from a touch phone; that is not strictly true.
>    - Prefix keys: the key row has a Ctrl chip (TerminalScreen.kt:153). TerminalController.onInput turns Ctrl+letter into a control byte (TerminalController.kt:138-141). So Ctrl, b, [ enters tmux copy-mode (the default C-b prefix; the conf sets none). From there a keyboard selection and copy are possible but awkward and hard to discover.
>    - Double/triple tap: tmux 3.4's built-in root bindings are `bind -n DoubleClick1Pane { ... if -F '#{||:#{pane_in_mode},#{mouse_any_flag}}' { send -M } { copy-mode -H; send -X select-word; ...; send -X copy-pipe-and-cancel } }`, and the same for TripleClick1Pane (select-line). When the pane's app has not grabbed the mouse (a plain shell, codex), the clicks the WebView synthesizes from taps may therefore copy a word or line via OSC 52. This is not verified on a device. In a Claude pane, where the fullscreen TUI grabs the mouse, the click goes to the app instead.
>    So the accurate statement is: there is no practical or general copy path, and never a selection of arbitrary text. That is not the same as "none at all".
> 
> 2. The OSC 8 part is stronger than the finding shows. Links do reach the phone because pty-manager.ts:326 declares `,*:hyperlinks`.
> 
> 3. Proposed fix, links:
>    - Do not load @xterm/addon-web-links. The desktop replaced it on purpose: the addon cannot join the hard-wrapped rows that tmux repaints, so a long OAuth URL only matched its first row (src/renderer/terminal/file-links.ts:404-409).
>    - Port createUrlLinkProvider and set `term.options.linkHandler` to a handler that calls a new NodetermBridge.openUrl, limited to http(s).
>    - Account for the fact that, with mouse reporting on, a tap on a link is also sent to tmux as a click.
> 
> 4. Proposed fix, copy: a long-press "copy screen" or "select lines" sheet built from `term.buffer.active` remains the right approach.
> 
> The line citations in the finding are correct: terminal.js:22, :80; TerminalController.kt:175, :177; README.md:18.

## A33

**On a Windows computer, 'New session' starts the agent in the user's home folder instead of the project, and silently drops the chosen Claude account while still registering it**

- Severity: **medium**; claimed by auditor: medium; effort: medium; area: critic; kind: bug
- Location: `android/protocol/src/main/kotlin/dev/nodeterm/protocol/model/Agents.kt:28`

**Evidence**

The relay attach that creates a phone-started session passes only `{cols, rows}` (host-service.ts:432 `pty.attachDetached(nodeId, sinks, { cols, rows })`). The desktop therefore spawns it in `options.cwd || os.homedir()` (pty-manager.ts:2834), and the session-host backend receives that same `cwd` (pty-manager.ts:3346). The phone's only way to reach the project is the launch line. But `SAFE_DIR = Regex("^/…")` (Agents.kt:28) rejects every Windows path (`C:\Users\…`), so `cd '<cwd>' &&` is omitted (Agents.kt:52). Likewise `CLAUDE_CONFIG_DIR='<dir>'` is omitted for a Windows account dir (Agents.kt:54), and the shell variant's `Regex("^/…")` returns null (SessionsTab.kt:331). TerminalController still registers the node with `launch.accountId` (TerminalController.kt:238). Windows computers are relay-only, and New session is offered only over the relay (HostScreen.kt:71), so Windows is exactly the platform that takes this path.

**Proposed fix**

Have the host own the cwd: extend `pty.attach` or `projects.registerNode` so the desktop creates a phone-started session in the project's cwd with the account env (the desktop already knows both). Failing that, emit a platform-appropriate launch line for a win32 host (the mirror or projects blob can carry the host OS). Never register an accountId the launch did not actually apply.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Mostly accurate. Three refinements.
> 
> (1) "New session is offered only over the relay" is true for every host OS (HostScreen.kt:71). Windows is the platform where that relay-only path also loses the cd/env. Mac and Linux relay launches get `cd '/path' &&` and work.
> 
> (2) The finding's alternative fix is weaker than it sounds. A "platform-appropriate launch line" is not enough on its own. The Windows session host runs the default Windows shell (localSessionShell). There, `cd 'C:\x' && ...` is a parse error in PowerShell 5.1, cmd does not accept single-quoted paths, and the `VAR=value cmd` env prefix is POSIX-only. So simply relaxing SAFE_DIR would make things worse, not better.
> 
> (3) The primary proposed fix should not be `projects.registerNode`. The phone deliberately registers AFTER typing the launch line (TerminalController.kt:231-238), so the node does not exist when `pty.attach` creates the session. The right seam is to extend `pty.attach` (host-service.ts:382-433) with an optional projectId and accountId. The host would resolve the cwd from its own project registry and the account env via `claudeConfigDirFor`, validated the same way the canvas does. Until that exists, the phone should neither offer the account picker nor send `accountId` to registerNode when the launch line could not apply CLAUDE_CONFIG_DIR.

## A34

**The Ctrl key-row chip does not apply to text sent from the input bar: arming Ctrl and sending 'z' submits a literal 'z' plus Enter**

- Severity: **medium**; claimed by auditor: low; effort: small; area: critic; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/TerminalController.kt:136`

**Evidence**

The Ctrl transform only applies when `ctrlArmed && data.length == 1` (TerminalController.kt:136-144). The input bar sends through `nt.submit` → `term.paste(text)` (terminal.js:129-133). Under a tmux client xterm always has bracketed-paste mode on (CLAUDE.md: tmux's own paste-through `?2004h`), so onData receives `\e[200~z\e[201~` (length > 1) and the Ctrl is not applied. The following '\r' (length 1, outside '@'..'_') then disarms Ctrl. The other way to type into xterm directly, the soft keyboard via the ⌨ chip, does not work (already reported).

**Proposed fix**

Apply an armed Ctrl in Kotlin before submitting: if the draft is a single character, send the control byte via `raw()` and skip Enter. Otherwise disarm the chip when the input bar is used.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> 1. **Wrong line numbers for terminal.js.** The file has 121 lines. `nt.submit` is at terminal.js:110-114 (`term.paste(text)` at 112, the delayed `onInput('\r')` at 113), not 129-133. The onData hookup is at terminal.js:50. The Ctrl condition is TerminalController.kt:138-142 (the finding's line 136 is the `fun onInput` declaration). The input bar is TerminalScreen.kt:124-139 and the chip is at TerminalScreen.kt:153.
> 
> 2. **The impact is slightly overstated.** "Only the four ^C/^D/^R/^L chips work" is not quite right. The chip does apply to single keystrokes typed straight into xterm: tapping the terminal to bring up the soft keyboard, per the comment at terminal.js:48-50. Whether that works with Android IMEs is a separate question. The bug is specifically that the chip has no effect on the input bar, which is the main text entry. Low severity is appropriate.
> 
> 3. **The fix should drop Enter in every case.** Check ctrlArmed in the Kotlin send handler: if the draft is one character that maps to a control byte (`uppercase in '@'..'_'`, optionally `'?'` → 0x7f), send it via `raw()` with no Enter, then disarm. Otherwise disarm when the input bar is used. Point 6 above is why Enter must be dropped even when bracketed paste is off.

## A35

**approvals.answer returns `answered:false` both for 'already handled' and for 'the write failed'; the phone always says 'Already handled.'**

- Severity: **medium**; claimed by auditor: low; effort: small; area: critic; kind: bug
- Location: `android/protocol/src/main/kotlin/dev/nodeterm/protocol/host/RelayHostConnection.kt:255`
- Note: Related: A06.

**Evidence**

Android: `return if (body?.b("answered") == true) SENT else ALREADY_HANDLED` (RelayHostConnection.kt:255), and InboxTab shows the toast "Already handled." (InboxTab.kt:88). Desktop, the verb added in this branch: `.then((answered) => …{ answered })` and `.catch(() => …{ answered: false })` (host-service.ts:724-725). answerPermission returns false when the write fails: writePendingAnswerLocal's `catch { return false }` (pending-approvals.ts:56-58), and for an SSH-project node `sshProjectManager.writePendingAnswer` fails whenever its ControlMaster is down (index.ts:2782-2785). The phone's stillWaiting re-read has just confirmed the node is still blocked.

**Proposed fix**

Return a reason from the verb (`{answered:false, reason:'gone'|'write-failed'}`) and show 'Couldn't answer — try again or open the session' for a failed write.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The root cause is stated a little wrong. The desktop does not return `answered:false` for "already handled" at all: `answerPermission` never checks whether the hook is still holding the request, so on the relay path every `answered:false` is a delivery failure (write error, no SSH conn record, ssh exec failure, or a throw). The desktop comment at host-service.ts:691 and the test header at host-inbox-verbs.test.ts:6-7 are wrong to say otherwise. A related side effect: answering an already-timed-out hook returns `answered:true` (SENT), which the SSH path avoids.
> 
> Better fix, matching the SSH script's semantics:
> - In `answerPermission`, test for `<pendingId>.json` first (local: stat under `pendingDir(homedir())`; SSH: `test -f` over the ControlMaster).
> - Return a discriminated result: `{answered:true} | {answered:false, reason:'gone'|'write-failed'}`.
> - Map only `reason:'gone'` to ALREADY_HANDLED.
> - Map `write-failed`, and an absent reason from an older desktop, to an error toast such as "Couldn't answer — try again or open the session", the same way `SshHostConnection.answerApproval` throws HostException for a failed write.

## A36

**After any connection drop the terminal stays on 'Disconnected. [Reattach]' even though the host connection reconnects by itself**

- Severity: **medium**; claimed by auditor: low; effort: small; area: critic; kind: gap
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/TerminalController.kt:105`

**Evidence**

On a relay drop, RelayHostConnection.onClosed calls `sink.onExit(null)` for every stream (RelayHostConnection.kt:121-126). TerminalController then sets `state = TermState.Ended("Disconnected.")` (TerminalController.kt:105-110). HostSession reconnects automatically 1.5 s later when watched (ConnectionManager.kt:141-149), but that only re-lists projects. TerminalController does not observe `session.state`, and re-attaching needs the manual Reattach button (TerminalScreen.kt:95). The SSH stream behaves the same way (`sink.onExit(cmd.exitStatus)` with a null status).

**Proposed fix**

When the exit code is null (a transport drop, not a pane exit), have TerminalController wait for the HostSession to return to Connected and call attach() again automatically with bounded retries.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The mechanism is right. Four refinements, the last two about the fix:
> 
> 1. **SSH detection is slower.** A dead SSH channel does not null `HostSession.conn` straight away. `fireClosed` runs only when the next `run()` fails (SshHostConnection.kt:84-98), which is usually the next 8 s poll. On SSH the host-level reconnect therefore follows the drop by up to about 8 s, not 1.5 s. An automatic reattach attempted before that point goes through `ensureConnected()`, gets the stale connection back, and its `hasSession` `run()` throws a HostException. That lands the terminal in Ended again, this time with "Couldn't open the terminal over SSH…".
> 2. **Relay reconnect can stall at approval.** The relay re-dial can pass through `ConnState.AwaitingApproval` (ConnectionManager.kt:114). Waiting for `Connected` is correct, but the wait should have no short fixed deadline.
> 3. **A null code is not proof of a transport drop.** A relay `Op.ERROR` frame whose `exitCode` is JSON null also yields `onExit(null)` (RelayHostConnection.kt:68-71; the desktop forwards the pty's `exitCode` verbatim at host-service.ts:342-349). A cleaner signal is to mark streams closed by the connection-level `onClosed` path, or to key the retry on `session.state` leaving `Connected`.
> 4. **Keep the retry bounded and conditional.** Retries should be capped, and they should run only while the screen is showing (not `disposed`), so a real host-side failure cannot loop.

## A37

**proguard-rules.pro would not survive turning on minification (R8 missing-class errors)**

- Severity: **low**; claimed by auditor: low; effort: small; area: build; kind: risk
- Location: `android/app/proguard-rules.pro:3`

**Evidence**

app/build.gradle.kts l.21-23 keeps `isMinifyEnabled = false` and says shrinking 'needs keep rules nobody has written yet'. proguard-rules.pro says: 'If it is ever turned on, sshj, BouncyCastle and EdDSA need keeps …' and adds only `-dontwarn javax.naming.**` and `-dontwarn org.slf4j.**`. jdeps on the actual runtime jars shows references to classes android.jar does not have: sshj 0.39.0 `SSHClient` and `userauth.method.AuthGssApiWithMic` reference `org.ietf.jgss.*` (GSSContext, GSSManager, Oid, …) and `javax.security.auth.login.LoginContext`, and eddsa 0.3.0 `EdDSAEngine` references `sun.security.x509.X509Key`. R8 in AGP 8 fails the build on missing classes unless they are `-dontwarn`ed.

**Proposed fix**

Add `-dontwarn org.ietf.jgss.**`, `-dontwarn javax.security.auth.login.**` and `-dontwarn sun.security.x509.**`, and drop the unnecessary `org.slf4j` dontwarn (slf4j-api is on the classpath). Alternatively, change the comment so it no longer implies the rules are complete.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The finding holds, with two corrections.
> 
> 1. It overstates the framing. The file does not really present itself as a ready-made, complete rule set. build.gradle.kts:21 says outright "shrinking needs keep rules nobody has written yet", and proguard-rules.pro:1-2 only says keeps "need" to exist. The real inconsistency is smaller: that comment says the rules have not been written, while proguard-rules.pro:3-7 does contain partial keeps. Those keeps would fail R8 on missing classes as soon as they were used.
> 
> 2. A better anchor is proguard-rules.pro:6-7 (the dontwarn block), not line 3. The fix:
>    - Add `-dontwarn org.ietf.jgss.**`, `-dontwarn javax.security.auth.login.LoginContext` (or `.**`) and `-dontwarn sun.security.x509.**`.
>    - `-dontwarn org.slf4j.**` is redundant but harmless, because slf4j-api is a declared runtime dependency of sshj in both its POM and its .module file. It is a nit, not a required part of the fix.
> 
> It is unclear whether the result then passes R8. That needs an actual `assembleRelease`, which cannot run here because Google Maven is blocked. Severity: low (latent). The wording "would break assembleRelease" is accurate only once someone enables minification.

## A38

**Quick approve requires the node to be exactly 'blocked', but the desktop publishes approval tickets while the node stays 'waiting' on a held question**

- Severity: **low**; claimed by auditor: low; effort: small; area: protocol; kind: bug
- Location: `android/protocol/src/main/kotlin/dev/nodeterm/protocol/host/QuickActions.kt:53`

**Evidence**

Android: `if (status.state != expected) return false`, with `expected = AgentState.BLOCKED` for approvals (`WAITING` for questions), which returns ALREADY_HANDLED. Desktop agent-status-mirror.ts:1520-1528: when a parent AskUserQuestion is pending and a concurrent approval arrives, `produceInboxFromState(... 'blocked' ...)` publishes the approval card with its pendingId, but the mirror keeps `state: next.state` = 'waiting' ('keep the parent's waiting badge and question correlation until its own answer'). Conversely, line 1611 (`kind = hasQuestion || nextState === 'waiting' ? 'question' : 'approval'`) can emit a question card while the state is 'blocked'.

**Proposed fix**

For approvals, check that the event is still unresolved and that its pendingId is still live, and accept either needs-you state (blocked or waiting). Do the same for questions.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The line citations (mirror 1520-1528 and 1611) are correct. Restrict the finding to the approval direction. The question-while-'blocked' half needs an uncorrelated question and is not reachable in the normal Claude flow after #821.
> 
> The proposed fix is too broad and would be harmful as written. Relax the node-state gate ONLY on the ticketed path. When `event.pendingId != null`, skip the `state == BLOCKED` requirement. Keep only the "fresh event is still unresolved" re-check that hook-reply-approvals.md prescribes, then call `conn.answerApproval`; the desktop or the answer file reports "gone" when the ticket expired. Do NOT accept WAITING for the ticketless send-keys fallback (claude, no pendingId), and do not accept BLOCKED for answerQuestion. On a node whose AskUserQuestion picker is on screen, typing `1` would pick option 1 of the question rather than approve anything.

## A39

**The account chip reads `account.label`, which the mirror never writes, so it falls back to the raw account UUID**

- Severity: **low**; claimed by auditor: low; effort: small; area: protocol; kind: bug
- Location: `android/protocol/src/main/kotlin/dev/nodeterm/protocol/model/ProjectsParser.kt:129`

**Evidence**

Android: `accountLabel = account?.let { it.s("label") ?: it.s("accountId") }`. The mirror's `account` is `ObservedClaudeAccount` = `{configDir, accountId: string|null, known, remote?}` (shared/types.ts:1348-1370), which has no `label`. MirrorSettings.claudeAccounts carries only `{id, dir}`. SessionsTab.kt:265 renders `status?.accountLabel`.

**Proposed fix**

Derive the label as the desktop's AccountChip does: for a known managed id, look up a label (or show a short form); for an unlinked dir, use the last segment of configDir.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Three small corrections. Nothing here changes the verdict.
> 
> (1) It is not a separate chip. The value is joined into the Sessions row's " · "-separated detail text (SessionsTab.kt:260-267), so the UUID mostly shows up as ellipsized noise at the end of the line.
> 
> (2) The parse site starts at ProjectsParser.kt:121 (`val account = e.o("account")`). The fallback is on line 129.
> 
> (3) Better fix: the mirror already carries labels for local managed accounts. `usage.accounts[]` has `{accountId, label, email}`, built from settings (agent-status-mirror.ts:312-317, `label: acct?.label ?? null`), and Android already parses that block (ProjectsParser.kt parseUsage → `UsageAccount.label`, used in InboxTab.kt:236). So the fix is:
> - Resolve `account.accountId` against `status.usage.accounts`, using label, then email.
> - If there is no match, show a short form of the id rather than the full UUID. `usage` is dropped from SSH slices, and it is absent when no usage snapshot exists.
> - When `accountId` is null and `known` is false, show the last path segment of `configDir`.
> - When `accountId` is null and `known` is true, show nothing (the system account).
> 
> Dropping the `label` read entirely would also remove dead code.

## A40

**The pending-launch path and the attach hand-off never re-check `disposed`: a stream can stay attached forever, or a phone-started node gets registered with no agent launched**

- Severity: **low**; claimed by auditor: low; effort: small; area: runtime; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/TerminalController.kt:234`

**Evidence**

- attach() checks `if (disposed)` once, on the background thread (:209), then posts `main.post { stream = s; state = TermState.Attached ... }` (:213). If dispose() ran on main between that check and the posted runnable, the runnable installs `s` on a disposed controller, and nothing ever detaches it.
- afterAttach (:231-242) runs on graph.scope: `delay(900)`, then `s.write(launch.command + "\r")`, then `conn.registerNode(...)`, with no disposed or stream check. If the user leaves during those 900 ms, dispose() has already detached the stream (relay `pty.kill`), so the launch line is dropped. registerNode still runs, against a tmux session the phone's attach already created.

**Proposed fix**

Re-check `disposed` inside the main.post and detach if it is set. In afterAttach, abort (and don't registerNode) if the controller was disposed or the stream has changed since the delay started.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The mechanism is right, with three clarifications and a better fix.
> 
> 1. (a) and (b) cannot both happen on the same attach. In the (a) race the stream is NOT detached, so the pending launch actually succeeds (the write and registerNode both land). The launch is lost only in the (b) window, where the posted runnable already installed the stream and dispose() then detached it.
> 
> 2. The launch is also unrecoverable. PendingLaunches.take (:229) already consumed the request, so reopening the terminal cannot retry it.
> 
> 3. Cited lines: the (a) window is between TerminalController.kt:209 and :213. The unguarded launch sequence is :234-241.
> 
> Better fix for (b): the proposed "abort and don't registerNode" still leaves the `nt-<id>` tmux session that the attach created (`new-session -A`) running as an invisible orphan with a bare shell. Either:
> - let the launch finish regardless of the viewer: dispose() defers the detach of a stream that still has a pending launch until afterAttach has written the line and called registerNode; or
> - on abort, call `s.endSession()` (`pty.destroy`) so the created session is killed, rather than just skipping registration.
> 
> Fix for (a): in the main.post runnable, re-check `disposed` and detach `s` if it is set. Mark `disposed` @Volatile, or cancel attachJob from dispose().

## A41

**The composed prompt is cleared even when no stream is attached, so the text is silently lost**

- Severity: **low**; claimed by auditor: low; effort: small; area: runtime; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/TerminalScreen.kt:132`

**Evidence**

TerminalScreen.kt:131-138: `controller.submit(draft, enter = true); draft = ""`, with no state check. submit → JS `term.paste(text)` → `bridge.onInput(d)` → TerminalController.kt:143 `stream?.write(out)`. stream is null while Connecting or after Ended ("Disconnected."), so the bytes are dropped.

**Proposed fix**

Disable Send (or keep the draft and show a message) unless controller.state is Attached.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The finding is correct. On the line reference: the handlers span TerminalScreen.kt:131-138 (onSend at 131-134, the IconButton at 135-138), not just line 132. The same silent drop affects the key-row chips and the ^C/^D chips (`key()` goes to JS and then `bridge.onInput`; `raw()` calls `stream?.write` at :289-291), but those are single keystrokes and lose almost nothing.
> 
> Suggested fix: make `submit` return whether it was delivered, e.g. `fun submit(...): Boolean { if (state != TermState.Attached) return false; ... ; return true }`, and clear `draft` only on true. Alternatively, set `enabled = controller.state == TermState.Attached` on the Send IconButton and ignore onSend when not attached.
> 
> Gate on `state` rather than reading `stream`. The two are updated together in the same main-thread post (:213-215, :107-108), while `stream` is also read from the JS bridge thread without synchronization.

## A42

**NewSessionDialog crashes if the selected project disappears while the dialog is open**

- Severity: **low**; claimed by auditor: low; effort: small; area: runtime; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/SessionsTab.kt:327`

**Evidence**

`val projects = snapshot.openProjects().filter { it.sshTarget == null }` is recomputed from the live snapshot that HostScreen re-lists every 8 s, while `projectId` is remembered. The Start button does `val p = projects.first { it.id == projectId }` (:327), which throws NoSuchElementException inside onClick when that project was closed or removed on the desktop meanwhile.

**Proposed fix**

Use firstOrNull and dismiss or show an error; alternatively disable Start when projectId is not in `projects`.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The line (SessionsTab.kt:327) and the root cause are correct. A more precise fix: work out the selection from the current list, e.g. `val selected = projects.firstOrNull { it.id == projectId } ?: projects.firstOrNull()`. Enable Start only when `selected != null`, and use `selected` in onClick instead of `first {}`. That way the dialog never crashes. It also avoids a subtle trap: if the remembered id disappears and no radio button is shown as selected, Start should not go to a hidden project. If all local open projects are gone, disable Start or dismiss the dialog.

## A43

**The HostScreen tab and scroll position reset after returning from a terminal**

- Severity: **low**; claimed by auditor: low; effort: small; area: runtime; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/HostScreen.kt:62`

**Evidence**

`var tab by rememberSaveable { mutableIntStateOf(initialTab) }` (:62). AppContent (MainActivity.kt:112-118) renders only `nav.current` and has no SaveableStateHolder, so HostScreen leaves composition when a Terminal is pushed and its saveable state is dropped. The normal push is `Route.Host(host.id)` (tab 0).

**Proposed fix**

Wrap each route in rememberSaveableStateHolder().SaveableStateProvider(key), or store the selected tab back into the Route on change.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Root cause and line are right. The proposed fix is incomplete, though. `rememberSaveableStateHolder().SaveableStateProvider(key)` only preserves `rememberSaveable` state. The Board tab's selected project is a plain `remember` (`var projectId by remember { mutableStateOf<String?>(null) }`, BoardTab.kt:86), and so is the Inbox archive toggle (`showArchive`, InboxTab.kt:68). Both would still reset to the first project / off after returning from a terminal. They need to become `rememberSaveable`, or be hoisted into the Route. Also, the SaveableStateProvider key must be unique per stack entry (for example a per-entry id), not the Route data class, which can repeat on the stack. And `removeState(key)` must be called on pop, or the saved state leaks. The simpler alternative is to write the selected tab back into the stack entry (replace `stack[i]` with `r.copy(tab = newTab)`). That fixes the tab, but not the scroll positions or BoardTab's projectId.

## A44

**System back discards Settings edits (device name, relay API base)**

- Severity: **low**; claimed by auditor: low; effort: small; area: runtime; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/SettingsScreen.kt:59`

**Evidence**

The name and apiBase are persisted only in the top-bar back IconButton (:59-63: `graph.hosts.deviceName = name; if (apiBase.startsWith("https://")) graph.hosts.apiBase = apiBase; nav.pop()`). The system back gesture goes to AppContent's `BackHandler(enabled = nav.stack.size > 1) { nav.pop() }` (MainActivity.kt:111), which pops without saving.

**Proposed fix**

Persist on change (or on dispose), or register a BackHandler inside SettingsScreen that saves before popping.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The finding is accurate. On the fix: the simplest change that keeps the https-only rule for apiBase is a `BackHandler { save(); nav.pop() }` inside SettingsScreen. The innermost enabled BackHandler wins, so it takes precedence over AppContent's. It should share one `save()` lambda with the IconButton at :59-63. Saving on every keystroke would be wrong for apiBase: the HostStore setter would persist half-typed values, and the `startsWith("https://")` check would let through intermediate values like "https://a". So if you save outside the back action, use a DisposableEffect onDispose save rather than a per-keystroke write. One more point: when the typed apiBase is not https, the top-bar back also drops it without a message. That is intended validation, but the user is not told.

## A45

**No onRenderProcessGone handler on the terminal WebView**

- Severity: **low**; claimed by auditor: low; effort: small; area: runtime; kind: risk
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/TerminalController.kt:175`

**Evidence**

The WebViewClient (:175-184) overrides only shouldOverrideUrlLoading. Per WebViewClient.onRenderProcessGone, the default returns false, and then "application will crash if render process crashed, or be killed if render process was killed by the system". Because of the missing lifecycle handling, terminal WebViews are also kept alive in the background.

**Proposed fix**

Override onRenderProcessGone: return true, drop the WebView, and set the controller to Ended ("Reopen terminal") so a new WebView can be created.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The cited line, root cause and severity are right. The proposed fix is incomplete.
> 
> 1. Returning true from `onRenderProcessGone` and setting `TermState.Ended` is not enough on its own. The existing Reattach button (TerminalScreen.kt:95) calls `controller.attach()`, which reuses the controller but never rebuilds the view. The `AndroidView` factory runs once per composition (TerminalScreen.kt:79), so no new WebView is created. After `webView = null`, `js()` returns silently (TerminalController.kt:192-193): a re-attached stream would paint into nothing, and `pageReady`/`pendingJs` would stay stale.
> 
> 2. The handler must also:
>    - detach the current `stream`;
>    - remove the WebView from its parent and call `destroy()`;
>    - reset `pageReady`, `pendingJs` and `cols`/`rows`;
>    - bump a generation counter that keys the `AndroidView` (e.g. `key(gen) { AndroidView(...) }`), so Compose builds a fresh WebView before attaching again.
> 
> 3. Optionally, call `setRendererPriorityPolicy(RENDERER_PRIORITY_BOUND, true)` so a backgrounded renderer is reclaimed ahead of the app, now that the app survives its loss.

## A46

**The ⌨ key-row chip only focuses the DOM textarea, which cannot raise the soft keyboard**

- Severity: **low**; claimed by auditor: low; effort: small; area: runtime; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/TerminalController.kt:293`

**Evidence**

`fun focusTerminal() = js("nt.focus()")` → terminal.js `focus: function () { term.focus() }`. Nothing in the app calls webView.requestFocus() or InputMethodManager.showSoftInput (grep finds neither). A script-initiated focus() from evaluateJavascript is not a user gesture, and the Android IME attaches to the focused View (the Compose text field, or nothing).

**Proposed fix**

In focusTerminal, call webView.requestFocus() and then InputMethodManager.showSoftInput(webView, 0) alongside the JS focus.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The conclusion and the line (TerminalController.kt:293, triggered from TerminalScreen.kt:171) are correct. The root-cause wording needs adjusting. Blink does not require a transient user gesture here. Script focus is allowed in a main frame (Frame::AllowFocusWithoutUserActivation returns true outside fenced frames), and the keyboard is gated only on STICKY activation, meaning any gesture since page load. The chip actually fails for three reasons:
> (a) Element::Focus returns immediately when the textarea is already the focused element, which is the normal state after the user has tapped the terminal once.
> (b) Sticky activation is missing if the user has never touched the page.
> (c) The WebView is not the focused Android view while the Compose draft field has focus.
> 
> Better fix:
> 1. In focusTerminal, clear the Compose focus first (LocalFocusManager.clearFocus() from TerminalScreen) so the draft field lets go of the IME.
> 2. Call webView.requestFocus().
> 3. Blur and then refocus the textarea (`nt.blur(); nt.focus()`), so Blink's already-focused early return does not swallow the call.
> 4. Post InputMethodManager.showSoftInput(webView, InputMethodManager.SHOW_IMPLICIT) with webView.post {} so it runs after the view has become the IME's served view. A synchronous call right after requestFocus can race.
> 
> Relying on showSoftInput is what makes this work regardless of the page's activation state. Needs a device check, since this was never built or run.

## A47

**The Keystore decrypt runs on the main thread in the host list's composition, once per row per recomposition**

- Severity: **low**; claimed by auditor: low; effort: small; area: runtime; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/HostsScreen.kt:121`

**Evidence**

Inside each LazyColumn item, `routeSummary(host, graph.secure.getString(SecureStore.relayTokenKey(host.id)) != null)`. SecureStore.getBytes (SecureStore.kt:56-67) runs Cipher.init + doFinal with an AndroidKeyStore key, which is a binder round trip to keystore2. The row recomposes on every ConnState change (Connecting/AwaitingApproval/Connected/Failed) as well as on list changes.

**Proposed fix**

Store a non-secret `hasRelayToken` flag on the host record, or compute it once in a remembered/background-loaded state.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The mechanism, line and severity (low) are all correct. Three additions:
> 
> 1. **Lock contention.** The `@Synchronized` monitor in SecureStore (lines 44, 52, 70, 76) also makes this composition wait on any concurrent background SecureStore call, such as ConnectionManager.kt:101, 167, 181 or 183.
> 
> 2. **Wasted decrypts.** The decrypt runs even for hosts with `host.relay == null`, where routeSummary ignores the result.
> 
> 3. **Better fix.** Store a non-secret `hasRelayToken` boolean on PairedHost, or check only `prefs.contains(key)` without decrypting. Either one:
>    - moves the check off the Keystore entirely;
>    - updates correctly through the existing `graph.hosts.update` that follows `putString` in adoptRelayIfAdvertised (ConnectionManager.kt:183-186).
> 
>    A plain `remember { }` would still run the decrypt on the main thread once per row. If the decrypt must stay, use `produceState` on `Dispatchers.IO` keyed on `(host.id, host.relay)`.

## A48

**The seen-events set is trimmed in hash order and updated without synchronization, which can produce duplicate notifications**

- Severity: **low**; claimed by auditor: low; effort: small; area: runtime; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/data/HostStore.kt:98`

**Evidence**

`fun markSeen(ids) { val next = (seenEvents() + ids).toList().takeLast(500).toSet(); prefs.edit().putStringSet("seenEvents", next).apply() }`. getStringSet returns a HashSet, so takeLast(500) drops arbitrary old ids rather than the oldest. The method is not @Synchronized and is called from the worker thread (InboxNotifier.kt:86), from graph.scope (TerminalController.kt:262) and from main (InboxTab.kt:76). Concurrent read-modify-write loses updates.

**Proposed fix**

Store (id, ts) pairs and trim by age, make markSeen @Synchronized, and use commit()/an atomic update.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Mostly accurate. Two corrections:
> 
> 1. The concurrency half is much narrower than the eviction half. SharedPreferences `apply()` updates the in-memory map synchronously, so the race window is microseconds. Also, TerminalController.kt:262's id is usually resolved on the desktop by the `ackRead` just before it, so losing that write rarely causes a re-notify. The dominant real cause is the hash-order eviction once the set passes 500. Each markSeen of k new ids then evicts k arbitrary old ids, and any of them that is still unresolved and under 6 h old gets re-announced.
> 
> 2. Better fix: announce() only considers events younger than 6 h (InboxNotifier.kt:79). So store id→seenAt (for example a JSON map in one string pref) and prune entries older than about 6 h plus a margin, rather than using a count cap; nothing still eligible is ever evicted. Make markSeen @Synchronized like the other mutators in the class. commit() is not needed, because apply() already publishes to memory atomically; the missing piece is the lock around the read-modify-write.

## A49

**SSH host-key TOFU pin is saved during key exchange (before auth) and is not tied to the pairing**

- Severity: **low**; claimed by auditor: medium; effort: small; area: security; kind: risk
- Location: `android/protocol/src/main/kotlin/dev/nodeterm/protocol/ssh/SshHostConnection.kt:330`

**Continuation status (2026-10-04):** the original authentication/pairing-anchor fix remains
in place. The later key-discovery residual is tracked as [A99](#a99): recursive external
`Include` discovery is fixed in `e07071e9`, with actual desktop and full beta 11 source checks
passing; physical included-key pairing remains pending.
Relative `HostKey` values, inaccessible configuration and a key without a readable public
counterpart remain outside discovery. Relative `Include` values are a different case: they are
resolved under the sshd configuration root. No first-use trust or mismatched-key override is added.

**Evidence**

The verifier pins whatever key answers first: `pinned == null -> { pin.pin(fp); true }` (line 330). This runs inside `client.connect()`, before `client.authPublickey(...)` (line 348). The catch block (lines 353-357) never undoes the pin, so an SSH server that REJECTS our key still becomes the pin (it is persisted via HostStore.update, ConnectionManager.kt:154-157). Pairing does not anchor the pin: `PairedHost.from` sets `sshHostKeyFingerprint = null` (PairedHost.kt:83), and neither the QR nor the sealed /pair response carries an SSH host key. Every non-Windows host advertises SSH whether or not sshd is running: pairing-service.ts:440 `directSsh = platform !== 'win32'` and line 652 only adds `ssh:false` on Windows. macOS ships with Remote Login off. For such a host the pin stays null and the phone keeps dialing the host's private LAN IP from whatever network it is on, including every 15 minutes from InboxWorker. Once pinned, a mismatch is a hard stop with no relay fallback: ConnectionManager.kt:88-93 rethrows HostKeyChangedException before the relay block.

**Proposed fix**

Record the fingerprint in verify() but persist it only after authPublickey succeeds. Anchor the pin in pairing: have the desktop return its SSH host key fingerprints (e.g. from /etc/ssh/ssh_host_*_key.pub) inside the sealed /pair response, and store them in PairedHost.from so the first connect is verified. Do not background-dial a host whose SSH has never authenticated, and allow relay fallback when the pin was never confirmed by a successful auth.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Downgrade to low. Four corrections:
> 
> 1. The unpinned window is narrow. On macOS/Linux the pairing QR is only shown while sshd answers on 127.0.0.1:22 (src/shared/pairing-gate.ts; PhonePairPopover.tsx:49; PhoneSection.tsx:95). The app then connects over SSH immediately on the pairing LAN (PairScreen.kt:158 → HostScreen.kt:66 startWatching), so the first pin is normally the real computer's key. The "Remote Login off, so the pin stays null forever" scenario does not happen at pairing.
> 
> 2. Pinning during key exchange mirrors OpenSSH's known_hosts behavior. The real defects are:
>    - The KDoc says the pin is null "before the first successful connect", but a key exchange whose authentication failed also pins (SshHostConnection.kt:44-47 vs 330/346-357).
>    - Pairing cannot anchor the pin: the desktop /pair response (pairing-service.ts:827) and the QR carry no SSH host key. Anchoring needs a desktop change, which would also serve the iOS app.
> 
> 3. The more likely user-facing impact is the one listed only as secondary evidence. After a correct pin, a private-IP collision on another network makes Auto mode fail with a "host key changed" error and never tries the relay (ConnectionManager.kt:88-93).
> 
> 4. Better fix:
>    - On a mismatch, refuse SSH and show the warning, but still fall through to the relay. The relay is independently authenticated (hostKeyB64 / relay host key plus the SAS approval), so this is safe.
>    - Persist the pin only after `authPublickey` succeeds.
>    - Have the desktop return its SSH host key fingerprints inside the sealed /pair response, and store them in `PairedHost.from`.

## A50

**The only distributable build is a debuggable APK, so Keystore-protected secrets can be pulled over adb/JDWP**

- Severity: **low**; claimed by auditor: medium; effort: medium; area: security; kind: risk
- Location: `android/app/build.gradle.kts:19`

**Current private-beta status (2026-10-04):** beta10/code11 from clean e3ce041c is installed on
the intended Pixel with verified signature/non-debuggable metadata, exact APK hash, install
identity and notification grant. Genuine desktop-issued beta9 pairing/relay credentials survive
the same-signer update; actual saved relay reopen/input reaches the scoped PTY. A91/A94 installed
End/recreate/open/End completed-empty flow also passes. Items 1/36 pass and item 49 is Partial, giving 10 Pass / 22 Partial /
32 Pending. This still leaves broader minified worker/QR/cellular-relay/device checks open; the
public distribution/link work is separate from this user's private-beta scope. Receipt:
`.nodeterm/android-beta-build-10/paired-update-result.json`; exact-source CI37194375778 has all
five jobs green. Earlier installation/results below retain their original historical scope.

**Evidence**

The release buildType has no signingConfig (lines 19-25). The README's only install path is `./gradlew :app:assembleDebug → app-debug.apk` (android/README.md:32-38). CI uploads `nodeterm-android-debug` (.github/workflows/android.yml:73-80). The desktop sends users to that folder (src/renderer/lib/links.ts:7 `ANDROID_APP_URL = '.../tree/main/android'`). AGP marks debug builds `android:debuggable=true`, which enables `adb shell run-as dev.nodeterm.android` and JDWP attach to the app process. SecureStore's guarantee ('it never leaves the secure hardware') is about the key material only: the key is usable by any code running as the app's UID or inside its process.

**Proposed fix**

Ship a signed, non-debuggable release build (configure signingConfig and publish release artifacts), and point the README and desktop link at it. Until then, state in the README that the debug APK exposes the phone's keys to anyone with adb access.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> **Severity is overstated. This is closer to low than medium.** The attack needs physical access to an unlocked phone that has USB debugging on and has accepted the attacker's adb RSA prompt. Someone in that position can already drive the non-debuggable app's own UI (terminal, new session) to run commands on the paired computer. What the debuggable flag adds is exfiltration of durable, reusable credentials: the unrestricted SSH key, and relay impersonation via box secret plus device token. Sideloading also does not require USB debugging; an APK can be installed from the browser, so "often switched on precisely to sideload" is plausible but not required.
> 
> **The cited line is right** (build.gradle.kts:19-25). The root cause is more precisely the absence of any signed release artifact or release pipeline. No debug-specific setting is wrong on its own: debug builds are meant to be debuggable.
> 
> **The fix should cover three things:**
> - A signed, non-debuggable release (a `signingConfig` fed from CI secrets, `assembleRelease`, artifacts attached to a GitHub Release).
> - Pointing README and `ANDROID_APP_URL` at that release.
> - Until then, a README warning that the debug APK exposes the phone's pairing credentials to anyone with adb access.
> 
> **A related, unverified distribution problem:** debug APKs built on CI are signed with a per-runner debug keystore. If that keystore is freshly generated each run, one CI artifact cannot update another in place. Uninstalling first wipes the Keystore and the prefs, which forces a re-pair.

**Private-beta continuation (2026-10-02):** local signing/verification is implemented in
`android/tools/package-beta.py`; exact takeover-branch pushes (or later opted-in manual CI runs)
version the unsigned AGP release and gate its
provenance on protocol, release and desktop/packaging checks. The tool verifies APK/R8 hashes from
that run's input metadata, rejects the public debug key, requires the expected private certificate,
checks non-debuggable release metadata/alignment/signature, and emits an APK/checksum/metadata set
only after success. Keys and signed APKs stay local: Actions artifacts on a public repo are not
private downloads. Real Android-tool regressions use disposable fixture keys/APKs, not an app build.
The user confirmed the first private beta and its retained signer is prepared in ignored local
state (RSA-3072 PKCS12, restricted directory/files, verified certificate pin distinct from debug).
The actual private minified beta at `fa71cb08` is signed, verified, and was installed and cold-started on
an MI8 (Android 15 / API 35). Installed metadata confirms version code `2`, minSdk `26`, targetSdk
`35`; refused `run-as` confirms the non-debuggable build. With notification permission granted,
the empty Computers screen, Pair button and Settings appear with no crash markers. This addresses
signed-artifact preparation and part of checklist item 5 on that test device. The user identified
the MI8 as the wrong phone, so only the newly installed app and its test UI dump were removed;
its newly authorized SSH key was removed and host `authorized_keys` restored byte-for-byte.
No host had been paired and no SSH connection attempted. The intended Pixel 10 Pro now has the
same signed beta; it runs Android 17 / API 37 with Vanadium WebView `154.0.8037.92.0`, accepted
notifications through the normal dialog, and refuses `run-as`. Manual SSH uses the authorized phone
key with existing keys preserved and a matching Ed25519 host pin, lists 17 real projects and
delivers a harmless sentinel in a controlled temporary test window. The actual code-3 private
update preserved host configuration, SSH key/pin and notification permission, and fixes the one-row
viewport/history failure (`A85`), including font/keyboard resize, Esc and draft input. QR/code
pairing, relay, reconnect/background/answer behavior and full 64-item phone validation leave `A50`
partly open; the user confirms Wi-Fi-off mobile-data WireGuard terminal access.

**Beta-6 device follow-up (2026-10-02):** the unchanged minified code-7 APK at source
`c4b1f6cf1009f293a658b6331d2ed1ab80aa36c6` passes requirement-audited checklist items 18/19/21/22/24/38/39:
real SSH Unicode rendering, exact 90000-character clipboard/150000-and-450000 size refusals,
silent invalid OSC52 with clipboard preserved, all three keyboard-focus states, and background
process-kill Inbox/back-stack restoration, plus the synthetic shipped-hook lifecycle detailed below.
All 17 sending chips plus four app-mode arrows and software-input/font/rotation SSH survival
complete item 18 on the existing proof. Copy-sheet exact Unicode/Share/modal isolation,
wrapped/OSC8 links and SSH background/detach recovery add partial evidence. Landscape with IME open was 129×1; usable-height
and larger-client Fit remain unverified. The 450000 pre-bridge cap is distinct JVM/JS evidence,
not inferred from a phone toast. Browser/Copy-sheet Open and offer interactions, airplane/outage,
QR/cellular-relay/notification, custom bindings/FPS and remaining variants stay open.
Encrypted paste pairing and a forced relay-only browse of an isolated production desktop
(`58a202be`, real SecretService credential storage) now pass against the live hosted API/relay;
the current `/v1/relay/join` contract is verified beyond interop. Remote access was enabled at
pairing, so no first SAS prompt is expected; QR/scanner, cellular relay, SAS denial/revoke and
remaining node/action behavior remain open. No user-profile credentials were copied into the private home.
The phone then attaches through the relay and sends echo input to an owned real PTY seeded through
production preload/Canvas events; phone New session/folder-picker are not tested. Item 39 now passes:
the shipped managed hook returns actual allow/deny JSON in 17.596/6.571 seconds, and a 45-second
expiry returns empty; the late Approve visibly reports timeout and opens the owned terminal without
false success. The producer is synthetic, with no live Claude CLI/account or requested Bash execution.
Mounted relay single-select one-tap, multi-select Open-session/input and copy-mode answers also
reach the actual synthetic application and its shipped PostToolUse hook/mirror. In the copy-mode
case, the exact owned pane is in mode before PreToolUse; option 3 arrives, mode becomes false,
and the mirror becomes working with its question resolved. Item 41 remains Partial: offscreen/
released/direct-SSH/target-guard device variants and notification questions remain open.
No live Claude CLI/account was used. At that stage required checks passed all 658 protocol
tests in 63 suites (54 seconds) plus offline app `compileKotlin` (5 seconds).
Only disposable fixture resources were cleaned up and the phone returned to regular Sessions;
scoped cleanup is not a full device/backend revoke check. On 2026-10-03 the user confirms the
final beta-6/code-7 usual manual-SSH terminal "Connects and scrolls smoothly", confirming connection
and smooth scrolling with WireGuard enabled and Wi-Fi off over cellular. Cellular hosted relay remains
untested. Item 20 remains Partial; no runtime change, phone command or new product finding resulted.
Protocol/offline app tasks at that stage passed in 50/1 seconds; current A90 checks are recorded below.
The [64-row record](android.md#what-is-verified-and-how) now has ten Pass, 22 Partial and
32 Pending after item 1 paired-update, focused A90 proof and item 36 Board verification; the earlier beta6 7/20/37 checkpoint is preserved, with named
conditional SKIP variants; `A50` remains partial. Private synthetic
proof is in `.nodeterm/android-beta-build-6/checklist-20261002/`. Recorded prior all-green branch `19da35a2` has all
five jobs green in [run `37140762345`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37140762345),
including A90. Historical beta9 source `4d33a5b5` failed documentation mapping in run `37144282865`;
current installed beta 10 source `e3ce041c` passes all five jobs in run `37194375778`. The next documentation push needs
its own checks/green workflow.
The requirement review promotes item 18 using existing all-key/software-input/font/rotation SSH
survival proof, without new phone work. Viewport/Fit belongs to item 23 and stays Partial; item 1
now passes desktop-issued beta9 pairing/relay survival across the code10→11 update.
The user resumed Pixel release checks on Oct4; full release, cellular hosted relay and live-Claude
verification remain open. No new product finding is added.
QA-driver coordinates/side-Back and Compose class assumptions are not product findings. No
production/host contract changed and no new audit finding is added.

**Historical prepared beta-7 update (2026-10-03), unused:** private `0.1.0-beta.7` / code `8` uses
source `b53610deb3843b59fa6a1bed5bdc5f36da0f5146` and the retained signer. The local AGP build
took 47 seconds; R8 and packaging passed. APK SHA-256:
`5141c6484b422b236a98213731076be621c4d14a55f47c79bfd989fb23609e6a`.
Ignored proof/artifacts are in `.nodeterm/android-beta-build-7/` and `.nodeterm/android-beta-7/`.
It was never installed and is superseded by beta 8 / code 9 below. Debug migration stays
conditional SKIP on this working Pixel. Historical beta-6 proof at `c4b1f6cf` and the
seven Pass / 20 Partial / 37 Pending tally remain unchanged. Preparation adds no runtime fix,
finding, phone work or device pass; `A50` stays partial.

**Historical beta-8 update (2026-10-03), superseded by installed beta 9:** A90's code-9 APK at clean
`b88d141528c1051964da07faf22cc7fa923c4846` passes the offline 49-second AGP release, R8 keeps,
retained-signer packaging/provenance and independent SDK 36/37 artifact checks. SHA-256:
`d373ad5c1790f714cb4464ad4a0a38c5ba9ab68e35103e54cf3aef5ce53081ce`.
The exact intended Pixel 10 Pro / Android 17 received a 28.05-second same-signer `adb install -r`.
Pulled pre/post APKs match known beta 6 / beta 8 and the SDK-37 public signer check matches the
retained pin. Post-install metadata is code 9/name beta 8/non-debuggable; `firstInstallTime` and
granted `POST_NOTIFICATIONS` are preserved. The app starts and its existing manual-SSH host row
remains in All computers. Opening that exact host reconnects over SSH and lists real driven
projects. The screenshot shows New terminal and own-app UI XML confirms the FAB is enabled/clickable;
this is not a TalkBack check. No existing pane was touched and no terminal was created or ended.
These facts establish manual-host configuration/reconnect/browse survival, not A90 creation or
desktop-issued pairing/relay credential survival.
Private installation proof is `.nodeterm/android-beta-build-8/device-install-20261003/receipt.json`
plus package/APK/certificate checks, `sessions.png` and `ui-sessions-ready.xml`. After the hike, pair on current beta 9 /
code 10 using desktop-issued JSON or QR, then verify pairing/relay credential survival across a later
same-signer higher-code update without downgrading or uninstalling (item 1). Historical beta-6
physical proof and the seven Pass / 20 Partial / 37 Pending ledger remain unchanged; `A50` stays partial.

## A51

**allowBackup=false does not stop device-to-device migration at targetSdk 35: hosts, pins and deviceId are cloned**

- Severity: **low**; claimed by auditor: low; effort: small; area: security; kind: gap
- Location: `android/app/src/main/AndroidManifest.xml:13`

**Evidence**

The manifest sets only `android:allowBackup="false"`, with no `android:dataExtractionRules`, and build.gradle.kts:14 targets SDK 35. Android 12's behavior changes state that for apps targeting 31+, allowBackup=false disables cloud backup but not device-to-device transfer; only a `<device-transfer>` exclusion in dataExtractionRules does. `nodeterm.hosts` (every PairedHost, its SSH pin and relay block) and the phone's `deviceId` (HostStore.kt:66-69) are plain SharedPreferences and move to the new phone. `nodeterm.secure` ciphertext moves too but cannot be decrypted there, so SecureStore regenerates the identity. The backend keys the device row on that deviceId: pairing-service.ts:921 says the mint 'upserts on it'.

**Proposed fix**

Add android:dataExtractionRules with `<cloud-backup>` and `<device-transfer>` excluding the `nodeterm.secure` and `nodeterm.hosts` shared_prefs (or excluding everything).

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Mostly right. Refinements:
> 
> 1. **Revoke only happens on Pro desktops.** `revokeRelayDevice` returns 'skipped' when the desktop holds no entitlement (`pairing-service.ts:156`: `if (!entitlement || !relayDeviceId || !apiBase) return 'skipped'`). So the "Remove revokes both phones" effect only happens on an entitled (Pro) desktop.
> 2. **A second, likely effect on free desktops (backend not in the repo, so not verified).** The mint comment at `pairing-service.ts:84-87` says the backend's free-tier re-registration demands `priorDeviceToken` for an existing deviceId, and without it returns 403, leaving a "silent LAN-only pairing". The migrated phone re-registers an existing deviceId but cannot decrypt its prior token (`PairScreen.kt:140` returns null). Unless the backend's same-desktop allowance applies, its relay leg may be refused. On a Windows desktop that refusal fails the pairing outright (502).
> 3. **Wording of the fix.** Exclusion paths for the sharedpref domain need the `.xml` suffix: `<exclude domain="sharedpref" path="nodeterm.secure.xml"/>` and `path="nodeterm.hosts.xml"`, under both `<cloud-backup>` and `<device-transfer>`, referenced with `android:dataExtractionRules="@xml/data_extraction_rules"`.
> 4. **A sturdier fix.** Keep `deviceId` inside SecureStore, or re-mint it whenever the box secret had to be regenerated. That way the relay id always changes together with the keys it belongs to, whatever the backup rules say.
> 
> Severity "low" is reasonable. It only bites after an Android 12+ phone migration, and the host list is recoverable by re-pairing.

## A52

**Approval and finish notifications put command text and the agent's last message on the lock screen**

- Severity: **low**; claimed by auditor: low; effort: small; area: security; kind: gap
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/notify/InboxNotifier.kt:108`

**Evidence**

`.setContentText(ev.title + (ev.detail?.let { " — $it" } ?: ""))` plus BigTextStyle with the detail (lines 108-109). There is no setVisibility, setPublicVersion or channel lockscreenVisibility, so the default VISIBILITY_PRIVATE applies, which shows full content on a secure lock screen under Android's default 'show sensitive content' setting. For approvals, `detail` is the tool summary: the first line of the Bash command, the file path with the diff size, or the fetched URL (agent-status-mirror.ts:1143-1198). For DONE events it is the agent's last message line (agent-status-mirror.ts:1691).

**Proposed fix**

Keep `detail` out of the notification by default: for example, set VISIBILITY_PRIVATE with a setPublicVersion that shows only 'Needs you — <session>' / '<computer>', and add an opt-in 'Show details on lock screen' setting. Or use VISIBILITY_SECRET for the attention channel.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The cited line is right: line 108, with line 109 carrying the BigTextStyle.
> 
> The first proposed fix would not work. VISIBILITY_PRIVATE is already the default, and Android shows the public version only when the user has turned on "hide sensitive content" for the lock screen. Under the default setting, a PRIVATE notification is still shown in full whether or not a public version exists. So "VISIBILITY_PRIVATE plus setPublicVersion" does not hide the detail in the case the finding describes.
> 
> Fixes that would work:
> - Use VISIBILITY_SECRET, on the notification or as the channel's lockscreenVisibility.
> - Or leave `detail` out of both contentText and BigTextStyle by default, and put it behind an opt-in setting (for example "show details in notifications").
> 
> The setPublicVersion that shows only "Needs you — <session>" is worth adding alongside either fix. It only helps users who already hide sensitive content, so on its own it does nothing for the default case.
> 
> The finding should also say that the same detail already reaches the iOS phone through the APNs push body (src/core/push-notify.ts:361). This is a difference in platform defaults, not an Android-only leak.

## A53

**OSC 52 handler has no size cap (the desktop caps at 1,000,000) and setPrimaryClip is unguarded**

- Severity: **low**; claimed by auditor: low; effort: small; area: security; kind: bug
- Location: `android/app/src/main/assets/terminal/terminal.js:55`

**Evidence**

Android: `var payload = idx >= 0 ? data.slice(idx + 1) : data; if (payload && payload !== '?') bridge.onCopy(payload)`, with no length limit and no `;` required. TerminalController.kt:153-161 decodes it and calls `cm.setPrimaryClip(...)` inside `main.post {}` with no try/catch. Desktop: src/renderer/terminal/osc52.ts `const MAX_BASE64 = 1_000_000 ... if (i < 0) return null ... if (!payload || payload === '?' || payload.length > MAX_BASE64) return null`, and it decodes with `fatal: true`. The vendored xterm.js accepts OSC payloads up to `PAYLOAD_LIMIT=1e7`.

**Proposed fix**

Mirror parseOsc52: require `;`, cap the base64 at the desktop's limit or lower, and decode strictly. Wrap setPrimaryClip in try/catch and toast on failure.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The finding is correct, but the proposed fix is partly insufficient. Capping at the desktop's `MAX_BASE64 = 1_000_000` would NOT prevent the crash:
> - tmux 3.4 forwards a 986,675-character base64 OSC 52 (measured), which is under 1,000,000 characters.
> - That decodes to about 740 KB of text, which ClipData parcels as UTF-16 at about 1.5 MB, still over the binder limit.
> 
> The fix that actually matters:
> 1. Wrap `setPrimaryClip` in try/catch and show a "copy too large" toast on failure.
> 2. Add a much lower cap in `terminal.js` and/or `onCopy`, for example a few hundred KB of base64 or about 100k characters of decoded text, to stay well under the shared 1 MB binder buffer.
> 
> Requiring `;` and decoding with a strict UTF-8 decoder (`CharsetDecoder` with `CodingErrorAction.REPORT`) are parity niceties only; neither prevents the crash.
> 
> The severity of low is defensible. Medium is also arguable, because remote pane output can crash the app, but only through a deliberately oversized sequence or a very large copy-mode selection.

## A54

**PairingClient trusts an unbounded Content-Length / EOF body from the pairing endpoint**

- Severity: **low**; claimed by auditor: low; effort: small; area: security; kind: bug
- Location: `android/protocol/src/main/kotlin/dev/nodeterm/protocol/pairing/PairingClient.kt:253`

**Evidence**

`val buf = ByteArray(length)` uses a Content-Length taken from `toIntOrNull()`, with no upper bound or sign check (lines 247-254). Without a Content-Length it reads with `input.readBytes()` until EOF (line 263). The only limit is the 64 KiB header cap and a per-read soTimeout. PairScreen catches only `Exception` (PairScreen.kt:159). The endpoint is whatever `host:pairPort` the payload names, and a `nodeterm://pair` link from any web page can supply it (the user still has to tap Pair).

**Proposed fix**

Reject a negative Content-Length or one above a small cap (the real response is well under 64 KiB), bound the EOF read the same way, and add an overall deadline for the exchange.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Line numbers: the Content-Length parse is at PairingClient.kt:132-137 (`toIntOrNull()` at line 135), `ByteArray(length)` is at line 139, and the EOF `input.readBytes()` is at line 148. The finding cites 247-254, 253 and 263, which do not exist in this 152-line file.
> 
> The negative-value case does not crash. NegativeArraySizeException is a RuntimeException, so PairScreen.kt:159's `catch (e: Exception)` catches it. The screen then shows the exception's bare message (e.g. "-1") as the error instead of a sentence. Only the huge-positive and unbounded-EOF cases (OutOfMemoryError) crash the app.
> 
> Proposed fix, confirmed as sound:
> - Reject a negative Content-Length, and any value above a small cap such as 64 KiB, with a PairingException.
> - Cap the no-length EOF read at the same size.
> - Bound the whole exchange with an overall deadline, e.g. `withTimeout`, and close the socket on cancellation so the blocking read unblocks.

## A55

**Inbox and Usage are per computer; iOS merges them across all paired computers**

- Severity: **low**; claimed by auditor: medium; effort: medium; area: parity; kind: gap
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/InboxTab.kt:64`

**Evidence**

docs/mobile-usage-inbox.md:130: "**Agents tab (feed)**: merged events across connections, newest first". :124: "**Usages tab**: one section per paired connection that reports `usage` (header: host name + relative `updatedAt`)". Android's `InboxTab(nav, hostId, session, snapshot)` (InboxTab.kt:64) and `UsageTab(snapshot)` each render one computer inside HostScreen's tabs. The only routes are Hosts/PairHost/Settings/Host/Terminal (MainActivity.kt:28-33), with no cross-computer inbox. HostsScreen shows no needs-you count per computer.

**Proposed fix**

Add a top-level Inbox/Usage screen that merges every paired computer's snapshot, labels each card with its computer, and adds a needs-you badge to each computer row.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Refinements only; nothing in the claim is wrong. UsageTab is defined in the same file (InboxTab.kt:213), not in its own file. The Route list is at MainActivity.kt:28-34. HostScreen already computes a per-computer needs-you count (HostScreen.kt:70). The cheapest part of the fix is to lift that `count { it.actionable }` onto each HostsScreen row, using the session's cached snapshot. The merged Agents feed and Usages view also need each card and section to carry its hostId. The feed's Open, Approve and Answer actions have to call the right computer's `session.ensureConnected()`, because QuickActions is per-session today (InboxTab.kt:103-115).


**Continuation status (2026-10-04):** the merged Inbox/Usage and computer labels were fixed in
`71b592a`/`0772cbf`; the original evidence above describes the pre-fix screen. A remaining
freshness gap persisted in the beta 10 source: opening All computers requested one refresh, but
only individual host/terminal screens owned the live eight-second watcher. [A97](#a97) now adds
STARTED-only per-host watching and serialized listing/publication in `8443e71e`. Full beta 11
source checks pass; new physical multi-computer results are pending. The existing item 60
ledger is unchanged.

## A56

**Current follow-up:** A105 implements request-owned remembered rules through hook JSON; the original blind-digit proposal below remains unsafe.

**Approval cards lack iOS's "Always allow" answer**

- Severity: **low**; claimed by auditor: low; effort: small; area: parity; kind: gap
- Location: `android/protocol/src/main/kotlin/dev/nodeterm/protocol/host/QuickActions.kt:23`

**Evidence**

docs/hook-reply-approvals.md:38-40, phone answerer: "`InboxApproval` writes it over the connection when the approval event carries `pendingId`; else falls back to send-keys. Digit `2`/\"Always allow\" keeps using send-keys in v1". Android's `answerApproval(conn, event, allow: Boolean)` (QuickActions.kt:23) supports only allow ("1" or the ticket) and deny (Esc). InboxTab offers only Approve / Deny / Open (InboxTab.kt:107-114).

**Proposed fix**

Add an "Always allow" action for Claude approvals. It re-checks that the node is still blocked, then sends `2` with send-keys; for a held ticket, open the session instead, since the prompt is not on screen.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The line references are right. Two corrections:
> 
> 1. **Evidence.** The iOS behaviour rests only on docs/hook-reply-approvals.md:39-40. docs/mobile-usage-inbox.md:135-140, the v1 phone spec, defines only Approve and Deny.
> 
> 2. **Impact and fix.** `hookReplyApprovals` is on by default (src/shared/types.ts:1986), so most Claude approvals are held tickets. A keyed "Always allow" only works for unticketed ones.
>    - For a held ticket, "open the session instead" does not put the choice in front of the user right away. The prompt is not painted until the hook times out (`NODETERM_PERM_WAIT_SECS`, default 45 s, per docs/hook-reply-approvals.md:24-30). Until then the opened pane shows no prompt to pick `2` from.
>    - Better fix: add an "Always allow" button only when `event.agentId == "claude"` and `event.pendingId == null`. Re-check that the node is still BLOCKED with `stillWaiting`, then `sendKeys(nodeId, "2")`.
>    - For ticketed approvals, either hide the button, or open the session with a note that the prompt appears after the hold times out.
>    - Also add the gap to docs/android.md "Known gaps" if it is not built.

## A57

**Current follow-up:** A106 extends the display fix to complete held single/multi question answers through hook JSON. Legacy unheld multi-select still opens the session.

**Multi-select AskUserQuestion cards fall back to "Open session"**

- Severity: **low**; claimed by auditor: low; effort: small; area: parity; kind: gap
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/InboxTab.kt:118`

**Evidence**

src/core/agent-status-mirror.ts:384-386: `multiSelect` "Rides the pipeline so the phone renders multi-select chips". src/core/push-notify.ts:61-62: "Rides the `nt` block so the phone renders multi-select". Android shows option chips only when `ev.options.isNotEmpty() && !ev.multiSelect` (InboxTab.kt:118), and `QuickActions.answerQuestion` returns OPEN_SESSION when `event.multiSelect` (QuickActions.kt:43).

**Proposed fix**

Render toggleable chips for multi-select questions and send the chosen digits followed by the picker's submit key, re-checking that the node is still waiting before each send.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Line and root cause are right: InboxTab.kt:118 and QuickActions.kt:43 both deliberately route multi-select questions to "Open session", in line with the fail-safe policy at QuickActions.kt:17-18. Two corrections to the wider claim.
> 
> 1. The gap that can actually be shown is on the display side. Android does not show a multi-select question's options at all; the else branch at InboxTab.kt:124-126 renders only "Open session". The desktop comments (agent-status-mirror.ts:384-386, push-notify.ts:61-63) say the phone should render multi-select chips. Whether iOS also answers these questions cannot be verified from this repo.
> 
> 2. The proposed answer path is speculative. No keystroke sequence for Claude Code's multi-select picker (toggle key, submit key) is measured or documented anywhere here. A safer fix has two steps:
>    - Now: render the options read-only (numbered, non-interactive) next to "Open session", so the card shows what is being asked.
>    - Later: add answer-from-Inbox only after measuring the picker's real key semantics on a live CLI, and keep the stillWaiting re-check before sending.

## A58

**Usage and feed cards omit iOS's pace line and the context indicator on event cards**

- Severity: **low**; claimed by auditor: low; effort: small; area: parity; kind: gap
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/InboxTab.kt:246`

**Evidence**

docs/mobile-usage-inbox.md:128-129: "Pace line: compare `usedPercent` vs elapsed fraction of the window (`windowMinutes` else 300/10080 by kind) → \"5h usage pace slower/faster\"". :131-132: "Cards show the node's `contextPercent` ring when known". Android's `UsageBar` (InboxTab.kt:246-273) shows only the percentage and reset time, never using `windowMinutes`. `EventCard` (InboxTab.kt:163-208) shows no context % (only the live working cards do).

**Proposed fix**

Compute the pace from `resetsAt` and `windowMinutes`, using the 300/10080-minute defaults by kind, and show `inbox.nodes[nodeId].contextPercent` on approval, question and done cards.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The line range for EventCard is slightly off. It is InboxTab.kt:162-206, not 163-208. UsageBar is 245-272 and the reset text is at line 263. The fix should compute the pace only when `resetsAt` is non-null: elapsed = 1 - (resetsAt - now) / (windowMinutes ?: (if kind == "session" then 300 else 10080)) / 60000. Compare that with usedPercent/100 to get "pace slower/faster". Also note that `windowMinutes` is null in some desktop mirror payloads (src/core/agent-status-mirror.test.ts:1584), so the per-kind defaults are required. The context value should come from `snapshot.status?.inbox?.nodes?.get(ev.nodeId)?.contextPercent`, which means passing it into EventCard.

## A59

**No built-in dictation (iOS has on-device Whisper plus a Cloud engine)**

- Severity: **low**; claimed by auditor: low; effort: small; area: parity; kind: gap
- Location: `android/app/src/main/AndroidManifest.xml:4`

**Evidence**

src/core/speech/whisper-models.ts:8-9: "The fences here are lessons already paid for on iOS: a download streams to a per-download `<file>.part.<genId>`". src/core/speech/cloud-speech.ts:4-6: "the SAME wire contract the iOS Cloud engine speaks (multipart WAV + locale, Bearer license token)". CLAUDE.md:5124: "**Mobile** keeps its own list, tracked separately as issue #591" (speech languages). Android has no speech code (a grep for speech/dictat/RECORD_AUDIO under android/ finds nothing), and the manifest declares only INTERNET, ACCESS_NETWORK_STATE, POST_NOTIFICATIONS and CAMERA (AndroidManifest.xml:4-8). The terminal input bar is a Compose `OutlinedTextField` (TerminalScreen.kt:124), so the keyboard's own voice typing still works.

**Proposed fix**

Add a mic button to the input bar using Android's SpeechRecognizer (or on-device whisper.cpp) that fills the draft and never auto-submits. Send the same multipart request to `/v1/transcribe` once it exists.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Two corrections.
> 
> 1. The Cloud half of the parity claim does not matter yet. /v1/transcribe does not exist. CLAUDE.md:5101 says "not built yet", and cloud-speech.ts:6-7 says every call "maps 404 to a friendly 'not available yet'". So the iOS Cloud engine cannot transcribe anything today either. The real, current gap is on-device dictation plus a language choice.
> 
> 2. The gap is also missing from docs/android.md "Known gaps" (lines 88-105). Either implement dictation or list it there. Citing TerminalScreen.kt:123-139 (the input Row) is more precise than manifest line 4.
> 
> The proposed fix is reasonable. Android's SpeechRecognizer needs RECORD_AUDIO plus a runtime permission prompt. It should fill the draft only and never call controller.submit, which matches the desktop rule that nothing auto-submits.

## A60

**Interop fixture needs the Electron binary, which is downloaded at test time inside the 20 s ready window, despite the workflow saying 'not Electron'**

- Severity: **low**; claimed by auditor: medium; effort: small; area: ci-docs; kind: bug
- Location: `android/protocol/src/test/interop/host-fixture.ts:22`

**Evidence**

The workflow comment at android.yml:39-42 says the fixture needs 'tweetnacl, ws and esbuild — not Electron ... hence no scripts', and InteropHarness.kt:72 bundles with `--external:electron`. The bundle still has three top-level `require("electron")` calls, from host-service.ts (`import { app, ipcMain } from 'electron'`, host-service.ts:28), host-identity.ts and host-canvas-hub.ts. I reproduced this with esbuild in the scratchpad: the bundle's lines 2330, 3565 and 4132 are `var import_electron… = require("electron")`, and they run when the module loads. Electron 42.11.3 has no postinstall. Its index.js ends in `module.exports = getElectronPath()`. When path.txt is missing, that function calls `downloadElectron()`, which does `spawnSync(process.execPath, [install.js])`, a synchronous download of about 110 MB from GitHub releases that extracts to 312 MB. If the download fails, it throws 'Electron failed to install correctly'. I simulated a clean node_modules/electron with an unreachable mirror, and `require` threw after 334 ms. On a fresh runner nothing downloads Electron beforehand. So the first `InteropHarness.start` pays for the download before the fixture can print its ready line, and the harness waits only `h.await(20_000)` for that line (InteropHarness.kt:93). A slow or failed download makes every interop test fail with 'fixture event not seen within 20000ms'. Local corroboration: node_modules/electron/path.txt and ~/.cache/electron are both dated 07:13, 18 minutes after `npm install` (06:54) and just before the protocol commit. That fits the first local interop run having done the download.

**Proposed fix**

Stop the fixture from loading the real electron package. For example, alias `electron` to a tiny stub exporting no-op `app`/`ipcMain` (`--alias:electron=./android/protocol/src/test/interop/electron-stub.ts`), or have the harness set `ELECTRON_OVERRIDE_DIST_PATH`, which makes index.js return a path without downloading. Then correct the workflow comment.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> 1. **Severity is lower than claimed; I'd call it low-to-medium.** On a GitHub-hosted runner, a GitHub-releases download of ~125 MB plus unzip usually finishes well inside 20 s. The normal outcome is a hidden 125 MB download (312 MB on disk) that adds a few seconds. Failures only happen when that download is slow or fails. Then both interop classes fail after 20 s: RelayInteropTest and PairingInteropTest (one `InteropHarness.start` each).
>    - An aggravating detail: when `h.await(20_000)` throws inside `start()`, the handle was never returned, so `close()` never runs. The node process is orphaned and keeps downloading, and the next test can start a second, concurrent download into the same dist/.
> 
> 2. **The local timestamp corroboration does not hold up.** node_modules/electron/path.txt is 07:13:04, but android/protocol/build/interop/ was created at 07:16:38, 3.5 minutes later. The download therefore happened before the first bundle recorded in that directory, and the timestamps do not show that the harness triggered it.
> 
> 3. **The proposed stub is incomplete.** Seven src/main/remote files import from electron, including host-identity.ts (`app, safeStorage`) and approved-devices.ts / peer-identity.ts (`app`), so a stub must also export `safeStorage`.
>    - Today, plain-node `require("electron")` returns a path string, so every member is already undefined at runtime. An empty-object stub is therefore behaviour-preserving for the current tests.
>    - The simplest fix is `pb.environment()["ELECTRON_OVERRIDE_DIST_PATH"] = <any dir>` in InteropHarness.start. The cleaner fix is esbuild `--alias:electron=<stub>`, which also removes the need for the electron package entirely.
>    - Either way, correct the comment at android.yml:39-40.

## A61

**Following CONTRIBUTING / android/README (`npm ci --ignore-scripts`) wipes a desktop developer's patched node_modules**

- Severity: **low**; claimed by auditor: medium; effort: small; area: ci-docs; kind: bug
- Location: `CONTRIBUTING.md:111`

**Evidence**

CONTRIBUTING.md:107-111 is aimed at desktop contributors who change host-service.ts, the blob, the mirror and similar. It tells them to run `./gradlew -p protocol test` (from `android/`, after `npm ci --ignore-scripts`). android/README.md:48 says the same ('Run `npm ci --ignore-scripts` at the repo root first'). `npm ci` always deletes node_modules, and `--ignore-scripts` skips the root postinstall `node scripts/patch-node-pty.mjs && electron-rebuild -f -w node-pty,smart-whisper` and node-pty's own install script (`node scripts/prebuild.js || node-gyp rebuild`). After that, src/main/node-pty-patch.test.ts, which reads node_modules/node-pty/src/unix/pty.cc and src/win/conpty.cc, goes red in the contributor's `npm test`. On Linux node-pty ships no prebuild (its prebuilds/ folder only has darwin-*/win32-*), so `npm run dev` has no pty.node. On macOS it falls back to the unpatched ptmx-leaking prebuild that CLAUDE.md calls 'not optional' to patch. The harness itself only checks that node_modules/.bin/esbuild, node_modules/ws and node_modules/tweetnacl exist (InteropHarness.kt:81-85), so any ordinary `npm install` / `npm ci` already works.

**Proposed fix**

Say that a normal `npm install` is enough and that `--ignore-scripts` is only for a machine without the native toolchain (as CI uses it). Warn that it replaces an existing node_modules.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The finding is accurate on the facts, the line numbers and the proposed fix. Severity is at the low end of medium, and arguably low: this is a documentation-only problem that affects developers, not the app or its users, and the test's own failure message names the recovery (`npm run rebuild`).
> 
> Recommended fix, in two parts:
> 1. **Scope the flag in both docs.** In CONTRIBUTING.md:110-111 and android/README.md:48, say that an existing `npm install` is enough. `--ignore-scripts` is only for a machine without the native toolchain, as CI uses it (android.yml:39-42).
> 2. **Add a warning.** `npm ci` deletes node_modules, so running it with `--ignore-scripts` over a working desktop checkout leaves node-pty unpatched and unbuilt until `npm install` or `npm run rebuild` is run again.

## A62

**SSH transport tests fail, not skip, on macOS: the gate checks only that /usr/bin/script exists, then runs util-linux-only flags**

- Severity: **low**; claimed by auditor: medium; effort: small; area: ci-docs; kind: bug
- Location: `android/protocol/src/test/kotlin/dev/nodeterm/protocol/SshTransportTest.kt:54`

**Evidence**

The gate at lines 54-55 is `tmuxAvailable() = ... tmux -V ... && File("/usr/bin/script").exists()`. Every pty-requesting exec then runs `listOf("script", "-qfec", "stty cols $cols rows $lines ...; $command", "/dev/null")` (lines 84-85). `-c <command>` (and `-f`, `-e` in this form) is util-linux syntax. macOS /usr/bin/script is the BSD one (`script [-aeFkqr] [-t time] [file [command ...]]`), which has no `-c` and exits with a usage error. On a Mac with Homebrew tmux on PATH, which is the normal nodeterm developer setup, the gate passes and the pty-backed tests fail: the pane process dies immediately, and `Sink.waitFor` throws "'…' never appeared". This affects the attach and cold-start tests. CONTRIBUTING.md:110-111 tells every contributor to run exactly this suite.

**Proposed fix**

Gate on util-linux `script` (for example, require `script --version` to report util-linux), or `assumeTrue(os.name == Linux)`, with a skip reason. Alternatively, allocate the pty in the MINA command without `script`.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Two corrections to the finding:
> - **Root cause and scope.** On macOS the first failure is not `Sink.waitFor` in the pty tests. `@BeforeAll` fails earlier: the private `TMUX_TMPDIR` is made by `Files.createTempDirectory("nt-ssh")` under `/var/folders/…/T/` (line 126). tmux resolves that to `/private/var/…`, so the socket path comes to about 110 characters, over macOS's 103. `tmux new-session` fails with "File name too long", and `assertEquals(0, code, out)` at line 187 throws. That fails all 8 tests in the class, not just attach and cold start. The BSD-`script` incompatibility at line 85 is real but only shows up after that is fixed.
> - **Citation.** The CONTRIBUTING.md reference is lines 106-109.
> 
> The fix needs both parts:
> 1. **Short socket directory.** Create a short, realpath'd `TMUX_TMPDIR`, the way `src/core/tmux-test-socket.ts` `makeTmuxTmpdir` does: prefer `/tmp` resolved to `/private/tmp`, and check `<dir>/tmux-<uid>/node-terminal` fits in 103 characters.
> 2. **`script` handling.** Either gate on util-linux `script` with a skip reason (for example, `script --version` reports util-linux, or `assumeTrue(os.name == Linux)`), or branch to BSD syntax: `script -q /dev/null /bin/sh -c '…'`.

## A63

**Android workflow path filters miss files that change the tested wire behavior, contrary to CLAUDE.md**

- Severity: **low**; claimed by auditor: medium; effort: small; area: ci-docs; kind: gap
- Location: `.github/workflows/android.yml:7`

**Evidence**

The triggers cover only `android/**`, `src/main/remote/**`, `src/main/pairing-*.ts` and the workflow file itself (lines 6-17). ci.yml runs no Gradle. CLAUDE.md:5390-5396 says a change to 'a host-service.ts verb, the projects.list blob, the pairing payload, the mirror file, or the SSH-visible file contracts ... the Android workflow (.github/workflows/android.yml) runs on those paths'. Several of those producers are outside the filter. (1) host-service.ts validates the phone's params with `isValidPendingId` from src/core/agents/pending-approvals.ts (host-service.ts:37; this is exactly what the interop `approvals.answer` test exercises), with `parseCardLabelEdit` from src/core/project-kanban-write.ts (:36), and with `TITLE_MAX` from src/core/project-node-append.ts (:35). All three are in the fixture bundle; I listed its esbuild metafile inputs. (2) The projects.list blob is built by `listProjectsOutput` in src/main/index.ts:632, whose sync comment at :621-623 names only NodetermProjects.swift, not ProjectsParser.kt. The new approvals.answer/inbox.ack wiring is also in src/main/index.ts (about :4019). (3) The mirror is src/core/agent-status-mirror.ts, and acks are consumed by src/core/ack-sweep.ts. (4) The URL-form pairing QR that PairingPayload parses comes from src/shared/pair-qr.ts. (5) package-lock.json pins the ws/tweetnacl/esbuild/electron the fixture runs. None of these triggers the workflow.

**Proposed fix**

Add the fixture's transitive sources (at least src/core/agents/pending-approvals.ts, src/core/project-kanban-write.ts, src/core/project-node-append.ts, src/shared/**), src/main/index.ts, src/core/agent-status-mirror.ts, src/core/ack-sweep.ts, src/shared/pair-qr.ts and package-lock.json to both path lists. Or drop the path filter, since the protocol job is cheap. Also name ProjectsParser.kt in the index.ts marker comment.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The root cause is right for the fixture's transitive sources, but the list is incomplete and part of the fix does nothing. The esbuild metafile shows 29 of the 43 bundled repo sources outside the filter, including src/main/windows-ssh-keys.ts (via pairing-service), src/core/license.ts, src/core/fs-ops.ts, src/core/platform.ts and many files under src/shared/. So the path list should cover at least `src/core/**`, `src/shared/**`, `src/main/windows-ssh-keys.ts` (or `src/main/*.ts`) and `package-lock.json`. The simplest fix is still to drop the path filter for the cheap protocol job.
> 
> Adding src/main/index.ts, src/core/agent-status-mirror.ts, src/core/ack-sweep.ts and src/shared/pair-qr.ts to the trigger would NOT make drift there fail anything. The fixture serves a hand-written blob and mirror (host-fixture.ts:140-165, :182 `listProjects: async () => blob`), and none of those producers is in the bundle. Closing that gap needs one of two things:
> - tests that build the blob, mirror and QR from the real producers, for example by extracting the blob assembly out of index.ts into a core module the fixture can import;
> - or CLAUDE.md:5392-5396 stops claiming the workflow covers "the projects.list blob ... the mirror file".
> 
> The index.ts marker comment (:621-623) should also name ProjectsParser.kt. Line references: the blob builder is at index.ts:633 (not 632), and the inbox wiring is at index.ts:4024-4025.

## A64

**Docs say the protocol tests check the mirror, the projects.list blob and the ~/.nodeterm files against desktop code, but those shapes are hand-copied in the tests**

- Severity: **low**; claimed by auditor: medium; effort: small; area: ci-docs; kind: gap
- Location: `CONTRIBUTING.md:107`

**Evidence**

CONTRIBUTING.md:107-111 says a change to 'the `projects.list` blob, ..., the agent-status mirror, or the `~/.nodeterm/{pending,acks,relay.json}` files' is caught because `./gradlew -p protocol test` 'runs it against this repo's own host code'. CLAUDE.md:5392-5396 makes the same promise. In the relay fixture, the blob, including the whole mirror JSON with `inbox.events`/`pendingId`, is a literal written by hand (host-fixture.ts:129-165 and `listProjects: async () => blob` at :180). `answerPermission`, `ackRead`, `registerNode` and the three kanban writers are fakes that only emit events (:181-204). SshTransportTest.kt:168-184 hand-writes workspace.json and agent-status.json, and tests pending/acks by writing files itself (:283-294). No test runs `listProjectsOutput`, `agent-status-mirror.ts`, `ack-sweep.ts` or the index.ts `inbox` wiring. Only connectHostSession's RPC routing/validation and createPairingService are real.

**Proposed fix**

Either narrow the docs to what is actually exercised (relay framing/handshake and host-service validation, pairing service) and name the hand-copied contracts, or generate the fixture's blob and mirror from the real writers (for example, build the mirror with AgentStatusMirror and the blob with the same assembly listProjectsOutput uses).

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The CONTRIBUTING.md:107-111 overclaim is real, and the fixture and test citations are correct (host-fixture.ts:129-165, :182, :183-205; SshTransportTest.kt:152-189 and :283-296). One part of the finding is wrong: CLAUDE.md:5388-5390 does not overclaim test coverage. It accurately names connectHostSession, createPairingService and the SSH server, and it tells contributors to update the hand-maintained fixture. CLAUDE.md's false statement is at :5395-5396, "the Android workflow ... runs on those paths". android.yml:5-17 only filters on android/**, src/main/remote/** and src/main/pairing-*.ts. So changes to src/main/index.ts (listProjectsOutput), src/core/agent-status-mirror.ts, src/core/ack-sweep.ts and src/core/agents/pending-approvals.ts do not trigger Android CI at all. docs/android.md:69-70, which lists `projects.list` as verified against the real host, is also overstated. Better fix, either or both of:
> (a) Narrow CONTRIBUTING.md, CLAUDE.md and docs/android.md to what is real: relay framing, handshake and host-service verb routing/validation, pairing, crypto, and the SSH scripts against real tmux. Name the hand-copied contracts (blob, mirror, v3 index, pending/acks, relay.json) and add the missing source paths to android.yml's `paths` filter.
> (b) Generate the fixture's mirror with the real AgentStatusMirror. Export the split markers and the blob assembly from a core module so the fixture and index.ts share one definition. In the SSH test, drive ack-sweep and pending-approvals against the files the Kotlin client writes.

**Current coverage update (2026-10-05):** actual producers now cover relay projects/mirror,
selected Server-profile publications, SSH action/managed writers and local/remote acknowledgement
consumers (A108/A111/A119). The newer relay-advertisement tests additionally run the actual
account-level writer/remover and Kotlin parser through private SSH, with every field, replacement,
removal and profile isolation checked. All 75 affected methods pass; four behavior mutants are
assertion-caught, with passing control/restored runs. The producer has a temporary OS-home adapter
during initialization; full Server boot/hooks/account probes, driven-slice producer parity and
standing-host/token/adoption/SAS/revoke behavior remain outside this proof. Legacy/adversarial
fixtures remain deliberately hand-written. Private evidence:
`.nodeterm/android-beta-build-16/desktop-links-and-advertisement-receipt/a64/`.
No production contract/APK or physical-ledger change follows.

## A65

**User-facing docs and desktop UI present the Android app as working, but it has never been built by AGP or run on a device, and no device checklist exists**

- Severity: **low**; claimed by auditor: medium; effort: small; area: ci-docs; kind: gap
- Location: `android/README.md:11`
- Note: PARTLY OBSOLETE: the premise "never built by AGP" is wrong. CI run 36109984730 built the debug APK with AGP on 2026-09-25. The "never run on a device" half still holds.

**Evidence**

android/README.md:11-26 marks 15 features ✓ (terminal with OSC 52 copy, swipe-to-scroll, WorkManager notifications, and more) with no caveat. README.md:49 and :103 now say 'phone companions for iOS and Android' and 'scan with the nodeterm app on iPhone or Android'. The desktop UI now links 'nodeterm for Android ↗' (PhonePairPopover.tsx:196-201, PhoneSection.tsx:213-218), and its pairing copy was generalized to 'the nodeterm phone app'. docs/android.md's 'What is verified' section (lines 62-86) only says the app module 'is built by CI ... it has no instrumented tests yet'. On this branch the workflow is new (added in 2f58918) and has never run. The app Kotlin was only type-checked against stubs because Google Maven was unreachable, so aapt2, the manifest merger, D8 and any device run are all unverified. CLAUDE.md requires stating what could not be run as a numbered device checklist (rule 16, docs/grok-agent.md §9 format) and says 'a doc line with no such test is a plan, not a fact'. docs/android.md has no such checklist.

**Proposed fix**

State in android/README.md and docs/android.md that :app has not yet been built by AGP or run on a device. Add a numbered device checklist covering pairing (QR, code, deep link), SSH and relay attach, WebView terminal and OSC 52, notifications, and Keystore persistence. Consider holding the desktop 'nodeterm for Android' link until a CI build has passed.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Drop the build claims and downgrade the severity to low.
> 
> Wrong in the original finding:
> - ".github/workflows/android.yml has never run" and ":app has never been built by AGP" are both false. Run 36109984730 on head 2f58918 passed both jobs, `:app:assembleDebug` included, and uploaded a 15.8 MB debug APK.
> - The list "aapt2, manifest merger, D8 unverified" is false.
> - R8 does not apply (`isMinifyEnabled = false`, android/app/build.gradle.kts:22).
> - Do not tell the docs to say ":app has not been built by AGP". That would now be false, and docs/android.md:85-86 is correct as written.
> 
> The remaining finding is:
> - The app has never been installed or run on a device or emulator, and no doc says so.
> - The android/README.md:11-26 ✓ table has no caveat.
> - docs/android.md has no numbered device checklist in the rule-16 / grok-agent.md §9 format.
> 
> Proposed fix:
> - Add a one-line caveat near the ✓ table, e.g. "the APK is built by CI; no row has yet been checked on a device — see docs/android.md §Device checklist".
> - Add that numbered checklist to docs/android.md. Cover:
>   - QR scan via CameraX/ML Kit, pasted code, and the `nodeterm://pair` deep link from the system camera
>   - SSH attach and TOFU pin on a real LAN
>   - relay attach plus SAS approval
>   - WebView terminal input bar, special keys, swipe scroll and OSC 52 clipboard
>   - WorkManager inbox notifications, including the Android 13+ POST_NOTIFICATIONS grant
>   - Keystore persistence across app restart and reinstall
>   - the cold-start resume offer
> 
> Holding back the desktop "nodeterm for Android" link is optional rather than needed, since a build has passed. Note that ANDROID_APP_URL points at eneskirca/nodeterm tree/main/android, which only exists once this branch merges upstream.

## A66

**ANDROID_APP_URL points at a folder that exists on neither upstream nor fork main yet, and it points at source code rather than an installable**

- Severity: **low**; claimed by auditor: low; effort: small; area: ci-docs; kind: gap
- Location: `src/renderer/lib/links.ts:7`

**Evidence**

The constant is `export const ANDROID_APP_URL = 'https://github.com/eneskirca/nodeterm/tree/main/android'`. This checkout's origin is github.com/CPlusPlus17/nodeterm, and `git ls-tree origin/main android` is empty. The android/ folder exists only on claude/android-ios-parity-75kfem, so the link 404s until this lands on eneskirca/nodeterm main specifically. A merge into the fork alone leaves it broken. Even when the folder exists, the link sits beside 'Get the nodeterm iOS app ↗' (PhonePairPopover.tsx:196-201) and after 'Don't have the app yet?' (PhoneSection.tsx:205-219), but it opens a Gradle source tree, not a download. bugReport.ts:7 already defines `REPO_URL` for the same repository.

**Proposed fix**

Derive the link from `REPO_URL` and merge upstream before shipping the copy. Label it as source/build instructions (for example, 'Android (build from source) ↗') until a downloadable release exists.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Line references:
> - PhonePairPopover.tsx: the iOS button is 191-196 and the Android button is 197-202.
> - PhoneSection.tsx: the Android button is 213-218, inside the "Don't have the app yet?" paragraph at 205.
> 
> Root cause: the dead link is a timing artifact, not a shipping defect. It resolves when the branch merges to eneskirca/nodeterm main, and releases are cut from upstream v* tags. The part that stays true after the merge is the wording: "nodeterm for Android ↗" sits beside an App Store link and after "Don't have the app yet?", but the target is a Gradle source tree. The only APK is an expiring CI run artifact that needs a GitHub login.
> 
> Better fix:
> - Relabel both call sites as source/build, e.g. "nodeterm for Android (build from source) ↗". Once a signed APK is published, point the link at a GitHub Release asset.
> - Deriving the URL from REPO_URL (`${REPO_URL}/tree/main/android`) removes the duplicate constant. It does not change behaviour on a fork, because REPO_URL is also hardcoded to upstream.

## A67

**The interop fixture is excluded from every tsconfig, so `npm run typecheck` never checks it against the desktop interfaces it implements**

- Severity: **low**; claimed by auditor: low; effort: small; area: ci-docs; kind: gap
- Location: `tsconfig.node.json:17`

**Evidence**

tsconfig.node.json's `include` covers electron.vite.config.ts, src/main, src/preload, src/shared, src/core, src/server and src/session-host. tsconfig.web.json covers src/renderer and src/shared. Neither covers android/protocol/src/test/interop/host-fixture.ts. That file implements `HostPtyManager` and the kanban/inbox/nodeActions bridge (host-fixture.ts:97-204) and is only bundled by esbuild, which strips types without checking them (InteropHarness.kt:67-75). It passes tsc today (I checked it with a scratch config extending tsconfig.node.json), but nothing keeps it that way.

**Proposed fix**

Add `android/protocol/src/test/interop/**/*.ts` to tsconfig.node.json's include (or a small dedicated tsconfig run by `npm run typecheck`).

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The line reference is slightly off: the `include` array in tsconfig.node.json is at lines 18-26 (line 17 is the closing brace of `compilerOptions`). The implementing code spans host-fixture.ts:97-212, not 97-204. The esbuild call in InteropHarness.kt is at lines 67-71 (about 65-75 including the setup around it).
> 
> Two additions to the finding:
> - android.yml's path filter leaves out `src/core/**`, but the fixture imports `src/core/platform` and `src/core/pty-manager`. Some desktop drift therefore skips even the runtime interop tests.
> - The `pty as unknown as PtyManager` cast at host-fixture.ts:178 means even a type-checked fixture only checks the `HostPtyManager` interface, not its fit to `PtyManager`.
> 
> The proposed fix works: add `android/protocol/src/test/interop/**/*.ts` to tsconfig.node.json's `include`. I verified the file compiles clean under that config, with `@types/ws` resolving from the repo's node_modules.

## A68

**Current follow-up (2026-10-05):** source-fixed in `7e91785c` with main-only push, retained PR filters, no merge-group trigger and opt-in manual beta preparation. Tests, mutations and the exact-head CI route are recorded in the latest workflow-readiness paragraph below. The original finding and verifier corrections remain historical evidence.

**Workflow triggers break repo conventions: every branch push plus pull_request doubles runs, and there is no merge_group**

- Severity: **low**; claimed by auditor: low; effort: small; area: ci-docs; kind: risk
- Location: `.github/workflows/android.yml:6`

**Evidence**

`push:` has only `paths:` and no `branches:` (lines 6-11), and `pull_request:` has the same paths (lines 12-17). For a PR branch in this repo, each commit therefore runs both jobs twice. The concurrency group `${{ github.workflow }}-${{ github.ref }}` separates refs/heads/<branch> from refs/pull/<n>/merge, so neither run cancels the other. ci.yml:7-11 and security.yml:10-14 restrict `push` to `branches: [main]` and add `merge_group:` because 'required checks must also report on the queue's synthetic merge commits'. android.yml has no merge_group, so the queue's combined commit is never tested against the Android contract.

**Proposed fix**

Use `push: branches: [main]` like ci.yml, keep `pull_request` (with widened paths), and add `merge_group:`.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Keep the duplicate-run finding (android.yml:6-17 and 20-22), severity low.
> 
> Fix: add `branches: [main]` to `push:` and keep its `paths:` filter, so the merged commit on main is still tested. Keep `pull_request:` with `paths:` (widening the paths is a separate matter). That removes the duplicate runs on same-repo PR branches, and possible tag-push runs as well.
> 
> Drop the merge_group reasoning or reframe it. The merged commit is tested post-merge through push-to-main. The workflow cannot be a required check because of its `paths` filters, not because merge_group is missing. And merge_group takes no `paths` filter, so adding it would run Android on every queued PR. Only add merge_group if Android is deliberately made a required check. In that case, replace the workflow-level `paths` filter with an in-job path check that always reports a status.

## A69

**The Gradle/Kotlin code has no dependency-update, CodeQL or wrapper-validation coverage**

- Severity: **low**; claimed by auditor: low; effort: small; area: ci-docs; kind: gap
- Location: `.github/dependabot.yml:4`

**Evidence**

dependabot.yml has only the `npm` and `github-actions` ecosystems. There is no `gradle` entry for /android or /android/protocol, whose crypto and network stack is pinned in protocol/build.gradle.kts:28-34 and app/build.gradle.kts:78 (okhttp 4.12.0, sshj 0.39.0, bcprov-jdk18on 1.78.1). security.yml:40 limits CodeQL to `languages: javascript-typescript`, so the new Kotlin NaCl port, relay socket, host-key pinning and Keystore code get no static analysis. android.yml runs a committed binary, android/gradle/wrapper/gradle-wrapper.jar (sha256 7d3a4ac4…), without a wrapper-validation step, and it has no Gradle cache, so every run downloads the distribution, AGP and all dependencies again.

**Proposed fix**

Add Dependabot `gradle` entries for /android and /android/protocol. Add `java-kotlin` to CodeQL (build-mode none works without the Android SDK). Add `gradle/actions/wrapper-validation` (or setup-gradle, which also caches) to android.yml.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Three corrections, one of them material.
> 
> 1. Line numbers.
>    - `dependabot.yml:4` is a comment; the ecosystem entries are at lines 5 and 36.
>    - The pins are at `protocol/build.gradle.kts:27` (okhttp), `:30` (sshj) and `:32` (eddsa), not lines 28-34.
>    - `app/build.gradle.kts:78` (bcprov) is correct.
> 
> 2. The CodeQL fix as proposed would analyse nothing. `build-mode: none` for `java-kotlin` covers Java source only; Kotlin needs a build, and every file under `android/` is Kotlin (43 `.kt`, 0 `.java`). Adding `java-kotlin` with build-mode none would scan nothing while looking like coverage. The fix needs `build-mode: manual` (or autobuild) with a build step:
>    - `./gradlew -p protocol compileKotlin` needs no Android SDK.
>    - `:app:compileDebugKotlin` works on ubuntu-latest, which ships the Android SDK.
> 
> 3. The impact wording is stronger than I could verify. Dependabot security alerts come from GitHub's dependency graph, not from `dependabot.yml`. I believe (from memory, not checked) that Gradle coverage in that graph needs the dependency submission API. If so, the complete fix also adds `gradle/actions/dependency-submission`; that would also make the existing `dependency-review` job in `security.yml` see Gradle changes.
> 
> The rest of the proposed fix stands: Dependabot `gradle` entries for `/android` and `/android/protocol`, and `gradle/actions/setup-gradle` in `android.yml`, which validates the wrapper and caches. Adding `distributionSha256Sum` to `gradle-wrapper.properties` would also pin the distribution itself.

## A70

**On Windows the interop tests fail with CreateProcess instead of skipping**

- Severity: **low**; claimed by auditor: low; effort: small; area: ci-docs; kind: bug
- Location: `android/protocol/src/test/kotlin/dev/nodeterm/protocol/InteropHarness.kt:66`

**Evidence**

The harness does `val esbuild = File(repoRoot, "node_modules/.bin/esbuild")` and then `ProcessBuilder(esbuild.path, ...)` (lines 66-68). `available()` gates only on that file existing (line 83). On Windows, npm also creates the extensionless sh shim, so the gate passes. CreateProcess cannot run a shell script, though: it looks for `esbuild.exe`, which does not exist beside esbuild.cmd. The lazy `bundle` then throws, and the test errors instead of skipping. CLAUDE.md treats Windows as a first-class desktop target and requires platform-bound tests to be gated.

**Proposed fix**

Invoke esbuild through node (`node node_modules/esbuild/bin/esbuild …`) or through its JS API, or resolve `esbuild.cmd` on Windows.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The root cause and the line numbers are right. Minor wording: CreateProcess may fail with error 193 (tries the sh file) rather than error 2 (looks for esbuild.exe); either way the result is an IOException.
> 
> The proposed fix is incomplete, and on its own it is harmful. If only the esbuild call is changed (for example `node node_modules/esbuild/bin/esbuild ...`), bundling succeeds on Windows and two new problems appear in PairingInteropTest:
> 
> (a) The pairing tests are platform-bound. The fixture calls `createPairingService(..., { timeoutMs: 60_000 })` without a `platform` option (host-fixture.ts:237-247). On win32, `directSsh = platform !== 'win32'` is false (pairing-service.ts:440), so the QR carries `ssh:false` (line 652). The first test's `assertTrue(payload.sshAvailable)` (PairingInteropTest.kt:53) then fails.
> 
> (b) The tests' home isolation does not work on Windows. PairingInteropTest.kt:38 sets only `HOME`, but pairing-service.ts:259-260 resolves `AGENT_DIR` from `os.homedir()`, which reads `USERPROFILE` on Windows. The relay-on test would reach the win32 branch, which mints and then calls `persistDevice({... token: agentToken ...})` (pairing-service.ts:803-822). That writes a paired test device, with a live bearer token, into the contributor's real `%USERPROFILE%\.nodeterm\agent.json`.
> 
> A correct fix has two parts:
> 1. Invoke esbuild through node, not the `.bin` shim, so RelayInteropTest can run on Windows.
> 2. Either gate PairingInteropTest off Windows (`assumeFalse(System.getProperty("os.name").startsWith("Windows"), reason)`), or have the fixture pass `platform: 'linux'` and have the test also set `USERPROFILE` to the temp home.

## A71

**android/README says 'JDK 17+', but the pinned Gradle 8.14.3 cannot run on JDK 25**

- Severity: **low**; claimed by auditor: low; effort: small; area: ci-docs; kind: gap
- Location: `android/README.md:36`

**Evidence**

The README says 'Needs JDK 17+ and the Android SDK'. The wrapper pins `gradle-8.14.3-bin.zip` (gradle-wrapper.properties:3). Gradle 8.14 supports running on Java up to 24; Java 25 support arrived in Gradle 9.1. A contributor whose default JAVA_HOME is the current LTS (25) gets a Gradle startup failure from `./gradlew`. CI pins 17 (android.yml:47-50, 68-71), and the protocol tests were run locally on 21.

**Proposed fix**

State the supported range ('JDK 17–24; Android Studio's bundled JDK works'), or bump the wrapper to a Gradle version that supports 25 (check AGP compatibility).

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The line (android/README.md:36) and the conclusion are correct. The finding says only "Gradle startup failure"; the precise cause is the Kotlin 2.0.21 compiler embedded in Gradle 8.14.3. Its `com.intellij.util.lang.JavaVersion.parse` rejects "25"/"25.0.1" with an IllegalArgumentException. This fires while settings.gradle.kts compiles, so the user sees "What went wrong: 25.0.1". The Kotlin DSL's own JVM-target mapping clamps unknown versions to JVM_22, so that part is safe.
> 
> Fix options:
> 1. Simplest: change the README to "JDK 17–24 (Android Studio's bundled JDK works; JDK 25 needs Gradle 9.1+)".
> 2. Add `gradle/gradle-daemon-jvm.properties` with `toolchainVersion=17`, so the daemon runs on 17 whatever JAVA_HOME is. This is incubating in 8.14, and the launcher still starts on JAVA_HOME.
> 3. Bump the wrapper to Gradle 9.1+. This needs its AGP compatibility with AGP 8.9.1 checked first; I have not verified that.

## A72

**Current follow-up:** A102 now includes trusted project env/shell and A103 preserves measured per-agent policy; old evidence below describes the earlier gap.

**Phone-started sessions are created without the agent-specific env, so for their whole life they get no hook-reply approvals, no canvas control and no pane ownership**

- Severity: **low**; claimed by auditor: medium; effort: medium; area: critic; kind: gap
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/TerminalController.kt:229`
- Note: Related: A08.

**Evidence**

New session works by attaching a fresh `term-…` id and typing the launch line (TerminalController.kt:229-241; the docs/android.md table says 'pty.attach of a fresh term-… id, launch line, then projects.registerNode'). The relay attach passes no agentId (host-service.ts:432), and the desktop's own comment at pty-manager.ts:2254-2259 says these spawns carry 'no ownerProjectId — and no cwd, agent, account…'. hookServer.buildPtyEnv therefore omits `NODETERM_AGENT_ID`, `NODETERM_PERM_WAIT_SECS` and `NODETERM_CANVAS_CONTROL`, all gated on agentId (hook-server.ts:1249-1251). Pane ownership is recorded only when an ownerProjectId is supplied (pty-manager.ts:2309-2310). The node is registered afterwards, so the desktop mounts it warm, and tmux ignores `-e` on an existing session (CLAUDE.md: 'Sessions are pinned for life'). Nothing ever adds the missing env.

**Proposed fix**

Pass the intended agentId (and project and account) through the create path: add optional `agentId/projectId/accountId` to `pty.attach` for a not-yet-existing session, validated host-side like registerNode, or register first and let the desktop spawn with a held launch. Then the session gets the same env a canvas-started node does.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The behaviour is real, but four details need correcting.
> 
> 1. **Root cause is on the desktop, not in the Android code.** The gap is in the relay host's `pty.attach` verb (`host-service.ts:432` passes only `{cols, rows}`), and the desktop documents it at `pty-manager.ts:2254-2259`. Android is copying the iOS new-session flow (`docs/android.md:43`), so iOS presumably has the same gap. The fix belongs on the desktop side, with the Android client sending the extra fields.
> 
> 2. **"No hook env" is too broad, and so is the desktop's own comment.** `hookEnv` is still built for every `persistKey` (`pty-manager.ts:2893-2896`). `NODETERM_NODE_ID` and `NODETERM_HOOK_ENDPOINT` are present, so status badges and inbox events still work. What is missing is only the agent-gated part: `NODETERM_AGENT_ID`, `NODETERM_PERM_WAIT_SECS`, `NODETERM_CANVAS_CONTROL` and the Codex launcher PATH. Approvals still work from the phone through the keystroke fallback (`QuickActions.kt:36-38`), so this is a degraded path, not a broken one.
> 
> 3. **Severity should be medium-low.**
>    - Agent messaging is off by default (`agentMessagingDefault`).
>    - Every pane is already unproven after a desktop restart.
>    - Plain Codex is a supported mode.
>    - The real losses are deterministic approvals and canvas control for Claude sessions started from the phone.
>    - The user can repair a session on the desktop with "Restart agent and shell", which recycles the session so it respawns with the right env.
> 
> 4. **Of the two proposed fixes, only the first is sound.**
>    - "Register first and let the desktop spawn" does not work in general. The desktop only mounts nodes of the active project, and nothing spawns a registered node in a background project. The phone's own `pty.attach` would still create a bare session.
>    - The workable fix is optional `agentId` (and account) on `pty.attach`, applied only when the session does not yet exist. The host should validate the value against builtin/custom agents and let `buildPtyEnv`/`canControlCanvas` decide the grant.
>    - `ownerProjectId` must be resolved on the host (the index entry id), not taken from the phone. Otherwise it breaks `pane-ownership.ts`'s rule that ownership never comes "off the wire".

## A73

**Notifications are documented as 'live every 8 seconds while a computer is open', but the in-app poll never posts a notification**

- Severity: **low**; claimed by auditor: medium; effort: small; area: critic; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/notify/InboxNotifier.kt:125`
- Note: Related: A25.

**Evidence**

InboxNotifier.announce has exactly one caller: InboxWorker.doWork (InboxNotifier.kt:125), the 15-minute WorkManager job. HostSession's 8 s poll (ConnectionManager.kt:212-221) only updates `_snapshot`. Yet the kdoc says '…plus the in-app 8 s refresh while a computer's screen is open' (InboxNotifier.kt:37-38). The Settings switch tells the user 'Checked about every 15 minutes in the background, and live while a computer is open.' (SettingsScreen.kt:84). android/README.md:55-56 says '…and live every 8 seconds while a computer is open'.

**Proposed fix**

Call InboxNotifier.announce from HostSession after each successful refresh, skipping events the user is currently looking at (e.g. the open terminal's node, or the Inbox tab). Alternatively, correct the copy in all three places.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The line is correct: :125 is the only caller, and the definition is at :71. Three corrections:
> 
> 1. **Impact.** On the HostScreen, the Inbox tab badge ("Inbox (N)", HostScreen.kt:70,112) already shows new actionable events live. The unannounced cases are the terminal screen, other paired computers, and the app in the background.
> 2. **The proposed fix only covers the computer being watched.** "Call announce from HostSession after each refresh" works only for that computer, because other computers' sessions are not polled at all (`startWatching` is per-host and is started only by HostScreen and TerminalScreen). So it does not fix the "on another computer's screen" case the finding describes.
> 3. **Better fix.** Either:
>    - Call `announce` from `refreshNow` and skip the node open in the terminal. This also needs the seen-set updated for events shown on the Inbox tab, or the worker will later re-announce events the user already saw.
>    - Or, simpler and honest: change the three copy sites to say notifications arrive only from the ~15-minute background check, and that the Inbox tab updates live while a computer's screen is open.
> 
> Severity: medium is arguable, low-medium is more accurate. It is a documentation promise that is not kept, not a broken headline flow.

## A74

**The LAN leg dials a DHCP IPv4 frozen at pairing time; when another SSH host answers at that address, the host-key 'hard stop' also blocks the relay fallback**

- Severity: **low**; claimed by auditor: medium; effort: small; area: critic; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/conn/ConnectionManager.kt:88`

**Evidence**

PairedHost.host is the QR's `host` (PairedHost.from, PairedHost.kt), which the desktop fills with `pickLanIPv4(os.networkInterfaces())` (pairing-service.ts:588). Nothing ever updates it: late adoption reads relay.json but not the address. connectLocked tries SSH to that address first in Auto. On a HostKeyChangedException it sets Failed and throws immediately: 'A changed host key is a security signal … do not quietly route around it' (lines 88-93), so the independently authenticated relay leg is never attempted. The error text says 'someone may be intercepting the connection'. The same private address commonly belongs to a different SSH-running machine: the computer's lease reassigned at home, or the phone on another network using the same 192.168.x.y range.

**Proposed fix**

Key the SSH pin to the computer rather than to the IP, and on a mismatch skip SSH but still try the relay (its identity is pinned separately, so no trust is lost). Refresh the LAN address when you can: publish it in `~/.nodeterm/relay.json` or the mirror and update it over the relay, or re-resolve it from a stable hostname.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Two parts of the finding are overstated and should be corrected.
> 
> 1. The user is not locked out until they re-pair. SettingsScreen.kt:98-110 has a per-computer route override, "Only through the relay" (`RoutePreference.RELAY_ONLY`), which skips the SSH leg (ConnectionManager.kt:76) and reaches the computer through the relay. The real problem is that the error text never mentions that setting. It tells the user to "remove and re-pair", or implies an attack. Severity is medium at most: the case is narrow and there is a manual workaround. Low is also defensible.
> 
> 2. The proposed fix "key the SSH pin to the computer rather than to the IP" is based on a misreading. The pin is already stored per paired computer, not per IP: `PairedHost.sshHostKeyFingerprint`, read through `pinFor(host)` via `graph.hosts.get(host.id)` (ConnectionManager.kt:154-157). What goes wrong is the stale dial target, not how the pin is keyed.
> 
> Better fix:
> - In AUTO, when `HostKeyChangedException` is thrown, record and show the warning but keep going to the relay leg, which has its own pinned identity. Keep the hard stop for SSH_ONLY.
> - Change the message to point at the "Only through the relay" setting.
> - Optionally, have the desktop publish its current LAN address (for example in relay.json, or in the relay's `projects.list` reply). The phone could then refresh `host.host` after a successful relay connect. Clear the SSH pin only if the relay-authenticated computer confirms the new host key.

## A75

**The New session account picker lists managed Claude accounts by raw UUID**

- Severity: **low**; claimed by auditor: low; effort: small; area: critic; kind: gap
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/SessionsTab.kt:316`

**Evidence**

The picker renders `Text(id ?: "System account")` for each `snapshot.status?.settings?.claudeAccounts` entry (SessionsTab.kt:316-320). The mirror's settings block carries only `{id, dir}` (agent-status-mirror.ts:184 `claudeAccounts?: { id: string; dir: string }[]`). The same snapshot does carry each account's `label`/`email` in `usage.accounts` (buildMirrorUsage, agent-status-mirror.ts:299-321; parsed into UsageAccount), but the picker never looks there.

**Proposed fix**

Resolve display names from `snapshot.status?.usage?.accounts` (label, else email) by accountId, falling back to the id. Longer term, add label/email to MirrorSettings.claudeAccounts.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> The finding is correct. Two refinements:
> 
> 1. **Line numbers.** The rows are built at SessionsTab.kt:316 and the `Text(id ?: "System account")` call is at line 319; the source list is set at line 292.
> 
> 2. **The fix only works on the desktop.** Only the desktop shell calls setMirrorUsageProvider (src/main/index.ts:3890). src/server/index.ts has no buildMirrorUsage/setMirrorUsageProvider call, so a Server Edition host publishes settings.claudeAccounts but no usage block. Usage can also be empty before the first poll. Looking the name up in `usage.accounts` (label, else email, else id) therefore only helps desktop hosts once usage has loaded.
> 
>    The durable fix is an additive `label` (and optionally `email`) field on MirrorSettings.claudeAccounts. It should be written by both producers (src/main/index.ts:2112 and src/server/index.ts:460, which already have `a.label` from settings) and parsed into ManagedAccount on Android. Old readers ignore unknown fields.

## A76

**Over direct SSH, opening a Sleeping (Eco-hibernated) session lands on a bare shell with no wake or resume offer**

- Severity: **low**; claimed by auditor: low; effort: small; area: critic; kind: gap
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/TerminalController.kt:247`

**Evidence**

Eco exits the CLI and leaves a shell in the pane. Over the relay, attaching wakes it: host-service calls `remoteViewer.attached`, which fires `agent:wake` (index.ts:3986-3989). Over SSH nothing tells the desktop about the attach. SshHostConnection.wake is `relayOnly(...)` (SshHostConnection.kt:251), and SessionsTab hides 'Wake' unless `capabilities.nodeActions` (SessionsTab.kt:150-156). The phone's own resume offer fires only when `s.fresh` (TerminalController.kt:247), and a hibernated session is not fresh. The app knows both `hibernated` and the sessionId (Launch.resumeCommand) but offers nothing.

**Proposed fix**

Show the same resume banner when `snapshot.statusOf(nodeId)?.hibernated == true` on an SSH attach, reusing Launch.resumeCommand with the node's cwd and account. Or route the wake through the relay when a relay leg exists.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> Two details are overstated or wrong.
> 
> 1. **"No in-app way" is too strong.** Settings has a route choice, "Only through the relay" (SettingsScreen.kt:104, `RoutePreference.RELAY_ONLY`). If remote access is set up, switching to it makes the next attach go over the relay, and that attach wakes the node. The user can also type the resume line by hand. The real gap is narrower: in the default AUTO route on the LAN, the app shows nothing for a Sleeping session.
> 
> 2. **The proposed fix's signature is wrong.** `Launch.resumeCommand(agent, sessionId)` (Agents.kt:31) takes no cwd or account. None are needed either: the hibernated pane already sits in the node's cwd, and its tmux session env already carries the account's CLAUDE_CONFIG_DIR / CODEX_HOME.
> 
> The simplest fix is to widen the condition at TerminalController.kt:247 from `if (s.fresh)` to `if (s.fresh || status?.hibernated == true)`, and word the banner as "Wake <agent>".
> - It stays an offer the user accepts, never typed unasked, matching the existing rule.
> - The desktop's `hibernated` flag clears itself on the resumed CLI's SessionStart / live hook states, so a resume started from the phone leaves the desktop consistent.
> - One weaker spot: the desktop's wake checks that a shell owns the pane before typing, and uses KILL_LINE. This banner does neither, but the user can see the pane before tapping.

## A77

**IME insets are not handled for Android 15's enforced edge-to-edge (targetSdk 35): the terminal gets double bottom padding when the keyboard opens, and other screens have no IME padding at all**

- Severity: **low**; claimed by auditor: low; effort: small; area: critic; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/TerminalScreen.kt:77`

**Evidence**

targetSdk = 35 (app/build.gradle.kts), so edge-to-edge is enforced on Android 15+. `android:statusBarColor` in themes.xml is ignored and adjustResize no longer resizes the window. TerminalScreen applies `Modifier.padding(padding).imePadding()` (line 77) without `consumeWindowInsets(padding)`. Material3 Scaffold only observes consumed insets and does not consume them for content: the material3 1.8.2 bytecode shows `onConsumedWindowInsetsChanged` and `exclude`, but no `consumeWindowInsets`. The bottom inset is therefore navigation bar plus IME height, and the IME inset already includes the navigation bar. PairScreen's paste field and SettingsScreen's 'Relay API' field, at the bottom of a scrolling Column, have no imePadding at all.

**Proposed fix**

Use `Modifier.padding(padding).consumeWindowInsets(padding).imePadding()` in TerminalScreen, and add `imePadding()` to the scrolling columns in PairScreen and SettingsScreen. Call `enableEdgeToEdge()` so behaviour is the same on API < 35.

**Verifier corrections and refinements** (these take precedence over the proposed fix where they disagree)

> 1. **Scope is Android 15+ (API 35) devices only, not "all devices with targetSdk 35".**
>    - On API 26-34 the decor still fits system windows because the app never enables edge-to-edge.
>    - There the root layout consumes the system-bar and IME insets, so Compose's `WindowInsets` read 0. Scaffold's padding and `imePadding()` are both no-ops, and `adjustResize` really resizes the window.
>    - So TerminalScreen, Pair and Settings behave correctly there.
> 
> 2. **`enableEdgeToEdge()` is optional consistency, not part of the fix.**
>    - The needed change is `consumeWindowInsets(padding)` before `imePadding()` at `TerminalScreen.kt:77`, plus `imePadding()` on the scrolling Columns at `PairScreen.kt:92` and `SettingsScreen.kt:69`.
>    - Adding `enableEdgeToEdge()` would move API 26-34 onto the inset path as well, so every screen would then depend on its inset handling.
> 
> 3. **The PairScreen claim is narrower than stated.**
>    - The paste field (`PairScreen.kt:109-114`) sits fairly high on the screen: after two text lines and a button, and it is 120dp tall. On a typical portrait phone it usually stays above the keyboard.
>    - What is more likely covered is the "Use this code" button beneath it (line 115), and the field itself in landscape or on short screens.
>    - The Settings "Relay API" field is the stronger case.
> 
> 4. **Version note.** The bytecode cited (material3 1.8.2) is the JetBrains desktop stub. The Android build uses material3 from BOM 2025.06.00 (1.3.x), which has the same Scaffold inset logic.


## A78

**Desktop quick-answer false success (continuation, 2026-10-02).**

Re-read at cached branch tip `6afd8f53`: `PtyManager.backgroundWrite` sent live answers through
its painter and released answers through a name-targeted control command. Neither cancelled copy
mode; a missing name could match a longer session name. Multi-step delivery also needs to preserve
write order and pin the resolved pane across awaits.

The local fix resolves `=session:` to a numeric pane ID once, cancels copy mode there and sends hex
bytes to that same pane. Complete calls queue per node, including live and released paths; another
node remains independent. Unconfirmed channels are retired without retrying keys. Regression tests
judge delivered bytes, prefix collisions, active-pane changes, cancellation failure and concurrent
write order. Real-tmux cases are added but cannot run in this socket-restricted sandbox.

## A79

**Direct-SSH quick-answer false success (continuation, 2026-10-02).**

`SshScripts.sendKeys` used an exact session target but did not leave copy mode, so tmux could return
zero while the application received nothing. `SshHostConnection.sendKeys` also accepted a missing
SSH exit status as success.

The local fix resolves and validates the pane ID, cancels copy mode and types into that ID, and
requires exit status zero. Lookup/cancel/send failures propagate. Three generated-shell regression
tests pass under a cached compiler; four shell mutations and the null-as-success mutation are
caught. Full protocol, MINA, real tmux and device execution remain pending.

## A80

**Control-mode startup reply consumes a queued command (continuation, 2026-10-02).**

`ControlModeClient.start` launches `attach-session`, which has its own control reply block. The
client previously queued only stdin commands and shifted that queue for every reply. When a pane
probe was queued immediately after start, the empty startup reply resolved it; its actual reply
then belonged to the next command. A socket-free reproduction against the real client confirmed
this mismatch.

The local fix reserves and consumes the startup reply before resolving stdin commands, and retires
the client if attach fails. Behavioral regressions feed the initial reply after a command is
already queued and verify that only the command's own reply resolves it. Test children now emit the
startup block too. Full real-tmux and device verification remain pending.

## A81

**Relay HTTP token requests can stall indefinitely (continuation, 2026-10-02).**

`RelayApi` shared the long-lived WebSocket client, whose read timeout is deliberately zero, with
join/device HTTP calls. A server accepting a connection but stalling its headers or body could
leave the app connecting indefinitely. Blocking `execute` inside `withContext(IO)` did not cancel
the call when the coroutine was cancelled.

The local fix gives HTTP its own finite I/O limits and a 30-second total deadline, applies that
deadline even to an injected client, and keeps coroutine cancellation bound to `Call.cancel` until
the response body is closed. A coroutine deadline also covers OkHttp dispatcher queueing while
preserving an outer caller's cancellation. WebSocket reads and wire shapes are unchanged. Six regression methods
run real OkHttp over in-memory sockets, covering both endpoints, stalled headers/body, trickling
body, cancellation, dispatcher queueing, caller deadlines and successful wire shapes. Three initial
and three follow-up mutation checks are caught. Required Gradle, live
backend, roaming and device verification remain pending.

## A82

**Shared read-ack files are stolen by other desktops (continuation, 2026-10-02).**

The local sweeper read and deleted every `.seen` file under `~/.nodeterm/acks` before establishing
ownership. The remote shell did the same glob for a shared SSH host. Whichever desktop swept first
could consume another desktop's acknowledgment, leaving its unread badge/card intact forever.

Local consumption now requires positive mirror ownership, including an unresolved own inbox card
whose old node entry expired after restart. Unknown files remain unread and untouched; retained
files bypass the directory-mtime cache because ownership can appear without another phone write.
The remote manager forms the union of every connected project's nodes per host and sends validated
IDs on stdin; the shell reads/deletes only that allowlist, and its output is checked against it.
Regression tests cover two owners, late ownership, expired-node inbox cards, multiple projects on
one host and refusal of unexpected output. Android interop uses the actual `SshScripts.ackRead`
producer against the desktop's real local/remote consumers. File names/content stay compatible with
iOS; @eneskirca should validate multi-desktop behavior. Full checks and device execution remain open.

## A83

**Release R8 cannot parse Kotlin 2.2 metadata (local build, 2026-10-02).**

The first actual local `:app:assembleRelease` completed under AGP 8.9.1, Kotlin 2.2.0, wrapper
Gradle 8.14.3 and JDK 21, but emitted many R8 Kotlin-metadata parsing warnings. A successful task
therefore did not establish that the shrinker supported the metadata in its inputs. The APK was
not accepted as the final beta.

The configuration fix in `fa71cb08` changes only AGP to 8.10.1 in `android/build.gradle.kts`;
Kotlin 2.2.0, Gradle 8.14.3 and JDK 21 remain unchanged. `GradleCiCoverageTest` now guards the
Kotlin/AGP/R8 compatibility boundary and AGP's Gradle minimum. Eight bounded guard tests pass and
two mutations are caught. These checks establish the version policy, not an app build.

The corrected actual release and final offline `:app:assembleRelease` succeeded; the metadata
warnings are gone, and every R8 runtime keep passed. That APK was privately signed, verified,
installed and cold-started on an MI8 (Android 15 / API 35), then removed when it was identified as
the wrong phone. Its newly authorized SSH key was removed; no host was paired or SSH connection
attempted. The same beta is subsequently installed on the intended Pixel with basic manual SSH
proof, and its corrected code-3 update verifies `A85` sizing/pre-attach tmux history. These results
establish the build fix; the full phone pass stays open under `A50`.
The test-only `A84` fix passed all 606 protocol tests. The compatibility sources are linked from the guard:
[Android Kotlin support](https://developer.android.com/build/kotlin-support) and
[AGP 8.10 release notes](https://developer.android.com/build/releases/agp-8-10-0-release-notes).

## A84

**Real SSH tests inherit host login hooks and share interactive Readline state (local verification, 2026-10-02).**

- Severity: **low**; effort: small; area: tests; kind: bug
- Location: `android/protocol/src/test/kotlin/dev/nodeterm/protocol/SshTransportTest.kt`

The first restored-host full protocol run executed 605 tests: 603 passed, two real-SSH tests
failed, and none were skipped. Both failures are confirmed harness isolation faults. The literal
leading-dash test types `-R; echo sk_$((2+3))` into a login Bash pane; Fedora's PackageKit
`command_not_found_handle` delays that command beyond the assertion deadline. The earlier test
which refuses a missing SSH exit status still delivers its lone Escape byte into the shared pane.
Readline keeps that state for the next test and turns its `echo` into `cho`.

The test-only fix in `1d6b04cc` starts a fresh primary pane for each test with a non-login shell and
isolates its initialization environment. It retains real SSH/tmux execution and the literal
leading-dash and missing-exit-status assertions. Both isolation mutations were caught, the fixed
source was restored, and the final full rerun passed all 606 tests with zero failures, errors or
skips. This was not an observed phone/APK failure; production app source and the `fa71cb08` APK
build are unchanged.

## A85

**WebView WRAP_CONTENT layout parameters collapse the terminal's CSS viewport to one row (device verification, 2026-10-02).**

- Severity: **medium**; effort: small; area: terminal; kind: bug
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/TerminalController.kt`, `createWebView`

On the intended Pixel 10 Pro (Android 17 / API 37, Vanadium WebView `154.0.8037.92.0`), private beta
`0.1.0-beta.1` / code `2` opens a large native terminal view but advertises 52/56 columns by one
row, despite native bounds `[0,396][1280,2448]`. The one-row height persists after a font change.
Manual SSH authentication, real project
listing and a harmless command in a controlled temporary test tmux window work; swipe does not
enter copy mode or expose old history in this one-row state.

The WebView lacked explicit layout parameters, so AndroidView supplied `WRAP_CONTENT`.
[Chromium's AwLayoutSizer](https://chromium.googlesource.com/chromium/src/+/HEAD/android_webview/java/src/org/chromium/android_webview/AwLayoutSizer.java)
sets forced zero layout height from that height policy. Large measured native bounds therefore
do not establish a nonzero CSS viewport, and FitAddon clamps terminal rows to one.

The minimal fix in `febe022a` sets both layout dimensions to `MATCH_PARENT` before loading the
terminal page; CSS and JavaScript are unchanged. The real Gradle `TerminalWebViewLayoutTest`
wiring guard passes, and the height-`WRAP_CONTENT` and removed-assignment mutations are caught in a
temporary source mirror. Actual retained-signer beta `0.1.0-beta.2` / code `3` from
`febe022ad2fc373f27ac11d9ad5f130f36f027a5` passed its offline AGP build (45 seconds), signature,
alignment/provenance verification and in-place update. Its host configuration, SSH key/pin and
notification grant survived. The controlled terminal now fills 52×45, and a downward swipe enters
tmux copy mode at position 82. A screenshot visibly shows the pre-attach ready/sentinel and marker
rows 001–039 from 120 rows printed before update/attach. History is restored by the native layout
fix; no production SSH-scroll change was needed. A− restores font 13 and 56×48, the soft keyboard
changes it to 56×25, and hiding the keyboard restores 56×48. Esc leaves copy mode; a second
harmless draft command executes with its whole output line visible. The owned temporary test
window alone was removed, with the previous window/process intact and intended-phone app/key/config
retained.

**User-reported mobile check:** with WireGuard enabled and Wi-Fi off, the user confirmed that the
intended Linux host's terminal opens over mobile data. This is separate from the ADB-assisted LAN
checks above. Mobile reconnect, approvals/questions, background behavior and the full 64-item
checklist remain open.

History regressions in `d6619bf6` pass 47 focused real Gradle SSH/terminal/link tests with zero skips. Both JavaScript swipe-direction/disabled-scroll mutations, the real-SSH wheel-direction mutation and the two native layout-policy mutations were caught; production sources were restored. **Final verification:** all 609 protocol tests passed in 59 suites with zero failures, errors or skips (52 seconds); the offline app `compileKotlin` passed (7 seconds).

Checklist items 20 and 23
cover history and viewport sizing without adding or removing any of the 64 items.

## A86

**Scroll responsiveness is poor despite reachable tmux history (post-beta investigation, 2026-10-02).**

- Severity: **medium**; effort: medium; area: performance; kind: gap
- Locations: `android/app/src/main/assets/terminal/terminal.js` touch handlers,
  `TerminalController.Bridge.onScroll`, `SshHostConnection.SshStream.scroll`

The user reports slow scrolling on both Wi-Fi and mobile-data VPN after the signed-beta checkpoint
`cf0487a3`, so a VPN-only cause is not supported. History is reachable; the issue is responsiveness
and gesture behavior. The initial investigation changed no source, installed APK or phone setting.

In a bounded private MINA/SSH/tmux fixture at 52×45, 240 wheel notches over two seconds move 1195
history rows: the first notch enters copy mode and later notches move five rows each. Production
JavaScript at checkpoint `cf0487a3` emits a notch per roughly 18.2 CSS pixels at font 13 and has no fling. This amplifies
drag distance into coarse steps. A single 700-CSS-pixel movement requests 38 notches, but SSH clamps
the call to 20, losing distance.

The fixture's connected socket has TCP_NODELAY disabled. At 30/60 Hz, its output-tail measurement
is about 40.8 ms with that setting versus 1.2–1.4 ms enabled; at 120 Hz both remain around 41 ms.
Writer-queue tails stay below 0.5 ms, so this controlled loopback run shows no host writer backlog.
These results do not establish TCP_NODELAY as the sole cause. Android uses xterm's DOM renderer,
while desktop defaults to WebGL.

The actual 194452-byte, two-second SSH capture was replayed through bundled xterm's DOM renderer
in Electron 42 / Chrome 148 under Xvfb, at 426×684 CSS pixels and DPR 1. Normal `renderRows` mean
was 0.14 ms, p95 at most 0.3 ms; with JIT-less mode requested, mean was 1.5 ms and p95 at most
1.9 ms. Pending writes peaked at one and 1622 bytes, with no final backlog, unrendered output or
long tasks and a stable 60 Hz animation-frame cadence. This excludes base64/DOM queue backlog as
the primary cause at this bounded desktop load; it does not establish Pixel performance.

**Implemented mitigations (2026-10-02).** `e6bdb157` enables TCP_NODELAY on the connected SSH
socket. `245b42e6` measures row height once per gesture and accounts for stock tmux's five rows per
wheel notch, batches same-direction movement by animation frame and preserves fast-swipe distance
in ordered calls of at most 20 notches. `2c5d15a8` adds one bounded serial `TerminalActions` drain
per accepted stream; suspended relay RPCs cannot reorder reversals or input. Input cancels unsent
scrolls and follows the in-flight call; retiring the viewer clears/cancels the queue. Native raw
chips and resume writes cancel page scrolling first, and callbacks remain bound to their accepted
stream. `40c4ee49` also cancels scrolling immediately before the delayed paste Enter. No host verb,
payload or SSH-visible file contract changed; this fix needs no iOS payload/interop fixture change.

The full restored-source protocol suite passed **638 tests in 61 suites**, with zero failures,
errors or skips (51 seconds); the final offline app `compileKotlin` passed (7 seconds). **30 mutations** were
caught: two SSH socket-policy, fourteen JavaScript gesture/input and fourteen actor/native-wiring
mutations. Private beta `0.1.0-beta.3` / code `4` from
`40c4ee49592e2f92fc7e6e9b548ba88a33b1e2d3` built locally in 49 seconds, passed every R8 keep
and retained-signer packaging; signature, source/hash provenance and alignment were verified, with
all 149 ZIP payloads unchanged by signing. Its in-place update on the intended Pixel succeeded,
preserving manual SSH registration/key/pin and notification permission. Push is
user-authorized and each requested push requires green Android workflow verification; no PR is
requested and `A68` remains deferred.

**Controlled Pixel proof.** The updated app reopens the intended Linux host over SSH and the owned
test terminal fills 56×48. Five identical downward swipes of 1000 native pixels over 350 ms produced
history positions 25, 40, 55, 70, 85 on beta 2, versus 5, 10, 15, 20, 25 on beta 3. Reversal moved
25 to 20; the actual Esc chip left copy mode (`pane_in_mode=0`). A screenshot records the controlled
test history. The phone returned to Sessions and refreshed; only the owned test session was removed,
with user panes untouched. These establish reduced drag gain, reversal and input cancellation, not smoother
rendering. Isolated `gfxinfo` samples contained only 11/12 frames and 5/6 janky frames respectively;
they establish no FPS improvement and are not a WebView renderer trace.

**Superseding user failure and next correction.** The user reports that beta 3 still has both lag
and too little movement on Wi-Fi and mobile-data VPN. Its controlled mechanical results above do
not establish satisfactory responsiveness. `A87` fixes report-triggered cancellation and restores
one measured row per notch, keeping frame batching, lossless ordered chunks, lifecycle barriers and
TCP_NODELAY. All 646 protocol tests in 62 suites pass with zero failures/errors/skips, and offline
app `compileKotlin` passes (8 seconds); 22 JavaScript and nine actor/native-wiring mutations are caught.
Code-5 beta built/signed and updated in place; user feel remained open at that checkpoint.
The beta-6 verification below now resolves the primary drag/coast complaint.

**Controlled beta-3 phone trace.** Twelve alternating gestures in an owned 56×48 dummy-history
terminal produce one JavaBridge invocation per gesture, 24 RAF callback collections and 11 distinct
presented pipelines. First invocation is 84–90 ms after touchstart; first presentation 170–196 ms is
correlation without an input→SSH→render flow. Presented Chromium scroll events measure 36–56 ms;
>1-second aggregate EventLatency mainly counts no-paint termination. No named JS/native methods or
scheduler/V8 measurements exist, and some newer extension fields are unparsed. Sparse FrameTimeline
and non-damaging ScrollJank events establish no terminal FPS/jank rate or renderer cause. These
measurements support comparing delivered updates after the correction, not blaming JIT or claiming
a one-second paint. No RTT emulation has run.

The matching beta-4 trace records 42 bridge invocations versus 12, 26 content commits versus 12,
and 25 distinct presentations versus 11 over twelve gestures. First invocations occur at 25–36 ms
versus 84–90 ms; this supports more frequent delivered updates, without establishing terminal FPS
or end-to-end SSH latency. Both traces and queries are retained in the private beta-4 evidence.

**Beta-4 user feedback and bounded fling correction.** The user reports that beta 4 moves more
lines but lacks momentum after finger lift. `1ad2e944` adds a velocity fling sampled over 120 ms,
released within 80 ms of recent movement at 0.45–3 CSS pixels/ms. Exponential decay uses a
240-ms constant, stops at 0.06 pixels/ms, and has hard 1000-ms/1200-pixel caps. Existing calls
carry at most 20 notches; frame gaps over 250 ms stop movement. `53462f96` adds `onScrollStop`
for new touch/input/reset/font/lifecycle barriers without typing into the pane. Queued keys/replies
and the in-flight operation survive; bytes already handed to SSH's writer/network cannot be recalled.
Automatic xterm reports preserve coast. No host/payload/SSH-file contract or iOS fixture changed.

All 658 protocol tests in 63 suites pass with zero failures/errors/skips (59 seconds), plus offline
app `compileKotlin` (10 seconds). Thirty-five JS and eleven new native mutations were caught;
seven strengthened kinetic tests and real bundled-xterm coast/report behavior pass. Private
`0.1.0-beta.5` / code `6` uses source `1ad2e94455a7adfb85d41212b12d36df39695324`; actual AGP
release built in 47 seconds and passed every R8 keep. Retained-signer packaging verifies metadata,
signature, 16-KB alignment and source/hash provenance. APK SHA-256:
`7cc68d384aeb21ab40800fa7c83f006dfbfefba16dd2e945967c8c5376f17655`.
It updated the intended Pixel in place with code-6/non-debuggable metadata and notification
permission confirmed. The user still reports continuous swiping stops and requires lifting; the
controlled test shows no coast after command completion. `A89` records the detached target cause
and stable-screen fix. Beta-6 build/sign/update and SSH reopening with retained key/pin pass.
Controlled Pixel continuous dragging, post-command coast and Esc stopping now pass; a held
touch also stops coast at a stable 56×25 viewport (see `A89`).

The user confirms normal continuous dragging and coast “Both work now”, resolving the primary
complaint. Separately, the user's final beta-6 cellular WireGuard SSH check confirms connection
and smooth scrolling.
**Still open:** reversal/lifecycle, custom wheel bindings and FPS.
Earlier new-touch checks opened the IME and resized tmux, so those results were inconclusive.
Custom tmux wheel bindings and FPS remain open. Existing checklist item 20 covers these checks;
the checklist remains 64 items.

**Native custom-wheel follow-up (2026-10-06).** A new `SshTransportTest` method runs the actual
`SshHostConnection` and `TerminalActions` against private native tmux over SSH. Emacs copy-mode
uses up/down row gains 3/2, vi uses 7/4. Staged requests exceeding the 20-notch transport limit
reach all expected positions; queued up37/down73/up29 returns through the live bottom and exposes
FIFO reordering. All eight positions settle for 300 ms and original bindings/options are restored.
Native control/restored runs pass; reversed direction, dropped wheel write and host clamp20→1
each fail the exact emacs up37 distance assertion (111 expected, 0/0/6 observed).
The first test-setup cancellation failure is preserved separately and earns no mutation credit.
See [the native receipt](android.md#native-custom-wheel-checks-2026-10-06). No production behavior,
APK or wire/file contract changes; the phone/FPS/lifecycle matrix and original device ledger remain open.

## A87

**Automatic xterm reports cancel a swipe and discard queued movement (2026-10-02).**

- Severity: **medium**; effort: medium; area: runtime; kind: bug
- Locations: `android/app/src/main/assets/terminal/terminal.js` input handlers,
  `TerminalController.Bridge`, `android/protocol/src/main/kotlin/dev/nodeterm/protocol/host/TerminalActions.kt`

The installed beta-3 page treats every xterm `onData` event as user input. xterm also emits focus,
mouse and terminal-query replies on that event. `cancelScroll()` clears the page queue and the
active touch position; native `TerminalActions.write()` drops unsent movement. A report during a
gesture therefore stops its subsequent moves, despite no user key or paste. The pinned xterm 5.5
CoreService marks keyboard/paste/IME input before `onData`, but also marks SGR mouse reports as
user input; using that flag alone still misclassifies mouse reports.

**Fix:** `3cffb49d` consumes the pinned input-origin event once, excludes full SGR mouse reports,
and routes automatic `onData` and legacy `onBinary` replies through `Bridge.onReport`. The bridge
captures its accepted stream and checks the page generation. `TerminalActions.report()` uses the
same bounded FIFO and serial drain while preserving pending scroll distance/direction; ordinary
user `write()` retains its cancellation barrier. Report errors do not retry or discard following
movement. Keys, paste and IME input still cancel scrolling. Gesture gain returns to one measured
text row per wheel notch; ordered frame batching, lossless 20-notch chunks, lifecycle retirement,
SSH TCP_NODELAY and delayed-Enter cancellation remain.

Real bundled xterm/Fit/page regressions exercise touch, focus, SGR/legacy mouse, query replies,
keyboard, paste and IME. Actor regressions cover reports between suspended chunks/reversals,
user-input barriers, shared bounds and non-retryable report errors; source pins verify generation,
stream identity, snapshot ordering, JavascriptInterface and no Ctrl transformation. All 646 protocol
tests in 62 suites pass with zero failures, errors or skips; offline app `compileKotlin` passes (8 seconds).
Twenty-two JS and nine actor/native-wiring mutations were caught. This proves the routing/queue
policy, not corrected phone feel; beta-4 delivery and controlled movement pass below. At that
checkpoint user follow-up remained open; the later beta-6 drag/coast confirmation is under `A89`.

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
These verify delivered movement/order/cancellation, not terminal FPS or satisfactory user feel;
at that checkpoint corrected-beta user follow-up remained open under `A86`; beta 6 now has
normal drag/coast confirmation.

**Residual:** a direct xterm/browser unbracketed user paste whose entire content exactly matches
an SGR mouse report can still take the automatic-report path. The native draft submission now
cancels JS/native scrolling before paste (`53462f96`/`1ad2e944`). Recheck this edge if the input-origin adapter changes.
No host verb, payload, mirror or SSH-visible file contract changed, so iOS owes no payload fixture
update for this fix. Revalidate the pinned internal xterm input-origin adapter on a bundle upgrade.

## A88

**New SDK signer labels reject a correctly signed private-beta artifact (2026-10-02).**

- Severity: **medium**; effort: small; area: tooling; kind: bug
- Locations: `android/tools/package-beta.py` `verified_signer`/signing command,
  `test_beta_signer.py`, `test_package_beta.py`, `test_beta_sdk.py`

The original verifier assumes one `Signer #1 certificate SHA-256 digest` line. `fed68fb3`
added strict SDK-range labels and explicit v2 signing, with 32 local tests and ten mutations.
CI run `37058184031` at `9ced6781` still failed five of 32 private-packaging tests at the same
signer/v2 gate; protocol, debug, release and CodeQL passed. The runner image includes SDK 37,
and the old fixture chose its highest lexical tools/platform instead of the installed SDK 36/35.
The raw CI verifier report was not captured. A local reproduction with official SDK 37 now
confirms a real format discrepancy: verification exits 0, v2 is true and there is one signer,
but its certificate label is `V3.0 Signer:`. The earlier range-only hypothesis did not cover it.

**SDK-37 follow-up (`f5fd3821`):** accept exact `V2 Signer:`/`V3.0 Signer:` single labels with a required
`Number of signers: 1`, and exact V3.0/V3.1 SDK-range labels with the existing one-certificate,
non-overlapping-range policy. Older indexed/range reports remain supported. Consider every APK
signer certificate line except source stamps; reject duplicate or conflicting certificates and
unknown/V3.2 hybrid classical/PQC identities rather than silently ignoring them. The expected certificate pin and
verified v2 gate are unchanged; signing explicitly enables v2. Fixtures now require the explicitly
installed SDK 36/platform 35, with exact reproduction overrides, and signature-gate failures
include safe verifier diagnostics from a disposable test key/APK only.

All 39 Python tests pass against each real SDK 36/37; six new parser and four fixture-selection
mutants are caught. Removing the single-label support also kills the actual SDK-37 acceptance
fixture. Proof/logs are in `.nodeterm/android-beta-build-4/ci-verification/` (working evidence:
`/tmp/nodeterm-beta4-ci-check/`). Follow-up [run `37061593216`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37061593216)
at `c37798b6495b4b68df379d0ae80887c23104b66d` completed with all five jobs green, confirming
observed CI repair. Each subsequent push still needs its own green workflow. Local reproduction
establishes the SDK-37 bug, not captured output from the original failed job.
No private key, APK, app code or phone setting changed from this tooling correction.


## A89

**Repaint detaches the touched text span and loses continued drag/release events (2026-10-02).**

- Severity: **medium**; effort: small; area: runtime; kind: bug
- Locations: `android/app/src/main/assets/terminal/index.html` terminal CSS,
  xterm DOM renderer row spans, `TerminalJsXtermInteractionTest`

The user reports that beta 5 stops during continuous swiping and only moves again after lifting.
The intended Pixel's controlled gesture updates history 0→15 at 369 ms, 25 at 391 ms and 30 at
412 ms, then remains fixed through 1.4 seconds after the ADB swipe command completes at 561 ms.
That is command completion, not a measured physical touchend timestamp. There is no verified coast.
The real bundled DOM renderer replaces row text spans during a redraw, detaching the element
that received touchstart. Later touchmove/touchend still target that detached span and no longer
bubble to the live page handlers. Tests dispatching events directly on the terminal host missed
this target-lifetime failure.

**Fix (`c4b1f6cf`):** set `.xterm-screen { touch-action: none; }` and
`.xterm-rows, .xterm-rows * { pointer-events: none; }`. Hit testing chooses the stable screen
behind painted text, keeping later move/end events connected across redraws. Existing fling,
ordered 20-notch batching, automatic-report routing and native stop/input/lifecycle barriers remain.

The actual bundled-xterm regression verifies the old span is removed, subsequent events on it
lose the live handler, and computed production CSS instead targets the connected screen so
continued movement and release coast survive a real redraw (24 notches versus one). A real
Electron 42.11.3 / Chromium 148.0.7778.280 probe of the shipped page confirms `elementFromPoint`
hits the stable connected screen across redraws; original CSS hits the detached span. This closes
the jsdom hit-test limitation for desktop Chromium, not actual Pixel touch behavior. All 658
protocol tests in 63 suites pass with zero failures/errors/skips (67 seconds), plus offline app
`compileKotlin` (8 seconds). Three CSS mutations are caught alongside 35 JS and eleven native
mutations. Private `0.1.0-beta.6` / code `7` uses source `c4b1f6cf1009f293a658b6331d2ed1ab80aa36c6`;
actual AGP release built in 43 seconds and passed every R8 keep. Retained-signer packaging verifies
metadata/signature/16-KB alignment/source hashes and preserves all 149 payloads. APK SHA-256:
`4947133a6ccf9c2b1e775e76d7c24f564e087cf036e59eac4dca08162a076d3c`.
The intended Pixel received a same-signer update preserving app data; notification permission
is confirmed. SSH reopened with the retained key/pin at 56×48. A 1000-native-pixel/1200-ms swipe
produced 23 observed positions from 0 to 110 over about 1103 ms (ADB command complete at
1535 ms). A 1000-pixel/200-ms swipe reached 110 at command completion (540.5 ms), then 250 at
1339 ms, about 799 ms later, with 29 observed updates overall. Continuous drag delivery and
post-command coast pass. Esc during coast left copy mode and remained out for 1.4 seconds.
New-touch stopping also passes with the keyboard already open and all sampled viewports at
56×25. After a 500-native-pixel/100-ms swipe, the DOWN command completed 152 ms after the swipe
command; the script then waited 1.2 seconds before issuing CANCEL. The last position change was at 503.6 ms, before DOWN completed at
588.8 ms; final position 100 remained unchanged through CANCEL. Earlier IME-resizing tap/DOWN
checks rebased tmux positions and were inconclusive, not additional failures. Evidence includes
`beta6-stable-viewport-touch-stop.json` and `stable-touch-check.log` in the private beta-6 proof.
Esc and Header Back then returned to Sessions and detached the owned client; only its exact
owned tmux session and phone UI XML were removed. Private evidence, including
`device-summary.json`, is in `.nodeterm/android-beta-build-6/` and `.nodeterm/android-beta-6/`.
No host verb, payload, mirror or SSH-visible file contract changed; no iOS fixture change is owed.
The user confirms normal continuous dragging and coast both work now. Reversal/lifecycle,
custom wheel bindings, FPS and the full device pass remain open. The user confirms final beta-6
connection and smooth scrolling on cellular WireGuard with Wi-Fi off over regular manual SSH;
cellular hosted relay remains untested.


## A90

**Manual SSH/WireGuard host cannot create a new plain terminal without a local desktop/relay (2026-10-03).**

- Severity: **medium**; effort: medium; area: parity; kind: gap
- Status: **implemented and host-verified** in `bcc92367` / `b88d1415`; beta 10/code 11 installed.
  Focused physical plain-SSH and beta 10 relay plain-shell creation/input/exact End pass;
  item 32 stays Partial for managed/cellular variants.
  The separate A91 otherwise-empty-host flow passes on beta 9 Oct4.
- Locations: Android Host screen/new-terminal choice, SSH scripts/connection and host listing

The user can browse and open existing sessions on their Linux host over manual SSH/WireGuard,
but cannot create a new shell. Another desktop drives that host's `nodeterm-rmt` sessions and
project files; the host has no own workspace or relay. `A26`'s canvas New-session flow still
requires `projects.registerNode` on the owning desktop, so it cannot serve this request.

**Implemented design:** explicitly create a plain shell on the separate `nodeterm-phone` socket
in a discovered host folder or Home. Creation marker/session metadata rediscover it under a
synthetic **Phone terminals** group; the shell survives disconnect and End addresses only its
exact owned session. Clear inherited nodeterm identities before starting the shell, and configure
only this socket for the terminal's mouse/history/UTF-8 behavior. Do not modify shared project
files, borrow an existing node's hook token or claim desktop-canvas registration. Desktop and
Server Edition keep scanning/reaping their own `node-terminal` / `nodeterm-rmt` sockets.

The `A08` refusal to create a missing managed/canvas session and existing relay New session stay
intact. No current host RPC, projects blob, pairing payload, mirror or SSH-visible file contract
changes. **iOS follow-up for @eneskirca:** consider the isolated phone socket, explicit creation
marker and session metadata rather than a canvas append for this independent-shell feature.

Atomic ID/resolved-cwd/request/fingerprint session environment allows rediscovery even if creation
stops before option finalization. The parser verifies the request's SHA-256, and actions pin the
validated fingerprint before checking live ownership. Reserved phone UUIDs never attach to either
desktop socket or send a creating relay RPC. Same-ID/folder retries retain a shell after directory
rename. New panes clear inherited managed identities and warm non-UTF-8 overrides; partial attach
restores phone-only settings. Host-owned creation survives dismissal/background, and Main
navigation checks the visible screen/ticket before opening.

**Verification:** the full real protocol suite passes **684 tests / 66 suites**, zero
failures/errors/skips, in 48 seconds; final offline app `compileKotlin` passes in 1 second.
Nine new real SSH/tmux methods, four pure phone-metadata tests and a relay interop refusal cover
creation/folders, quoting/idempotency, interrupted discovery, reconnect/history/End, stale/foreign
ownership, warm environment and reserved socket IDs; helper/wiring regressions cover UI lifecycle.
All **32 new mutants are caught**: eleven actual Gradle/Kotlin 2.2 protocol behavioral variants,
twelve helper behavior variants and nine native wiring variants. These are host/fixture results,
not physical phone results.

Historical `0.1.0-beta.8` / code `9`, clean source `b88d141528c1051964da07faf22cc7fa923c4846`, was
**installed on the intended Pixel, now superseded by beta 9**. The actual offline AGP release builds in 49 seconds; R8 keeps,
retained-signer packaging, 16-KB alignment and source/hash provenance pass. Independent SDK 36/37
tools verify v2/v3 signatures and one retained signer, all 149 unsigned payloads are byte-preserved
with three signing entries added, all four ELF PT_LOAD alignments pass, and R8/service mapping
agrees with the source/version/hash/build inputs. Terminal assets/native libraries are unchanged
from beta 6. APK SHA-256:
`d373ad5c1790f714cb4464ad4a0a38c5ba9ab68e35103e54cf3aef5ce53081ce`.
Private artifact/proof are in `.nodeterm/android-beta-8/` and `.nodeterm/android-beta-build-8/`.

The 28.05-second exact-Pixel same-signer update verifies matching pre/post APK hashes and signer,
code 9/name beta 8/non-debuggable metadata, retained install identity/notification grant and an
existing manual-SSH host row. Receipt: `.nodeterm/android-beta-build-8/device-install-20261003/receipt.json`.
The existing host reconnects over SSH and lists real driven projects; New terminal is visually
present and its FAB is enabled/clickable in own-app UI XML. No existing pane was touched and no
terminal was created or ended. This is installation/reconnect/browse/UI-availability proof, not
Create/cwd/history/reconnect/End or TalkBack proof. Historical beta-6/code-7
device evidence and prepared unused beta 7 / code 8 are preserved; at that installation checkpoint
the ledger remained seven Pass /
20 Partial / 37 Pending. After the hike, pair on current beta 9 then use a later same-signer
higher-code update for item 1, keeping the working app installed. For item 32 use Linux host →
Sessions → New terminal → Home/project/custom absolute folder → Create; verify real cwd/input/history,
disconnect/app-restart rediscovery and exact owned End on the intended Pixel over SSH/WireGuard.
Existing desktop sessions, project files and canvas must remain unchanged. Full relay/managed-agent
creation and the rest of the 64-item matrix remain separate pending requirements.

**Completed focused Pixel proof:** beta 8/code 9 creates Home, discovered-project and custom-folder
shells with verified cwd/input, pre-attach history, drag/coast/Esc, no duplicate from rapid double
Create and visible missing-folder error/corrected retry without an orphan. Force-stop/restart
retains three shell PIDs/history and SSH rediscovery. Beta9/code10 update, reconnect and same-pane
native input pass. Native UI End of custom→project→Home removes exactly each selected UUID,
retains sibling immutable fingerprints/PIDs, changes counts 3→2→1→0 and removes the final Phone
terminals group. Eleven desktop session IDs/pane PIDs and nine protected project/workspace hashes
are unchanged. Owned shells, empty fixture folders and UI dumps are removed; the phone returns
to regular host Sessions. Proof:
`.nodeterm/android-beta-build-8/a90-pixel-check-20261003/final-focused-results.json` and
`beta9-exact-ui-end.json`. Only item 32 is promoted to Partial: current **7 Pass /21 Partial /36 Pending**.
The Oct3 proof does not verify relay canvas/managed or cellular creation or the full checklist.
The separate A91 otherwise-empty-host last-End variant passes on beta 9 Oct4 below. The isolated bare-Esc/paste contamination was a QA input
artifact, and clean native input passed; it did not produce a paste finding.

## A91

**Ending the last phone shell on an otherwise empty SSH host leaves its cached row visible (2026-10-03).**

- Severity: **medium**; effort: small; area: runtime; kind: bug
- Status: **fixed in `4d33a5b5`, delivered in installed beta 9/code 10**.
  The physical otherwise-empty-host flow passes on beta9 Oct4; A94 is delivered in beta 10 with its full focused empty-host flow passed.
- Locations: `android/app/src/main/kotlin/dev/nodeterm/android/conn/ConnectionManager.kt`
  (`HostSession.refreshNow`), `android/protocol/src/main/kotlin/dev/nodeterm/protocol/host/ListingFailure.kt`

When the last phone-owned shell is ended and the SSH host has no workspace, driven sessions or
other phone shells, browse throws `NothingFoundException`. The session has ended, but native
refresh previously kept the last successful snapshot, so Sessions still showed its row. A lost
reply or host refusal cannot prove nodes are gone; blindly clearing every failed listing would
also discard useful cached rows during an outage.

**Fix:** `ListingFailure.snapshot` returns `ProjectsSnapshot.EMPTY` only for the authoritative
`NothingFoundException`; generic host/transport failures retain the previous snapshot, and
cancellation rethrows before replacement. `ConnectionManager` applies the policy while preserving
the route-specific error and existing connection rules. The authoritative empty answer leaves
SSH connected and New terminal available. No current RPC, projects blob, pairing, mirror or
SSH-visible file contract changes.

**Verification:** four `ListingFailureTest` methods use an actual parsed phone listing to verify
last-row removal, generic-error retention, cancellation identity and native error/connection
wiring. Full real Gradle protocol passes **688 tests / 67 suites**, zero failures/errors/skips,
in 52 seconds; offline app `compileKotlin` passes in 6 seconds. All six isolated Kotlin 2.2/JDK 21
mutants are caught, and independent review finds no blocker. Ignored XML/mutation proof is in
`.nodeterm/android-beta-build-9/`.

**Physical otherwise-empty-host pass (2026-10-04):** installed beta 9/code 10 creates and opens
its first Home shell through New terminal. Native End removes the exact row and Phone terminals
group while SSH stays connected. New terminal remains usable and creates/opens a second Home
shell. That second shell was retained for the beta 10 update and subsequently ended in the full
A91/A94 flow below; final fixture/service cleanup is not yet claimed. Proof:
`.nodeterm/android-beta-build-9/checklist-20261004/a91-beta9-focused-results.json` plus UI receipts.
This closes A91's focused empty-host physical variant. Item 32 stays Partial and the ledger stays
At that checkpoint7 Pass /21 Partial /36 Pending because relay/managed and cellular creation remain open;
later paired-update and item 36 Board verification bring the current tally to 10 Pass / 22 Partial / 32 Pending.
A94's separate false Loading label was observed; beta 10 delivers the correction and its full installed End/recreate/open/End completed-empty flow passes.

Private beta `0.1.0-beta.9` / code `10`, clean source
`4d33a5b5366c99479b648086649205350c7752b1`, built in 43 seconds and updated the exact intended
Pixel with the retained signer in 6.46 seconds. Its pulled installed APK matches SHA-256
`719cfeea1dcf27900dd35692a59004ca07e8261b3f14bd43922f0706b6b4ab54`.
Three owned beta-8 shells survived and were rediscovered after updating, then all were ended
through verified exact-session cleanup. Historical source CI run
`37144282865` failed the device-checklist documentation mapping; debug/release APK and CodeQL
passed, private packaging was skipped. Recorded prior all-green branch is `19da35a2`, all five jobs in
run `37140762345`; the next push needs its own checks/green workflow.
This revision adds the A91 item 32 mapping and isolates its Known gaps paragraph, without
weakening the test. The recorded local 688/67 source baseline predates the final documentation;
fresh full protocol/offline app gates follow the frozen docs and exact-head CI proof is retained
separately after the next push.
Independent SDK 36/37 review verifies signature/alignment, all 149 unsigned payloads preserved,
four ELF alignments, expected R8/service metadata and source/hash provenance. The non-debuggable
installation preserves install identity, notification grant and app data; pairing/relay credential
survival is not proved. Receipts: `.nodeterm/android-beta-build-9/artifact-review.json` and
`.nodeterm/android-beta-build-9/device-install-20261003/receipt.json`; private APK:
`.nodeterm/android-beta-9/nodeterm-android-0.1.0-beta.9.apk`.

## A92

**Desktop/Server link lookup can exclude the hovered row after a long wrapped run (2026-10-04).**

- Severity: **low**; effort: small; area: desktop renderer; kind: bug
- Status: **fixed in `127b6b28`; native Linux Desktop UI verified at `01b4a2f5` with A121's leave
fix**. Separate Linux Server checks pass at `dcdf664a`. The later GPU-enabled eight-case matrix
passes (Canvas4 hardware / Modal4 DOM); Those earlier runs did not verify GPU recovery; later individual pilots are recorded in the final
follow-up. macOS remains unverified.
- Locations: `src/renderer/terminal/file-links.ts` (`paragraphContaining`) and `file-links.test.ts`

This was the desktop follow-up recorded while fixing Android `A32`. The exported helper walks up
as many as 32 continuing rows, then joins at most 32 rows downward. Hovering row 32 or later in
a full-width run can therefore return a paragraph ending before the requested row. URL lookup
on a tail row can offer only `https://x` instead of the complete `https://x.io/a`.

**Fix:** reserve the requested row by limiting the upward walk to `MAX_JOIN_ROWS - 1`, retaining
the 32-row total budget. This affects the shared Desktop/Server renderer only. Android's
`terminal.js` already has the corresponding `A32` fix; no Android APK change, host-service verb,
projects blob, pairing payload, mirror or SSH-visible file change is involved, and no iOS
adoption is owed.

**Verification:** the 24-test focused Vitest file passes, including exhaustive containment/text
checks for every row in 80-row hard/soft wrapped runs and actual URL-provider range/activation on
a tail row beyond the cap. All 54 tests across the three affected link/dialect files and the full
`npm run typecheck` pass. Three isolated production-copy mutants are caught: restore the old
upward bound, expand the total budget, or omit the hovered tail from the downward window.
Control and restored copies pass. Private evidence: `/tmp/nodeterm-file-link-fix-verify/results.json`
and per-variant logs. No active source was changed for mutation runs; desktop `out/` remains the
previous `071735d6` build while the isolated production pairing fixture runs. Android's installed
beta 9 and the 7 Pass / 21 Partial / 36 Pending ledger are unchanged; no new phone results are claimed.

## A93

**Fresh-desktop remote-on pairing succeeds without relay credentials (2026-10-04).**

- Severity: **medium**; effort: medium; area: pairing/hosted relay; kind: interop/backend
- Status: **open**. A backend refusal is confirmed; its recovery policy and a repair are unverified.
- Locations: src/main/pairing-service.ts (mintRelayDevice and the direct-SSH pairing branch),
  android/app/src/main/kotlin/dev/nodeterm/android/ui/PairScreen.kt (previous token lookup),
  and the external hosted /v1/relay/device endpoint.

**Observed:** the intended Pixel, still on private beta 9/code 10, accepted genuine pairing JSON
from a fresh isolated production desktop with remote access on. Local pairing succeeded, but
the saved host received no relay credential. A bounded retry using the same request body as production
mint returned HTTP 403 with error reauth_required. No backend repository was read or changed.

**Relevant state:** the previous owned fixture had been forgotten on the phone, removing its
saved relay token while preserving the global phone identity. The fresh desktop has a different
device/host-key identity. Android looks for a prior token by the pairing's host key; production
desktop code forwards it when supplied, and carries its own normal device id. These facts
suggest a backend re-registration/C2 constraint, but do not establish the backend's exact rule.

For a direct-SSH desktop, production pairing deliberately retains its working SSH registration
when relay mint fails. That explains local success; it does not establish working “from anywhere”
access or complete checklist items 8/12/17. Historical beta-6 hosted-relay proof remains valid.
No phone identity reset, individual desktop identity/token copying or user-secret import was
performed. Ordinary restart/re-pairing of the complete original owned fixture profile now
succeeds, preserving host/device identity and issuing actual relay credentials on beta 9.
After the retained-signer code10→11 update, beta 10 reconnects through the saved relay pairing,
opens the owned terminal and sends input to its real scoped PTY. An anchored SSH refusal warning
remains before AUTO relay fallback; this does not claim OnlyRelay preference survival. This verifies one legitimate
same-desktop recovery case, not the backend's full C2 policy or fresh-different-desktop repair.
**iOS implication for @eneskirca:** check prior-token lookup and recovery messaging when Forget
removes a relay token but persistent phone identity remains. No new external field/fixture
change is introduced by this finding.
New private evidence belongs in .nodeterm/android-beta-build-9/checklist-20261004/.
Item 1 paired-update and item 36 rebuilt-Board verification pass; item 35 stays Partial, giving current 10 Pass / 22 Partial / 32 Pending.

## A94

**Completed empty SSH listings still show “Loading sessions…” (2026-10-04).**

- Severity: **medium**; effort: small; area: native Sessions state; kind: runtime bug
- Status: **fixed in 3c217cba; delivered in beta10/code11**. Five actual Kotlin regression
  methods/eight isolated mutants and full Gradle 689/67 zero failures/errors/skips pass;
  the full installed End/recreate/open/End completed-empty flow passes.
- Locations: android/protocol/src/main/kotlin/dev/nodeterm/protocol/host/ListingFailure.kt,
  ListingFailureTest.kt and android/app/src/main/kotlin/dev/nodeterm/android/ui/SessionsTab.kt.

**Physical failure:** the intended Pixel's beta 9 finishes listing the otherwise-empty private
OpenSSH fixture and shows the completed error banner, Over SSH and an available New terminal.
Its Sessions content nevertheless keeps “Loading sessions…”. Private before-fix proof:
.nodeterm/android-beta-build-9/checklist-20261004/a91-initial-empty.json and .png.

A91 correctly replaces stale rows after NothingFoundException, but used ProjectsSnapshot.EMPTY
with fetchedAt=0, the marker for a first listing still pending. SessionsTab chooses its loading
label from that timestamp. The fix stamps this authoritative empty answer with its completion
time, retaining cancellation and the prior uncertain-failure cache/route/error behavior.
No external host-service, pairing, mirror or SSH-file contract changed; no iOS adoption is owed.
The clean e3ce041c snapshot builds private beta10/code11 in 52.4 seconds; R8 keeps and independent
SDK36/37 artifact review pass. The retained-signer update is installed on the intended Pixel,
with matching SHA-256 04ace0ea01540bb477fcf823395a299fa211cfef3745aa28674099038ceb3693,
install identity/notification grant and the owned SSH pane preserved. Full protocol passes 689
tests/67 suites with zero failures/errors/skips (86.08 seconds wall time including a new daemon),
offline app compile passes in 6.78 seconds. The exact built source `e3ce041c` has all five CI jobs green in [run `37194375778`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37194375778). Each later documentation push needs its own green workflow. The installed full End/recreate/open/End completed-empty flow passes.
Beta9 A91 last-End/recreate proof remains separate. No item 32 promotion follows.
Item 1 paired-update and item 36 Board verification pass, giving 10 Pass / 22 Partial / 32 Pending.

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


## A95

**Phone Board move and label persist but the mounted desktop Board remains stale (2026-10-04).**

- Severity: **medium**; effort: small; area: desktop/phone interop; kind: runtime bug
- Status: **fixed in `ec12ea9a`; rebuilt production desktop physical verification passes**.
  Actual beta 10 phone move/remove/re-add/create-label checks complete item 36; Android APK is unchanged.
- Locations: `src/core/workspace-store.ts` (`kanbanWriteNow`/`announceProjectFile`),
  `src/renderer/canvas/Canvas.tsx` (`onExternalChange`/`onServerChange`), Desktop
  `src/preload/index.ts` (`workspace.onServerChange`) and the mounted
  `src/renderer/components/kanban/KanbanView.tsx`.

**Observed:** on the installed beta10/code11 Pixel, the phone's Board moves its owned
relay-created plain shell to In Progress. Its card moves and the actual persisted project
board assigns that exact node to the In Progress column. The already mounted desktop Board
still places it in Ungrouped at two snapshots approximately 60 seconds apart, with unchanged
page time origin and no reload. A new blue label is also created and applied through the phone: persisted metadata and the
mobile card have it, while the mounted desktop still has no labels. The same view had already
picked up phone New-session node
creation and Rename, so those successes do not prove board propagation. The production desktop
was the held `071735d6` build; Android uses the clean beta 10 snapshot `e3ce041c`. Those commits have
identical relevant core/Canvas/Board code. Source tracing confirms `announceProjectFile` sends
this core-owned Board write as `workspaceExternalChange`. The active dirty canvas classifies
changed kanban metadata as a conflict and does not replace the projects-store Board; its conflict
strip is under the Board overlay. The existing `onServerChange` path already applies core-owned
updates while preserving live Flow state. Desktop's actual preload had deliberately made
`workspace.onServerChange` a no-op under the old server-only assumption. A core-channel-only
change would repair Server Edition but leave Desktop unaffected. Commit `ec12ea9a` includes
both the existing server-change announcement and real Desktop IPC subscription with unsubscribe.
The same owned paired profile was then restarted with the repaired production `ec12ea9a` build;
the actual no-reload phone/desktop move/add/remove/create-label checks below pass.

**Source verification:** nine affected Vitest suites (133 tests), full `npm run typecheck` and
strict TypeScript checking of the acceptance test pass. Four isolated source mutants are caught,
including the original Desktop preload no-op. `src/core/workspace-store.kanban.test.ts` verifies
the own-write channel; `src/preload/index.test.ts` verifies payload delivery, channel separation
and exact unsubscribe. `test/acceptance/phone-board-updates.test.ts` uses the actual Desktop preload
and Server WebSocket adapters, production change planners and mounted real `KanbanView` for local
and SSH projects, including default Board seeding and preservation of unsaved canvas movement on
the next ordinary save. This does not replace physical rebuilt-desktop verification.

**Private evidence:** the owned fixture's proof directory contains
`release-qa-board-snapshot-1791110071897978622-f0b5c9.json` (persisted In Progress) and
`release-qa-board-dom-1791110071897952231-481e0f.json` plus
`release-qa-board-dom-1791110131369275364-a2e18b.json` (mounted Ungrouped, matchesPersisted=false,
same page time origin). Native mobile proof is in
`.nodeterm/android-beta-build-9/checklist-20261004/beta10-board-after-move-portrait` UI receipts.
These observations preserve the original held-build failure separately from the repaired result.

**Rebuilt physical verification:** the actual beta 10 phone moves the owned card to Ungrouped,
removes its blue label, re-adds that label, and creates/applies a second blue label. Each action
updates persisted state and the already mounted production desktop Board. Baseline
`release-qa-board-dom-1791111329350981266-9c35ac.json` and resulting DOM receipts
`release-qa-board-dom-1791111393296743731-3f0e0a.json`,
`release-qa-board-dom-1791111472591205070-dde430.json` and
`release-qa-board-dom-1791111663350183645-51ca7c.json` all match persisted state and share page time
origin `1791111312961.1`; no reload is performed. Matching native result/UI receipts are
`beta10-a95-rebuilt-first-move-result.json`, `beta10-a95-label-removal-result.json` and
`beta10-a95-label-readd-create-result.json` under the Oct4 checklist directory. This completes
item 36. Including item 49 Settings evidence, the current tally is 10 Pass / 22 Partial / 32 Pending. It verifies the owned production fixture,
without deployment to the user's regular desktop or a new Android APK.
Exact phone End also removes the adopted card from the mounted Board with the same page origin
and matching persisted state (`release-qa-board-dom-1791111853036062170-ed2205.json`); the original
producer terminal is preserved. This does not complete Wake/Refresh repaint checks in item 35.
This is an existing remote-action behavior shared by phone clients; @eneskirca should verify
iOS-triggered board changes after the repair. No external verb, payload or project-file format changes.

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

## A96

**Sessions have no local search (2026-10-04).**

- Severity: **low**; effort: small; area: phone UX; kind: feature gap
- Status: **fixed in `f73633fb`; full candidate-source checks pass, physical follow-up pending**.
- Locations: `SessionsTab.kt`, protocol `model/SessionSearch.kt` and `SessionSearchTest.kt`.

**Before:** the installed beta 10 source `e3ce041c` lists every open project's sessions in status
buckets; finding a named session or folder requires scrolling. There is no query field or filter.
**Implementation:** a native Search sessions field uses trimmed, case-insensitive literal matching
against the displayed session name, visible agent label, project name/folder and node folder.
Project matches retain the group; session matches retain only those original rows. Project order,
status buckets, actions and the unavailable-New-session note remain intact. Loading, a completed
empty host and no search matches have distinct labels. The host/tab's existing A43 saved-state
holders preserve the query across terminal navigation and recreation; Clear search is labelled.

**Bounded verification:** all 12 actual `SessionSearchTest` JVM methods pass using cached
Kotlin 2.2/JDK 21 compilation: ten behavior tests and two native wiring guards. Twenty-one
isolated-copy mutants are caught by assertions; restored tests pass and production inputs are
unchanged. This is not a Gradle/Compose runtime or physical search result.
Private proof: `/tmp/nodeterm-session-search-verify/results.json`.
The subsequently coordinated actual eight-class focused Gradle run passes
(`precommit-focused-protocol-2.log`), and the final callback-aware offline app compile passes
(`precommit-app-compile-final.log`). Full candidate-source protocol/app gates subsequently pass
at `314105a4`, as recorded in the delivery receipt below. Physical search is not verified.

**Follow-up:** add search/restoration checks alongside existing item 10's session-grouping checks,
without replacing that item's required route/status evidence. New phone touch/keyboard proof is
pending. No desktop/server host contract changes; the iOS search UI is separate UX work.

## A97

**All computers does not refresh live while visible (A55 residual, 2026-10-04).**

- Severity: **low**; effort: small; area: parity; kind: freshness gap
- Status: **fixed in `8443e71e`; full candidate-source and mutation checks pass, physical results pending**.
- Locations: `AllComputersScreen.kt`, `conn/ConnectionManager.kt`, protocol
  `host/ForegroundRefresh.kt`, `host/ConnectionUsers.kt` and `ForegroundRefreshTest.kt`.

**Before:** the merged screen in `e3ce041c` refreshes each paired computer once on START and on
explicit Refresh/Try again or an answer. Its Inbox and Usage can remain stale while open; the
eight-second watcher is owned only by individual host/terminal screens. This is separate from
the already-fixed merged-feed layout in A55.
**Implementation:** each paired host has a keyed STARTED watcher, using AUTO initially and on
later ticks. Denied/unanswered approval holds remain in place; only that host's Try again requests
USER approval. The initial UI task yields so on-screen Inbox registration precedes listing and
notification announcement. STOP/removal cancels that host's watcher. The last All-computers
watcher requests closure only after in-flight users finish; a newer watcher supersedes an old
deferred close. Individual host opening retains USER-first behavior and its quick-return policy.
One per-host serial operation covers connect, listing, snapshot publication and announcement,
including manual, pushed and polled refreshes. Pushed changes and delayed reconnect jobs are
children of the current watcher, including while delayed or queued behind that serial operation.
STOP cancels them; cancellation/current-connection guards prevent an old job from reopening a
hidden host or moving to a replacement watcher. The poll job is assigned before its lazy start.

**Verification:** `ForegroundRefreshTest` defines 19 methods (18 behavior, one native
wiring), and the focused ownership run also includes six `ConnectionUsersTest` methods. They
cover cadence, trigger gates, cancellation, ownership, serialized relisting, host removal and
watcher-owned pushed/delayed work. Actual cached Kotlin 2.2/JDK 21 control/restored runs pass all
25 methods. Thirty-one non-equivalent isolated-copy mutants are assertion-killed: 17 behavior
and 14 native-wiring mutants. Ten source hashes remain unchanged and bind the receipt to
`8443e71ee872db46da68380a9db1ab05748818d2`; an equivalent redundant-guard mutation is excluded.
Private proof: `/tmp/nodeterm-all-computers-refresh-verify/results.json`. The earlier
eight-class focused Gradle run passes 134 methods with zero failures, errors or skips; that run
preceded final assertion-cleanup additions. Full candidate-source protocol/app checks
subsequently pass at `314105a4`, including these final assertions.
Physical item 60 multi-computer freshness, notification suppression and lifecycle
checks remain pending; no device-ledger promotion follows the source implementation.

## A98

**Captured terminal output cannot be searched (2026-10-04).**

- Severity: **low**; effort: small; area: terminal UX; kind: feature gap
- Status: **fixed in `1b1872f1`; full candidate-source checks pass, physical follow-up pending**.
- Locations: `TerminalScreen.kt` (`CopySheet`/Find chip), protocol `model/TerminalCopy.kt` and
  `TerminalSearchTest.kt`.

**Before:** `e3ce041c` already offers snapshot lines, link actions, line/range selection, Copy and
Share, but no text search. **Implementation:** Find opens that same local captured-output sheet.
A native query field highlights literal case-insensitive occurrences and moves Previous/Next
through matches with wrapping navigation. UTF-16/exclusive offsets match Compose spans; rows and
selected line identities stay unchanged. Query changes reset the cursor, Clear removes the query,
and no-match/truncated counts are explicit. Matching is capped at 2,000 occurrences, with
truncation reported only when another match exists. Whitespace in a nonblank query is significant.
This searches the existing captured snapshot, including joined soft wraps; it does not fetch or
search all remote tmux history, and no query is typed into the pane.

**Bounded verification:** all nine actual `TerminalSearchTest` JVM methods pass and 13
isolated-copy mutants are caught. Tests cover literal punctuation,
Unicode offsets, empty/long queries, navigation, the exact cap, original copy order and native
wiring. The coordinated actual eight-class focused Gradle run and final callback-aware offline
app compile pass (`precommit-focused-protocol-2.log`, `precommit-app-compile-final.log`).
Full candidate-source protocol/app checks subsequently pass at `314105a4`; physical results
remain pending.

**Follow-up:** record the extra Find/query/selection checks beside existing Copy-sheet item 56,
and keyboard-open layout/closing checks beside item 50. Preserve all of those items' original
requirements and current statuses. No external protocol change; iOS UX parity can be considered
separately by @eneskirca.

## A99

**SSH host-key discovery ignores recursive external Includes (A49 residual, 2026-10-04).**

- Severity: **low**; effort: small; area: security; kind: discovery gap
- Status: **fixed in `e07071e9`; full candidate-source checks pass, physical included-key pairing pending**.
- Locations: `src/main/ssh-host-keys.ts`/`.test.ts`,
  `android/protocol/src/test/interop/host-fixture.ts` and `PairingInteropTest.kt`.

**Before:** `e3ce041c` discovers standard public-key names and direct HostKey entries in the
readable main config/drop-ins. A served key named only through an external/nested Include can be
absent from the sealed pairing anchors; the phone correctly refuses that first SSH key, and
pairing again repeats the incomplete discovery.
**Implementation:** readable Includes are followed recursively, including quoted/multiple paths
and lexically expanded glob components. Relative Includes resolve under the configuration root,
including when the including file is external. Canonical paths stop cycles; discovery has
depth/file/byte/directory/glob/public-file budgets, and nonregular/oversized/unreadable inputs are
skipped. Reads are bounded and use nonblocking/no-follow plus opened-inode checks. Public-key
fingerprinting retains the public-target guard; private HostKey paths named by the config are
excluded from Include reads. Relative HostKey values remain unsupported; no new trust override
or weakening of pin/anchor checks is introduced.
HostKey paths are deduplicated per file/across configs, with at most 256 distinct configured
paths canonicalized. Exhausting that budget stops further Include traversal so unresolved
private-key aliases cannot become later configuration reads.

**Source verification:** the actual Linux Vitest control/restored runs pass all 19 tests,
including a real FIFO replacement boundary. Sixteen isolated-copy source mutants are caught by
assertions, including repeated/unbounded key canonicalization and continuing after key overflow.
Proof: `/tmp/nodeterm-ssh-include-root-verify/results.json`; the recorded inputs remain unchanged.
Desktop regressions cover recursive/relative Includes, glob ordering, cycles, budgets and read
boundaries. The Android fixture and new `PairingInteropTest` case use
scratch configuration/public keys with the actual production pairing service: the returned
sealed anchors are stored and used for an actual fixture SSH authentication. The actual
eight-class focused Android Gradle run and final offline app compile pass
(`precommit-focused-protocol-2.log`, `precommit-app-compile-final.log`). Full candidate-source
protocol/app and desktop checks subsequently pass at `314105a4`.
Physical included-key pairing is an item 11 follow-up, with the existing 64-item ledger unchanged.
The pairing field and SSH-visible contracts are unchanged; @eneskirca should check that iOS uses
the supplied anchors and presents the existing refusal/recovery messages consistently.

**Current delivery boundary:** installed beta 10 / code 11 and its 10 Pass / 22 Partial /
32 Pending ledger remain the device checkpoint. These four source additions are not yet
physically verified. Private beta 11 / code 12 is now **prepared, not installed**, from clean
source `314105a435d18e719f53d49bb292d0f3e965ad4a`. The local AGP release completes in 51.78
seconds, with R8 keeps passing. Candidate-source required gates report **730 protocol tests in
70 suites**, zero failures/errors/skips, offline app compile, **17 affected Vitest suites /
297 tests** and full desktop TypeScript passing. Proof:
`.nodeterm/android-beta-build-11/build-source-3/required-gates.json`. The existing layout source
pin in `LegRoutingTest` is corrected in `314105a4` to reflect the weighted list below Search;
that follow-up changes the test assertion, not product behavior. Across A96–A99, **81
non-equivalent isolated mutants** are caught (21 + 31 + 13 + 16).

**Independent artifact review passes:** candidate APK SHA-256
`ae052a8a02567c42576012309c5de059827d8b9ff28a9972673af0440d977341` is verified against its
metadata and build/R8 provenance. Official SDK 36 and 37 both verify v2/v3 signatures, one
expected retained signer, package/version, minSdk 26/targetSdk 35, nondebuggable metadata and
16 KB ZIP alignment; all four native libraries satisfy 16 KB ELF alignment. Signing preserves
all 149 unsigned ZIP payloads and adds only the three v1 signature entries. Terminal assets
and native libraries are byte-identical to beta 10; DEX, version/signature/optimization metadata
and an R8-mapped service-loader descriptor change as expected. Service-loader entries match
the actual R8 mapping. Receipt: `.nodeterm/android-beta-build-11/artifact-review.json`;
private APK: `.nodeterm/android-beta-11/nodeterm-android-0.1.0-beta.11.apk`.
No installation, new physical PASS or new CI result is claimed by this preparation. Each
requested push still requires green exact-head workflow verification; current phone cleanup,
rotation restoration and background watcher checks remain pending.

## A100

**Retained host history search**

Source change: `2f693d83, 97b8a9a4, 4f1985f5`.

Find previously searched only phone-captured output. It now searches retained host history on the attached generation/exact pane, with literal case-sensitive queries, original line numbers and explicit capture/result bounds. Search does not change copy mode or input. Old backends refuse without replacement. Query/stream/lifecycle fences discard stale answers. Actual producer/consumer and retained output-order tests pass; physical Find flow remains pending.

## A101

**Interrupted typed session-host reads reconnect**

Source change: `fbaa535d`.

An EPIPE in the existing socket suite also reproduced on the earlier baseline. Bounded reconnect/resend now allows only named typed reads after EPIPE/ECONNRESET. Sent writes, deadlines, host refusals and unknown errors do not replay. Actual socket tests and three isolated policy mutants pass.

## A102

**Cold relay attach retains trusted project launch settings**

Source change: `e584586f`.

Cold phone attaches previously omitted project env/shell. The host prepares trust-aware settings without spawning, resolves saved project/account/agent ownership ahead of phone hints, rechecks warm races, then commits reply/snapshot/attach synchronously. Existing warm sessions retain launch facts. Real shared launch builders and 22 mutations verify the source; actual fixture discovery is isolated from host tmux. Physical/live launches remain pending.

## A103

**Agent approval policy survives launch, resume and wake**

Source change: `91e6a3f5`.

Non-Claude launch/resume/wake previously dropped project approval policy. Android now matches measured desktop agent dialects and the actual host Codex vocabulary; only Claude uses its own auto capability gate. Unsupported modes retain CLI defaults. Eight actual mirror/desktop-builder fixtures and six mutations pass; a live agent/device matrix remains pending.

## A104

**Offscreen Sleeping nodes can wake without switching projects**

Source change: `2d6cb2cd`.

The renderer-only mounted-node nudge left offscreen/closed-project sessions Sleeping. The desktop now resolves unique saved ownership and actual live/released session proof across awaits, preserving Pause, exit/process/generation guards and original SSH routing. A typed persistent-backend wake is additive; an old backend refuses without restart. Actual socket/tmux regressions and 22 mutations pass. Windows runtime and physical inactive-project/lifecycle checks remain open.

## A105

**Earlier Desktop application verified (2026-10-07, source `41406fef`):** Real Claude 2.1.292 uses genuine
captured node routing in a sibling namespace and the unchanged managed hook. The shipped Desktop
consumer applies one original `localSettings` rule: nine hooks, one consumed/removed hold, two
Bash executions without a second hold, and the exact CLI-saved rule; **8.648 seconds / $0.0166058**.
Result `nodeterm-new-phone-fixture-h7nho19u/home/qa-project/real-cli-a105-44b6a670/proof/result.json`
hashes to `741b0f5a73522ec76bf29ebeab7a0cf43b9c2b19a47da0f022ecc0369356c228`; independent review
`nodeterm-new-phone-fixture-h7nho19u/proof/root-a105-application-review.json` hashes to
`ee9e1fd9dc3fc191b1d6ede108347252d29265dc4222143bb7d4a60f97c6d434`. At that earlier checkpoint, Android input was unverified.

**Physical Android application verified (`e06b5547` / beta 19):** The normal Always allow dialog
selects one original `localSettings` rule. Real sibling Claude consumes one 36.814-second hold and
executes two Bash calls without a second hold (nine hooks, 45.982 seconds total), saving the exact
rule itself. [Actual result and independent review](android.md#beta-19-publication-provider-and-emulator-checkpoint-2026-10-07)
retain the original-node/request correlation. Rule persistence after CLI restart, production-pane-child
launch and wider scope remain pending; A106's scoped pass is below. The original 10/22/32 ledger is unchanged.

A separate private FD/TTY component calibration (`a105-toy-fd-actual-822fkn84`) fails before any
provider action. It establishes no production-pane-child launch or restart acceptance and is not
a new product finding; the pending limits above remain.

**Always allow uses original concrete hook rule scopes**

Source change: `db4abccf, 7c206ec5`.

A56 is now implemented without its unsafe proposed blind digit. Eligible original addRules suggestions carry exact tool/content/destination and UI confirmation; the guarded v2 reply uses updatedPermissions. Android and Desktop/Server offer the same original scopes. Gone/replaced/unsupported requests never type keys. Actual shipped managed-shell consumer and Kotlin/TypeScript fixtures pass; the bounded Desktop and Android rule cases above are verified, while restart/wider persistence remain open. iOS adoption is owed to @eneskirca.

## A106

**Physical application verified (`e06b5547` / beta 19):** One original held AskUserQuestion
preserves both questions; normal phone Send answers chooses Cobalt (single) and nonadjacent
Lint/Docs (multi). The unchanged hook's `updatedInput`, actual PostToolUse/Stop and final PTY
output match. [Result and independent review](android.md#beta-19-publication-provider-and-emulator-checkpoint-2026-10-07)
record explicit owned provider stop/reap after completion; wider question/lifecycle scope remains pending.

**Complete held Claude questions have deterministic answers**

Source change: `db4abccf`.

A57 display-only work is extended to all supported held questions. Parent PreToolUse AskUserQuestion requests publish full question schemas, submit every selected index, preserve original input and derive exact answer labels through hook JSON. Held v2 cards omit legacy digits for old phones; unheld multi-select remains Open session. Request/card/file fences and consumed-hook POST govern settlement. The 52 shared hook/Android mutants cover A105/A106 together; the original two-question phone/CLI case above passes, while wider scope remains open.

## A107

**Typed source control works on direct SSH**

Source change: `489c30a8`.

The existing eight Git verbs now execute over POSIX SSH inside physically admitted local/driven roots and repository roots, with quoted argv/literal paths, NUL-delimited parsing, bounded output and confirmed status. Git capability does not depend on an actions-service advertisement or a relay leg. Third-machine projects refuse. Unknown writes retire the connection with no replay. Upstream fallback requires the exact native exit-128 missing-upstream diagnostic for the pre-dispatch branch. Real SSH Git tests include hostile filenames, symlink jail escape, hooks/signatures, rejected pushes and transport uncertainty. Twenty-six pure and five real transport/routing mutants are caught; physical Source Control remains pending.

## A108

**Owned SSH Board and Desktop session actions**

Source change: `d716138c`, `585e726f`.

At the A108 checkpoint, Desktop/Server exposes bounded private typed request/response files under the exact selected userData profile, with fresh instance/host-time advertisement, ownership and nonce guards. Board operations use the actual WorkspaceStore save queue and change broadcasts. Desktop offers delivery-only wake/refresh/rename nudges; Server offers Board only. Duplicate requests do not execute twice inside their immutable retry window; unknown results never replay/fallback. Another desktop's unowned driven projects refuse. Canvas cold New was outside the A108 service scope. A111 now adds a host-owned launch API on current enabled local Linux/macOS tmux hosts, including Server; its physical checks remain pending. Actual filesystem/FIFO, Desktop wiring and headless Server checks pass (33 tests); 29 native and 29 Android client mutation variants catch regressions. Real Node/Kotlin/generated-shell interop passes; the full merged Gradle gate verifies MINA and bundle coverage. Physical service flows remain pending.

## A109

**Three-digit findings retain device coverage**

Source change: `4e2f877d`.

The documentation scanner recognized only two-digit finding IDs, silently ignoring continuation IDs from A100. Both heading and reference scanners now accept full IDs with at least two digits and reject malformed suffixes. The actual regression and restored control pass; reverting either production regex is caught by an assertion. Two mutants are killed.

## A110

**SSH integration fixtures retain their own profiles and actual permissions**

Test changes: `8c57016c`, `b2e41255`.

The first merged protocol run exposed shared-home pollution: the new file-service tests reused
one class fixture and changed the workspace later transport tests expected. Each service method
now owns and closes its own SSH server, private home/profile, tmux root and command observer.
Existing browse, third-machine refusal and uncertainty assertions are preserved. A real MINA
mutation restores the shared home: the first service succeeds, later producers fail with EEXIST,
and the unchanged browse and NeedsRelay assertions catch the corrupted fixture. Control and
restored runs pass all six real methods. Nine additional Inbox mutants verify host/event admission,
busy state, cancellation and finally retirement; they extend the stale merged wiring assertion.

The affected native suite also exposed a test-created mode narrowed by inherited umask `0077`.
Explicit chmod makes the unsafe service directory actually `0755` before asserting Unsafe refusal.
All 30 tests pass under `0077` and `0022` in both control and restored runs; removing chmod triggers
the exact Vitest rejection assertion. The assertion still requires Unsafe refusal. Full merged gates pass
815 protocol tests / 83 suites and 1,314 affected Vitest tests / 53 files, with zero failures and only
the ten named existing Windows/macOS runtime skips on Linux; app and TypeScript checking pass.

**Prepared private beta 12 (2026-10-04).** `0.1.0-beta.12` / code `13`, clean built source
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

**Prepared private beta 14 (2026-10-04).** `0.1.0-beta.14` / code `15`, clean built source
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

## A111

**Canvas New over direct SSH needs host-owned creation, not registration metadata (2026-10-04).**

A108's private actions service supplies Board/node metadata actions but cannot safely recreate a
cold managed pane by registering a node alone. Phone-built commands would duplicate the desktop's
account, trust, hook and launch policy; ordinary SSH attach must continue refusing missing panes.

The additive `sessions.createManagedV1` action resolves actual open local project/settings/account
facts through the host planner. An enabled Linux/macOS tmux backend exclusively creates a new
host-minted session, confirms one exact pane/PID/kernel birth and records runtime ownership. The
WorkspaceStore queue saves portable cwd and local shell, preserving pending intent until one
attested host submission is confirmed. Its private journal syncs file and directory phases before
side effects. Expanded launch text stays in private state/stdin, never shared project/receipt.
Failures expose an inert manual recovery notice; restart/uncertain/different-choice requests never
replay a launch or grant ownership from disk. Removed/pending accounts and changed cwd are refused
again at synchronous spawn, while ordinary renderer Home fallback stays intact.

Android saves the exact UUID/nonce/instance request before dispatch and public receipts until an
actual guarded SSH viewer is confirmed. The first attach pins selected profile/service, whole
single-pane session, creation/PID/birth marker, and fresh SSH tty; it is attach-only. Closing the
dialog/backgrounding cannot resend or navigate a stale screen. Stale proof requires explicit
inspection/discard; no automatic relay fallback or replacement creation. Older hosts retain the
relay New flow. Windows/non-tmux and third-machine/driven project creation are unsupported V1.
Managed canvas End remains relay-only so terminal termination also removes the canvas node;
SSH viewer close leaves it running. The separate phone-owned plain terminal End is unchanged.

Actual isolated native node-pty/Electron and tmux creation with a fixture agent passes; this proves
one submission with the host cwd/account/hooks/env/policy, not real Claude startup. Protocol,
producer interop, mutation and minified beta-13 local release gates pass. The Pixel remains on
beta 10 and the 64-row ledger remains 10 Pass / 22 Partial / 32 Pending. iOS @eneskirca needs the
new advertised action and durable attach-only receipt contract; no external message or PR opened.

## A112

**The managed producer exposes missing session-host CI and local incremental coverage (2026-10-04).**

A111's actual PtyManager fixture imports `src/session-host/**`; the esbuild-metafile regression
found those repository inputs absent from both Android workflow path filters. Gradle's declared
external source input directories also omitted them, so a source edit could leave local protocol
tests up to date. Both push/pull_request filters and Gradle inputs now include the directory.
Actual fixture graph/declared-input regressions cover this addition; removing either trigger
filter or the Gradle input fails its isolated mutation check. The actual producer/consumer
fixture and coverage guards pass, catching nine isolated variants. A68's PR-stage trigger
restriction stays deferred; each push still requires exact-head green Android CI.

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

## A119

**Explicit SSH profile folder (2026-10-04).**

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

## A120

**One-time password SSH setup (2026-10-04).**

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

## A121

**Canvas terminal blur can leave a stale link pointer (2026-10-05).**

- Severity: **low**; effort: small; area: desktop renderer; kind: bug
- Status: **fixed in `01b4a2f5`; native Linux Desktop UI verified**. Separate Linux Server checks
pass at `dcdf664a`. The later GPU-enabled eight-case matrix passes (Canvas4 hardware / Modal4 DOM);
Those earlier runs did not verify GPU recovery; later individual pilots are recorded in the final
follow-up. macOS remains unverified.

**Observed:** the isolated full Linux Electron Desktop UI at `c0accdfcb0642dc2d643e1794640065f61906f34` rendered a wrapped URL through the real plain NodePTY and bundled xterm DOM renderer. Tail hover, complete URL activation by Ctrl-click, and native non-drag movement outside the terminal were delivered. In the SGR mouse case, moving to the canvas left xterm's active link and pointer state set (`A92_HOVER_CLEAR_FAILED`). No pointer capture was active. The normal mouse case completed the same leave successfully.

**Cause at `c0accdfc`:** `src/renderer/nodes/TerminalNode.tsx` called `term.blur()` synchronously from `onBodyLeave`. The bundled xterm DOM renderer handles blur by immediately rendering all rows with `replaceChildren`. The native trace records screen `pointerleave` and `mouseout`, then destination `mouseover` whose former span is detached, with no actual screen `mouseleave`. Linkifier clears its hover on that missing `mouseleave`, so its `mouseOut` stays false and pointer/link state survives. The visible row underline can disappear during blur even though Linkifier's hovered decoration state and pointer remain; this finding does not claim every visible underline persisted.

**Source repair:** `terminal/deferred-blur.ts` defers only the captured terminal's blur with `setTimeout(0)`. Re-entry, intentional focus and lifecycle cleanup cancel it; generation and exact current-terminal identity reject stale callbacks, including same-object park/adopt. The controller remains reusable after cleanup. Status/presence release stays synchronous. Nine behavioral methods pass, all 63 tests in four affected terminal files and the full TypeScript check pass, and five isolated production mutations fail on assertions (immediate blur, microtask, ignored cancel, missing generation, missing owner). The control/restored copies pass. Private proof: `.nodeterm/android-beta-build-16/desktop-links-and-advertisement-receipt/a121-unit/`. Fresh full control and restored builds at `01b4a2f5` each pass all eight actual native Linux Desktop cases; the synchronous-blur mutant fails on named hover-clear after trusted delivery. See the final receipt below.

**Scope:** Desktop and Server share the Canvas `TerminalNode` handler. The original diagnosis is Linux Desktop; separate genuine Linux Server execution at `dcdf664a` now verifies the shared handler through its authenticated HTTP/WebSocket bridge. Modal terminal leave does not use this handler. Android's terminal is unaffected, and this repair changes no external protocol or iOS contract. The Android APK source, installed phone version and 64-item physical ledger stay unchanged.

**Separate A92 evidence:** the old upward-bound link mutant already fails with the named `A92_TAIL_HOVER_MISSING` in a real native tail hover. That established sensitivity to A92's lookup cap defect while the initial control was incomplete. The final current-source eight-case controls and both full-app mutants now pass; preserve the original preliminary receipt separately.

Private evidence:
- Current failed control: `/tmp/nodeterm-a92-current-ys5prgif/runtime/control-7yoizvhv/proof/{receipt.json,runtime-result.json,canvas-soft-sgr-hover-clear-failed.png}`.
- A92 old-bound mutant: `/tmp/nodeterm-a92-mutant-7dyrrp0u/runtime/old-upward-bound-mgnkw593/proof/{receipt.json,runtime-result.json}`.

## A122

**Focused Desktop xterm consumes the advertised native Quit chord (2026-10-05).**

- Severity: **medium**; effort: small; area: Desktop terminal keyboard; kind: bug.
- Status: **source-fixed in `9613cec519c1469aff10371bf0acf97adb90ed1a`; four Linux native cases pass**.
- Locations: `src/renderer/terminal/terminal-config.ts`, `src/renderer/nodes/TerminalNode.tsx`
  and `src/renderer/components/kanban/ModalTerminal.tsx`.

Earlier full-product Linux Desktop attempts delivered native Ctrl+Q while the terminal was
focused but reached no native confirmation. The actual File-menu and outside-terminal Ctrl+Q
controls later confirm natural Quit on the historical `972f7994` / built `01b4a2f5` checkpoint.
The original V5 key observation is document-capture/main before-input evidence, not the final
renderer default-prevented state. Current source identifies the ordinary xterm Ctrl+Q/XON path
as the missing native-role exception; `terminalKeyAction` now returns `native` for only the exact
printed platform Quit chord on Desktop keydown/keyup before policy or registry handling.
Canvas and Modal pass their actual Desktop/browser identity. Neither handler prevents default
for this branch. Server and other terminal chords keep their existing bytes/behavior.

133 focused policy tests and all 218 tests in three affected files pass with full TypeScript
checking. Six isolated compiled mutations are assertion-caught with passing control/restored
runs. A fresh full Desktop build is source-bound to `9613cec5`; all four native Linux
Canvas/Modal × app-first/terminal-first cases pass. Actual owned textarea/main focus at dispatch,
parented native Quit confirmation, Escape Cancel retaining the exact PTY, and later natural
File-menu Quit with own PTY/hook retirement are verified. See the final checkpoint section.

The fix changes only Desktop renderer shortcut handling, not Android, SSH/relay contracts or iOS
fields. macOS/Windows native delivery remains unverified. No APK, installed-phone or physical
ledger change follows from this source repair.

## A123

**A restored addon context stays live after disposal and budget retirement (2026-10-05).**

- Severity: **low**; effort: small; area: Desktop Canvas GPU lifecycle; kind: bug.
- Status: **fixed in `db83fb7dfc59c336083769edf0943bf82b367c58`; Linux native control/mutant/restored verified**.
- Locations: `src/renderer/nodes/TerminalNode.tsx`, `src/renderer/terminal/webgl-budget.ts`.

At source `6bfa5412`, a genuine quick original `webglcontextrestored` event restores the context.
The owning Canvas listener disposes the addon and removes its budget grant, but addon-webgl 0.18
only detaches its canvas/deletes resources. The native observer sees the original context healthy
at readable DOM fallback, fresh hardware regrant and final observation. The restore hook clears
its local `webgl`, but `webglAddonRef.current` still references the disposed addon until replacement;
the passive fixture also retains the captured context for observation. This establishes missing explicit retirement, not a reproduced Chromium cap-pressure
failure or a permanent leak. Page-wide and repeated pressure consequences remain an inference.

The repair explicitly calls `loseWebglContexts` on the captured original addon canvas after
disposal and before notifying the coordinator. It preserves stale-addon ownership, already-lost
cleanup and the delayed budget-gated regrant policy. Two new tests cover detached captured
canvases and continuation after an earlier canvas throws. All 44 budget tests, 301 affected tests
in seven files and full TypeScript checking pass. Full helper control/restored runs catch two
exact assertion mutants; these helper checks do not prove TerminalNode wiring.

Three fresh full builds at the signed repair source supply separate actual native wiring proof.
Both fixed controls observe a trusted original restore before production's handler, production's
second native loss, readable stock DOM and distinct fresh NVIDIA WebGL2. The sole-call-removal
compiled mutant fails exactly `GPU_RETIRED_CONTEXT_NOT_LOST` after three trusted native input
acknowledgements and two complete URL controls pass; old context remains live. Startup/focus/
fixture failures supply no mutation credit. Every run preserves the same terminal, buffer, grid
and real PTY birth, with no fixture second loss, GC or forced redraw. Explicit fixture app exit
supplies no ordinary-Quit proof. See the final follow-up and its private source-bound archive.

The shared Desktop/Server Canvas hook receives this repair when using the per-terminal WebGL
addon. Source-bound native retirement checks pass for Linux Desktop at `db83fb7d` and the later
genuine Node Server/browser Canvas soft/none pilot at `fa259f6e`. A separate derived Desktop cell
correlation uses three existing `db83fb7d` captures; it adds no Server runtime or synchronized/
full-frame compositor proof. Android, external SSH/relay contracts and iOS fields are unchanged;
no APK or phone ledger change follows. Other platforms, synchronized/full-frame compositing,
physical-display output, shared glyph eviction and repeated/page-wide pressure remain unverified.

## A124

**Managed SSH New rejects an available absolute shell as unavailable (2026-10-05).**

- Severity: **medium**; effort: small; area: shared Desktop/Server executable resolution; kind: bug.
- Status: **fixed in `651f46da239cb0877c3bfccc6a478e1b555a63cc`; one physical Pixel 7a managed-shell case verified on `40731381`**.
- Locations: `src/core/exec-path.ts` (`findInPathString`), `src/core/managed-terminal-plan.ts`
  (`createManagedTerminalPlanner`), `src/core/pty-manager.ts` (`resolveLocalSessionShell`).

Fresh beta 16/code 17 on the separate Pixel 7a reaches a genuine owned Desktop host at
`15dd1341c55302f9936b83a19d82c165733320c9` through manual explicit-profile SSH. Existing-terminal
input/cwd/history pass, but **New session → Start with default Claude selected** reports “The
configured shell is unavailable.” The original XML shows that tapping a nonclickable option label
did not select Terminal. This is still shared shell validation before any agent CLI resolution;
the repaired wrong-label retest correctly refuses the missing Claude CLI and is not a new finding.
The host has blank `defaultShell`, inherited `SHELL=/bin/bash` and an available
executable `/bin/bash`; the planner calls the real login-PATH resolver. That resolver joins the
absolute program beneath each PATH entry, checking unrelated paths such as `/usr/bin/bin/bash`.
The observed workspace retains only its original Desktop terminal.

The repair validates the exact absolute path with the platform's executable-access check and a
regular-file check, returning null on failure without PATH fallback. Bare-name/PATHEXT behavior
is unchanged. Real-filesystem regressions cover an absolute executable outside PATH, absent and
non-executable files, directories and a joined PATH shadow. Planner integration uses the actual
shell and login-PATH resolvers with a disposable inherited absolute shell and blank defaultShell.
All **38 affected Vitest tests in two files** pass; five platform cases skip on Linux. Full
TypeScript checking passes. Network/PID-isolated control and restored runs pass; removing the
absolute branch fails three regressions, removing the regular-file check fails directory rejection,
and removing executable access fails non-executable rejection. Three earlier fixture setup
failures stopped before Vitest and earn no mutation credit.

The actual shell radio is independently selected in `repaired-shell-selected.xml`. On frozen
Desktop `40731381`, the phone creates/registers `/bin/bash` node `term-muvrrd9n-623cda88cddd8ded`,
pane PID 1101, and input executes exactly once in the project cwd. The original terminal/PID 368
remains unchanged. Viewer close/reopen and Android process restart (9258 → 14735) with saved SSH
reconnect return to the same managed pane and visible old marker, without resetting app identity.
After 150 further output lines, Find reports two matches in 155 retained lines; native tmux `-S 0`
excludes the old marker from the visible screen. History selected-line clipboard paste matches.
Local Copy-sheet search correctly has no offscreen-marker match; URL offer and URL clipboard paste
pass. No external browser-open result is claimed.

Both owned host profiles are removed through the app and the phone returns to Computers/Add;
beta 16 and global identity remain. V5 then stops at clean `40731381` with runner success/exit zero,
graceful requested stop, app/server exit, closed listeners and generated private-auth cleanup.
The old host's negative source-binding receipt explicitly preserves the earlier working-tree edits.
The exact `40731381` offline protocol gate passes 949 methods / 98 suites with zero failures,
errors or skips; the full frozen Desktop build passes in 29.3 seconds. First-push
[Android run `37375870878`](https://github.com/CPlusPlus17/nodeterm/actions/runs/37375870878)
passes all five jobs against `40731381c646ccd3425af597b116b5371daf0a63`.

Physical proof is `.nodeterm/android-pixel7a-device-y0ia4hm_/physical-repair-result.json` and its
named evidence; source/regression proof is
`~/.cache/nodeterm-android-work/a124-executable-mutation-lhf2f_p6/proof/`. This single manual high-port
SSH shell case does not verify live agents/provider answers, managed End, power loss, QR/relay/
cellular routes or the full background/outage/permission/64-item matrix. The original Pixel 10 Pro
beta-10 ledger remains paused at **10 Pass / 22 Partial / 32 Pending**.
No phone payload, host verb or SSH-visible file contract changes. The shared host repair also
benefits iOS managed creation; @eneskirca should note the host update, with no new client field.

## A125

**Open SSH card does not follow automatic reconnection; inactive cards use the active owner (2026-10-06).**

- Severity: **medium**; effort: small; area: Desktop card/SSH renderer lifecycle; kind: bug.
- Status: **source-fixed in `415dae9b`; eight bounded Linux Desktop reconnect cases pass at `5b7286b3` with A126; one two-host inactive-global case passes at `59e4c93e`; wider scope remains open**.
- Baseline: `11e22453235dbd8bf474dd8034a0eaf5778c3992`.
- Locations: `ModalTerminal.tsx` exit listener and nodeId-only attachment effect; `CardModal.tsx`
  stable card/view key; `GlobalKanbanView.tsx` owning swimlane; `TerminalNode.tsx`
  `sshConnectionScope`/`resolveSshRemote`; `Canvas.tsx` active/inactive reconnect respawn.

The baseline Modal exit callback only writes the ended banner, and its attachment effect depends
only on nodeId. Canvas queues connection exit 255 and bumps its own respawnNonce after successful
reconnection, while an inactive owner's branch only retires parked Canvas viewers. That transient
nonce is intentionally not serialized into the global board's stored node projection. The global
lane keeps modalNodeId and reads its latest card through byId; a selected-object cache is not the
cause. The card also receives no explicit owning project, so the SSH helper assumes the active tab.

The `415dae9b` repair publishes renderer-only exact scope/node reattachment notifications at the existing
coordinator's successful pending-node flush. Each Modal generation subscribes before async attach,
marks itself lost before reporting remote 255/unavailable and replaces its own viewer only for a
matching notification. Cleanup fences late async/refused results and detaches the exact viewer.
Both boards pass the owner; scope resolution retains active ownership as the default for existing
Canvas callers. The card remains mounted and creates with the original persistKey/requireRemote,
without any initial/pending command or agent resume delivery. No persisted/wire contract changes.

Nine actual mounted Modal/Global-board cases use the real LocalTransport and SshReconnector;
four coordinator subscription cases cover failure/success, exact routing, co-viewers, racing
status/promise completion and retired unsubscribe. All **100 affected tests in 11 files** pass
with zero failures/skips, and full TypeScript passes using ordinary composite/incremental caches.
Six isolated variants remove the 255 report, flush notification, scope/node filtering, global owner,
late-dead guard or exact-viewer cleanup; each fails intended assertions (respectively 2/7/2/1/2/1
failures), with **28-test** passing controls/restoration and bound unchanged candidate/main sources.

**Admitted native baseline.** The genuine Linux Desktop Modal soft/none case on source/build
`11e22453` admits selected Modal, hidden Canvas and remote pane at `80x24` before one producer
paint. Initial trusted native input and complete URL controls pass. A single birth-pinned product
ControlMaster SIGKILL produces exit 255; the product reconnects its master and Canvas (`pty-2`),
but the same open Modal remains on `pty-1` through a six-second coherent recovered-state window.
The second trusted native `g` produces one exact IPC write to `pty-1`, misses its two-second ACK
deadline, and an additional 800 ms observation still shows producer count one. This is classified
`MODAL_RECONNECT_INPUT_UNACKNOWLEDGED`, with fixture exit 3 in 26.43 seconds. Remote pane/server/
producer identity and complete retained history remain unchanged before, during and after outage.
Exact owned session/observer/master/daemon cleanup and generated-auth removal pass. Explicit
fixture exit supplies no ordinary-Quit proof. Earlier geometry-calibration refusals stay separate.

Native proof: `~/.cache/nodeterm-android-work/nodeterm-linux-ssh-reconnect-case-_r9f0qvs/proof/`.
`receipt.json` SHA `18db5b3ebfeb32db1881a1183a259b68944ae9ff8fe6c95a7bb6b30c90faa1e5` records the
verified product negative; `runtime-result.json` SHA
`137bca085ceddb38db3f52fe0ce8a17fc74d1f1d785c1bff169e317457eee797` binds the actual input evidence.
Separate Canvas controls at the old `11e22453` source are historical baseline controls, not
repaired-Modal acceptance. The first fresh `415dae9b` control creates replacement Modal and
Canvas viewers but exposes [A126](#a126) duplicate automatic replies before ACK 2 is attempted.
Its original unclassified exits and later diagnosis remain separate. With A126 fixed in `5b7286b3`,
the eight bounded Linux Desktop reconnect cases pass; [A126 below](#a126) binds that separate
acceptance. The later two-host case below at `59e4c93e` also verifies one quiet park/adopt cycle
and inactive global-card recovery with active A unchanged. Wider parking, Server/Android/phone
outages, physical custom bindings/FPS, provider-authenticated answers and macOS/Windows remain
unverified. The original Pixel 10 Pro beta-10 ledger stays paused
at **10 Pass / 22 Partial / 32 Pending**. This Desktop renderer repair changes no Android APK,
host-service verb, blob/pairing/mirror/SSH-visible file or iOS client adoption requirement.

Private candidate proof: `~/.cache/nodeterm-android-work/modal-reconnect-candidate-g37ek98k/`
(`candidate-result.json`, SHA `7a54a18e823f26067ac46f9022bc58670062a61d52084078deb0bdd9bb5c824d`;
full source patch SHA `f17b1b919980c15a79ba286b1216898632eddf7cbe91ce3acb387f873e63a3bd`).
Actual mutation proof: `~/.cache/nodeterm-android-work/modal-reconnect-mutations-qcaln9wi/`
(`mutation-result.json`, SHA `ed1e89f8cf26c6a59da993087851ab39dc22ae1e0d240594274cb337cdb7611d`).

## A126

**Co-view xterms duplicate automatic terminal replies into the retained process (2026-10-06).**

- Severity: **medium**; effort: small; area: Desktop renderer terminal input; kind: bug.
- Status: **source-fixed in `5b7286b3`; regressions/TypeScript/mutations, forced950/98/app gates and eight bounded Linux Desktop reconnect cases pass; one quiet native park/adopt + inactive-global case passes at `59e4c93e`; wider scope remains open**.
- Observed source/build: `415dae9b66b74c5165fab312e6c4cda3ed78a957` (A125 repair).
- Locations: `TerminalNode.tsx` and `ModalTerminal.tsx` unconditional xterm `onData` forwarding;
  `src/renderer/terminal/xterm-input.ts`; installed xterm 5.5 `CoreService.triggerDataEvent`.

**Retained failure and subsequent diagnosis.** One owned product ControlMaster SIGKILL triggers
normal automatic recovery in the fresh Linux Desktop Modal soft/none control. Replacement Modal
and Canvas create requests use the new session. Both views then send automatic DA1/DA2 responses
(7 and 11 bytes each). The retained strict producer records 18 unexpected bytes with SHA
`5df79d99ea5f3f007797bd1da48825081c9b5db6800cd1c8935c92218c3ab7ed`, exactly matching
`ESC[?1;2c` followed by `ESC[>0;276;0c`. Its initial trusted native `g` ACK is clean; final count
remains one, and ACK 2 is **not attempted**. Replaying output to two xterms must not inject a second
set of automatic replies into the live inner process. Do not whitelist these bytes in the producer.

The original wrapper/runtime exit codes are **1/2**; the retained receipt remains
`admission-or-verification-unclassified`. Root and peer review subsequently diagnose A126 from
that unexpected-input digest and actual xterm source. This later interpretation does not rewrite
the receipt or turn the failed run into a positive. Completed before-outage/gap observations retain
their own same-grid history/pane/producer evidence; no complete recovered history, native input,
wrapped-link matrix or broader outage/platform result is established by this failed control.

Proof: `~/.cache/nodeterm-android-work/nodeterm-linux-ssh-reconnect-case-_llfwbzw/proof/`.
`receipt.json` SHA `91d894114b86b167c072a27b7e53ddadbd711cf3dcbed6f18ebdd184d3b48cdf`;
`runtime-result.json` SHA `b3eab62f56c7a3d755498c84def73b320144be22937531c91568a4ae66f05930`.
The earlier `11e22453` A125 stale-card product negative, historical Canvas controls and geometry
calibration failures retain their original source bindings and classifications.

**Source repair and bounded verification.** The independently reviewed `xterm-input.ts` repair
uses xterm 5.5's actual input origin: public `onData` erases that flag. One live automatic-response
owner is scoped to the exact `api.pty` object and actual session id within one renderer. Exit,
closed/recycled subscription and final disposal release it, promoting another live view. Genuine
keyboard/paste/SGR mouse input and actual DOM focus/blur from every view remain intact. For
automatic DEC1004 focus-state replies, prefer the connected textarea that is its owner document's
actual active element; a stale focus class is insufficient. Canvas park retains the xterm,
subscription and lease, and adoption does not rebind or rewrap it. Actual Canvas mounting passes the
separate native matrix below; the later two-host case adds one quiet native park/adopt cycle with
carried-writer SID provenance, without a post-adopt Canvas input/current SID-ref claim. An unsupported private xterm shape warns
explicitly and preserves public input through a fallback where duplicate replies remain possible.
The legacy `onBinary` path is unchanged; no new integration proof is claimed.

Sixteen new cases comprise **nine installed xterm 5.5 dependency cases**, **one explicit unsupported-
shape shim case** and **six mounted Modal cases** with fake rendering and real helper,
LocalTransport and SshReconnector. They exercise automatic parser replies, reply-shaped genuine
input/paste, actual SGR mouse-origin dispatch, real private browser focus/blur, focus-query election,
live promotion/retirement, exact API/session scopes, nested origin restoration and synchronous
first output. All **294 unique affected tests in 17 files** pass with zero failures/skips; full
TypeScript passes with ordinary composite/incremental caches. These public `Terminal.input` checks
remain distinct from the separately accepted native textarea/mounted-Canvas observations below.

Nine actual isolated variants remove ownership, user origin, API/session scope, promotion,
focused-query election, genuine-focus origin, pre-output binding or Modal generation retirement.
Each fails intended AssertionErrors (respectively **9/3/1/2/8/2/1/1/3** failures). Both **25-test**
control/restored runs pass, with candidate/main bindings and restored source hashes retained.
Private final candidate proof: `~/.cache/nodeterm-android-work/a126-response-owner-candidate-g0ish79q/`.
`candidate-final-result.json` SHA
`21009c892e4c2dc0ec676d6c09ad67b8a8a34ef9cd06ccf8b43d45a3bb551f12`;
source patch SHA `495104f45339832a0b04f98e09177ce57bd63d5c698f5c11563c056c11f4756d`.
Actual mutation proof: `~/.cache/nodeterm-android-work/a126-response-owner-mutations-hwj1f9iq/`,
`mutation-result.json` SHA `73f4a110bbf6256c81796fb062d7aec485a8d04ba3138fcdacfe206765cbfc50`.
The earlier receipt's wording counted all ten helper cases as installed-xterm cases; the final
receipt preserves that history and explicitly qualifies the one fallback shim separately.

**Accepted native reconnect matrix.** Root independently accepts all eight cases on exact
source/built revision `5b7286b302440c210bb204fbe2d7821f7b37b9f0`, tree
`24da00670b41251ef61c2a914a77b4b2a8afbe03`.
Eight actual Linux Desktop **Canvas/Modal × soft/hard wraps × inner none/SGR mouse** cases
pass at `5b7286b3`. Each loses one birth-pinned product ControlMaster, creates a new master/
selected local viewer and retains its remote pane/server/producer/cwd and complete same-grid history before,
during, after and at final observation. Both trusted actual textarea `g` inputs are acknowledged
on the old/new PTY: **16 ACKs**, **zero unexpected bytes**, one producer paint per case and
**16 complete URL activations**. Native hover/leave and exact owned cleanup pass. Modal cases
use `80x24`; Canvas cases use `49x48`, with each history comparison bound to its own grid/case.
The selected open Modal stays open and replaces its viewer. The strict producer/classifier is
unchanged; no automatic-reply bytes are whitelisted.

| Surface | Wrap | Inner mouse | Grid | History lines / bytes | Receipt case |
| --- | --- | --- | --- | --- | --- |
| Modal | soft | none | 80x24 | 74 / 6550 | `qwis3lax` |
| Canvas | soft | none | 49x48 | 74 / 6941 | `9ypju82g` |
| Canvas | soft | SGR | 49x48 | 74 / 6941 | `3jmljmrc` |
| Canvas | hard | none | 49x48 | 112 / 6979 | `gguaxz39` |
| Canvas | hard | SGR | 49x48 | 112 / 6979 | `eq912pi1` |
| Modal | soft | SGR | 80x24 | 74 / 6550 | `7fq_jkva` |
| Modal | hard | none | 80x24 | 92 / 6568 | `qkf4lynp` |
| Modal | hard | SGR | 80x24 | 92 / 6568 | `c4t8_1qo` |

Private native aggregate: `~/.cache/nodeterm-android-work/a125-a126-native-matrix-ww8e8nwo/root-acceptance.json`,
SHA `d8a5366b83d4c4b3ada9a1112521f762905ce3b835be4a32983ce9150f4f391a`.
It binds all eight receipt/runtime hashes, geometry/history/timing and exact cleanup.
Each case is `nodeterm-linux-ssh-reconnect-case-<case>/proof/receipt.json`; root independently
checks raw runtime/service/log/ready/tool evidence. The historical `11e22453` stale-input and
`415dae9b` unclassified DA controls remain unchanged.

**294 unique affected tests / 17 files** and full incremental TypeScript pass. **15 isolated
mutants (six A125 + nine A126)** are caught by assertions; each fix's control/restored runs pass.
Forced offline checks at `5b7286b3` execute **950 tests / 98 suites**, zero failures/errors/skips,
and both protocol/app Kotlin compile tasks. These are disposable QA hosts; no new APK or regular
Desktop installation is included. Publication requires fresh offline gates and all five Android
CI jobs for the exact published HEAD; its private bundle and final report carry that run's result.
Forced protocol executes in 128.019 seconds; app/protocol Kotlin compilation in 19.041 seconds.
All 2,465 tracked source bindings and tools stay unchanged. Private gate receipt:
`~/.cache/nodeterm-android-work/5b7286-offline-gates-_68rpcak/gate-result.json`, SHA
`4c35734a2c9654d4d76f061defa147281875f25aa33e046ba8b44da5593e9e0e`.
A125/A126's 15 actual mutants retain separate 28-/25-test passing control/restored runs.

**Bounded two-host global-card and park/adopt follow-up.** One actual Linux Desktop soft/none
case passes at exact source/build `59e4c93e5b1256e9882205700d4907a5d43a8e20`, tree
`0f4753c65b858003a0d1560c3cf278cbffb48fd0`, in 27.39 seconds. Two distinct private OpenSSH hosts
have independent owner projects and remote PID namespaces, with source-reviewed private home/tmp
mounts; a separate raw mount-namespace probe is not retained. B's global Modal stays open through
ordinary native palette B → A → B → A switches; one quiet pre-outage park/adopt cycle retains
its installed xterm/core/input/focus wrappers, ordered subscriptions/API, full renderer buffer,
remote history and existing native client/master. The SID witness comes from actual primary
create/native Canvas `g1` and the carried identical writer with no create/detach/client replacement;
Canvas's lifecycle-closure SID is not an observed current/adopted React ref. No post-adopt Canvas
input or streaming/expiry/eviction result is claimed.

With actual A active/mounted and unchanged, B alone loses its birth-pinned product ControlMaster.
Its continuously open inactive global card recovers on B's new master and fresh warm selected
viewer/session; no inactive-B Canvas creation or launch replay occurs. Native Canvas `g1`, inactive
Modal `g2` and recovered Modal `g3` each receive one exact ACK. Both complete wrapped URL controls,
zero unexpected input, one paint per role and full `80x24` retained B pane/server/producer/cwd/history
before/during/after/final pass. A master/client/pane/producer/grid/history/input/routing stay unchanged
within the acceptance window. Exact per-role observer/session/master/daemon cleanup and generated-
auth removal pass. This adds no product repair, test or mutation count, APK, regular Desktop update
or ordinary-Quit proof. See [the bounded two-host follow-up](android.md#inactive-global-card-owner-and-bounded-parkadopt-2026-10-06) for detailed scope and build pins.

Private proof: `~/.cache/nodeterm-android-work/nodeterm-linux-ssh-global-owner-6lens2kd/proof/`.
`receipt.json` SHA `e923f8fca25e05aa9869ab3bd22e4b2444147e41621c2bf0a8ca38465ece78c3`;
`runtime-result.json` SHA `313413ea48f371b6fbc62e2d03c14af7f0b0fcd0c573110c9d18137f0da13adb`.
Root acceptance: `~/.cache/nodeterm-android-work/a125-a126-global-owner-root-mq6v7w7z/root-acceptance.json`,
SHA `7cb20c71a52dfc3bf968073170867b6e7ff199957e23a664a5ffebb5e3ab453d`.
Independent review: `~/.cache/nodeterm-android-work/ssh-global-owner-independent-review-kn_5dsw4/independent-review.json`,
SHA `7fc9ace6926a5004ee5a8c817d664fde59f8cf6d83d26a9e1ca5fa3a03cd869a`.
The earlier `nodeterm-linux-ssh-global-owner-3fmkgrkj/proof/` fixture refusal stays historical:
exit 2 before park/outage required a nonexistent Canvas React SID ref. It receives no product-
negative or repair credit; the corrected driver preserves that diagnostic and every other oracle.

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

## A127

**A closed SSH viewer falsely reports that its retained host session ended (2026-10-06).**

- Severity: **medium**; effort: small; area: phone; kind: bug.
- Status: **source-fixed in `0d50075a`; beta 17/code18 Pixel 7a viewer-only exit and same-producer
  manual Reattach/draft input physically verified at `a79375c3`; wider device scope pending**.
- Location: `android/app/src/main/kotlin/dev/nodeterm/android/ui/TerminalController.kt`,
  `sinkFor(...).onExit`; `android/protocol/src/main/kotlin/dev/nodeterm/protocol/host/HostConnection.kt`,
  `TerminalSink.onExit`.

On the intended Pixel 7a's beta 16/code 17, terminating only the owned attached tmux viewer
reports SSH exit 1 and displays “The session ended (exit 1).” Native observations show the
original server, exact producer pane/process generation, cwd and history still present.
Manual Reattach opens another viewer onto that same shell. The stream's status does not
establish producer death. Evidence is bound to the
[physical receipt](android.md#pixel-7a-lifecycle-scroll-and-input-follow-up-2026-10-06), particularly
`26-after-channel-drop.xml`, `27-channel-settled.xml`, `27-native-channel-recover.json` and
`channel-interruption.json`.

The fix uses `TerminalExit.closedMessage`: every numeric exit describes the terminal connection
closing; an unknown exit retains “Disconnected.” It clarifies the stream-exit contract without
changing retry conditions, budgets, generation checks or Reattach. It does not infer liveness
from stale listings or automatically retry arbitrary nonzero failures.

Three actual JVM methods and offline app compilation pass. A compiled actual callback harness
passes all twelve control/restored cases; three isolated mutants fail assertions, including a
controller bypass of the neutral helper. The old callback baseline fails four assertions.
The harness uses immediate Handler, viewer-slot and retry-admission fakes; it supplies no native
producer-liveness, Android lifecycle or updated APK proof. Independent read-only review finds
no material issues. No wire shape or iOS client change is required.

The later [beta-17 checkpoint](android.md#pixel-7a-beta-17-upgrade-and-composed-send-2026-10-06)
physically verifies the neutral exit-1 notice after terminating only the captured viewer, Send
being disabled and draft retained. Manual Reattach preserves the exact producer and full `50x40`
native history, then submits that retained draft once. This proves one viewer-only case,
not producer death, arbitrary nonzero retry, transport outage or the full lifecycle matrix.
The final owned cleanup passes; the frozen nine-case/303-raw-hash physical receipt is
`nodeterm-new-phone-fixture-q5v1nuem/proof/physical-pixel7a-beta17/qa-report.json`, SHA-256
`ece4fa48d31fab55a9f5158f475b4415e9c116c8a2f1683ec48295bf42e55e6b`.
Ordinary native Quit and the wider lifecycle matrix remain unverified.

Private proof: `/tmp/nodeterm-a127-proof.json`, SHA-256
`75069aa576ae694cd1b7b8248a9b81c2364882eb37a00d1ccabb93157bf49f67`;
compiled callback recipe `/tmp/nodeterm-a127-verify.py`, SHA-256
`4956f76e79041e585bf9312395d24ccaa1af341539928f73d3cf3cb850e257cc`.

## A128

**2026-10-08 lost-receipt follow-up (bounded physical pass):** The exact production Enter
receipt reader is killed from its first positive 22-byte read EXIT after one original-shell
execution, with real pidfd/wait-status death evidence. Fresh XML observes the exact newer draft
and disabled Send before loss; the draft remains through automatic original-shell recovery.
One real ACK/witness stays unique over 120 seconds later with the original terminal/producer/
complete sibling guard held. Owned cleanup completes. Android's internal composed status,
whole-host/network loss, native-route loss and remount/Ctrl remain unverified; no new finding,
source/wire/APK change or original ledger promotion occurs. See
[the measured receipt loss](android.md#lost-send-reply-and-newer-draft-2026-10-08).

**2026-10-08 retained-receipt follow-up (bounded physical pass):** A fresh beta21/direct-SSH case
observes the exact newer 146-character draft and disabled Send before a measured post-execution
receipt hold ends. The same draft remains with Send enabled after release; one original-TTY
witness/ACK stays unique 168.735781 seconds later with the original terminal/producer/guard held.
Owned cleanup completes. At that checkpoint, lost reply, blackhole, remount/Ctrl and native TLS/history were unverified;
the earlier partial wrapper and original 64-row ledger are unchanged. See
[the measured receipt hold](android.md#held-send-reply-and-newer-draft-2026-10-08).

**2026-10-08 physical follow-up (bounded partial):** One normal Send and a newer-draft suffix
return before a nine-second pause of the original SSH peer ends. The final required XML observation
misses that deadline, preserving the wrapper failure. Later the exact newer draft remains visible
with Send enabled and one original-TTY witness/ACK stays unique 125.310 seconds later. This is no
strict timed-race, post-write held-result or lost-reply pass; the installed beta21/source `ef4caec2`
and original 64-row ledger stay unchanged. See [the bounded follow-up](android.md#nine-second-send-and-newer-draft-follow-up-2026-10-08).

**2026-10-07 backend follow-up:** Current local relay Send also routes to the captured direct
native Windows PTY or a session host negotiating `composed-input-v1`. Internal v2
prepare/write/cancel requests use host-minted one-use tickets bound to the exact live session
generation and subscribed socket, with a 10-second expiry and per-terminal lock across paste
and a separately checked Enter at least 150 ms later. The client checks the captured subscriber
registration and original transport inside its deferred send. A sent-phase receipt loss or
RPC exception stays uncertain without replay; old hosts refuse without restart. Busy/stale
attachment refusals do not request an update. The Android outer action/result is unchanged;
actual producer-to-Kotlin tests accompany the host change. The separate Linux kernel-PTY proof
and native byte-recorder interop do not verify physical Windows ConPTY or phone use of these
backends. See [the source/verification checkpoint](android.md#composed-send-backend-follow-up-2026-10-07-a128)
for final evidence and limitations; iOS availability adoption remains with **@eneskirca**.

**Composed Send clears a draft without submitting it while tmux history is open (2026-10-06).**

- Severity: **high (BLOCKS a reliable input release)**; effort: medium; area: input; kind: bug.
- Status: **source-fixed in `7e7d2c04`; beta CI registration in `5484ab9f`; merged 982/102 protocol and app,
  affected 187/11/full TypeScript and all-five CI pass at `a79375c3`; beta 17 emacs/vi Send, controlled vi
  reconnect/raw Ctrl and exact owned End/cleanup physically verified; wider device cases pending**.
- Location: `TerminalController.submit`, `TerminalScreen` Send, `ComposedCompletion`,
  `ComposedPreparation`, `TerminalActions.submit`, `SshHostConnection.SshStream.submitComposed`,
  `SshComposedInput`, `RelayHostConnection.Stream.submitComposed`, `PtyManager.submitComposed`,
  `core/composed-tmux.ts` and `host-service.ts`'s `pty.submitComposed`.

Two intended Pixel 7a cases reproduce input loss: composed Send in vi copy mode after a real
SSH transport interruption, and composed Send on a healthy connection in emacs copy mode.
The bar clears, but the exact original shell has no command or marker. In the healthy emacs
case, copy mode remains active at position 70 and the full native capture is unchanged.
The preceding automatic reconnect and history preservation pass; subsequent composed delivery
fails. The receipt keeps the pre-Send capture separate from the actual post-Send capture.
Evidence: `25-unsent-draft.xml`, `30-transport-settled.xml`,
`32-native-after-explicit-send.json`, `35-copy-mode-draft.xml`,
`35-native-copy-before.json`, `36-copy-mode-after-send.xml` and `37-native-copy-after.json`,
bound by the [physical receipt](android.md#pixel-7a-lifecycle-scroll-and-input-follow-up-2026-10-06).

Installed beta-16 Send returns success when JavaScript is queued, then clears the draft. Native scroll
cancellation removes pending swipes but does not cancel host copy mode; raw stdin reaches the
tmux history viewer rather than the foreground shell. Ordinary raw input, terminal reports and
wheel events cannot globally acquire copy-mode cancellation semantics.

The source fix awaits an explicit composed action on the captured viewer's input actor. It
stops JavaScript momentum, removes unsent scrolling and orders Send behind the reserved
in-flight scroll. Native attestation binds the attached viewer, server/session and exact
pane/process generation; retirement refuses unsent work before queued SSH detach can run.
Host history cancellation affects only that captured pane. Nonempty paste uses tmux-owned
bracketed framing, followed 150 ms later by a separate Enter with a fresh identity/lifetime
guard. Failure after paste is uncertain. Ctrl remains one raw byte without framing or Enter;
payloads use private stdin/buffers, and no uncertainty replays.

`ComposedCompletion` accepts one delivered receipt only for the same current viewer. The screen
clears only an unchanged draft revision, including protection against editing away and back to
identical text; a newly rearmed Ctrl survives. Refused, uncertain and stale completions retain
input. `ComposedPreparation` treats a synchronous WebView provider throw as a refusal without
leaving Send busy. Positive delivery means submission to the attested pane/PTY, not command
execution. Direct Unix SSH and current local-tmux relay support this action. Legacy/unverifiable
hosts, native Windows/session-host and SSH-project relay routes explicitly refuse, retaining the
draft without a raw-input or `node.sendKeys` fallback.

The additive **`pty.submitComposed {streamId, input:{kind, text, enter}}`** returns
`{status:"delivered"|"refused"|"uncertain", message?}`. The Android client and actual
`android/protocol/src/test/interop/host-fixture.ts` land with the host in `7e7d2c04`.
**iOS @eneskirca** needs the same explicit awaited action, exact receipt, paste/Enter separation
and draft-retention policy, including honest old-host refusal. Existing raw frame/report/wheel
semantics are unchanged.

The frozen candidate passes **170 distinct affected Kotlin methods / 8 suites**, **187 affected
Vitest tests / 11 files**, full TypeScript and forced offline app compilation. Actual isolated
SSH/tmux fixtures cover both copy modes, sibling-pane isolation, raw Ctrl, separately timed
Enter, viewer retirement and uncertainty. All **26 source mutants** (17 Android, nine host)
fail assertions; control/restored runs pass, including the supplementary 42-test host control
with 11 native cases. `5484ab9f` registers the four host suites in private-beta CI. **Nine actual
Gradle/JUnit configuration methods** pass; deleting each registration fails an assertion, with
control/restored checks passing, for **30 assertion-caught mutations** total.
Independent read-only source/evidence review finds no material issues.

Aggregate V2: `/home/mgysin/.cache/nodeterm-android-work/a128-composed-submit-candidate-elbunqup/a128-composed-review-v2.json`,
SHA-256 `34a0044207b64b5627f0a8653a9969234430a51b697d8ef589220f9e9a26b68f`.
CI registration proof: `/home/mgysin/.cache/nodeterm-android-work/a128-ci-coverage-tzs459s8/proof/receipt.json`,
SHA-256 `6f5b956e6c4ff2d9c0f8a6c070ba429b1cfe8c1175852c56bf30be159c5720f9`.
These source/configuration and isolated native-fixture results remain separate from the later
[beta-17 checkpoint](android.md#pixel-7a-beta-17-upgrade-and-composed-send-2026-10-06). Exact
merged `a79375c3` executes 982/102 protocol and app and affected 187/11/full TypeScript successfully; run `37523703627`
passes all five jobs/ten critical steps. Retained-signer beta 17/code18 is installed with the
exact prepared/installed APK hash and saved temporary SSH profile preserved without pin edit
or key readmission. Bounded emacs and vi copy-mode Send each reach the original producer exactly
once, exit copy mode and leave the guard unchanged. Controlled vi transport recovery retains
the draft with Send disabled, then recovers the same pane and byte-identical full same-grid
capture; its scroll position changes, so exact position preservation is not claimed. One raw
Ctrl+C submits exactly `03`, without another byte in a bounded 0.8-second window. Actual phone
managed shell creation and exact owned SSH End pass; the original guard/canvas-node behavior
is preserved. Only the temporary profile/admitted public key are retired, restoring the
original authorization file; nonce-validated cleanup removes generated private auth and closes
both owned listeners with source/tools/build outputs unchanged. Ordinary Quit is unverified.
The frozen nine-case/303-raw-hash report has SHA-256
`ece4fa48d31fab55a9f5158f475b4415e9c116c8a2f1683ec48295bf42e55e6b`.
Changed-host-key enforcement, controlled edit/rearm/stale-completion/uncertain-ack races, other
control combinations and provider/device cases remain pending; no full checklist/relay/cellular/
real-PAM/power-loss/platform or SDK-37 acceptance follows. Installed APK/runtime source stays
`a79375c3`; later docs-only publication gates/CI have separate receipts and imply no reinstall.
The original **10 Pass / 22 Partial / 32 Pending** ledger is unchanged. See also the
[source checkpoint](android.md#composed-send-source-checkpoint-2026-10-06-a128).

## A129

**Native history swipes send wheel input to the foreground when application mouse reporting is off**

- Severity: **medium**; effort: medium; area: input; kind: bug.
- Status: **Source-fixed in `0818bbed` and `2d693263`, published with mandatory gates and
  exact-head CI at `1add0408`; physical acceptance pending.** Later genuine Linux Desktop V8/V9
  pilots stop at blank readiness before input. V8's eight-second gate is shorter than supported
  cold-create budgets; V9's 30-second gate and complete all-thread snapshots still do not prove
  original creation or attachment. [Scoped evidence](android.md#fresh-fedora-output-and-native-desktop-readiness-2026-10-08)
  retains both negatives and exact owned cleanup without product attribution or acceptance credit.
  The confirmed failure belongs to
  `ce1121ba56617defd7facdd44743d416e92b19e4`; its original receipt remains historical.

On that confirmed source, Android's `terminal.js:435–446` drained every history gesture through
`bridge.onScroll`. `TerminalController.onScroll` and `TerminalActions` ordered that action, then
`RelayHostConnection.scroll` called `pty.scroll`. In `src/main/remote/host-service.ts:638–660`,
the handler assumed a tmux client and wrote fixed SGR wheel bytes through `pty.write` without
checking the backend or current application mouse mode. `PtyManager.write` forwarded them to
`session.proc.write`. For direct native Windows and session-host panes, this was foreground
input, not a retained-history viewport. The native emulators already retained history; its
existence did not make that wheel route browse it. A swipe could therefore feed unexpected
terminal input to an application that had requested no mouse reports.

The isolated component receipt is
`/tmp/nodeterm-native-scroll-triage-ylpvdie0/receipt.json`, SHA-256
`c5d50310e539ad02d1c825ac12d19865b4c488184d1d50a8c809aad44b7cbb1a`.
Freshly compiled Kotlin `RelayConnector`/`RelayHostConnection` calls reach the actual approved
E2EE host handler, `NativeWindowsPane` and standalone session-host/client with real emulators.
After synthetic output disables mouse reporting and supplies 200 history lines, scrolling up
three and down two notches records three `ESC[<64;1;1M` and two `ESC[<65;1;1M` writes in each
backend; retained history remains available. The PTY writers are explicit byte recorders and
the host PTY bridge is a component adapter. This is not full Desktop, WebView gesture, kernel
PTY, foreground CLI, physical Windows ConPTY or phone acceptance, and earns no mutation credit.

Existing tmux and direct-SSH scrolling provenance remains unchanged: those streams attach real
tmux clients with mouse handling enabled. Their custom-binding, gesture and momentum checks do
not verify native-backend history scrolling. A128 composed Send is a separate action and does
not resolve this bug; at that earlier checkpoint, installed beta 17 and the original
**10 / 22 / 32** checklist were unchanged.

**Published source-fixed implementation.** `pty.attach` advertises `scrollV1:true`;
`pty.scrollV1 {streamId, dir:"up"|"down", lines:1..20, viewId?}` returns `history` with `viewId`,
`offset`, `totalRows`, `cols`, physical `rows`, `olderTruncated`, `hasOlder`, `hasNewer`, or
`input`/`refused`/`uncertain` (a message accompanies refusal/uncertainty). Each row carries
printable text, wrap flag and normal/alternate section. The exact attached stream owns a
**1 MiB/8192-row** snapshot, bounded **256 KiB/200-row** pages, a **60-second inactivity TTL**
and a **32-action FIFO**; the process budget is **16 MiB**. Each notch moves **three physical
rows**. Foreign/expired tokens refuse. A valid token pages stored rows without PTY operations,
including when the live app changes its mouse mode, until Live/user input/resize/new intent
clears it. A new intent without a token reads the actual headless xterm **6.0.0** tracking and
encoding behind output/geometry, with zero native input when off and requested default/SGR/
pixel encoding when on; unknown state names a refusal. Negotiated `scroll-view-v1` serves
`scrollViewV1 {name, generation, up, lines, capture}` bound to the exact session-host generation
and original subscribed socket. Direct native and known-tmux routes bind their captured viewer;
no background/name-only fallback or uncertain replay exists.
Legacy known-tmux/direct-SSH gestures, copy mode and momentum retain their separate evidence.

Android keeps the actual shipped xterm **5.5** live parser and displays these rows in a separate
inert layer. Actor/page/display epochs reject stale completions; visible-row Copy and links do
not consult an unrelated live buffer. Host/client/producer interop change together; iOS
@eneskirca must adopt capability, page fields and view invalidation together.

Current evidence is **34 leaf tests/3 files + 20 assertion-caught mutations**, **343 backend
tests/37 files + four existing Windows-only skips + 21 assertion-caught mutations**, and **13
root helper/RPC control/restored cases + 18 assertion-caught mutations**. These are actual
emulators and protocol/component/recorder boundaries, not physical ConPTY/kernel PTY/phone
acceptance. A separate startup-cleanup control/restored test and one assertion mutant pass.
Focused Android control/restored runs pass 99 methods/11 suites and offline app checking; its
14 assertion variants comprise 13 behavioral mutations and one posted-Runnable source pin.
Separate CI-reader control/restored checks pass 11 methods and catch eight configuration-input
deletions, not eight more production mutants. The durable Android index
`a129-android-proof-l9kmrcc0/index.json` has SHA-256
`4ceeaacb141c1fc218644676d4287c15ed325f5d0b29a98fbea3fd36629242af`; the separate CI-reader index
`a129-android-ci8-proof-p6uyz7nw/index.json` has SHA-256
`f39a53b7b4f37135f923a5019660feade9701d82addbbfebb34fb3d5b82a11fd`. Each layer retains its
own source binding and classifications; no aggregate mixes them or prior attempts.
Published integration `1add0408` passes forced fresh 1012/105 protocol checks with no
failures/errors/skips, offline app, 568/52 affected Vitest tests with exactly four existing
Windows process-tree skips, full TypeScript and all-five/ten-step Android CI `37602046133`,
attempt 1. At that earlier checkpoint, signed beta 18/code 19 was ready and not installed on the intended phone, SHA-256
`19d55ee177335064b1edb4874b6d27216862d16a7d30ebe476875c566cd263e0`; actual retained-signer
artifact checks use SDK 36, while SDK 37 artifact verification is unavailable. Actual app/WebView
and physical ConPTY/phone acceptance remain unverified. Regular Desktop is not deployed and
no PR is opened. At that earlier checkpoint, installed beta 17/code 18 from `a79375c3` and the
original 10/22/32 physical ledger were unchanged. The separate published
A128 `944223ef` 984/102 protocol, 360/26 Vitest and all-five/ten-step CI `37594743169` checkpoints
are historical bindings, not A129 verification. Source-fixed does not promote the physical checklist.


## A130

**A held touch on the displayed Live button leaves the previous fling running until click**

- Severity: **medium**; effort: small; area: input; kind: bug.
- Status: **Source-fixed in `9da36320`, published in `5bda2c32`; mandatory gates/CI pass and
  beta 19/code 20 is installed. Actual app/WebView/physical behavior acceptance remains pending.**
  The failure below belongs to `1add0408`.

On confirmed `1add0408`, `android/app/src/main/assets/terminal/terminal.js`'s Live-button `touchstart`
listener stops propagation without calling `cancelScroll`. The terminal host's `touchstart`
listener normally cancels the old fling, but that stopped event cannot reach it. The Live
`click` later calls `cancelInputScroll`, so a held touch continues old scrolling before click.

The shipped-source probe uses an outside-repo derivative of the existing terminal driver
with explicit child-to-parent event bubbling, stub DOM/xterm/bridge and deterministic RAF.
Original and derivative baseline results match. During a 512-ms held touch on the displayed
Live button, it records **20 additional requests / 23 notches**, matching the no-touch
control, with no new stop callback. Terminal-surface touch stops immediately; clicking Live
then stops and closes history. Receipt `a129-live-held-probe-h2m613ux/receipt.json`, SHA-256
`b89954c2f959b63df727b986ebcf260e64dac716dd20ef65cb76e0d370d624ea`.

The original reproduction is source event behavior, not actual WebView, real host transport,
emulator, physical ConPTY or phone acceptance, and earns no mutation credit.

**Focused source fix.** Live-button touch-down calls `cancelScroll` before
`stopPropagation`. Old momentum and the native pending-scroll queue stop immediately;
history and its display epoch remain intact until click. Three new `TerminalJsLiveTouchTest`
JVM methods cover held/moved touch without a parent gesture, ordinary click/obsolete page,
and cancelled press/current page. Control and restored runs pass **48 methods / 7 suites**,
zero failures/errors/skips; **three semantic mutants** (old handler, premature history close,
parent gesture) fail assertions. Receipt `a130-live-touch-proof-3thll7zv/receipt.json`, SHA-256
`7eae4fd3f280d945be7dae6544c6569cea9d931b7818dd91e78bceae01be9753`. This focused proof uses
the shipped page through explicit DOM/xterm/bridge stubs and deterministic RAF with a
compiled JVM harness; it does not promote actual WebView or physical acceptance.

Published `5bda2c32` passes forced fresh 1015 methods/106 suites with zero failures/errors/skips,
offline app/full TypeScript and exact-head five-job/ten-step CI `37608652625`. Retained-signer
beta 19/code 20 is installed on the intended Pixel 7a, SHA-256
`e7271ebe1c1d65d8f6a09f7c59ab4b0042081c152c421568caabdcf6965bad42`; actual SDK-36 artifact
review `beta19-final-recipes-r5x3c9z6/build/artifact-review.json` hashes to
`9157b0f7b1369c1a1e899c67cb4a82dae973e5eac286f2cf28483f972c202186`. SDK 37 is absent.
[Canonical gates/provider/emulator receipts](android.md#beta-19-publication-provider-and-emulator-checkpoint-2026-10-07)
retain full hashes and scoped negative diagnostics, plus the measured 6.18-second same-signer
update's unchanged first-install time/notification grant/flags, public SSH identity continuity
and one fresh explicit-profile authentication/first pin through an owned ADB reverse tunnel.
Bounded beta-19 known-tmux emacs/vi Send, brief background draft retention, viewer-close/manual
Reattach and controlled SSH-handler recovery pass with exact owned cleanup. At that earlier
`5bda2c32` checkpoint, saved-profile/pin reuse, changed-key refusal and A105/A106 application
remained unverified; the later `e06b5547` phone cases above verify those bounded paths.
A129 native/session-host history and A130 held Live-touch acceptance remain pending. The failed
emulator provisioning and exact owned cleanup add no app/CA/APK proof. A129's earlier `1add0408` evidence and the original
64-item **10 / 22 / 32** ledger remain unchanged.

## A131

**Buffered output and commands waiting for page readiness can outlive their terminal viewer**

- Severity: **medium**; effort: small; area: phone; kind: bug.
- Status: **Source-fixed/published in `11fbff08`; full gates/CI and beta-20 installation pass at
  that earlier checkpoint. Beta21 bounded output/background and controlled SSH recovery/draft/Send
  pass; original A132 attribution and wider lifecycle/races remain open.**

At `644445aa`, `TerminalController` checks the viewer ticket before appending to a shared binary
buffer. Its delayed flush carries no ticket, and backgrounding leaves that buffer scheduled.
An old flush can therefore run after a new viewer paints, and a reader that passed the earlier
check can refill the buffer after retirement. `TerminalPage` also keeps untagged strings while
loading: old paint/output or raw/key commands can survive a reconnect on that same unready page.
These are source ownership findings, not reproduced physical failures.

`TerminalOutput` checks admission, viewer ownership and a one-use flush reservation under the same
lock. Snapshot admission replaces earlier bytes and gates later bytes behind its paint. Every
viewer retirement invalidates its buffer and callbacks; an ordered current exit flushes its final
snapshot/tail before retirement when the page is ready. The 16-ms batching and 192-KiB binary
chunks remain, including split UTF-8. `TerminalPage` tags viewer commands and drops them on
retirement, preserving page-global font setup and lifecycle suspension.

Eleven new behavioral methods exercise the actual Kotlin queue/page/slot with an explicit
scheduler and a paused producer. Three separate source pins check the app wiring. The focused
forced offline control/restored passes **71 methods / 8 suites**, zero failures/errors/skips,
including existing page/handoff/actions/composed-input/completion/keyboard-chip coverage. This is component/source
proof; it does not execute Android Handler/WebView or demonstrate a physical race. JavaScript
already dispatched to a ready WebView is outside this fix. Host verbs, pairing, mirrors and
SSH-visible files are unchanged; no producer interop contract changes. iOS implication for
@eneskirca: review equivalent viewer buffer/pending-page retirement, without a wire migration.

The unchanged queue/page/test's first frozen window passes 32/3 control/restored and catches ten
behavioral mutants. The tightened final controller's separate 71/8 window catches four app
source-pin mutants; the earlier three wiring variants are historical, not extra unique mutations.
[Canonical receipts](android.md#viewer-output-lifetime-source-checks-2026-10-07-a131) bind actual
compiled source, fresh XML and assertion failures. At that earlier beta20 checkpoint, fresh
1029/108/app/TypeScript and all-five/ten-step CI pass on `11fbff08`; the direct-SSH observations
show later rows in a resumed screenshot, but active-production background overlap is unproven.
A132/A133 then require separate completion/exit-display attribution. Later beta21 controlled
SSH recovery, two active Home/resume cycles, draft retention and one explicit Send pass as
[separately scoped](android.md#direct-ssh-reconnect-and-active-background-continuity-2026-10-08);
A133's closed-view checks are separate. Full physical lifecycle/race acceptance is not claimed.
A129/A130 need a trusted relay/native-history route; direct SSH supplies no Live history overlay.
The 64-item ledger remains **10 Pass / 22 Partial / 32 Pending**.


## A132

**Completion marker absent from native capture after all numbered output rows**

- Severity: **medium**; effort: unknown; area: verification; kind: gap.
- Status: **OPEN — reproduced bounded observation; product/fixture attribution pending.**

At signed `11fbff08` on an owned Linux/tmux fixture, one fixed Python command requests 1200
numbered rows and then `FLOW_DONE`; the final marker's actual emission is unproven. The native observer finds all rows 0000–1199 once and the
original shell owner restored, but `flowDone`/`complete` are false. Independent raw tmux capture
also lacks the completion marker, so this does not establish an Android queue drop. The default
Fedora prompt is a suspected interaction, not a proven cause. Preserve the original negative.
[Canonical receipts](android.md#beta-20-publication-and-bounded-output-checks-2026-10-07) bind the
native result `abdb84f3…` and raw capture `29ed9640…`.

A later native discriminator at docs-only `656e5d8a` passes two private tmux/Bash cases with
synthetic short and properly delimited long prompts. Both use 2-ms rows, capture all 1200 numbered
rows and the confirmed 24-byte completion write in raw pane/client and captured screen, restore
the same shell and retire the owned server. Private
`a132-native-discriminator-root-ttxny3ik/checkpoint.json`, SHA-256
`476ff53ed890a9c1fa2657e8b30e8e5cb7e705ee17efcaa5273e2cc53c1f202c`, binds 70 artifacts.
These are not the original Fedora prompt/40-ms command, SSH or phone checks; A132 remains open.

A fresh normal-Fedora login discriminator at `9b8bba2b` also passes with the unchanged original
226-byte/40-ms producer: all 1200 rows and one standalone marker are present in output-only raw
recording/native capture, with marker bytes in the client raw stream. Existing Bash OSC3008
reports success, but no producer wait status or final-write witness is added. Current user/hostname,
private cwd and native literal send-keys delivery do not establish historical prompt/Desktop paste
parity. Exact owned cleanup and the independent 108-record review pass;
[canonical evidence](android.md#fresh-fedora-output-and-native-desktop-readiness-2026-10-08)
keeps the original negative and attribution **OPEN**.

Next: isolate the original completion and prompt ordering across raw PTY/tmux/transport/display. Add a regression only after identifying the failed
supported layer; a successful dispatch or numbered-row count alone must not satisfy completion.
No source fix, Android-only attribution or checklist promotion is claimed.

## A133

**Phone exit display no longer shows previously displayed terminal history**

- Severity: **medium**; effort: small; area: phone; kind: bug.
- Status: **Source-fixed in `94c8d2c4`, refined/published at `ef4caec2`; final 1033/110/app/TS and CI five/ten pass, beta 21/code 22 installed; bounded same-page retention, final-marker/Unicode clipboard paste and post-font OSC8/plain link offers pass; normal browser/Share pilot now measured as separately scoped; wider matrix unverified.**

On beta 20/code 21 Pixel 7a through direct SSH to the same owned tmux target, a separate real
phone Send contains `printf 'A131_17930152_MOBILE_FINAL_TAIL\n'; exit 0`. The later screenshot
shows `[exited]` and an exit-0 overlay without the prior displayed history. No byte capture before
exit proves that final marker was emitted; neither its loss nor an Android-only cause is established.
See [the exact screenshot/XML](android.md#beta-20-publication-and-bounded-output-checks-2026-10-07).

The later native immediate/delayed traces confirm tmux clears the alternate screen before leaving
it, so a leave-only capture is already blank. This change passively captures before `CSI 2 J` and
promotes only a current known SSH/tmux EOF after xterm's parse barrier. Its separate inert closed
pane retains visible rows, wraps, Copy and touch links through layout changes; new viewer/paint/page/
lifecycle retirement clears it. Blank captures replace stale text. Live TUI/parser behavior and
transport capabilities stay unchanged; there is no Live/input path from the closed layer.
The [local source checkpoint](android.md#closed-sshtmux-exit-display-source-checkpoint-2026-10-07-a133)
records 26 passing actual-xterm component cases, 11 semantic assertion mutants with 23-case
control/restored and one additional 26-case geometry assertion mutant. Permanent behavioral
JUnit and three app source-pin methods pass; final 1033/110/app/TS and exact-head CI pass at
`ef4caec2`, and beta 21/code 22 is installed. Bounded same-page retention/Copy-sheet/link offers
and font redraw pass. The later exact final-marker/Unicode clipboard paste and post-font OSC8/plain
link offers pass. The later [normal browser/Share pilot](android.md#fresh-fedora-output-and-native-desktop-readiness-2026-10-08)
records the address-field nonce/chooser preview; wider lifecycle checks remain unverified.
This preserves the last rendered pane on
one page, not backend full history/unpainted bytes or persistent history across backgrounding.
The original phone final-marker emission remains unverified. iOS needs the equivalent EOF/display
review by @eneskirca; no wire change is introduced.

The first full run at unpushed `94c8d2c4` exposed an integration regression: refit/font/resize
advanced the legacy submission epoch, dropping a same-view delayed Enter and failing the existing
swipe-barrier test. This follow-up advances that epoch only when the viewer/display clears;
geometry still invalidates pending EOF captures through the separate revision. All 16 focused
methods and the now-required 27 component cases pass. Reinstating the old epoch placement fails
only the new layout/Enter assertion, with healthy/restored controls passing. The linked source
checkpoint records this separately from the earlier mutation proofs. Final source publication,
mandatory gates, exact-head CI and retained-signer beta21 installation pass. The later bounded
Pixel7a case retains eight Unicode rows/wraps/final tail at exit0, exposes normal Copy-sheet
filtering/selection and exact OSC8/plain URL offers, and survives smaller-font redraw. Its
31-record physical review is `beta21-closed-physical-independent-xs0wdxrr/review.json`, SHA-256
`7145b2cac1c7fbfed39503de5ef00acec8c1bfbce13650bfe6b3b1e5dee364ab`. At that earlier pilot, clipboard
contents and post-font hit tests were not yet verified. The later fresh pilot in the linked checkpoint
verifies exact final-marker/Unicode clipboard paste and both URLs after smaller/restored fonts.
At that copy/link pilot, browser navigation and Share were untested. The later separately scoped
pilot is linked above; unrelated TUI/lifecycle checks remain unverified.
The exact owned target/logger exit naturally; fixture/profile/key/reverse/timeout cleanup is
separately recorded in the linked checkpoint. No full-device or A129/A130 acceptance is claimed.

## A134

**Login-shell executable-resolution probe can outlive its child timeout**

- Severity: **medium**; effort: small; area: desktop; kind: bug.
- Status: **Source-fixed/published; original create/visible prompt and scoped native capture/reload/input verified; native-history phone/gesture acceptance pending.**

`execFile`'s timeout sends a signal, while its callback can still await process/stream completion.
The shared PATH/environment resolver previously relied on that callback to settle cached callers.
The earlier passive original-create diagnostic at `70fde6b0` reaches the PATH await and no later stage
within its bound; the actual child's signal/profile/stream cause is unproven. This does not prove
native attachment or a shell absence, and the earlier V8/V9 negatives remain separate.

The local helper adds an independent five-second Promise fallback, guards settlement once and
ignores late callback values. It kills only its returned child while exitCode/signalCode are null
and releases that child's pipes; no descendant/PID/group search or global termination is added.
Parsing, shared-cache/coalescing, inherited fallback and Windows behavior remain. Focused checks
pass: 37 tests/three affected files, five existing Windows-only skips, seven assertion-caught mutants
with healthy/restored controls and full TypeScript. A separate controlled real-child comparison
also passes. Published `3f382367`/`0d8594a6` pass fresh 1033/110/app/TypeScript, 161 affected tests
with five Windows-only skips and CI five/ten. Fresh V14's original session-host create fulfills and
shows its Bash prompt without PTY input; V13 cause/fallback and native-history/phone acceptance
remain unverified. Every push still requires fresh exact-revision gates/CI. See the
[canonical stage/source checkpoint](android.md#login-shell-probe-completion-deadline-2026-10-08-a134).
This shared Desktop behavior also benefits the iOS companion; @eneskirca needs no wire change.
The installed beta21 artifact and original 64-row ledger are unchanged.

A separate fresh original-consumer case at immutable build `0d8594a6` and docs-only checkout
`98907171` passes both original factory/kernel admissions before producer input, capture of all
200 unique marker names with Unicode, normal renderer reload and `q`/`r` input/ACK to the same
original shell. The original daemon/state/socket/token/Bash/producer generations and complete
sibling capture stay unchanged; owned retirement is verified. This does not promote Android
native-history/Live, canvas gestures or full rendered payload parity. See the
[scoped consumer receipt](android.md#native-desktop-capture-and-renderer-reattach-2026-10-08).

## A135

**Delayed raw-input consumption clears newly armed Ctrl**

- Severity: **medium**; effort: small; area: Android input; kind: bug.
- Status: **Source fixed; policy/wiring controls and publication/install pass; phone timing pending.**

The bridge captures one immutable armed/revision snapshot and consumes only it on its current
viewer. Off/on rearm and stale-viewer callbacks preserve the newer arm. Five policy and three
wiring methods pass; three policy and one wiring mutant are caught. This is source/policy
verification, not a physical race reproduction. No wire change; iOS @eneskirca should compare
its local modifier lifetime. [Full scope](android.md#captured-ctrl-consumption-2026-10-08-a135).

## A136

**Retained terminal navigation entry loses its editor when composition is removed**

- Severity: **medium**; effort: small; area: Android navigation/editor; kind: bug.
- Status: **Source fixed/published and beta22 installed; one bounded fixed-phone remount pass.**

The Pixel7a/beta21 composer and checked Ctrl become empty/unchecked after normal PairHost
coverage and Back; both native panes and captures are identical. The corrected harness and
screen-timeout continuation are qualified in the canonical record. Full TextFieldValue/revision/
Ctrl now live in process memory per actual entry, with whole-stack retention and sealed retirement.
Send clears only its exact revision; pending Controller/speech and process-death restoration are
not added. Nine store and three wiring methods pass; seven policy and one wiring mutant are caught.
A135 is the source dependency. Signed-source publication and beta22 installation pass. One fresh
no-Send PairHost/Back retains the exact draft/checked Ctrl; original native controls remain equal
except a new phone client under the same SSH parent/session/TTY. Owned closure is verified with
the uncertain timeout result preserved and original 15000 read back; raw Ctrl timing, selection/IME
and pending-Send checks remain pending. No wire
change; iOS @eneskirca should compare local editor lifetime.
[Full scope](android.md#retained-terminal-editor-2026-10-08-a136).

## A137

**Retained terminal remount loses pending Send state and outcome guidance**

- Severity: **medium**; effort: small; area: Android input/navigation; kind: bug.
- Status: **Published at `b9e4cbc7`; beta23/code24 prepared and reviewed; installation/phone comparison unverified.**

Before the fix, the entry retained its editor/Ctrl, but a replacement controller started without the
old pending state or uncertainty notice. Once reattached it could offer Send for that draft without prior
guidance. This demonstrates an outcome-visibility gap, not a physical duplicate or automatic retry.
The fix shares button/IME admission through one entry-owned identity attempt, preserves a
visible uncertainty notice across remount and later refusal, and seals retired handles. Original
viewer/stream/actor and editor/Ctrl revision fences still prevent stale positive clearing. Twelve
behavior and three wiring methods pass, with ten behavior/three wiring mutants caught. Full1069/116
and offline app pass; fresh exact-source gates and CI37740459063 attempt 1 pass all five jobs/ten
required steps. Retained-signer beta23/code24/source `b9e4cbc7` passes 46 available SDK36/R8/metadata
artifact checks; actual SDK37 remains unverified. Pre-install snapshot refusal occurred before update
dispatch. Beta22/code23/source `2ba0b142` is last verified installed; guarded installation and the
controlled pending-Send phone comparison remain unverified. A136's no-Send evidence and the original
64-item ledger are unchanged. No host wire or process-death persistence change; iOS @eneskirca should
compare local entry-owned attempt/guidance lifetime. [Full scope](android.md#pending-send-outcome-after-remount-2026-10-08-a137).

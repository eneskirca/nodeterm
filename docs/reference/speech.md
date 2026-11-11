# Speech / dictation (desktop + server) — deep reference

Moved verbatim from `CLAUDE.md` so the always-loaded file stays small. `CLAUDE.md`
keeps a short summary and links here. When a rule here changes, update both.

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
- **Linux x64 ships TWO whisper binaries, picked per CPU (issue #1267).** smart-whisper's
  binding.gyp passes no `-m` flags, so on x86-64 ggml compiles at the SSE2 baseline and every
  AVX/AVX2/FMA/F16C kernel drops out (`objdump -d smart-whisper.node | grep -c ymm` = **0** on the
  shipped build). Measured, base model, 3 s of audio, 12-thread AVX2 box: **18.8 s** as shipped vs
  **1.9 s** with `-mavx -mavx2 -mfma -mf16c`, and the same 11.2 s → 1.5 s under Electron's ABI; the
  report was large-v3-turbo taking ~7 min for one sentence. `scripts/patch-smart-whisper.mjs` (run
  before `electron-rebuild` in `postinstall`/`rebuild`, beside the node-pty patch) adds a
  `smart-whisper-avx2` target behind a gyp `OS=="linux" and target_arch=="x64"` condition — mac and
  Windows builds are unchanged — and makes smart-whisper's loader read
  `globalThis.__NODETERM_WHISPER_BINARY__`. `pickWhisperBinary` sets it from `/proc/cpuinfo`.
  **Never ship a single `-mavx2` build**: on a CPU without AVX2 that is a SIGILL that takes the
  whole app down on the first dictation, which is why the baseline stays and why every failure
  (flags unreadable, variant file absent, variant fails to load) falls back to it rather than to
  "unavailable". `WHISPER_SIMD_FLAGS` and the script's `SIMD_FLAGS` must name the same set (pinned
  by `smart-whisper-patch.test.ts`, which also fails on an unpatched install). Threads:
  `whisperThreads` replaces whisper.cpp's `min(4, cpus)` with about half the logical CPUs plus two,
  capped at 8 — **not** every CPU: ggml's workers spin-wait, and 12 threads on 12 busy logical CPUs
  measured 12.8 s against 8 threads' 1.4 s. Not covered yet: macOS x64 (Accelerate, same missing
  SIMD flags in ggml), a GPU backend (this smart-whisper has no Vulkan build option), cancelling a
  running transcription, and the Server Edition (installed with `--ignore-scripts`, so it keeps the
  baseline; the startup log line `[speech] whisper binary: …` says which binary loaded).
- **macOS: smart-whisper's Metal shader path is patched to the unpacked copy** (second patch in
  `scripts/patch-smart-whisper.mjs`, marker `NODETERM-PATCH(smart-whisper-metal-asar)`). smart-whisper
  sets `GGML_METAL_PATH_RESOURCES` from its own `__dirname`, which in the packaged app is inside
  `app.asar`; native code cannot read inside an asar ("Not a directory"), so Metal init failed and
  whisper.cpp ran on the CPU with no error shown. The shader file is already unpacked (asarUnpack), so
  the patch rewrites `app.asar` to `app.asar.unpacked` in that path. MEASURED with the app's own binary
  on an M5 Pro, large-v3-turbo, 2.7 s clip: 5.97 s on the CPU, 0.64 s on Metal; in the app, dictation
  went from several seconds to under one. A dev install and an explicit `GGML_METAL_PATH_RESOURCES`
  are unchanged.
- **smart-whisper's model params are patched to start from whisper.cpp's defaults** (third patch in
  `scripts/patch-smart-whisper.mjs`, marker `NODETERM-PATCH(smart-whisper-ctx-params)`, every
  platform). Its `LoadModel` declared `whisper_context_params params;` and set only `use_gpu`, so DTW,
  `gpu_device`, `flash_attn` and the rest were uninitialized stack memory and the result depended on
  what was there. MEASURED on an M5 Pro, Electron 42, large-v3-turbo: the shipped binary crashed in 4
  of 4 runs outside the app (`aheads_masks_init` then a crash in `whisper_free_state`, because garbage
  switched DTW on with large-v3's alignment heads); with the defaults it ran without a crash, 0.56 s
  for a 2.7 s clip and 0.93 s for 21 s on Metal. The slow dictation inside the packaged app is a
  separate bug: Metal cannot read its shaders inside app.asar. A newer whisper.cpp is
  faster again (0.22 s / 0.43 s, measured the same way) but needs a build change on every platform;
  that is a separate follow-up.

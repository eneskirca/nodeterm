#!/bin/sh
# Checks the release build's R8 output against the runtime keeps in app/proguard-rules.pro (audit A37).
# CI runs it after `./gradlew :app:assembleRelease`, from android/:
#
#     tools/check-r8-output.sh [app/build/outputs/mapping/release]
#
# R8 finishing proves only that it accepted the rules. A keep whose class was renamed or moved matches
# nothing and R8 does not say so, so this checks the keeps MATCHED what they exist for:
#   seeds.txt    every class and member a keep rule pinned, under its original name;
#   mapping.txt  "original -> output:" for every class that survived.
# It checks only the targets named below (bridge methods are read from the source, so a new one is
# covered). A NEW class or member reached by name needs its keep in proguard-rules.pro, which nothing
# in CI asks for (except for a WorkManager worker: R8RulesTest does), and a line here so CI checks
# that the keep matched.
# It does not prove that the reflection-loaded code works on a device; nothing here runs the APK.
set -eu

dir=${1:-app/build/outputs/mapping/release}
seeds=$dir/seeds.txt
mapping=$dir/mapping.txt
bridge_src=app/src/main/kotlin/dev/nodeterm/android/ui/TerminalController.kt
bridge=dev.nodeterm.android.ui.TerminalController\$Bridge

for f in "$seeds" "$mapping" "$bridge_src"; do
    if [ ! -f "$f" ]; then
        echo "check-r8-output: $f is missing (R8 did not run, AGP moved its outputs, or the bridge moved)." >&2
        ls -la "$dir" >&2 || true
        exit 1
    fi
done

fail=0
ok() { echo "ok    $1"; }
bad() { echo "FAIL  $1" >&2; fail=1; }
# An extended-regex literal for a class or member name ('.' and '$' are the only specials they hold).
lit() { printf '%s' "$1" | sed 's/[.$]/\\&/g'; }

# 1. Every @JavascriptInterface method of the bridge is a seed (kept, under its own name). The names
#    come from the source, so a new bridge method is checked without editing this script.
methods=$(grep -A1 '@JavascriptInterface' "$bridge_src" | grep -oE 'fun [A-Za-z0-9_]+' | sed 's/^fun //')
[ -n "$methods" ] || bad "no @JavascriptInterface methods found in $bridge_src"
for m in $methods; do
    if grep -Eq "^$(lit "$bridge"): .*[ .]$m\(" "$seeds"; then ok "bridge method $m kept"; else bad "bridge method $m is not a seed"; fi
done

# 2. The workers keep their names (WorkManager stored them) and their (Context, WorkerParameters)
#    constructors: the background check, and the answer sent from a notification (audit A25).
worker=dev.nodeterm.android.notify.InboxWorker
action_worker=dev.nodeterm.android.notify.InboxActionWorker
for w in "$worker" "$action_worker"; do
    if grep -Eq "^$(lit "$w"): .*\(android\.content\.Context, ?androidx\.work\.WorkerParameters\)" "$seeds"; then
        ok "$w constructor kept"
    else
        bad "$w (Context, WorkerParameters) constructor is not a seed"
    fi
done

# 3. Classes loaded by name keep their names: the workers, BouncyCastle's provider, one of the algorithm
#    tables it loads by string concatenation, the X25519 SPI sshj's curve25519 key exchange asks it
#    for, and an exception whose name user-facing error text can fall back to. A class R8 did not
#    rename may be absent from mapping.txt; a pinned one is then still a line of its own in seeds.txt.
for c in \
    "$worker" \
    "$action_worker" \
    org.bouncycastle.jce.provider.BouncyCastleProvider \
    'org.bouncycastle.jcajce.provider.symmetric.AES$Mappings' \
    'org.bouncycastle.jcajce.provider.asymmetric.edec.KeyAgreementSpi$X25519' \
    dev.nodeterm.protocol.host.HostException
do
    l=$(lit "$c")
    if grep -Eq "^$l -> " "$mapping"; then
        if grep -Eq "^$l -> $l:\$" "$mapping"; then ok "$c keeps its name"; else bad "$c was renamed: $(grep -E "^$l -> " "$mapping")"; fi
    elif grep -Eq "^$l\$" "$seeds"; then
        ok "$c keeps its name (a seed; not in mapping.txt)"
    else
        bad "$c is neither in mapping.txt nor a seed: removed"
    fi
done

if [ "$fail" -ne 0 ]; then
    echo "check-r8-output: a keep rule in app/proguard-rules.pro did not match (see FAIL lines)." >&2
    exit 1
fi
echo "check-r8-output: all runtime keeps matched."

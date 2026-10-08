#!/usr/bin/env python3
"""Sign and verify an unsigned AGP release APK; never build an APK or create a release key.

Passwords are supplied only through local files understood by keytool/apksigner. Successful output
contains exactly an APK, its checksum, and beta-metadata.json. Nothing is uploaded or installed.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile


PACKAGE_NAME = "dev.nodeterm.android"
MIN_SDK = 26
TARGET_SDK = 35
ANDROID_DIR = Path(__file__).resolve().parents[1]


class PackagingError(Exception):
    pass


def sha256(path):
    with path.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256")
    return digest.hexdigest()


def run_tool(argv, action, cwd=None):
    try:
        result = subprocess.run(argv, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise PackagingError(f"{action} could not run.") from error
    if result.returncode:
        # Signing tools can include credential-related details in diagnostics. Keep their captured
        # output off the log; no password value ever appears in this script's argv or messages.
        raise PackagingError(f"{action} failed.")
    return result.stdout


def signer_pin(value):
    normalized = value.replace(":", "").lower()
    if not re.fullmatch(r"[0-9a-f]{64}", normalized):
        raise PackagingError("Expected signer must be a SHA-256 certificate fingerprint.")
    return normalized


def validate_version(code, name):
    if not 1 <= code <= 2_100_000_000:
        raise PackagingError("Version code must be between 1 and 2100000000.")
    if len(name) > 100 or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+-beta\.[1-9][0-9]*", name):
        raise PackagingError("Version name must identify a beta, for example 0.1.0-beta.1.")


def regular_file(path, description):
    if not path.is_file():
        raise PackagingError(f"{description} is not a file.")


def password_file(path, description):
    regular_file(path, description)
    data = path.read_bytes()
    password = data.rstrip(b"\r\n")
    if not password or b"\n" in password or b"\r" in password or b"\0" in password:
        raise PackagingError(f"{description} must contain one nonempty password line.")


def build_tools(explicit):
    if explicit:
        root = explicit.resolve()
    else:
        sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
        if not sdk:
            raise PackagingError("Set ANDROID_HOME or pass --build-tools-dir.")
        candidates = [path for path in (Path(sdk) / "build-tools").glob("*")
                      if re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", path.name)]
        if not candidates:
            raise PackagingError("No stable Android build-tools installation was found.")
        root = max(candidates, key=lambda path: tuple(map(int, path.name.split("."))))
    suffix = ".exe" if os.name == "nt" else ""
    tools = {name: root / (name + (".bat" if name == "apksigner" and os.name == "nt" else suffix))
             for name in ("aapt", "zipalign", "apksigner")}
    for tool in tools.values():
        regular_file(tool, "Android build tool")
    return tools


def apk_metadata(apk, aapt):
    output = run_tool([str(aapt), "dump", "badging", str(apk)], "APK manifest inspection").decode("utf-8")
    package = re.search(r"^package: name='([^']+)' versionCode='([0-9]+)' versionName='([^']*)'", output, re.M)
    minimum = re.search(r"^sdkVersion:'([0-9]+)'$", output, re.M)
    target = re.search(r"^targetSdkVersion:'([0-9]+)'$", output, re.M)
    if not package or not minimum or not target:
        raise PackagingError("APK manifest metadata is incomplete.")
    return {"packageName": package[1], "versionCode": int(package[2]), "versionName": package[3],
            "minSdk": int(minimum[1]), "targetSdk": int(target[1]),
            "debuggable": "application-debuggable" in output.splitlines()}


def require_metadata(actual, args):
    expected = {"packageName": PACKAGE_NAME, "versionCode": args.version_code,
                "versionName": args.version_name, "minSdk": MIN_SDK, "targetSdk": TARGET_SDK,
                "debuggable": False}
    if actual != expected:
        mismatches = ", ".join(key for key in expected if actual.get(key) != expected[key])
        raise PackagingError(f"APK does not match the beta configuration: {mismatches}.")


def certificate(keystore, alias, password_path, keytool):
    return run_tool([keytool, "-exportcert", "-keystore", str(keystore), "-alias", alias,
                     "-storepass:file", str(password_path)], "Signing certificate inspection")


def parse_verified_signer(output):
    failure = "APK must have one verified signer and an APK Signature Scheme v2 signature."
    lines = output.splitlines()
    counts = [line for line in lines if line.startswith("Number of signers")]
    v2 = [line for line in lines if line.startswith("Verified using v2 scheme")]
    if (counts and counts != ["Number of signers: 1"]) or v2 != ["Verified using v2 scheme (APK Signature Scheme v2): true"]:
        raise PackagingError(failure)
    certificates = [line for line in lines if "Signer" in line and "certificate SHA-256" in line
                    and not line.startswith("Source Stamp Signer")]
    signers, ranges = set(), []
    for line in certificates:
        indexed = re.fullmatch(r"Signer #1 certificate SHA-256 digest: ([0-9a-fA-F]{64})", line)
        if indexed:
            if len(certificates) != 1:
                raise PackagingError(failure)
            signers.add(indexed[1].lower())
            continue
        # Build-tools 37 labels a single signer by its highest verified scheme. Its verbose
        # count is mandatory here; numbered/multiple, unknown or repeated labels remain refused.
        scheme = re.fullmatch(r"(?:V2|V3\.0) Signer: certificate SHA-256 digest: ([0-9a-fA-F]{64})", line)
        if scheme:
            if counts != ["Number of signers: 1"] or len(certificates) != 1:
                raise PackagingError(failure)
            signers.add(scheme[1].lower())
            continue
        # ApkSignerTool prints SDK ranges for v3.1 instead of numbered signer labels. Preserve
        # the single-certificate policy across ranges, rather than counting each range as a key.
        ranged = re.fullmatch(r"(?:Signer |V3\.[01] Signer: )\(minSdkVersion=([1-9][0-9]{0,9})(?: \(dev release=true\))?, "
                              r"maxSdkVersion=([1-9][0-9]{0,9})\) certificate SHA-256 digest: ([0-9a-fA-F]{64})", line)
        if not ranged or (line.startswith("V3.") and counts != ["Number of signers: 1"]):
            raise PackagingError(failure)
        minimum, maximum = int(ranged[1]), int(ranged[2])
        if not minimum <= maximum <= 2_147_483_647:
            raise PackagingError(failure)
        ranges.append((minimum, maximum))
        signers.add(ranged[3].lower())
    ranges.sort()
    if len(signers) != 1 or any(previous[1] >= current[0] for previous, current in zip(ranges, ranges[1:])):
        raise PackagingError(failure)
    return next(iter(signers))


def verified_signer(apk, apksigner):
    output = run_tool([str(apksigner), "verify", "--verbose", "--print-certs", str(apk)],
                      "APK signature verification").decode("utf-8")
    return parse_verified_signer(output)


def require_unsigned(apk, archive, apksigner):
    # A failed verify can also mean an invalid existing signature. Refuse its structural markers
    # too rather than silently replacing it with a trusted beta signature.
    signed = any(re.fullmatch(r"META-INF/[^/]+\.(SF|RSA|DSA|EC)", name, re.I) for name in archive.namelist())
    with apk.open("rb") as apk_bytes:
        apk_bytes.seek(max(0, archive.start_dir - 16))
        signed = signed or apk_bytes.read(16) == b"APK Sig Block 42"
    if not signed:
        verification = subprocess.run([str(apksigner), "verify", str(apk)],
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
        signed = verification.returncode == 0
    if signed:
        raise PackagingError("Input APK is already signed; use AGP's unsigned release APK.")


def verify_build_inputs(args):
    regular_file(args.build_inputs, "Build inputs metadata")
    try:
        recorded_bytes = args.build_inputs.read_bytes()
        recorded = json.loads(recorded_bytes.decode("utf-8"))
    except (ValueError, UnicodeError) as error:
        raise PackagingError("Build inputs metadata must be a JSON object.") from error
    expected = {"schemaVersion": 1, "signed": False, "sourceRevision": args.source_revision.lower(),
                "versionCode": args.version_code, "versionName": args.version_name,
                "unsignedApkSha256": sha256(args.apk), "r8MappingSha256": sha256(args.r8_dir / "mapping.txt"),
                "r8SeedsSha256": sha256(args.r8_dir / "seeds.txt")}
    if (not isinstance(recorded, dict) or recorded.get("signed") is not False
            or type(recorded.get("schemaVersion")) is not int or type(recorded.get("versionCode")) is not int
            or any(recorded.get(key) != value for key, value in expected.items())):
        raise PackagingError("Build inputs metadata does not match the unsigned APK, R8 reports, revision and version.")
    return {**expected, "buildInputsSha256": hashlib.sha256(recorded_bytes).hexdigest()}


def package_beta(args):
    if sys.version_info < (3, 11):
        raise PackagingError("Python 3.11 or later is required.")
    if os.name != "posix" or not shutil.which("sh"):
        raise PackagingError("Beta packaging requires POSIX Android SDK tools and sh; use Linux, macOS or WSL.")
    validate_version(args.version_code, args.version_name)
    expected_signer = signer_pin(args.expected_signer_sha256)
    if not re.fullmatch(r"[0-9a-fA-F]{40}", args.source_revision):
        raise PackagingError("Source revision must be the full 40-character Git commit SHA.")
    for path, description in ((args.apk, "Unsigned APK"), (args.keystore, "Signing keystore")):
        regular_file(path, description)
    password_file(args.store_password_file, "Keystore password file")
    password_file(args.key_password_file, "Key password file")
    tools = build_tools(args.build_tools_dir)
    keytool = shutil.which("keytool")
    if not keytool:
        raise PackagingError("keytool from JDK 17 or later is required.")
    if args.output_dir.exists() and (not args.output_dir.is_dir() or any(args.output_dir.iterdir())):
        raise PackagingError("Output directory must be absent or empty; existing artifacts are never overwritten.")
    try:
        with zipfile.ZipFile(args.apk) as archive:
            if archive.testzip() is not None or "AndroidManifest.xml" not in archive.namelist() or "classes.dex" not in archive.namelist():
                raise PackagingError("Unsigned APK is incomplete or corrupt.")
            require_unsigned(args.apk, archive, tools["apksigner"])
    except zipfile.BadZipFile as error:
        raise PackagingError("Unsigned APK is not a valid ZIP archive.") from error
    require_metadata(apk_metadata(args.apk, tools["aapt"]), args)
    signer = hashlib.sha256(certificate(args.keystore, args.key_alias, args.store_password_file, keytool)).hexdigest()
    debug_certificate = run_tool([keytool, "-exportcert", "-keystore", str(ANDROID_DIR / "app/debug.keystore"),
                                  "-alias", "androiddebugkey", "-storepass", "android"], "Public debug certificate inspection")
    if signer == hashlib.sha256(debug_certificate).hexdigest():
        raise PackagingError("A beta must never use the repository's public debug signing key.")
    if signer != expected_signer:
        raise PackagingError("Keystore certificate does not match the expected signer pin.")
    for name in ("mapping.txt", "seeds.txt"):
        regular_file(args.r8_dir / name, "R8 output")
        if not (args.r8_dir / name).stat().st_size:
            raise PackagingError("R8 output must not be empty.")
    # The keep checker resolves source paths from android/, as the existing CI step does.
    run_tool(["sh", str(ANDROID_DIR / "tools/check-r8-output.sh"), str(args.r8_dir.resolve())],
             "R8 runtime-keep verification", cwd=ANDROID_DIR)
    build_inputs = verify_build_inputs(args)
    args.output_dir.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".nodeterm-beta-", dir=args.output_dir.parent) as workspace:
        temporary = Path(workspace)
        artifacts = temporary / "artifacts"
        artifacts.mkdir(mode=0o700)
        aligned = temporary / "aligned.apk"
        artifact_name = f"nodeterm-android-{args.version_name}.apk"
        signed = artifacts / artifact_name
        # apksigner consumes successive lines when the same password-file path supplies both
        # passwords. Keep distinct private copies so a common one-line password file works too.
        store_password = temporary / "store-password.txt"
        key_password = temporary / "key-password.txt"
        for source, destination in ((args.store_password_file, store_password), (args.key_password_file, key_password)):
            destination.write_bytes(source.read_bytes())
            destination.chmod(0o600)
        run_tool([str(tools["zipalign"]), "-P", "16", "-f", "4", str(args.apk), str(aligned)], "APK alignment")
        # Inputs are normally downloaded into a stable local directory. Refuse accidental changes
        # during packaging too, so the recorded hashes still describe the bytes we aligned.
        if verify_build_inputs(args) != build_inputs:
            raise PackagingError("Build inputs changed during APK alignment.")
        run_tool([str(tools["apksigner"]), "sign", "--ks", str(args.keystore), "--ks-key-alias", args.key_alias,
                  "--ks-pass", "file:" + str(store_password), "--key-pass", "file:" + str(key_password),
                  "--v2-signing-enabled", "true",
                  "--v4-signing-enabled", "false",
                  "--out", str(signed), str(aligned)], "APK signing")
        actual_signer = verified_signer(signed, tools["apksigner"])
        if actual_signer != expected_signer:
            raise PackagingError("Signed APK certificate does not match the expected signer pin.")
        require_metadata(apk_metadata(signed, tools["aapt"]), args)
        run_tool([str(tools["zipalign"]), "-c", "-P", "16", "4", str(signed)], "Signed APK alignment verification")
        if verify_build_inputs(args) != build_inputs:
            raise PackagingError("Build inputs changed during APK signing.")
        digest = sha256(signed)
        (artifacts / (artifact_name + ".sha256")).write_text(f"{digest}  {artifact_name}\n", encoding="utf-8")
        metadata = {"schemaVersion": 1, **apk_metadata(signed, tools["aapt"]), "artifactName": artifact_name,
                    "signerSha256": actual_signer, "apkSha256": digest, "sourceRevision": args.source_revision.lower(),
                    "unsignedApkSha256": build_inputs["unsignedApkSha256"], "buildInputsSha256": build_inputs["buildInputsSha256"],
                    "r8MappingSha256": build_inputs["r8MappingSha256"], "r8SeedsSha256": build_inputs["r8SeedsSha256"]}
        (artifacts / "beta-metadata.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
        # All gates passed before the output becomes visible. A failed signing/verification leaves
        # neither a misleading APK nor a partial set of artifacts to distribute.
        os.replace(artifacts, args.output_dir)
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ("apk", "keystore", "store-password-file", "key-password-file", "r8-dir", "build-inputs", "output-dir"):
        parser.add_argument("--" + option, type=Path, required=True)
    parser.add_argument("--build-tools-dir", type=Path)
    for option in ("key-alias", "expected-signer-sha256", "version-name", "source-revision"):
        parser.add_argument("--" + option, required=True)
    parser.add_argument("--version-code", type=int, required=True)
    args = parser.parse_args()
    try:
        metadata = package_beta(args)
    except (PackagingError, OSError, subprocess.TimeoutExpired, UnicodeError) as error:
        print(f"package-beta: {error}", file=sys.stderr)
        return 1
    print(f"Verified beta: {metadata['artifactName']} (version code {metadata['versionCode']}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())

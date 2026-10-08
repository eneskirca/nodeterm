"""Real SDK/signature gates against tiny test APKs, never a nodeterm application build.

Set ANDROID_HOME (or NODETERM_ANDROID_TEST_SDK) to a cached SDK with build-tools and android.jar.
Every signing key created here is temporary and for tests only. No phone, sockets or network.
"""

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile


HERE = Path(__file__).resolve().parent
PACKAGER = Path(os.environ.get("NODETERM_ANDROID_TEST_PACKAGER", str(HERE / "package-beta.py")))
ANDROID_DIR = HERE.parent
VERSION_NAME = "0.1.0-beta.1"
REVISION = "a" * 40


def fixture_sdk(sdk, build_tools_version="36.0.0", platform_version="android-35"):
    """Use the SDK explicitly installed by CI; additional runner SDKs must not change the fixture."""
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", build_tools_version):
        raise RuntimeError("Fixture build-tools override must name one stable SDK version.")
    if not re.fullmatch(r"android-[0-9]+(?:\.[0-9]+)?(?:-beta[1-9][0-9]*)?", platform_version):
        raise RuntimeError("Fixture platform override must name one Android SDK platform.")
    tools = Path(sdk) / "build-tools" / build_tools_version
    android_jar = Path(sdk) / "platforms" / platform_version / "android.jar"
    if not all((tools / name).is_file() for name in ("aapt", "apksigner", "zipalign", "d8")):
        raise RuntimeError(f"Fixture requires Android build-tools {build_tools_version}: {tools}")
    if not android_jar.is_file():
        raise RuntimeError(f"Fixture requires Android SDK platform {platform_version}: {android_jar}")
    return tools, android_jar


class PackageBetaTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sdk = os.environ.get("NODETERM_ANDROID_TEST_SDK") or os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
        if not sdk:
            raise RuntimeError("An Android SDK is required for real APK/signature gate tests.")
        cls.sdk = Path(sdk)
        cls.tools, cls.android_jar = fixture_sdk(
            cls.sdk, os.environ.get("NODETERM_ANDROID_TEST_BUILD_TOOLS", "36.0.0"),
            os.environ.get("NODETERM_ANDROID_TEST_PLATFORM", "android-35"))
        print(f"Packaging fixture SDK: build-tools={cls.tools}, platform={cls.android_jar}", file=sys.stderr)
        if not shutil.which("keytool") or not shutil.which("javac"):
            raise RuntimeError("SDK build tools/platform and JDK keytool/javac are required.")
        cls.temp = tempfile.TemporaryDirectory(prefix="nt-beta-tests-")
        cls.root = Path(cls.temp.name)
        cls.password = cls.root / "password.txt"
        cls.password.write_text("ephemeral-test-password\n", encoding="utf-8")
        cls.password.chmod(0o600)
        cls.key_password = cls.root / "key-password.txt"
        cls.key_password.write_bytes(cls.password.read_bytes())
        cls.key_password.chmod(0o600)
        cls.keystore = cls.root / "fixture-private.p12"
        cls.tool(["keytool", "-genkeypair", "-alias", "fixture", "-keyalg", "RSA", "-keysize", "2048",
                  "-validity", "2", "-dname", "CN=Temporary Android packaging test", "-storetype", "PKCS12",
                  "-keystore", str(cls.keystore), "-storepass:file", str(cls.password), "-keypass:file", str(cls.password)])
        cls.pin = cls.export_pin(cls.keystore, "fixture", cls.password)
        # A valid fixture dex, rather than a file that merely has the expected name. The fixture
        # has no app behavior: aapt creates only its manifest, and the class holds one constant.
        java = cls.root / "Fixture.java"
        java.write_text("public class Fixture { public static final int VALUE = 1; }\n", encoding="utf-8")
        cls.tool(["javac", "--release", "17", str(java)])
        dex_dir = cls.root / "dex"
        dex_dir.mkdir()
        cls.tool([str(cls.tools / "d8"), "--min-api", "26", "--output", str(dex_dir), str(cls.root / "Fixture.class")])
        cls.dex = (dex_dir / "classes.dex").read_bytes()
        cls.good_apk = cls.fixture_apk("good")
        cls.good_r8 = cls.fixture_r8(cls.root / "r8")
        cls.good_inputs = cls.fixture_inputs("good-inputs")
        cls.signature_diagnostics = None

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, "temp"):
            cls.temp.cleanup()

    @classmethod
    def tool(cls, argv):
        result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
        if result.returncode:
            raise AssertionError(f"Test fixture tool failed: {Path(argv[0]).name}: {result.stderr.decode(errors='replace')}")
        return result.stdout

    @classmethod
    def export_pin(cls, keystore, alias, password):
        der = cls.tool(["keytool", "-exportcert", "-keystore", str(keystore), "-alias", alias,
                        "-storepass:file", str(password)])
        return hashlib.sha256(der).hexdigest()

    @classmethod
    def fixture_apk(cls, name, package="dev.nodeterm.android", code=2, version=VERSION_NAME, debug=False, minimum=26, target=35):
        root = cls.root / name
        root.mkdir()
        manifest = root / "AndroidManifest.xml"
        manifest.write_text(f'''<manifest xmlns:android="http://schemas.android.com/apk/res/android"
            package="{package}" android:versionCode="{code}" android:versionName="{version}">
            <uses-sdk android:minSdkVersion="{minimum}" android:targetSdkVersion="{target}" />
            <application android:label="Temporary packaging test {name}" android:debuggable="{str(debug).lower()}" />
            </manifest>''', encoding="utf-8")
        apk = root / "fixture-unsigned.apk"
        cls.tool([str(cls.tools / "aapt"), "package", "-f", "-M", str(manifest), "-I", str(cls.android_jar), "-F", str(apk)])
        with zipfile.ZipFile(apk, "a") as archive:
            archive.writestr("classes.dex", cls.dex)
        return apk

    @classmethod
    def fixture_r8(cls, directory):
        directory.mkdir()
        bridge = "dev.nodeterm.android.ui.TerminalController$Bridge"
        source = (ANDROID_DIR / "app/src/main/kotlin/dev/nodeterm/android/ui/TerminalController.kt").read_text()
        methods = re.findall(r"@JavascriptInterface\s+fun\s+(\w+)", source)
        if not methods:
            raise AssertionError("R8 fixture must pin the real bridge's kept methods")
        workers = ["dev.nodeterm.android.notify.InboxWorker", "dev.nodeterm.android.notify.InboxActionWorker"]
        classes = workers + ["org.bouncycastle.jce.provider.BouncyCastleProvider",
                              "org.bouncycastle.jcajce.provider.symmetric.AES$Mappings",
                              "org.bouncycastle.jcajce.provider.asymmetric.edec.KeyAgreementSpi$X25519",
                              "dev.nodeterm.protocol.host.HostException"]
        seeds = [f"{bridge}: void {method}()" for method in methods]
        seeds += [f"{worker}: void <init>(android.content.Context, androidx.work.WorkerParameters)" for worker in workers]
        seeds += classes
        (directory / "seeds.txt").write_text("\n".join(seeds) + "\n", encoding="utf-8")
        # These are synthetic R8 output fixtures for the keep checker, never output from a nodeterm
        # build and never claims that the fixture APK was minified by AGP.
        (directory / "mapping.txt").write_text("\n".join(f"{name} -> {name}:" for name in classes) + "\n", encoding="utf-8")
        return directory

    @classmethod
    def fixture_inputs(cls, name, apk=None, r8=None, code=2, version=VERSION_NAME, **overrides):
        apk, r8 = apk or cls.good_apk, r8 or cls.good_r8
        metadata = {"schemaVersion": 1, "signed": False, "sourceRevision": REVISION,
                    "versionCode": code, "versionName": version,
                    "unsignedApkSha256": hashlib.sha256(apk.read_bytes()).hexdigest(),
                    "r8MappingSha256": hashlib.sha256((r8 / "mapping.txt").read_bytes()).hexdigest(),
                    "r8SeedsSha256": hashlib.sha256((r8 / "seeds.txt").read_bytes()).hexdigest()}
        metadata.update(overrides)
        path = cls.root / (name + ".json")
        path.write_text(json.dumps(metadata), encoding="utf-8")
        return path

    def setUp(self):
        self.output = self.root / (self.id().split(".")[-1] + "-output")
        self.call_number = 0

    def package(self, **overrides):
        values = {"apk": self.good_apk, "keystore": self.keystore, "store-password-file": self.password,
                  "key-password-file": self.password, "key-alias": "fixture", "expected-signer-sha256": self.pin,
                  "version-code": 2, "version-name": VERSION_NAME, "source-revision": REVISION,
                  "r8-dir": self.good_r8,
                  "output-dir": self.output, "build-tools-dir": self.tools}
        values.update(overrides)
        self.call_number += 1
        if "build-inputs" not in values:
            if all((values["r8-dir"] / report).is_file() for report in ("mapping.txt", "seeds.txt")):
                values["build-inputs"] = self.fixture_inputs(self.id().split(".")[-1] + "-inputs-" + str(self.call_number),
                                                           apk=values["apk"], r8=values["r8-dir"],
                                                           code=values["version-code"], version=values["version-name"])
            else:
                values["build-inputs"] = self.good_inputs
        argv = [sys.executable, str(PACKAGER)]
        for key, value in values.items():
            argv += ["--" + key, str(value)]
        result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
        if result.returncode and b"APK must have one verified signer" in result.stderr:
            # Production deliberately suppresses signing-tool output. Diagnose this test's
            # selected SDK with a new disposable fixture, never a real app key or password.
            result.stderr += self.fixture_signature_diagnostics()
        return result

    @classmethod
    def fixture_signature_diagnostics(cls):
        if cls.signature_diagnostics is None:
            aligned, signed = cls.root / "diagnostic-aligned.apk", cls.root / "diagnostic-signed.apk"
            cls.tool([str(cls.tools / "zipalign"), "-P", "16", "-f", "4", str(cls.good_apk), str(aligned)])
            cls.tool([str(cls.tools / "apksigner"), "sign", "--ks", str(cls.keystore), "--ks-key-alias", "fixture",
                      "--ks-pass", "file:" + str(cls.password), "--key-pass", "file:" + str(cls.key_password),
                      "--v2-signing-enabled", "true", "--v4-signing-enabled", "false",
                      "--out", str(signed), str(aligned)])
            report = subprocess.run([str(cls.tools / "apksigner"), "verify", "--verbose", "--print-certs", str(signed)],
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
            header = (f"\nDisposable test fixture signature diagnostics:\n"
                      f"build-tools={cls.tools}\nplatform={cls.android_jar}\nverify exit={report.returncode}\n")
            cls.signature_diagnostics = header.encode() + report.stdout + report.stderr
        return cls.signature_diagnostics

    def refused(self, result, message):
        self.assertNotEqual(0, result.returncode, result.stdout.decode() + result.stderr.decode())
        self.assertIn(message, result.stderr.decode())
        self.assertFalse(self.output.exists(), "a failed gate must publish no artifacts")
        self.assertNotIn("ephemeral-test-password", result.stdout.decode() + result.stderr.decode())

    def signer_wrapper(self, name, after_sign="", before_sign=""):
        directory = self.root / name
        directory.mkdir()
        for tool in ("aapt", "zipalign"):
            (directory / tool).symlink_to(self.tools / tool)
        wrapper = directory / "apksigner"
        wrapper.write_text(f'''#!{sys.executable}
import json
import struct
import subprocess
import sys
from pathlib import Path
import zipfile
arguments = sys.argv[1:]
if arguments and arguments[0] == "sign":
{before_sign or "    pass"}
result = subprocess.run([{str(self.tools / "apksigner")!r}] + arguments)
if result.returncode == 0 and arguments and arguments[0] == "sign":
{after_sign or "    pass"}
sys.exit(result.returncode)
''', encoding="utf-8")
        wrapper.chmod(0o755)
        return directory

    def test_accepts_verified_private_beta_and_writes_exact_artifacts(self):
        result = self.package()
        self.assertEqual(0, result.returncode, result.stderr.decode())
        name = "nodeterm-android-" + VERSION_NAME + ".apk"
        self.assertEqual({name, name + ".sha256", "beta-metadata.json"}, {path.name for path in self.output.iterdir()})
        self.assertEqual(0, self.output.stat().st_mode & 0o077, "private APK output must be inaccessible to other users")
        apk = self.output / name
        digest = hashlib.sha256(apk.read_bytes()).hexdigest()
        self.assertEqual(f"{digest}  {name}\n", (self.output / (name + ".sha256")).read_text())
        metadata = json.loads((self.output / "beta-metadata.json").read_text())
        self.assertEqual(self.pin, metadata["signerSha256"])
        self.assertEqual(digest, metadata["apkSha256"])
        self.assertEqual(2, metadata["versionCode"])
        self.assertEqual(False, metadata["debuggable"])
        self.assertEqual(REVISION, metadata["sourceRevision"])
        self.assertEqual(hashlib.sha256((self.good_r8 / "mapping.txt").read_bytes()).hexdigest(), metadata["r8MappingSha256"])
        self.assertEqual(hashlib.sha256(self.good_apk.read_bytes()).hexdigest(), metadata["unsignedApkSha256"])
        inputs = self.root / (self.id().split(".")[-1] + "-inputs-1.json")
        self.assertEqual(hashlib.sha256(inputs.read_bytes()).hexdigest(), metadata["buildInputsSha256"])
        output = self.tool([str(self.tools / "apksigner"), "verify", "--verbose", "--print-certs", str(apk)]).decode()
        self.assertIn(self.pin, output)
        self.assertRegex(output, r"Verified using v2 scheme .*: true")

    def test_next_beta_keeps_signer_and_increases_version(self):
        first = self.package()
        self.assertEqual(0, first.returncode, first.stderr.decode())
        first_metadata = json.loads((self.output / "beta-metadata.json").read_text())
        self.output = self.output.with_name(self.output.name + "-next")
        next_apk = self.fixture_apk("next-beta", code=3, version="0.1.0-beta.2")
        inputs = self.fixture_inputs("next-beta-inputs", apk=next_apk, code=3, version="0.1.0-beta.2")
        second = self.package(**{"apk": next_apk, "version-code": 3, "version-name": "0.1.0-beta.2", "build-inputs": inputs})
        self.assertEqual(0, second.returncode, second.stderr.decode())
        second_metadata = json.loads((self.output / "beta-metadata.json").read_text())
        self.assertEqual(first_metadata["signerSha256"], second_metadata["signerSha256"])
        self.assertGreater(second_metadata["versionCode"], first_metadata["versionCode"])

    def test_requires_v2_even_when_the_signing_tools_default_to_disabled(self):
        wrapper = self.signer_wrapper("default-v2-disabled", before_sign='''    if "--v2-signing-enabled" not in arguments:
        arguments[1:1] = ["--v2-signing-enabled", "false"]''')
        result = self.package(**{"build-tools-dir": wrapper})
        self.assertEqual(0, result.returncode, result.stderr.decode())
        apk = self.output / ("nodeterm-android-" + VERSION_NAME + ".apk")
        output = self.tool([str(self.tools / "apksigner"), "verify", "--verbose", "--print-certs", str(apk)]).decode()
        self.assertIn(self.pin, output)
        self.assertRegex(output, r"Verified using v2 scheme .*: true")

    def test_rejects_debuggable_apk(self):
        self.refused(self.package(apk=self.fixture_apk("debuggable", debug=True)), "debuggable")

    def test_rejects_wrong_package(self):
        self.refused(self.package(apk=self.fixture_apk("wrong-package", package="dev.other.app")), "packageName")

    def test_rejects_wrong_version_code(self):
        self.refused(self.package(apk=self.fixture_apk("wrong-code", code=3)), "versionCode")

    def test_rejects_wrong_version_name(self):
        self.refused(self.package(apk=self.fixture_apk("wrong-name", version="0.1.0-beta.2")), "versionName")

    def test_rejects_wrong_sdk_levels(self):
        for name, levels, field in (("minimum", {"minimum": 25}, "minSdk"), ("target", {"target": 34}, "targetSdk")):
            self.refused(self.package(apk=self.fixture_apk("wrong-sdk-" + name, **levels)), field)

    def test_rejects_public_debug_key_even_if_the_expected_pin_matches(self):
        password = self.root / "debug-password.txt"
        password.write_text("android\n")
        copied = self.root / "copied-debug.keystore"
        shutil.copyfile(ANDROID_DIR / "app/debug.keystore", copied)
        debug_pin = self.export_pin(copied, "androiddebugkey", password)
        self.refused(self.package(**{"keystore": copied, "key-alias": "androiddebugkey", "store-password-file": password,
                                     "key-password-file": password, "expected-signer-sha256": debug_pin}), "public debug")

    def test_rejects_wrong_signer_pin(self):
        self.refused(self.package(**{"expected-signer-sha256": "0" * 64}), "signer pin")

    def test_rejects_unexpected_signer_in_signed_output(self):
        store_password = self.root / "wrapper-store-password.txt"
        key_password = self.root / "wrapper-key-password.txt"
        store_password.write_text("android\n")
        key_password.write_text("android\n")
        replacements = {"--ks": str(ANDROID_DIR / "app/debug.keystore"), "--ks-key-alias": "androiddebugkey",
                        "--ks-pass": "file:" + str(store_password), "--key-pass": "file:" + str(key_password)}
        wrapper = self.signer_wrapper("wrong-output-signer", before_sign=f'''    replacements = {replacements!r}
    for option, value in replacements.items():
        arguments[arguments.index(option) + 1] = value''')
        self.refused(self.package(**{"build-tools-dir": wrapper}), "Signed APK certificate")

    def test_rejects_tampered_signed_output(self):
        # Change an uncompressed dex byte after the real SDK signer succeeds. Manifest and ZIP
        # alignment remain readable, so rejection proves the signature gate examines final bytes.
        wrapper = self.signer_wrapper("tampered-output", after_sign='''    output = Path(arguments[arguments.index("--out") + 1])
    with zipfile.ZipFile(output) as archive:
        info = archive.getinfo("classes.dex")
        assert info.compress_type == zipfile.ZIP_STORED
    with output.open("r+b") as apk:
        apk.seek(info.header_offset + 26)
        name_length, extra_length = struct.unpack("<HH", apk.read(4))
        position = info.header_offset + 30 + name_length + extra_length + 100
        apk.seek(position)
        previous = apk.read(1)[0]
        apk.seek(position)
        apk.write(bytes([previous ^ 1]))''')
        self.refused(self.package(**{"build-tools-dir": wrapper}), "APK signature verification failed")

    def test_rejects_inputs_changed_during_signing(self):
        for number, change in enumerate(({"sourceRevision": "b" * 40}, {"note": "changed after validation"})):
            inputs = self.fixture_inputs("changed-during-signing-" + str(number))
            wrapper = self.signer_wrapper("changed-inputs-tools-" + str(number), before_sign=f'''    path = Path({str(inputs)!r})
    recorded = json.loads(path.read_text())
    recorded.update({change!r})
    path.write_text(json.dumps(recorded))''')
            self.refused(self.package(**{"build-tools-dir": wrapper, "build-inputs": inputs}), "Build inputs")

    def test_rejects_incorrect_password_without_printing_it(self):
        password = self.root / "wrong-password.txt"
        password.write_text("wrong-private-password-marker\n")
        result = self.package(**{"store-password-file": password})
        self.refused(result, "certificate inspection failed")
        self.assertNotIn("wrong-private-password-marker", result.stdout.decode() + result.stderr.decode())

    def test_rejects_signed_input(self):
        signed = self.root / "already-signed.apk"
        self.tool([str(self.tools / "apksigner"), "sign", "--ks", str(self.keystore), "--ks-key-alias", "fixture",
                   "--ks-pass", "file:" + str(self.password), "--key-pass", "file:" + str(self.key_password),
                   "--v4-signing-enabled", "false", "--out", str(signed), str(self.good_apk)])
        self.refused(self.package(apk=signed), "already signed")

    def test_rejects_signed_input_even_when_its_signature_is_invalid(self):
        signed = self.root / "invalid-signed-input.apk"
        self.tool([str(self.tools / "apksigner"), "sign", "--ks", str(self.keystore), "--ks-key-alias", "fixture",
                   "--ks-pass", "file:" + str(self.password), "--key-pass", "file:" + str(self.key_password),
                   "--v4-signing-enabled", "false", "--out", str(signed), str(self.good_apk)])
        # Extra bytes after ZIP's final directory record keep the ZIP readable but invalidate the
        # signed container. "apksigner verify" alone cannot distinguish this from unsigned input.
        with signed.open("ab") as output:
            output.write(b"x")
        verification = subprocess.run([str(self.tools / "apksigner"), "verify", str(signed)],
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
        self.assertNotEqual(0, verification.returncode, "negative fixture must have an invalid signature")
        self.refused(self.package(apk=signed), "already signed")

    def test_rejects_missing_or_broken_r8_keeps(self):
        r8 = self.fixture_r8(self.root / "broken-r8")
        seeds = r8 / "seeds.txt"
        seeds.write_text(seeds.read_text().replace("org.bouncycastle.jce.provider.BouncyCastleProvider\n", ""))
        mapping = r8 / "mapping.txt"
        mapping.write_text(mapping.read_text().replace("org.bouncycastle.jce.provider.BouncyCastleProvider -> org.bouncycastle.jce.provider.BouncyCastleProvider:\n", ""))
        self.refused(self.package(**{"r8-dir": r8}), "R8 runtime-keep verification failed")
        seeds.unlink()
        self.refused(self.package(**{"r8-dir": r8}), "R8 output is not a file")

    def test_preserves_existing_output(self):
        self.output.mkdir()
        before = self.output / "previous.apk"
        before.write_bytes(b"existing artifact")
        result = self.package()
        self.assertNotEqual(0, result.returncode)
        self.assertIn("never overwritten", result.stderr.decode())
        self.assertEqual(b"existing artifact", before.read_bytes())
        self.assertEqual({before.name}, {path.name for path in self.output.iterdir()})

    def test_rejects_invalid_versions_before_creating_output(self):
        for overrides in ({"version-code": 0}, {"version-code": 2_100_000_001},
                          {"version-name": "0.1.0"}, {"version-name": "0.1.0-beta.1/elsewhere"}):
            self.refused(self.package(**overrides), "Version")

    def test_rejects_incomplete_apk(self):
        incomplete = self.root / "incomplete.apk"
        with zipfile.ZipFile(incomplete, "w") as archive:
            archive.writestr("AndroidManifest.xml", b"incomplete fixture")
        self.refused(self.package(apk=incomplete), "incomplete or corrupt")

    def test_rejects_build_inputs_from_a_different_apk(self):
        self.refused(self.package(**{"apk": self.fixture_apk("other-build"), "build-inputs": self.good_inputs}),
                     "Build inputs metadata does not match")

    def test_rejects_build_inputs_from_different_r8_reports(self):
        r8 = self.fixture_r8(self.root / "other-build-r8")
        for report in ("mapping.txt", "seeds.txt"):
            path = r8 / report
            original = path.read_text()
            path.write_text(original + "# Different build report\n")
            self.refused(self.package(**{"r8-dir": r8, "build-inputs": self.good_inputs}), "Build inputs metadata does not match")
            path.write_text(original)

    def test_rejects_build_inputs_from_different_revision_or_version(self):
        for number, fields in enumerate(({"sourceRevision": "b" * 40}, {"versionCode": 3}, {"versionName": "0.1.0-beta.2"},
                                         {"signed": True}, {"signed": 0}, {"schemaVersion": 2}, {"versionCode": "2"})):
            inputs = self.fixture_inputs("mismatched-inputs-" + str(number), **fields)
            self.refused(self.package(**{"build-inputs": inputs}), "Build inputs metadata does not match")


if __name__ == "__main__":
    unittest.main()

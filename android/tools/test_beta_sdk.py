"""Additional runner SDKs must not silently change the real-signature fixture toolchain."""

from pathlib import Path
import tempfile
import unittest

from test_package_beta import fixture_sdk


class BetaFixtureSdkTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="nt-beta-sdk-selection-")
        self.addCleanup(self.temp.cleanup)
        self.sdk = Path(self.temp.name)

    def install(self, tools="36.0.0", platform="android-35"):
        directory = self.sdk / "build-tools" / tools
        directory.mkdir(parents=True, exist_ok=True)
        for name in ("aapt", "apksigner", "zipalign", "d8"):
            (directory / name).touch()
        jar = self.sdk / "platforms" / platform / "android.jar"
        jar.parent.mkdir(parents=True, exist_ok=True)
        jar.touch()
        return directory, jar

    def test_defaults_ignore_newer_lexical_and_preview_runner_installations(self):
        expected = self.install()
        for tools, platform in (("37.0.0", "android-37.2-beta3"), ("36.1.0", "android-36.1"),
                                ("9.0.0", "android-9"), ("36.0.0-rc1", "android-35-ext15")):
            self.install(tools, platform)
        self.assertEqual(expected, fixture_sdk(self.sdk))

    def test_missing_pinned_tools_or_platform_fail_without_falling_back(self):
        self.install("37.0.0", "android-37.2-beta3")
        with self.assertRaisesRegex(RuntimeError, "build-tools 36.0.0"):
            fixture_sdk(self.sdk)
        tools, jar = self.install()
        jar.unlink()
        with self.assertRaisesRegex(RuntimeError, "platform android-35"):
            fixture_sdk(self.sdk)
        jar.touch()
        (tools / "d8").unlink()
        with self.assertRaisesRegex(RuntimeError, "build-tools 36.0.0"):
            fixture_sdk(self.sdk)

    def test_explicit_reproduction_overrides_select_exact_tools_and_platform(self):
        self.install()
        expected = self.install("37.0.0", "android-37.2-beta3")
        self.install("38.0.0", "android-38")
        self.assertEqual(expected, fixture_sdk(self.sdk, "37.0.0", "android-37.2-beta3"))

    def test_invalid_or_absent_overrides_do_not_select_any_other_installation(self):
        self.install()
        for version in ("", "latest", "36.0.0-rc1", "../36.0.0", "36.0.0/anything"):
            with self.subTest(version=version), self.assertRaises(RuntimeError):
                fixture_sdk(self.sdk, version)
        for platform in ("", "latest", "../android-35", "android-35/anything"):
            with self.subTest(platform=platform), self.assertRaises(RuntimeError):
                fixture_sdk(self.sdk, platform_version=platform)
        with self.assertRaisesRegex(RuntimeError, "build-tools 37.0.0"):
            fixture_sdk(self.sdk, "37.0.0")
        with self.assertRaisesRegex(RuntimeError, "platform android-36"):
            fixture_sdk(self.sdk, platform_version="android-36")


if __name__ == "__main__":
    unittest.main()

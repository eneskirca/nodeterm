"""The real CI preflight accepts ordinary defaults and refuses unusable beta inputs."""

import os
from pathlib import Path
import subprocess
import sys
import unittest


class BetaVersionEnvironmentTest(unittest.TestCase):
    def test_selected_environment_values_match_packaging_rules(self):
        cases = [
            (None, None, True), ("", "", True),
            ("2", "0.1.0-beta.1", True), ("2100000000", "9.9.9-beta.8", True),
            ("0", "0.1.0-beta.1", False), ("2100000001", "0.1.0-beta.1", False),
            ("2", "0.1.0", False), ("2", "0.1.0-beta.0", False),
            ("02", "0.1.0-beta.1", False), (" 2", "0.1.0-beta.1", False),
            ("2", None, False), (None, "0.1.0-beta.1", False),
        ]
        script = Path(__file__).with_name("check-beta-version.py")
        for code, name, accepted in cases:
            with self.subTest(code=code, name=name):
                env = os.environ.copy()
                for key, value in (("NODETERM_ANDROID_VERSION_CODE", code), ("NODETERM_ANDROID_VERSION_NAME", name)):
                    env.pop(key, None)
                    if value is not None:
                        env[key] = value
                result = subprocess.run([sys.executable, str(script)], env=env, capture_output=True, text=True, timeout=10)
                self.assertEqual(accepted, result.returncode == 0, result.stderr)

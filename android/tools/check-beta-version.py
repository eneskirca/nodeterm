#!/usr/bin/env python3
"""Validate selected CI beta overrides with the local packager's version rules."""

import os
from pathlib import Path
import runpy
import sys


def main():
    code = os.environ.get("NODETERM_ANDROID_VERSION_CODE", "")
    name = os.environ.get("NODETERM_ANDROID_VERSION_NAME", "")
    if not code and not name:
        return 0  # Ordinary unsigned builds keep Gradle's default version.
    policy = runpy.run_path(str(Path(__file__).with_name("package-beta.py")))
    try:
        number = int(code)
        if str(number) != code:
            raise ValueError("Version code must be a positive decimal integer.")
        policy["validate_version"](number, name)
    except (ValueError, policy["PackagingError"]) as error:
        print(f"beta-version: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Parse the official apksigner indexed and SDK-range certificate reports without relaxing gates."""

import os
from pathlib import Path
import runpy
import unittest


PACKAGER = runpy.run_path(os.environ.get("NODETERM_ANDROID_TEST_PACKAGER", str(Path(__file__).with_name("package-beta.py"))))
parse = PACKAGER["parse_verified_signer"]
PackagingError = PACKAGER["PackagingError"]
PIN = "a" * 64
OTHER = "b" * 64
V2 = "Verified using v2 scheme (APK Signature Scheme v2): true"
INDEXED = "Signer #1 certificate SHA-256 digest: " + PIN


def report(*certificates, count="1", v2=V2, separator="\n"):
    lines = ["Verifies", v2]
    if count is not None:
        lines.append("Number of signers: " + count)
    return separator.join(lines + list(certificates)) + separator


def ranged(minimum=28, maximum=2_147_483_647, pin=PIN, dev=False):
    return (f"Signer (minSdkVersion={minimum}" + (" (dev release=true)" if dev else "") +
            f", maxSdkVersion={maximum}) certificate SHA-256 digest: {pin}")


class BetaSignerOutputTest(unittest.TestCase):
    def test_accepts_one_indexed_signer_and_line_endings(self):
        for separator in ("\n", "\r\n"):
            for count in ("1", None):
                with self.subTest(separator=repr(separator), count=count):
                    self.assertEqual(PIN, parse(report(INDEXED, count=count, separator=separator)))

    def test_accepts_one_sdk_range_and_case_normalizes_its_pin(self):
        for dev in (False, True):
            self.assertEqual(PIN, parse(report(ranged(pin=PIN.upper(), dev=dev))))

    def test_deduplicates_only_the_same_certificate_in_disjoint_sdk_ranges(self):
        self.assertEqual(PIN, parse(report(ranged(33), ranged(28, 32))))
        self.assertEqual(PIN, parse(report(ranged(28, 32), ranged(33, 35), ranged(36))))

    def test_accepts_build_tools_37_single_scheme_signer(self):
        for label in ("V2 Signer:", "V3.0 Signer:"):
            certificate = label + " certificate SHA-256 digest: " + PIN.upper()
            self.assertEqual(PIN, parse(report(certificate)))
            for count in (None, "0", "2", "01", "one", "1\nNumber of signers: 1"):
                with self.subTest(label=label, count=count), self.assertRaises(PackagingError):
                    parse(report(certificate, count=count))
            for v2 in ("", V2.replace("true", "false")):
                with self.subTest(label=label, v2=v2), self.assertRaises(PackagingError):
                    parse(report(certificate, v2=v2))

    def test_accepts_build_tools_37_disjoint_same_certificate_scheme_ranges(self):
        original = ranged(28, 32).replace("Signer (", "V3.0 Signer: (")
        rotated = ranged(33).replace("Signer (", "V3.1 Signer: (")
        self.assertEqual(PIN, parse(report(original, rotated)))
        for certificates in ((original, rotated.replace(PIN, OTHER)), (rotated, rotated),
                             (original.replace("32)", "33)"), rotated)):
            with self.subTest(certificates=certificates), self.assertRaises(PackagingError):
                parse(report(*certificates))
        with self.assertRaises(PackagingError):
            parse(report(original, rotated, count=None))

    def test_rejects_duplicate_unknown_or_malformed_build_tools_37_signers(self):
        good = "V3.0 Signer: certificate SHA-256 digest: " + PIN
        for certificates in ((good, good), (good, good.replace(PIN, OTHER)),
                             (good, INDEXED), (good, good.replace("V3.0", "V2")),
                             (good, good.replace("V3.0", "V4")),
                             (good, ranged().replace("Signer (", "V3.2 Hybrid Classical Signer: (")),
                             (good, ranged().replace("Signer (", "V3.2 Hybrid PQC Signer: (")),
                             (good.replace("Signer:", "Signer #1:"),),
                             (good.replace("Signer:", "Signer #2:"),),
                             (good.replace("V3.0", "V3.1"),),
                             (good.replace("V3.0", "V3.2 Hybrid Classical"),),
                             (good.replace("V3.0", "V3.2 Hybrid PQC"),),
                             (good.replace(PIN, PIN[:-1]),), (good + " trailing",)):
            with self.subTest(certificates=certificates), self.assertRaises(PackagingError):
                parse(report(*certificates))

    def test_rejects_missing_or_unverified_v2(self):
        for v2 in ("", V2.replace("true", "false"), V2 + " trailing", V2 + "\n" + V2,
                   V2 + "\n" + V2.replace("true", "false")):
            with self.subTest(v2=v2), self.assertRaises(PackagingError):
                parse(report(INDEXED, v2=v2))

    def test_rejects_multiple_signers_and_malformed_or_conflicting_counts(self):
        for count in ("0", "2", "01", "one", "", "1 trailing", "1\nNumber of signers: 1", "1\nNumber of signers: 2"):
            with self.subTest(count=count), self.assertRaises(PackagingError):
                parse(report(INDEXED, count=count))
        for certs in ((INDEXED, INDEXED.replace("#1", "#2")), (INDEXED, INDEXED),
                      (ranged(28, 32), ranged(33, pin=OTHER)), (INDEXED, ranged())):
            with self.subTest(certs=certs), self.assertRaises(PackagingError):
                parse(report(*certs))

    def test_rejects_overlapping_repeated_and_invalid_sdk_ranges(self):
        cases = [(ranged(28, 33), ranged(33)), (ranged(), ranged()),
                 (ranged(28, 33), ranged(33, dev=True)), (ranged(28, 40), ranged(30, 35)),
                 (ranged(0),), (ranged(-1),), (ranged(33, 32),), (ranged(maximum=2_147_483_648),),
                 (ranged("028"),), (ranged("1" * 5000),)]
        for certs in cases:
            with self.subTest(certs=str(certs)[:150]), self.assertRaises(PackagingError):
                parse(report(*certs))

    def test_rejects_unrecognized_labels_and_missing_or_malformed_fingerprints(self):
        for cert in ("", INDEXED.replace("#1", "#2"), INDEXED.replace("#1", "#01"),
                     INDEXED.replace(PIN, PIN[:-1]), INDEXED + " trailing", INDEXED.replace("digest:", "digest"),
                     INDEXED.replace(PIN, "g" * 64), ranged().replace("maxSdkVersion", "maximumSdkVersion"),
                     ranged().replace("Signer (", "Signer #1 (")):
            with self.subTest(cert=cert), self.assertRaises(PackagingError):
                parse(report(cert))

    def test_ignores_source_stamp_certificate_when_counting_apk_signers(self):
        self.assertEqual(PIN, parse(report(INDEXED, "Source Stamp Signer certificate SHA-256 digest: " + OTHER)))
        self.assertEqual(PIN, parse(report("V3.0 Signer: certificate SHA-256 digest: " + PIN,
                                          "Source Stamp Signer: certificate SHA-256 digest: " + OTHER)))


if __name__ == "__main__":
    unittest.main()

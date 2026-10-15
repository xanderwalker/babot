"""Check packaging boundaries that prevent a release from overwriting bootloader."""

import importlib.util
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location(
    "firmware_release", Path(__file__).resolve().parents[1] / "scripts/build-firmware.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


def record(address, kind, payload=b""):
    data = bytes([len(payload), address >> 8, address & 255, kind]) + payload
    return ":" + (data + bytes([-sum(data) & 255])).hex().upper() + "\n"


class FirmwareReleaseTests(unittest.TestCase):
    def check_hex(self, *records):
        return release.validate_hex("".join(records).encode("ascii"))

    def test_application_is_contiguous_from_zero(self):
        self.assertEqual(self.check_hex(record(0, 0, b"abcd"), record(0, 1)), (4, 4))

    def test_rejects_missing_eof_and_checksum_damage(self):
        with self.assertRaises(ValueError):
            self.check_hex(record(0, 0, b"abcd"))
        with self.assertRaises(ValueError):
            self.check_hex(":040000006162636400\n", record(0, 1))

    def test_rejects_bootloader_and_eeprom_addresses(self):
        with self.assertRaises(ValueError):
            self.check_hex(record(0x7000, 0, b"x"), record(0, 1))
        with self.assertRaises(ValueError):
            self.check_hex(record(0, 4, b"\x00\x81"), record(0, 0, b"x"), record(0, 1))

    def test_rejects_sparse_overlap_or_data_after_eof(self):
        for records in (
            (record(0, 0, b"a"), record(2, 0, b"b"), record(0, 1)),
            (record(0, 0, b"a"), record(0, 0, b"b"), record(0, 1)),
            (record(0, 0, b"a"), record(0, 1), record(1, 0, b"b")),
        ):
            with self.subTest(records=records), self.assertRaises(ValueError):
                self.check_hex(*records)

    def test_source_archive_is_stable_across_input_order(self):
        first = release.deterministic_zip({"a": b"1", "b": b"2"})
        second = release.deterministic_zip({"b": b"2", "a": b"1"})
        self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Build checked, deterministic website firmware assets; never touch a device."""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import zipfile


ROOT = Path(__file__).resolve().parents[1]
CLI_VERSION = "1.5.1"
CORE_VERSION = "1.8.8"
LIBRARIES = {"Servo": "1.3.0", "CD74HC4067": "1.0.2"}
MAX_APPLICATION = 28672
BUILD_INPUTS = (
    "babot.ino", "ExternalProtocol.cpp", "ExternalProtocol.h",
    "ServoOutput.cpp", "ServoOutput.h", "FirmwareVersion.h", "sketch.yaml",
)
SOURCE_INPUTS = BUILD_INPUTS + (
    "LICENSE", "PROTOCOL.md", "firmware/INSTALL.txt",
    "firmware/THIRD_PARTY_NOTICES.txt", "scripts/build-firmware.py",
)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def validate_hex(data):
    """Reject malformed, overlapping, sparse, bootloader or EEPROM-address data."""
    image = {}
    base = 0
    ended = False
    for number, line in enumerate(data.decode("ascii").splitlines(), 1):
        if not line:
            continue
        if ended or not re.fullmatch(r":[0-9A-Fa-f]+", line):
            raise ValueError(f"Invalid HEX record at line {number}")
        record = bytes.fromhex(line[1:])
        if len(record) < 5 or len(record) != record[0] + 5 or sum(record) % 256:
            raise ValueError(f"Invalid HEX length/checksum at line {number}")
        size, high, low, kind = record[:4]
        address = high * 256 + low
        payload = record[4:-1]
        if kind == 0:
            for offset, byte in enumerate(payload):
                absolute = base + address + offset
                if absolute >= MAX_APPLICATION or absolute in image:
                    raise ValueError("HEX contains bootloader/EEPROM or overlapping data")
                image[absolute] = byte
        elif kind == 1:
            if size or address:
                raise ValueError("Invalid HEX end record")
            ended = True
        elif kind in (2, 4):
            if size != 2 or address:
                raise ValueError("Invalid HEX address record")
            base = int.from_bytes(payload, "big") << (4 if kind == 2 else 16)
        else:
            raise ValueError(f"Unsupported HEX record type {kind}")
    if not ended or not image or min(image) != 0 or len(image) != max(image) + 1:
        raise ValueError("Application must be nonempty contiguous flash from address zero")
    # A complete final 128-byte flash page must also stay outside the bootloader.
    end = max(image) + 1
    if ((end + 127) // 128) * 128 > MAX_APPLICATION:
        raise ValueError("Padded application page would overlap bootloader")
    return len(image), end


def deterministic_zip(entries):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, content in sorted(entries.items()):
            entry = zipfile.ZipInfo("babot/" + name, (1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, content)
    return output.getvalue()


def add_tree(entries, base, destination):
    for path in sorted(base.rglob("*")):
        if path.is_file() and not any(part.startswith(".") for part in path.relative_to(base).parts):
            entries[destination + "/" + path.relative_to(base).as_posix()] = path.read_bytes()


def build(cli):
    version = json.loads(subprocess.check_output([cli, "version", "--json"], text=True))
    if version.get("VersionString") != CLI_VERSION:
        raise ValueError(f"Arduino CLI {CLI_VERSION} required; found {version.get('VersionString')}")

    workspace = ROOT / "build/firmware/release"
    sketch = workspace / "sketch/babot"
    output = workspace / "output"
    # Only this script's staging directory is removed. User sketches are untouched.
    if workspace.exists():
        shutil.rmtree(workspace)
    sketch.mkdir(parents=True)
    output.mkdir(parents=True)
    for name in BUILD_INPUTS:
        shutil.copyfile(ROOT / name, sketch / name)

    result = subprocess.run([
        cli, "compile", "--profile", "babot-release", "--clean", "--json",
        "--build-path", str(workspace / "compiled"),
        "--output-dir", str(output), str(sketch),
    ], capture_output=True, text=True, env={**os.environ, "SOURCE_DATE_EPOCH": "0"})
    try:
        report = json.loads(result.stdout)
    except ValueError:
        raise RuntimeError(result.stdout + result.stderr) from None
    print(report.get("compiler_out", ""), end="")
    if report.get("compiler_err"):
        print(report["compiler_err"], file=sys.stderr, end="")
    if result.returncode or not report.get("success"):
        raise RuntimeError("Arduino compilation failed: " + result.stderr)

    builder = report["builder_result"]
    core = builder["build_platform"]
    used = {item["name"]: item for item in builder["used_libraries"]}
    if core["id"] != "arduino:avr" or core["version"] != CORE_VERSION:
        raise ValueError("Build profile selected an unexpected Arduino core")
    for name, expected in LIBRARIES.items():
        if used.get(name, {}).get("version") != expected:
            raise ValueError(f"Build profile selected an unexpected {name} version")

    # Explicitly choose application-only HEX; never .with_bootloader.hex or .eep.
    firmware = (output / "babot.ino.hex").read_bytes()
    byte_length, end = validate_hex(firmware)
    properties = dict(item.split("=", 1) for item in builder["build_properties"])
    if properties.get("compiler.elf2hex.flags") != "-O ihex -R .eeprom":
        raise ValueError("Core no longer excludes EEPROM from the application HEX")
    if properties.get("build.mcu") != "atmega32u4":
        raise ValueError("Build MCU is not ATmega32U4")
    if properties.get("upload.maximum_size") != str(MAX_APPLICATION):
        raise ValueError("Unexpected bootloader/application boundary")
    sections = {section["name"]: section["size"] for section in builder["executable_sections_size"]}
    if sections.get("text") != byte_length:
        raise ValueError("HEX payload length does not match executable flash size")

    entries = {name: (ROOT / name).read_bytes() for name in SOURCE_INPUTS}
    source_files = {name: sha256(content) for name, content in sorted(entries.items())}
    # Keep the exact source and license headers of linked dependencies available
    # without access to the private application repository.
    core_path = Path(core["install_dir"])
    for path in ("cores/arduino", "variants/leonardo", "libraries/EEPROM"):
        add_tree(entries, core_path / path, "third-party/ArduinoCore-avr/" + path)
    for path in ("boards.txt", "platform.txt"):
        entries["third-party/ArduinoCore-avr/" + path] = (core_path / path).read_bytes()
    for name in LIBRARIES:
        add_tree(entries, Path(used[name]["install_dir"]), "third-party/" + name)
    entries["third-party/ArduinoCore-avr/LICENSE.txt"] = entries["third-party/Servo/LICENSE.txt"]
    entries["INSTALL.txt"] = entries["firmware/INSTALL.txt"]
    entries["THIRD_PARTY_NOTICES.txt"] = entries["firmware/THIRD_PARTY_NOTICES.txt"]
    archive = deterministic_zip(entries)

    match = re.search(r'^#define BABOT_FIRMWARE_VERSION "(\d+\.\d+\.\d+)"$',
                      (ROOT / "FirmwareVersion.h").read_text(), re.MULTILINE)
    if not match:
        raise ValueError("FirmwareVersion.h needs a literal semantic release version")
    release = match.group(1)
    stem = "babot-motion-" + release
    manifest = {
        "schemaVersion": 1,
        "id": "babot-motion-leonardo",
        "version": release,
        "board": "arduino:avr:leonardo",
        "protocol": 1,
        "hex": stem + ".hex",
        "sha256": sha256(firmware),
        "sizeBytes": len(firmware),
        "maximumApplicationSize": MAX_APPLICATION,
        "firmwareByteLength": byte_length,
        "applicationStart": 0,
        "applicationEndExclusive": end,
        "flashPageSize": 128,
        "sourceZip": stem + "-source.zip",
        "sourceZipSha256": sha256(archive),
        "sourceZipSizeBytes": len(archive),
        "source": {
            "repository": "https://github.com/xanderwalker/babot",
            "upstreamCommit": "dca09d19d3fd281651805e8ca3b8ce80e3ee45c1",
            "files": source_files,
        },
        "build": {
            "arduinoCli": CLI_VERSION,
            "arduinoAvrCore": CORE_VERSION,
            "avrGcc": "7.3.0-atmel3.6.1-arduino7",
            "libraries": LIBRARIES,
            "ramBytes": sections.get("data"),
        },
        "license": "CC-BY-NC-4.0",
        "licenseFile": "LICENSE.txt",
        "notices": "THIRD_PARTY_NOTICES.txt",
        "installationGuide": "INSTALL.txt",
    }
    files = {
        manifest["hex"]: firmware,
        manifest["sourceZip"]: archive,
        "manifest.json": json_bytes(manifest),
        "LICENSE.txt": (ROOT / "LICENSE").read_bytes(),
        "THIRD_PARTY_NOTICES.txt": entries["THIRD_PARTY_NOTICES.txt"],
        "INSTALL.txt": entries["INSTALL.txt"],
    }
    files["SHA256SUMS"] = "".join(f"{sha256(content)}  {name}\n"
                                    for name, content in sorted(files.items())).encode("ascii")
    return files, manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Rebuild and compare; do not replace published assets")
    parser.add_argument("--arduino-cli", default="arduino-cli")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "web-player/public/firmware")
    arguments = parser.parse_args()
    files, manifest = build(arguments.arduino_cli)
    if arguments.check:
        mismatches = [name for name, content in files.items()
                      if not (arguments.output_dir / name).is_file()
                      or (arguments.output_dir / name).read_bytes() != content]
        if mismatches:
            raise ValueError("Release artifacts are stale: " + ", ".join(mismatches))
        print("All release files match a clean pinned build.")
    else:
        arguments.output_dir.mkdir(parents=True, exist_ok=True)
        for name, content in files.items():
            (arguments.output_dir / name).write_bytes(content)
        print(f"Wrote {len(files)} release files to {arguments.output_dir}")
    print(f"BaBot Motion {manifest['version']}: {manifest['firmwareByteLength']} flash bytes; "
          f"SHA-256 {manifest['sha256']}")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as error:
        sys.exit(str(error))

# Working on BaBot Motion

This repository contains an independent BaBot firmware extension and a browser
lap player. Start with [README.md](README.md). Preserve upstream attribution,
the repository licence, and bundled third-party notices.

## Help an owner install or replay

Direct owners to [the setup website](https://visualizerf1.xanderwalker.com/babot/#setup)
and [installation and recovery](FIRMWARE_INSTALL.md). A normal installation does
not require cloning this repository, an agent, a GitHub account, or Arduino IDE.
The supported controller is Arduino Leonardo / ATmega32U4 with its supported
Caterina bootloader; do not generalize this installer to other boards.

Guide the owner through preparation, browser device selection, firmware
verification, mounting checks, and the Singapore replay. Before flashing, the
separate **Power Up** supply must be disconnected, the ball/model removed, and
the USB data cable connected to **Upload Code**. Follow the setup page for the
later power and mounting steps. The physical front mode button is not a reset
button. Use the documented recovery path when the bootloader port disappears.

Opening the website or asking for code changes does not authorize flashing or
motion. Only operate real hardware when the human has authorized that action
and confirmed the relevant physical preparation. Honor authorization already
given in the conversation; do not repeatedly ask for it. Never infer hands-clear,
servo power, physical level, or successful movement from a serial reply. Routine
code edits, builds, and simulated tests do not need a hardware approval step.

## Project map

- `babot.ino`, `ExternalProtocol.*`, `ServoOutput.*`, `FirmwareVersion.h`:
  firmware and its guarded USB motion protocol; see [PROTOCOL.md](PROTOCOL.md).
- `sketch.yaml`, `scripts/build-firmware.py`, `firmware/`: pinned firmware build,
  deterministic release packaging, installation text, and third-party notices.
- `web-player/src/Setup.tsx`, `firmware-installer.mjs`, `setup-usb-lease.mjs`:
  browser installer and its USB ownership lifecycle.
- `web-player/src/`: replay UI, video clock, motion sampling, serial transport,
  mounting checks, and shared connection manager.
- `web-player/public/firmware/`: versioned HEX, source ZIP, manifest, and hashes.
- `tests/`, `web-player/tests/`: firmware host tests and simulated player tests.

See [web-player/README.md](web-player/README.md) for local development, media,
mounting backup, and optional browser test fixtures.

## Build and validate

Use Node 22.13 or later within Node 22, or Node 24, with npm. From the repository
root:

```sh
npm --prefix web-player ci
npm --prefix web-player test
npm --prefix web-player run build
npm --prefix web-player run dev
```

The dev server is at `http://127.0.0.1:5176/`; append `#setup` for the installer.
Automated tests must use mocks and must never open a real USB device. Use an
isolated browser profile for browser fixtures, following their documented setup.

Firmware host tests require a C++11 compiler and Python 3. Release builds require
Arduino CLI **1.5.1**. The `babot-release` profile pins Arduino AVR **1.8.8**,
Servo **1.3.0**, and CD74HC4067 **1.0.2**:

```sh
./tests/run.sh
python3 scripts/build-firmware.py
python3 scripts/build-firmware.py --check
```

Rebuild artifacts when their packaged inputs change; do not edit HEX, ZIP, or
hashes by hand. Keep firmware version, manifest, source archive, and checksum
files consistent. Run checks relevant to the change; documentation-only edits
do not require redundant firmware rebuilds unless they change packaged inputs.

## Preserve these contracts

- Installation writes application flash only. Preserve EEPROM servo offsets,
  bootloader, and fuses; retain signature, bounds, hash, readback, EEPROM, and
  running-firmware checks. Do not bypass verification to make an install pass.
- Installer and player share `babot-usb-controller-v1`. Release ownership only
  after transport closure; do not compete with another tab or serial tool.
- Firmware verification and browser mounting verification are separate. Never
  mark mounting verified without the owner's fresh required observations, or
  import another device's calibration as trusted.
- The selected video's media clock owns replay timing. Preserve stale-frame and
  invalid-telemetry guards, fresh user intent after faults, and stop behavior on
  pause, seek, completion, page hiding, or disconnect. `ACK STOP`, `EVENT OFF`,
  and observed physical level are different evidence.
- Preserve firmware limits, watchdog, sequencing, and one acknowledged command
  in flight. No automatic `ARM`, calibration pulse, or replay during setup.

Keep ignored credentials, local hosting state, calibration backups, device
evidence, downloaded video, and generated media out of commits. A contributor
does not need the maintainer's `.sites` checkout or deployment credentials to
build or test; do not assume those exist. Official onboard video remains on its
provider's CDN or in a user's local browser selection.

The browser installer remains beta until the complete stock-device installation
and recovery path has been observed on real hardware. Passing builds, mocks,
checksum checks, and published source establish software results, not a physical
installation or successful motion. Report those distinctions explicitly.

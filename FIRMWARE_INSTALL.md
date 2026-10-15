# Install BaBot Motion

Open [BaBot setup](https://visualizerf1.xanderwalker.com/babot/#setup) in a desktop
browser with Web Serial and Web Locks, such as Chrome or Edge. The setup page
installs firmware once, verifies it, and leads into the Singapore pole lap.
Browser installation is a beta until its complete stock-device path has been
observed on real BaBot hardware. Software tests do not prove physical motion.

## Before installing

- Use the BaBot with the Arduino Leonardo / ATmega32U4 controller. Other boards
  and modified bootloaders are not supported by this installer.
- Remove the ball/model and disconnect the separate **Power Up** supply while
  flashing. Connect a USB **data** cable from the computer to **Upload Code**.
- Close Arduino Serial Monitor and disconnect other BaBot browser tabs.
- An assembled stock BaBot should already have its servo offsets calibrated.
  Installing this firmware does not replace the manufacturer's servo calibration
  procedure or validate mechanical assembly.

## Install from the browser

1. Open setup and read the preparation instructions. The page downloads the
   versioned release and checks its SHA-256 and Intel HEX integrity before USB
   programming is enabled.
2. Select the runtime **Arduino Leonardo** port to restart into upload mode.
3. Select the newly appearing bootloader port when prompted. Browser permission
   for this port is separate from permission for the normal runtime port.
4. Keep the data cable connected through writing and readback verification.
   The installer checks the AVR signature and application bounds, reads the
   existing EEPROM, writes application flash only, verifies it, and compares
   EEPROM afterward. It does not write EEPROM, fuses, or the bootloader.
5. Use **Check installed firmware** to reconnect to the normal Leonardo port.
   A completed write is not enough: the running firmware must answer its identity
   and release-information requests before setup proceeds.
6. Continue to the player. Reconnect the separate **Power Up** supply and complete
   the small roll and pitch mounting checks with hands clear. Fresh setup revokes
   any previous browser mounting verification; firmware installation alone never
   authorizes motion.
7. Start the Singapore lap at the default 25% strength. The onboard video controls
   timing. Pause, stop, or loss of fresh video frames stops the pose stream; the
   firmware watchdog provides its independent return-to-level behavior.

If no upload port appears, restart the upload-mode step; do not select a different
board. Cancellation or an interrupted write may require repeating the installation.
Do not reconnect motor power until a complete firmware write and runtime check pass.

## Arduino IDE fallback and recovery

The setup page provides the same release's source ZIP and compiled HEX file. The
source archive contains a `babot` folder; open `babot/babot.ino` in Arduino IDE,
install the listed libraries, select **Arduino Leonardo**, and upload through
**Upload Code**. Keep the local `.cpp` and `.h` files beside the sketch.

To return to normal manufacturer firmware, use the source and installation
instructions linked in the [official BaBot manual](https://ba-bot.com/pages/manual).
Our firmware boots level in OFF; normal ball balancing is enabled by the physical
button. The official firmware's startup behavior differs.

## Development and release

`python3 scripts/build-firmware.py` builds the pinned Leonardo firmware and creates
`web-player/public/firmware/manifest.json`, its application HEX, and source ZIP.
`python3 scripts/build-firmware.py --check` verifies release artifacts against a fresh
build. Keep the firmware version and website manifest together in one release.
See the firmware's pinned build profile and [PROTOCOL.md](PROTOCOL.md) for the wire
contract. Firmware information is separate from protocol compatibility.

The website uses relative asset URLs so the same release works at `/` locally and
at `/babot/` on the hosted Site. Run `node scripts/sync-hosted-player.mjs` after
opening the existing Lapform Site source to copy current source and firmware
artifacts into its `apps/babot` folder. Publish with the Sites source workflow.
Generated ribbon media is retained separately and is not recreated by this copy.

Before declaring the installer ready for general use, record stock-to-custom
installation, EEPROM preservation, runtime verification, calibration, observed
motion, stop/disconnect behavior, and interrupted-upload recovery on supported
operating systems. No automated test should open a real USB port.

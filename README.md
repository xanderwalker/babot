# BaBot Motion · Pole Lap Player

Replay qualifying pole laps with synchronized onboard video, telemetry, chassis
visualizations, and optional motion on a BaBot.

This is an independent community extension of the [BaBot robot](https://ba-bot.com/)
and its firmware. It is not an official BaBot or Formula 1 product.

**[Set up your BaBot →](https://visualizerf1.xanderwalker.com/babot/#setup)** ·
[Open the player](https://visualizerf1.xanderwalker.com/babot/) ·
[Beta release and downloads](https://github.com/xanderwalker/babot/releases/tag/v1.0.0-beta.1)

> **Browser installer: beta.** Automated firmware and browser checks pass, but
> the complete stock-BaBot browser installation and recovery path still needs
> first-device validation. Firmware identification and software tests do not
> establish correct physical mounting or motion.

## I have a BaBot

Start at the **[setup website](https://visualizerf1.xanderwalker.com/babot/#setup)**
on the computer connected to your BaBot, using desktop Chrome or Edge. No GitHub
account, coding agent, repository clone, or Arduino IDE is needed for this path.

1. Confirm the supported Arduino Leonardo / ATmega32U4 controller. Remove the
   ball/model, disconnect separate **Power Up** power, and connect a USB data
   cable to **Upload Code**.
2. Follow the installer to select the normal USB port, restart into the
   bootloader, and install the verified firmware download.
3. Check the running firmware, then follow the power and mounting instructions.
   Observe the separate roll and pitch checks before enabling replay motion.
4. Play Singapore at the default 25% strength. Return to the player for later
   sessions; reinstalling firmware is not part of normal playback.

The installer verifies flash readback and checks that stored servo calibration
is unchanged. The player also works without hardware for video and visualization.
See **[installation, compatibility, and recovery](FIRMWARE_INSTALL.md)** for the
full instructions and Arduino IDE fallback.

## I am using a coding agent

Give your agent this repository URL and ask:

> Help me set up my stock BaBot for lap playback using
> https://github.com/xanderwalker/babot. Read AGENTS.md and FIRMWARE_INSTALL.md
> first, then guide me through the hosted installer and mounting checks.

The agent can explain prerequisites and troubleshoot. You still select the USB
device in your local browser and observe the physical checks. Agents should
start with [AGENTS.md](AGENTS.md), use the published release for ordinary setup,
and treat hardware operations separately from code changes.

## I want to build or contribute

The repository contains the Leonardo firmware and the React/TypeScript player.
The player includes a 2026 pole-lap library; Singapore is the first setup replay.
Official onboard availability, supported motion intervals, and ribbon-render
status are documented in the [player guide](web-player/README.md).

Use Node.js 22.13 or newer on the 22.x line, or Node.js 24, with npm:

```sh
git clone https://github.com/xanderwalker/babot.git
cd babot/web-player
npm ci
npm test
npm run build
npm run dev
```

Open http://127.0.0.1:5176/. A local build does not require USB hardware or access
to the hosted site's deployment account. Generated ribbon films are not stored
in Git; the player builds without them.

From the repository root, run firmware host tests with `./tests/run.sh`.
To reproduce the downloadable firmware, install Arduino CLI **1.5.1** and run:

```sh
python3 scripts/build-firmware.py --check
```

This compiles using the pinned profile and compares the release artifacts; it
does not upload to hardware. See [the protocol](PROTOCOL.md),
[firmware installation](FIRMWARE_INSTALL.md), and [player development guide](web-player/README.md).

## Firmware behavior

The extension is based on the official BaBot firmware at commit
`dca09d19d3fd281651805e8ca3b8ce80e3ee45c1`. Changes add guarded USB motion,
watchdog stops, smooth servo output, and release identification. It boots level
in `OFF`; the physical button still enables normal ball balancing. Existing
assembly and servo-calibration functions remain available.

Video time drives replay. Pausing cancels motion intent, and mounting verification
is separate from firmware verification. The displayed chassis motion is derived
from telemetry, not measured suspension movement or plate-angle feedback.
The [protocol guide](PROTOCOL.md) describes limits, acknowledgements, and stops.

## Support, attribution, and license

Use **[GitHub Issues](https://github.com/xanderwalker/babot/issues)** for this
extension's installer, player, and firmware issues. Include the browser/OS,
controller model, firmware version, and exact error. Never post credentials or
private logs. For the manufacturer's assembly instructions and original firmware,
use the [official BaBot manual](https://ba-bot.com/pages/manual).

The existing [Creative Commons Attribution-NonCommercial 4.0 license](LICENSE)
is retained. This is publicly available source with a noncommercial restriction;
publication does not remove that restriction. Credit BaBot and retain the change
and license notices. Bundled components retain their own licenses, listed in
[third-party notices](firmware/THIRD_PARTY_NOTICES.txt).

Telemetry and media provenance are recorded in the player data manifests.
Official F1 onboard footage remains on its official CDN and is not included in
this repository or covered by this project's license.

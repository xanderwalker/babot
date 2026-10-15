# BABOT
The open-source ball-balancing robot you build, program, and bring to life.

https://www.ba-bot.com
https://www.ba-bot.com/manual/

## Install and replay

Open [Set up your BaBot](https://visualizerf1.xanderwalker.com/babot/#setup) to
install the browser firmware release, verify the controller, check mounting,
and replay Singapore. See [installation and recovery](FIRMWARE_INSTALL.md) for
supported hardware, the Arduino IDE fallback, and the hardware validation status.

## Singapore lap player

The [web player](web-player/README.md) synchronizes the Singapore pole onboard,
telemetry, Blender ribbons, and a conceptual F1 chassis with USB platform motion.
Run `npm install` and `npm run dev` inside `web-player`, then open
http://127.0.0.1:5176/.

## USB chassis-motion extension

This checkout is based on the official firmware at commit
`dca09d19d3fd281651805e8ca3b8ce80e3ee45c1` and preserves its normal balance,
off, assembly, and calibration behavior. It adds a guarded, watchdog-protected
USB external-motion mode for synchronizing the platform to a video chassis pose.
Unlike upstream, this controller build boots in `OFF` at a level pose so an
upload or reboot cannot start ball-balancing while a model car is attached. A
normal physical single press still selects `ON`.
The external protocol accepts a 20-degree roll/pitch vector-magnitude envelope
(`roll^2 + pitch^2 <= 20^2`), while retaining per-command IK and
calibrated-servo validation.
The 50 Hz external follower tracks the smoothed chassis vector at up to 80
degrees/second and uses a separate 40-degree/second guarded return to level.
External-motion IK output uses a float-preserving 544-2400 microsecond servo
mapping; official normal balance, calibration, and assembly behavior remains
unchanged.
See [PROTOCOL.md](PROTOCOL.md) for the complete host contract and safety behavior.

Run the host parser contract tests with:

```sh
./tests/run.sh
```

Compile for the BaBot's Arduino Leonardo without uploading:

```sh
arduino-cli compile --fqbn arduino:avr:leonardo .
```

# 🧾 License
This project is licensed under the Creative Commons Attribution-NonCommercial 4.0 International License.

# 📞 Contact
For inquiries or support, please contact: info@ba-bot.com

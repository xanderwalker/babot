# BaBot external-motion protocol

This firmware keeps the official BaBot modes and adds a guarded `EXTERNAL`
mode for a USB host. The host sends newline-delimited ASCII at 115200 baud.
Lines may end in LF or CRLF. Commands are case-sensitive and must fit in 63
bytes, excluding the terminator.

The controller build boots level in normal `OFF` mode. It never starts the
official ball-balancing loop merely because firmware was uploaded or rebooted;
a physical single press can still select normal `ON` mode.

## Identification

The firmware makes a best-effort boot announcement:

```text
READY BABOT_MOTION 1
```

Native USB can connect after that announcement, so the authoritative probe is:

```text
PING 1
ACK 1 PING BABOT_MOTION 1
```

`PING` is accepted in every mode. It never moves the platform, arms external
control, changes the armed session sequence, or refreshes the motion watchdog.
A controller must require product `BABOT_MOTION` and protocol version `1` before
enabling motion.

## Motion commands

```text
ARM <seq>
POSE <seq> <roll-deg> <pitch-deg>
LEVEL <seq>
STOP <seq>
```

`seq` is an unsigned decimal integer from 1 through 4294967295. `ARM` starts a
new session and establishes its first sequence. Every subsequent motion command
must have a strictly larger sequence. Start another session well before the
counter reaches its maximum; wraparound is not accepted.

`ARM` is accepted from normal `ON` or `OFF`, levels the platform, and enters
external mode. It is rejected during assembly or calibration. `POSE` sets a
target in decimal degrees. `LEVEL` is a live, level target and still acts as a
watchdog heartbeat. `STOP` ends the session and performs a slew-limited return
to level before entering normal `OFF` mode.

Accepted commands receive:

```text
ACK <seq> ARM
ACK <seq> POSE
ACK <seq> LEVEL
ACK <seq> STOP
```

Rejected input receives `NACK <seq> <reason>`. The sequence is zero when the
line could not be parsed far enough to recover a valid ID. Reasons are:

```text
BAD_COMMAND BAD_SEQUENCE BAD_ARITY BAD_NUMBER LINE_TOO_LONG
BUSY NOT_ARMED STALE_SEQUENCE LIMIT IK
```

## Safety contract

- The protocol envelope is a 20-degree roll/pitch vector-magnitude circle:
  `roll^2 + pitch^2 <= 20^2`. Full +/-20-degree cardinal-axis poses are allowed,
  while combined poses share that budget: `(12, 16)` is allowed and `(20, 20)`
  receives `NACK <seq> LIMIT`. This circular policy is
  not a promise that every in-envelope pose fits every calibration: the live
  EEPROM servo offsets and strict IK/servo checks remain authoritative, and an
  in-envelope command can still receive `NACK <seq> IK`.
- An exhaustive 0.05-degree host grid of 502,617 accepted poses at the 65 mm
  plate height found linkage cosine terms from 0.863098 to 0.956292 and logical
  servo angles from 2.75383 to 61.12989 degrees. Because stored offsets are
  integers, the full accepted circle needs offsets of at least 62 on A/B/C; the
  firmware checks the actual stored offsets rather than assuming those values.
  The upstream boot clamp permits an offset of 50, which does not cover the
  accepted circle; the official calibration flow's no-adjustment baseline is 75,
  which does. Do not assume the connected robot's calibration without checking
  it through the user-operated calibration procedure.
- The official IK reduces each linkage to its radial/vertical plane and ignores
  tangential attachment displacement. That ignored component reaches 23.808 mm
  in this grid, so passing the firmware math does not prove linkage clearance,
  platform clearance, stability, or safe motion with a payload.
- Start the first unloaded test with the controller's motion scale well below
  100 percent.
- Every target is inverse-kinematics checked before it is accepted, and every
  intermediate pose is checked again before servo writes.
- External platform motion clamps each calibrated servo command to 0-180
  degrees, maps it continuously to the Servo library's default 544-2400 us
  pulse range, and writes microseconds. All integer-degree outputs exactly match
  Arduino `Servo.write`; fractional IK output is retained at one-microsecond
  resolution. Official normal balance, assembly, and calibration writes remain
  unchanged.
- Output is updated at no more than 50 Hz. Active tracking follows the direct
  current-to-target vector at up to 80 degrees/second (1.6 degrees per tick),
  covering the measured lap trace's 77.802-degree/second maximum without
  changing its direction. STOP, watchdog, and button exits use a gentler
  40-degree/second vector return to level.
- The host must send `POSE` or `LEVEL` at 50 Hz even when the target is unchanged.
- After 250 ms without an accepted motion command, the firmware rejects further
  poses, ramps to level, and returns to `OFF`. Detection occurs on the 50 Hz
  motion tick, so the observed trigger is 250-270 ms after the last command.
- Pressing the physical button in external mode immediately starts the same
  guarded return. The press is consumed and cannot toggle a normal mode afterward.
- IR measurement, ball detection, and PID balance work are skipped in external
  mode so they cannot block USB pose timing.
- Official assembly mode is unchanged: it directly sweeps each servo alone from
  100 to 180 and back to 100 with 250 ms delays. It bypasses platform IK, so an
  assembly sweep is not evidence that a coordinated roll/pitch pose is valid.

Safety transitions emit one or more unsequenced notices:

```text
EVENT WATCHDOG
EVENT BUTTON_EXIT
EVENT IK_FAULT
EVENT OFF
```

Any of the first three disables pose acceptance immediately. `EVENT OFF` means
the slew-limited level return has completed.

## Video controller lifecycle

1. Open the Arduino Leonardo serial port at 115200 and send `PING`.
2. Verify the exact compatible-firmware reply, then send `ARM`.
3. On each 20 ms video clock tick, sample the chassis pose for the video's
   current media time and send a fresh `POSE` sequence.
4. Treat the video's media clock as authoritative; never advance motion from a
   separate wall-clock timer.
5. On pause, seek, ended, page hide, serial error, or controller disconnect,
   send `STOP` when possible. Re-identify and re-arm before resuming.
6. Disable Play on any `NACK` or `EVENT` until the controller has deliberately
   restored a safe session.

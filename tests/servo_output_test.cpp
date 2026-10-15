#include "../ServoOutput.h"

#include <assert.h>
#include <math.h>
#include <stdio.h>

int main() {
  // Arduino map(value, 0, 180, 544, 2400) is the exact Servo.write mapping
  // for the default attach(pin) configuration. Preserve every integer input.
  for (int degrees = 0; degrees <= 180; ++degrees) {
    const int official =
        degrees * (BABOT_SERVO_MAX_MICROSECONDS -
                   BABOT_SERVO_MIN_MICROSECONDS) /
            180 +
        BABOT_SERVO_MIN_MICROSECONDS;
    assert(babotServoDegreesToMicroseconds(static_cast<float>(degrees)) ==
           official);
  }

  assert(babotServoDegreesToMicroseconds(-10.0f) ==
         BABOT_SERVO_MIN_MICROSECONDS);
  assert(babotServoDegreesToMicroseconds(190.0f) ==
         BABOT_SERVO_MAX_MICROSECONDS);
  assert(babotServoDegreesToMicroseconds(NAN) == 1472);

  const int at90 = babotServoDegreesToMicroseconds(90.0f);
  const int at901 = babotServoDegreesToMicroseconds(90.1f);
  const int at9025 = babotServoDegreesToMicroseconds(90.25f);
  const int at905 = babotServoDegreesToMicroseconds(90.5f);
  assert(at90 == 1472);
  assert(at901 > at90);
  assert(at9025 > at901);
  assert(at905 > at9025);

  int distinctPulses = 1;
  int previous = babotServoDegreesToMicroseconds(90.0f);
  for (int tenth = 1; tenth <= 10; ++tenth) {
    const int pulse =
        babotServoDegreesToMicroseconds(90.0f + tenth * 0.1f);
    assert(pulse >= previous);
    if (pulse != previous) ++distinctPulses;
    previous = pulse;
  }
  assert(distinctPulses >= 10);

  printf("servo mapping: 0=%dus, 90=%dus, 180=%dus; "
         "90.0/90.1/90.25/90.5=%d/%d/%d/%dus\n",
         babotServoDegreesToMicroseconds(0.0f), at90,
         babotServoDegreesToMicroseconds(180.0f), at90, at901, at9025,
         at905);
  return 0;
}

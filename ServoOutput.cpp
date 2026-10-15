#include "ServoOutput.h"

int babotServoDegreesToMicroseconds(float degrees) {
  // NaN cannot pass coordinated IK, but map it to the neutral midpoint if this
  // helper is ever called independently.
  if (degrees != degrees) degrees = 90.0f;
  if (degrees < 0.0f) degrees = 0.0f;
  if (degrees > 180.0f) degrees = 180.0f;

  const float pulse =
      static_cast<float>(BABOT_SERVO_MIN_MICROSECONDS) +
      degrees * static_cast<float>(BABOT_SERVO_MAX_MICROSECONDS -
                                   BABOT_SERVO_MIN_MICROSECONDS) /
          180.0f;

  // Servo::write uses Arduino map(), which truncates for non-negative values.
  // Truncating here matches all integer-degree writes exactly while retaining
  // approximately 0.1-degree resolution through integer microseconds.
  int microseconds = static_cast<int>(pulse);
  if (microseconds < BABOT_SERVO_MIN_MICROSECONDS) {
    microseconds = BABOT_SERVO_MIN_MICROSECONDS;
  }
  if (microseconds > BABOT_SERVO_MAX_MICROSECONDS) {
    microseconds = BABOT_SERVO_MAX_MICROSECONDS;
  }
  return microseconds;
}

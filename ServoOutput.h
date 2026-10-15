#ifndef BABOT_SERVO_OUTPUT_H
#define BABOT_SERVO_OUTPUT_H

// Arduino Servo 1.3.0 defaults used by Servo::attach(pin). Coordinated BaBot
// platform writes use the same endpoints while preserving fractional degrees.
const int BABOT_SERVO_MIN_MICROSECONDS = 544;
const int BABOT_SERVO_MAX_MICROSECONDS = 2400;

int babotServoDegreesToMicroseconds(float degrees);

#endif

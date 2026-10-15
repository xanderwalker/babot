#include <assert.h>
#include <math.h>
#include <stdio.h>

#include "../ExternalProtocol.h"

// Host reproduction of calculatePlatformServoAngles() in babot.ino. The use of
// float operations and *f math functions mirrors the ATmega32u4, where double
// has the same precision as float. This test deliberately evaluates roll and
// pitch together rather than checking each axis independently.
namespace {

const float kPi = 3.14159265358979323846f;
const float kDegToRad = kPi / 180.0f;
const float kRadToDeg = 180.0f / kPi;
const float kR1 = 50.0f;
const float kR2 = 39.2f;
const float kBaseR = 32.9f / sqrtf(3.0f);
const float kPlatformR = 107.9f / sqrtf(3.0f);
const float kPlateHeight = 65.0f;

struct IkResult {
  float logical[3];  // A, B, C after the firmware's linkage mapping
  float rawCosine[3];
  float tangential[3];  // ignored by the official radial/vertical IK
};

bool calculateFirmwareIk(float rollDeg, float pitchDeg, IkResult &result) {
  const float roll = -rollDeg * kDegToRad;
  const float pitch = -pitchDeg * kDegToRad;
  float angles[3];

  for (int i = 0; i < 3; ++i) {
    const float baseAngle = static_cast<float>(i) * 120.0f * kDegToRad;
    const float px = kPlatformR * cosf(baseAngle);
    const float py = kPlatformR * sinf(baseAngle);
    const float x1 = px * cosf(pitch) + kPlateHeight * sinf(pitch);
    const float z1 = -px * sinf(pitch) + kPlateHeight * cosf(pitch);
    const float y1 = py * cosf(roll) - z1 * sinf(roll);
    const float z2 = py * sinf(roll) + z1 * cosf(roll);
    const float bx = kBaseR * cosf(baseAngle);
    const float by = kBaseR * sinf(baseAngle);
    const float dx = x1 - bx;
    const float dy = y1 - by;
    const float dxLocal = dx * cosf(baseAngle) + dy * sinf(baseAngle);
    result.tangential[i] =
        -dx * sinf(baseAngle) + dy * cosf(baseAngle);
    const float distance = sqrtf(dxLocal * dxLocal + z2 * z2);
    if (!isfinite(distance) || distance <= 0.0001f) return false;

    const float rawCosine =
        (kR1 * kR1 + distance * distance - kR2 * kR2) /
        (2.0f * kR1 * distance);
    result.rawCosine[i] = rawCosine;
    if (rawCosine < -1.0001f || rawCosine > 1.0001f) return false;
    const float constrained =
        rawCosine < -1.0f ? -1.0f : (rawCosine > 1.0f ? 1.0f : rawCosine);
    angles[i] =
        (atan2f(z2, dxLocal) - acosf(constrained)) * kRadToDeg;
    if (!isfinite(angles[i])) return false;
  }

  result.logical[0] = angles[2];
  result.logical[1] = angles[0];
  result.logical[2] = angles[1];
  return true;
}

}  // namespace

int main() {
  float logicalMin[3] = {INFINITY, INFINITY, INFINITY};
  float logicalMax[3] = {-INFINITY, -INFINITY, -INFINITY};
  float rawMin = INFINITY;
  float rawMax = -INFINITY;
  float maxTangentialMagnitude = 0.0f;
  unsigned long samples = 0;

  // Scan a +/-20-degree square but include only the circular protocol envelope.
  // The production hard-limit function is used here, not a duplicate policy.
  for (int rollIndex = 0; rollIndex <= 800; ++rollIndex) {
    const float roll = rollIndex == 0 ? -20.0f
                       : rollIndex == 400 ? 0.0f
                       : rollIndex == 800 ? 20.0f
                       : -20.0f + static_cast<float>(rollIndex) * 0.05f;
    for (int pitchIndex = 0; pitchIndex <= 800; ++pitchIndex) {
      const float pitch = pitchIndex == 0 ? -20.0f
                          : pitchIndex == 400 ? 0.0f
                          : pitchIndex == 800 ? 20.0f
                          : -20.0f +
                                static_cast<float>(pitchIndex) * 0.05f;
      if (!externalPoseWithinHardLimits(roll, pitch)) continue;
      IkResult result;
      assert(calculateFirmwareIk(roll, pitch, result));
      ++samples;

      for (int servo = 0; servo < 3; ++servo) {
        const float logical = result.logical[servo];
        assert(logical >= -10.0f && logical <= 85.0f);
        if (logical < logicalMin[servo]) logicalMin[servo] = logical;
        if (logical > logicalMax[servo]) logicalMax[servo] = logical;
        if (result.rawCosine[servo] < rawMin) rawMin = result.rawCosine[servo];
        if (result.rawCosine[servo] > rawMax) rawMax = result.rawCosine[servo];
        const float tangentialMagnitude = fabsf(result.tangential[servo]);
        if (tangentialMagnitude > maxTangentialMagnitude) {
          maxTangentialMagnitude = tangentialMagnitude;
        }
      }
    }
  }

  // Boundary membership can differ by a few points across host libm/float
  // implementations; the production predicate still defines each decision.
  assert(samples > 500000UL && samples < 505000UL);
  assert(rawMin > 0.8629f && rawMin < 0.8633f);
  assert(rawMax > 0.9561f && rawMax < 0.9565f);
  assert(logicalMin[0] > 2.856f && logicalMin[0] < 2.859f);
  assert(logicalMin[1] > 2.752f && logicalMin[1] < 2.756f);
  assert(logicalMin[2] > 2.856f && logicalMin[2] < 2.859f);
  assert(logicalMax[0] > 61.002f && logicalMax[0] < 61.006f);
  assert(logicalMax[1] > 61.128f && logicalMax[1] < 61.132f);
  assert(logicalMax[2] > 61.002f && logicalMax[2] < 61.006f);
  assert(maxTangentialMagnitude > 23.806f &&
         maxTangentialMagnitude < 23.811f);
  assert(externalPoseWithinHardLimits(20.0f, 0.0f));
  assert(externalPoseWithinHardLimits(12.0f, 16.0f));
  assert(!externalPoseWithinHardLimits(20.0f, 20.0f));

  // Servo.write receives offset - logicalAngle. A uniform offset of 75 (the
  // calibration flow's no-adjustment baseline) covers this grid; the boot-time
  // lower clamp of 50 does not. Runtime firmware therefore must keep checking
  // the actual three EEPROM offsets, as it does.
  for (int servo = 0; servo < 3; ++servo) {
    assert(75.0f - logicalMax[servo] >= 0.0f);
    assert(75.0f - logicalMin[servo] <= 180.0f);
  }
  assert(50.0f - logicalMax[0] < 0.0f);
  assert(50.0f - logicalMax[2] < 0.0f);

  printf("IK grid %lu poses: raw cosine %.6f..%.6f\n", samples, rawMin,
         rawMax);
  printf("logical A %.6f..%.6f, B %.6f..%.6f, C %.6f..%.6f deg\n",
         logicalMin[0], logicalMax[0], logicalMin[1], logicalMax[1],
         logicalMin[2], logicalMax[2]);
  printf("maximum tangential displacement ignored by official IK: %.6f mm\n",
         maxTangentialMagnitude);
  printf("uniform offset 75 command envelope %.6f..%.6f deg\n",
         75.0f - fmaxf(fmaxf(logicalMax[0], logicalMax[1]), logicalMax[2]),
         75.0f - fminf(fminf(logicalMin[0], logicalMin[1]), logicalMin[2]));
  printf("offset 50 aggregate command envelope %.6f..%.6f deg\n",
         50.0f - fmaxf(fmaxf(logicalMax[0], logicalMax[1]), logicalMax[2]),
         50.0f - fminf(fminf(logicalMin[0], logicalMin[1]), logicalMin[2]));
  printf("offset 150 aggregate command envelope %.6f..%.6f deg\n",
         150.0f - fmaxf(fmaxf(logicalMax[0], logicalMax[1]), logicalMax[2]),
         150.0f - fminf(fminf(logicalMin[0], logicalMin[1]), logicalMin[2]));
  return 0;
}

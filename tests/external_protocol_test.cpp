#include "../ExternalProtocol.h"

#include <assert.h>
#include <math.h>
#include <string>

static ExternalFeedResult feed(ExternalLineParser &parser,
                               const std::string &bytes,
                               ExternalCommand &command,
                               ExternalParseError &error) {
  ExternalFeedResult result = EXTERNAL_FEED_NONE;
  for (size_t i = 0; i < bytes.size(); ++i) {
    ExternalFeedResult next = parser.push(bytes[i], command, error);
    if (next != EXTERNAL_FEED_NONE) result = next;
  }
  return result;
}

static void assertNear(float actual, float expected) {
  assert(fabs(actual - expected) < 0.0001f);
}

int main() {
  ExternalLineParser parser;
  ExternalCommand command;
  ExternalParseError error = EXTERNAL_PARSE_OK;

  assert(feed(parser, "PING 1\n", command, error) == EXTERNAL_FEED_COMMAND);
  assert(command.type == EXTERNAL_COMMAND_PING);
  assert(command.sequence == 1);

  assert(feed(parser, "ARM ", command, error) == EXTERNAL_FEED_NONE);
  assert(feed(parser, "42\r\n", command, error) == EXTERNAL_FEED_COMMAND);
  assert(command.type == EXTERNAL_COMMAND_ARM);
  assert(command.sequence == 42);

  assert(feed(parser, "POSE 43 +12.000 -16.000\n", command, error) ==
         EXTERNAL_FEED_COMMAND);
  assert(command.type == EXTERNAL_COMMAND_POSE);
  assert(command.sequence == 43);
  assertNear(command.rollDeg, 12.0f);
  assertNear(command.pitchDeg, -16.0f);

  assert(feed(parser, "LEVEL 44\nSTOP 45\n", command, error) ==
         EXTERNAL_FEED_COMMAND);
  assert(command.type == EXTERNAL_COMMAND_STOP);
  assert(command.sequence == 45);

  assert(feed(parser, "POSE 46 nan 0\n", command, error) ==
         EXTERNAL_FEED_ERROR);
  assert(error == EXTERNAL_PARSE_BAD_NUMBER);
  assert(command.sequence == 46);
  assert(feed(parser, "POSE 46 1e2 0\n", command, error) ==
         EXTERNAL_FEED_ERROR);
  assert(error == EXTERNAL_PARSE_BAD_NUMBER);
  assert(feed(parser, "ARM 0\n", command, error) == EXTERNAL_FEED_ERROR);
  assert(error == EXTERNAL_PARSE_BAD_SEQUENCE);
  assert(feed(parser, "ARM 4294967296\n", command, error) ==
         EXTERNAL_FEED_ERROR);
  assert(error == EXTERNAL_PARSE_BAD_SEQUENCE);
  assert(feed(parser, "POSE 50 1\n", command, error) == EXTERNAL_FEED_ERROR);
  assert(error == EXTERNAL_PARSE_BAD_ARITY);
  assert(feed(parser, "DRIVE 51 1 2\n", command, error) ==
         EXTERNAL_FEED_ERROR);
  assert(error == EXTERNAL_PARSE_BAD_COMMAND);

  std::string oversized(ExternalLineParser::LINE_CAPACITY, 'X');
  oversized += '\n';
  assert(feed(parser, oversized, command, error) == EXTERNAL_FEED_ERROR);
  assert(error == EXTERNAL_PARSE_LINE_TOO_LONG);
  assert(command.sequence == 0);

  assert(!externalSequenceIsNewer(10, 10));
  assert(!externalSequenceIsNewer(9, 10));
  assert(externalSequenceIsNewer(11, 10));
  assert(!externalSequenceIsNewer(1, 0xFFFFFFFFUL));
  assert(externalPoseWithinHardLimits(-20.0f, 0.0f));
  assert(externalPoseWithinHardLimits(0.0f, 20.0f));
  assert(externalPoseWithinHardLimits(12.0f, 16.0f));
  assert(externalPoseWithinHardLimits(-12.0f, -16.0f));
  assert(!externalPoseWithinHardLimits(20.0f, 20.0f));
  assert(!externalPoseWithinHardLimits(20.0f, 0.001f));
  assert(!externalPoseWithinHardLimits(20.001f, 0.0f));
  assert(!externalPoseWithinHardLimits(0.0f, -20.001f));
  assert(!externalPoseWithinHardLimits(NAN, 0.0f));

  float nextRoll = 0.0f;
  float nextPitch = 0.0f;
  externalStepTowardVector(0.0f, 0.0f, 20.0f, 0.0f, 1.6f,
                           nextRoll, nextPitch);
  assertNear(nextRoll, 1.6f);
  assertNear(nextPitch, 0.0f);

  externalStepTowardVector(0.0f, 0.0f, 12.0f, 16.0f, 1.6f,
                           nextRoll, nextPitch);
  assertNear(nextRoll, 0.96f);
  assertNear(nextPitch, 1.28f);
  assertNear(sqrtf(nextRoll * nextRoll + nextPitch * nextPitch), 1.6f);

  externalStepTowardVector(1.0f, -1.0f, 1.5f, -0.5f, 1.6f,
                           nextRoll, nextPitch);
  assertNear(nextRoll, 1.5f);
  assertNear(nextPitch, -0.5f);

  externalStepTowardVector(20.0f, 0.0f, 0.0f, 20.0f, 1.6f,
                           nextRoll, nextPitch);
  assertNear(sqrtf((nextRoll - 20.0f) * (nextRoll - 20.0f) +
                   nextPitch * nextPitch), 1.6f);
  assert(externalPoseWithinHardLimits(nextRoll, nextPitch));

  return 0;
}

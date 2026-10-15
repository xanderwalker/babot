#ifndef BABOT_EXTERNAL_PROTOCOL_H
#define BABOT_EXTERNAL_PROTOCOL_H

#include <stddef.h>
#include <stdint.h>

// The parser is intentionally independent of Arduino APIs so the exact wire
// contract can be exercised by a normal host C++ compiler.
enum ExternalCommandType : uint8_t {
  EXTERNAL_COMMAND_NONE = 0,
  EXTERNAL_COMMAND_PING,
  EXTERNAL_COMMAND_ARM,
  EXTERNAL_COMMAND_POSE,
  EXTERNAL_COMMAND_LEVEL,
  EXTERNAL_COMMAND_STOP
};

enum ExternalParseError : uint8_t {
  EXTERNAL_PARSE_OK = 0,
  EXTERNAL_PARSE_EMPTY,
  EXTERNAL_PARSE_LINE_TOO_LONG,
  EXTERNAL_PARSE_BAD_COMMAND,
  EXTERNAL_PARSE_BAD_SEQUENCE,
  EXTERNAL_PARSE_BAD_ARITY,
  EXTERNAL_PARSE_BAD_NUMBER
};

enum ExternalFeedResult : uint8_t {
  EXTERNAL_FEED_NONE = 0,
  EXTERNAL_FEED_COMMAND,
  EXTERNAL_FEED_ERROR
};

struct ExternalCommand {
  ExternalCommandType type;
  uint32_t sequence;
  float rollDeg;
  float pitchDeg;
};

class ExternalLineParser {
 public:
  static const uint8_t LINE_CAPACITY = 64;

  ExternalLineParser();
  ExternalFeedResult push(char incoming, ExternalCommand &command,
                          ExternalParseError &error);
  void reset();

 private:
  char line_[LINE_CAPACITY];
  uint8_t length_;
  bool overflow_;
  bool invalidCharacter_;
};

bool parseExternalCommandLine(char *line, ExternalCommand &command,
                              ExternalParseError &error);
bool externalSequenceIsNewer(uint32_t candidate, uint32_t previous);
bool externalPoseWithinHardLimits(float rollDeg, float pitchDeg);
void externalStepTowardVector(float currentRollDeg, float currentPitchDeg,
                              float targetRollDeg, float targetPitchDeg,
                              float maximumVectorStepDeg,
                              float &nextRollDeg, float &nextPitchDeg);
const char *externalCommandName(ExternalCommandType type);
const char *externalParseErrorName(ExternalParseError error);

#endif

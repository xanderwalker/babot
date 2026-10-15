#include "ExternalProtocol.h"

#include <math.h>
#include <string.h>

namespace {

bool isSpace(char value) {
  return value == ' ' || value == '\t';
}

bool parseSequence(const char *token, uint32_t &value) {
  if (token == NULL || *token == '\0') return false;

  uint32_t parsed = 0;
  const char *cursor = token;
  while (*cursor != '\0') {
    if (*cursor < '0' || *cursor > '9') return false;
    uint8_t digit = static_cast<uint8_t>(*cursor - '0');
    if (parsed > (0xFFFFFFFFUL - digit) / 10UL) return false;
    parsed = parsed * 10UL + digit;
    ++cursor;
  }

  if (parsed == 0) return false;
  value = parsed;
  return true;
}

bool parseDecimal(const char *token, float &value) {
  if (token == NULL || *token == '\0') return false;

  const char *cursor = token;
  bool negative = false;
  if (*cursor == '+' || *cursor == '-') {
    negative = (*cursor == '-');
    ++cursor;
  }

  bool sawDigit = false;
  float parsed = 0.0f;
  while (*cursor >= '0' && *cursor <= '9') {
    sawDigit = true;
    if (parsed > 1000000.0f) return false;
    parsed = parsed * 10.0f + static_cast<float>(*cursor - '0');
    ++cursor;
  }

  if (*cursor == '.') {
    ++cursor;
    float place = 0.1f;
    while (*cursor >= '0' && *cursor <= '9') {
      sawDigit = true;
      parsed += static_cast<float>(*cursor - '0') * place;
      place *= 0.1f;
      ++cursor;
    }
  }

  if (!sawDigit || *cursor != '\0') return false;
  value = negative ? -parsed : parsed;
  return true;
}

ExternalCommandType parseCommandName(const char *token) {
  if (strcmp(token, "PING") == 0) return EXTERNAL_COMMAND_PING;
  if (strcmp(token, "INFO") == 0) return EXTERNAL_COMMAND_INFO;
  if (strcmp(token, "ARM") == 0) return EXTERNAL_COMMAND_ARM;
  if (strcmp(token, "POSE") == 0) return EXTERNAL_COMMAND_POSE;
  if (strcmp(token, "LEVEL") == 0) return EXTERNAL_COMMAND_LEVEL;
  if (strcmp(token, "STOP") == 0) return EXTERNAL_COMMAND_STOP;
  return EXTERNAL_COMMAND_NONE;
}

}  // namespace

ExternalLineParser::ExternalLineParser() {
  reset();
}

void ExternalLineParser::reset() {
  length_ = 0;
  overflow_ = false;
  invalidCharacter_ = false;
  line_[0] = '\0';
}

ExternalFeedResult ExternalLineParser::push(char incoming,
                                            ExternalCommand &command,
                                            ExternalParseError &error) {
  error = EXTERNAL_PARSE_OK;

  if (incoming == '\r') return EXTERNAL_FEED_NONE;

  if (incoming != '\n') {
    unsigned char byteValue = static_cast<unsigned char>(incoming);
    if ((byteValue < 0x20 && incoming != '\t') || byteValue > 0x7E) {
      invalidCharacter_ = true;
      return EXTERNAL_FEED_NONE;
    }
    if (overflow_) return EXTERNAL_FEED_NONE;
    if (length_ >= LINE_CAPACITY - 1) {
      overflow_ = true;
      return EXTERNAL_FEED_NONE;
    }
    line_[length_++] = incoming;
    return EXTERNAL_FEED_NONE;
  }

  command.type = EXTERNAL_COMMAND_NONE;
  command.sequence = 0;
  command.rollDeg = 0.0f;
  command.pitchDeg = 0.0f;

  if (overflow_) {
    reset();
    error = EXTERNAL_PARSE_LINE_TOO_LONG;
    return EXTERNAL_FEED_ERROR;
  }
  if (invalidCharacter_) {
    reset();
    error = EXTERNAL_PARSE_BAD_COMMAND;
    return EXTERNAL_FEED_ERROR;
  }
  if (length_ == 0) {
    reset();
    return EXTERNAL_FEED_NONE;
  }

  line_[length_] = '\0';
  bool parsed = parseExternalCommandLine(line_, command, error);
  reset();
  return parsed ? EXTERNAL_FEED_COMMAND : EXTERNAL_FEED_ERROR;
}

bool parseExternalCommandLine(char *line, ExternalCommand &command,
                              ExternalParseError &error) {
  command.type = EXTERNAL_COMMAND_NONE;
  command.sequence = 0;
  command.rollDeg = 0.0f;
  command.pitchDeg = 0.0f;
  error = EXTERNAL_PARSE_OK;

  char *tokens[5] = {NULL, NULL, NULL, NULL, NULL};
  uint8_t tokenCount = 0;
  char *cursor = line;
  while (*cursor != '\0') {
    while (isSpace(*cursor)) ++cursor;
    if (*cursor == '\0') break;
    if (tokenCount >= 5) {
      error = EXTERNAL_PARSE_BAD_ARITY;
      return false;
    }
    tokens[tokenCount++] = cursor;
    while (*cursor != '\0' && !isSpace(*cursor)) ++cursor;
    if (*cursor != '\0') *cursor++ = '\0';
  }

  if (tokenCount == 0) {
    error = EXTERNAL_PARSE_EMPTY;
    return false;
  }

  command.type = parseCommandName(tokens[0]);
  if (command.type == EXTERNAL_COMMAND_NONE) {
    error = EXTERNAL_PARSE_BAD_COMMAND;
    return false;
  }

  uint8_t expectedTokens =
      (command.type == EXTERNAL_COMMAND_POSE) ? 4 : 2;
  if (tokenCount != expectedTokens) {
    error = EXTERNAL_PARSE_BAD_ARITY;
    return false;
  }

  if (!parseSequence(tokens[1], command.sequence)) {
    error = EXTERNAL_PARSE_BAD_SEQUENCE;
    return false;
  }

  if (command.type == EXTERNAL_COMMAND_POSE) {
    if (!parseDecimal(tokens[2], command.rollDeg) ||
        !parseDecimal(tokens[3], command.pitchDeg)) {
      error = EXTERNAL_PARSE_BAD_NUMBER;
      return false;
    }
  }

  return true;
}

bool externalSequenceIsNewer(uint32_t candidate, uint32_t previous) {
  return candidate > previous;
}

bool externalPoseWithinHardLimits(float rollDeg, float pitchDeg) {
  // NaN is the only floating-point value unequal to itself. Infinities fail
  // the finite hard-limit comparisons below.
  if (rollDeg != rollDeg || pitchDeg != pitchDeg) return false;
  const float absRoll = rollDeg < 0.0f ? -rollDeg : rollDeg;
  const float absPitch = pitchDeg < 0.0f ? -pitchDeg : pitchDeg;
  if (absRoll > 20.0f || absPitch > 20.0f) return false;

  // Factoring radius^2 - major^2 avoids losing the small remaining budget
  // near a cardinal-axis limit (for example, 20.0, 0.001).
  const float major = absRoll > absPitch ? absRoll : absPitch;
  const float minor = absRoll > absPitch ? absPitch : absRoll;
  const float remainingSquared = (20.0f - major) * (20.0f + major);
  return minor * minor <= remainingSquared;
}

void externalStepTowardVector(float currentRollDeg, float currentPitchDeg,
                              float targetRollDeg, float targetPitchDeg,
                              float maximumVectorStepDeg,
                              float &nextRollDeg, float &nextPitchDeg) {
  if (maximumVectorStepDeg <= 0.0f) {
    nextRollDeg = currentRollDeg;
    nextPitchDeg = currentPitchDeg;
    return;
  }

  const float deltaRoll = targetRollDeg - currentRollDeg;
  const float deltaPitch = targetPitchDeg - currentPitchDeg;
  const float distanceSquared =
      deltaRoll * deltaRoll + deltaPitch * deltaPitch;
  const float maximumStepSquared =
      maximumVectorStepDeg * maximumVectorStepDeg;
  if (distanceSquared <= maximumStepSquared) {
    nextRollDeg = targetRollDeg;
    nextPitchDeg = targetPitchDeg;
    return;
  }

  const float scale = maximumVectorStepDeg / sqrtf(distanceSquared);
  nextRollDeg = currentRollDeg + deltaRoll * scale;
  nextPitchDeg = currentPitchDeg + deltaPitch * scale;
}

const char *externalCommandName(ExternalCommandType type) {
  switch (type) {
    case EXTERNAL_COMMAND_PING:  return "PING";
    case EXTERNAL_COMMAND_INFO:  return "INFO";
    case EXTERNAL_COMMAND_ARM:   return "ARM";
    case EXTERNAL_COMMAND_POSE:  return "POSE";
    case EXTERNAL_COMMAND_LEVEL: return "LEVEL";
    case EXTERNAL_COMMAND_STOP:  return "STOP";
    default:                     return "UNKNOWN";
  }
}

const char *externalParseErrorName(ExternalParseError error) {
  switch (error) {
    case EXTERNAL_PARSE_EMPTY:          return "EMPTY";
    case EXTERNAL_PARSE_LINE_TOO_LONG:  return "LINE_TOO_LONG";
    case EXTERNAL_PARSE_BAD_COMMAND:    return "BAD_COMMAND";
    case EXTERNAL_PARSE_BAD_SEQUENCE:   return "BAD_SEQUENCE";
    case EXTERNAL_PARSE_BAD_ARITY:      return "BAD_ARITY";
    case EXTERNAL_PARSE_BAD_NUMBER:     return "BAD_NUMBER";
    default:                            return "OK";
  }
}

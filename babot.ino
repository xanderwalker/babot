/**
 * BaBot Code
 * Operating Modes:
 * - ON:           Active balancing with PID control
 * - OFF:          Platform level, no balancing
 * - ASSEMBLY:     Servos sweep for assembly verification
 * - CALIBRATION:  Interactive servo offset calibration
 * - EXTERNAL:     Guarded USB roll/pitch control with watchdog
 */

#include <CD74HC4067.h>
#include <Servo.h>
#include <math.h>
#include <EEPROM.h>
#include "ExternalProtocol.h"
#include "FirmwareVersion.h"
#include "ServoOutput.h"

static_assert(BABOT_SERVO_MIN_MICROSECONDS == MIN_PULSE_WIDTH,
              "BaBot servo mapping must match Servo.attach(pin) minimum");
static_assert(BABOT_SERVO_MAX_MICROSECONDS == MAX_PULSE_WIDTH,
              "BaBot servo mapping must match Servo.attach(pin) maximum");

// ============================================================================
// CONFIGURATION CONSTANTS
// ============================================================================

float P_GAIN = 3.0;
float I_GAIN = 0.04;
float D_GAIN = 25.0;

const float DEG2RAD  = M_PI / 180.0;
const float RAD2DEG  = 180.0 / M_PI;
const float R1       = 50.0;
const float R2       = 39.2;
const float BASE_R   = 32.9  / sqrt(3.0);
const float PLAT_R   = 107.9 / sqrt(3.0);
const float PLATE_HEIGHT = 65.0;

const int BUTTON_PIN      = A1;
const int LED_PIN         = 8;
const int IR_LED_PIN      = 7;
const int IR_RECEIVER_PIN = A0;
const int DIGIPOT_CS      = 4;
const int DIGIPOT_DIN     = 1;
const int DIGIPOT_SCLK    = 0;
const int SERVO_PIN_A     = 11;
const int SERVO_PIN_B     = 10;
const int SERVO_PIN_C     = 9;

const float IR_SMOOTH_ALPHA     = 0.7;
const float OUTPUT_SMOOTH_ALPHA = 0.9;
const float BALL_THRESHOLD      = 350.0;
const float VEL_SCALE           = 0.001;

const unsigned long DOUBLE_PRESS_GAP = 500;
const unsigned long LONG_PRESS_TIME  = 1000;

const float EXTERNAL_TRACK_SPEED_DEG_S  = 80.0;
const float EXTERNAL_RETURN_SPEED_DEG_S = 40.0;
const float EXTERNAL_LEVEL_EPSILON_DEG  = 0.02;
const unsigned long EXTERNAL_WATCHDOG_MS = 250;
const uint8_t EXTERNAL_SERIAL_BUDGET     = 64;

const int EEPROM_ADDR_A = 0;
const int EEPROM_ADDR_B = 4;
const int EEPROM_ADDR_C = 8;

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

enum BaBotMode   { ON, OFF, ASSEMBLY, CALIBRATION, EXTERNAL_CONTROL };
enum CalibServo  { CALIB_A, CALIB_B, CALIB_C, CALIB_DONE };
enum ButtonPress { NO_PRESS, SINGLE_PRESS, DOUBLE_PRESS, TRIPLE_PRESS, QUAD_PRESS, LONG_PRESS };
enum ExternalExitReason { EXTERNAL_EXIT_STOP, EXTERNAL_EXIT_WATCHDOG,
                          EXTERNAL_EXIT_BUTTON, EXTERNAL_EXIT_IK };

// ============================================================================
// GLOBAL STATE
// ============================================================================

int   ambientLight[16] = {0};
int   irLight[16]      = {0};
float irSignal[16]     = {0.0};
float irSignalRaw[16]  = {0.0};

float centerX = 0.0, centerY = 0.0;
float setpointX = 0.0, setpointY = 0.0;

float lastErrorX = 0.0, lastErrorY = 0.0;
float integralX  = 0.0, integralY  = 0.0;

float plateRoll  = 0.0, platePitch  = 0.0;
float smoothRoll = 0.0, smoothPitch = 0.0;

bool          ballWasOnPlate = false;
unsigned long ballLostTime   = 0;

// Controller build starts inert: an upload/reboot cannot begin balancing with
// a taped-on model car. The physical button still enables normal ON mode.
BaBotMode  mode       = OFF;
CalibServo calibServo = CALIB_A;

int servoOffsetA = 100;
int servoOffsetB = 100;
int servoOffsetC = 100;

unsigned long buttonDownTime = 0;
unsigned long lastPressTime  = 0;
int           pressCount     = 0;
bool          buttonLastState = LOW;
bool          suppressButtonUntilRelease = false;

// Latched press: ensures button presses are never lost between fast and 30Hz paths
ButtonPress lastPress = NO_PRESS;

int skipCounter = 0;

ExternalLineParser externalParser;
bool          externalArmed       = false;
bool          externalReturning   = false;
uint32_t      externalLastSequence = 0;
float         externalTargetRoll   = 0.0;
float         externalTargetPitch  = 0.0;
float         externalCurrentRoll  = 0.0;
float         externalCurrentPitch = 0.0;
unsigned long externalLastCommandMs = 0;

CD74HC4067 mux(5, 13, 6, 12);
Servo servoA, servoB, servoC;

unsigned long testStartTime = 0;

uint8_t assemblyStep = 0;  // 0=IDLE, 1=SWEEP_A, 2=SWEEP_B, 3=SWEEP_C
int     assemblyPos  = 0;

// ============================================================================
// TIMING HELPER
// ============================================================================

/**
 * Returns true at most once per 33333us (30Hz)
 */
bool every30Hz() {
  static unsigned long last = 0;
  unsigned long now = micros();
  if (now - last < 33333) return false;
  last = now;
  return true;
}

/**
 * Returns true at most once per 20000us (50Hz).
 */
bool everyExternal50Hz() {
  static unsigned long last = 0;
  unsigned long now = micros();
  if (now - last < 20000) return false;
  last = now;
  return true;
}

// ============================================================================
// SETUP
// ============================================================================

void setup() {
  pinMode(BUTTON_PIN,      INPUT);
  pinMode(LED_PIN,         OUTPUT);
  pinMode(IR_LED_PIN,      OUTPUT);
  pinMode(DIGIPOT_CS,      OUTPUT);
  pinMode(DIGIPOT_DIN,     OUTPUT);
  pinMode(DIGIPOT_SCLK,    OUTPUT);
  digitalWrite(DIGIPOT_CS, HIGH);

  servoA.attach(SERVO_PIN_A);
  servoB.attach(SERVO_PIN_B);
  servoC.attach(SERVO_PIN_C);

  EEPROM.get(EEPROM_ADDR_A, servoOffsetA);
  EEPROM.get(EEPROM_ADDR_B, servoOffsetB);
  EEPROM.get(EEPROM_ADDR_C, servoOffsetC);
  servoOffsetA = constrain(servoOffsetA, 50, 150);
  servoOffsetB = constrain(servoOffsetB, 50, 150);
  servoOffsetC = constrain(servoOffsetC, 50, 150);

  Serial.begin(115200);
  Serial.println(F("READY BABOT_MOTION 1"));
  ADCSRA = (ADCSRA & 0b11111000) | 0b101;  // ADC prescaler = 32 (faster)

  setDigitalPot(230);
  movePlatform(0, 0, PLATE_HEIGHT);
  delay(1000);
}

// ============================================================================
// MAIN LOOP
// ============================================================================

void loop() {
  processExternalSerial();

  // -------------------------------------------------------------------------
  // FAST PATH — runs every cycle
  // Button detection, mode switching, LED blinking
  // -------------------------------------------------------------------------

  if (mode == EXTERNAL_CONTROL && !suppressButtonUntilRelease &&
      digitalRead(BUTTON_PIN) == HIGH) {
    beginExternalReturn(EXTERNAL_EXIT_BUTTON);
    suppressButtonUntilRelease = true;
    pressCount = 0;
  }

  ButtonPress press = NO_PRESS;
  if (suppressButtonUntilRelease) {
    if (digitalRead(BUTTON_PIN) == LOW) {
      suppressButtonUntilRelease = false;
      buttonLastState = LOW;
      pressCount = 0;
      lastPress = NO_PRESS;
    }
  } else {
    press = checkButton(mode == CALIBRATION);
  }

  // sendSerialData();

  // Latch any detected press so it isn't lost if 30Hz gate hasn't fired yet
  if (press != NO_PRESS) lastPress = press;

  // Mode switching (not allowed during calibration)
  if (mode != CALIBRATION && mode != EXTERNAL_CONTROL) {
    if (press == SINGLE_PRESS && mode != ASSEMBLY) mode = (mode == ON) ? OFF : ON;
    if (press == QUAD_PRESS)   { mode = ASSEMBLY; assemblyStep = 0; assemblyPos = 0;
                                servoA.write(100); servoB.write(100); servoC.write(100); }
    if (press == TRIPLE_PRESS) { mode = CALIBRATION; calibServo = CALIB_A; }
  }

  // LED — always runs at full speed for smooth blinking
  switch (mode) {
    case ON:          blinkLED(300);              break;
    case ASSEMBLY:    blinkDoubleFlash();          break;
    case CALIBRATION: blinkLED(50);               break;
    case EXTERNAL_CONTROL: blinkLED(100);         break;
    case OFF:         digitalWrite(LED_PIN, LOW);  break;
  }

  // External control owns the servo timing and intentionally skips all IR and
  // PID work. Serial parsing and the physical exit button still run above.
  if (mode == EXTERNAL_CONTROL) {
    if (everyExternal50Hz()) handleExternalMode();
    return;
  }

  // -------------------------------------------------------------------------
  // 30Hz PATH — sensor reading + PID + servos
  // -------------------------------------------------------------------------
  if (!every30Hz()) return;

  measureIR();
  calculateWeightedCenter(irSignal, centerX, centerY);

  switch (mode) {
    case ON:          handleOnMode();              break;
    case OFF:         handleOffMode();             break;
    case ASSEMBLY:    handleAssemblyMode();        break;
    case CALIBRATION: runCalibration(lastPress);   break;
    case EXTERNAL_CONTROL: break;  // handled by the 50Hz path above
  }

  // Clear latched press after 30Hz handler has consumed it
  lastPress = NO_PRESS;
}

// ============================================================================
// MODE HANDLERS
// ============================================================================

void handleOnMode() {
  if (ballOnPlate()) {
    digitalWrite(LED_PIN, HIGH);

    if (!ballWasOnPlate) {
      skipCounter = 2;
      lastErrorX = setpointX - centerX;
      lastErrorY = setpointY - centerY;
    }

    ballWasOnPlate = true;
    ballLostTime   = millis();

    if (skipCounter > 0) { skipCounter--; return; }

    pidControl(centerX, setpointX, lastErrorX, integralX, plateRoll);
    pidControl(centerY, setpointY, lastErrorY, integralY, platePitch);

    smoothRoll  = OUTPUT_SMOOTH_ALPHA * plateRoll  + (1 - OUTPUT_SMOOTH_ALPHA) * smoothRoll;
    smoothPitch = OUTPUT_SMOOTH_ALPHA * platePitch + (1 - OUTPUT_SMOOTH_ALPHA) * smoothPitch;

    movePlatform(smoothRoll, smoothPitch, PLATE_HEIGHT);

  } else {
    if (ballWasOnPlate && millis() - ballLostTime < 1000) {
      movePlatform(plateRoll, platePitch, PLATE_HEIGHT);
    } else {
      ballWasOnPlate = false;
      integralX = integralY = 0;
      lastErrorX = lastErrorY = 0;
      setpointX = setpointY = 0;
      plateRoll = platePitch = 0;
      movePlatform(0, 0, PLATE_HEIGHT);
    }
  }
}

void handleOffMode() {
  plateRoll = platePitch = 0;
  movePlatform(0, 0, PLATE_HEIGHT);
}

void handleAssemblyMode() {
  const int PARK_POS = 100;

  bool pressed = (lastPress == SINGLE_PRESS);
  if (pressed) lastPress = NO_PRESS;

  if (assemblyStep == 0 && pressed) {
    assemblyStep = 1;

    servoA.write(100);
    servoA.write(180); delay(250);
    servoA.write(PARK_POS);

    servoB.write(100);
    servoB.write(180); delay(250);
    servoB.write(PARK_POS);

    servoC.write(100);
    servoC.write(180); delay(250);
    servoC.write(PARK_POS);

    assemblyStep = 0;  // back to IDLE, ready for next press
  }
}

// ============================================================================
// GUARDED USB EXTERNAL CONTROL
// ============================================================================

void sendExternalAck(const ExternalCommand &command) {
  Serial.print(F("ACK "));
  Serial.print(command.sequence);
  Serial.print(' ');
  Serial.print(externalCommandName(command.type));
  if (command.type == EXTERNAL_COMMAND_PING) {
    Serial.print(F(" BABOT_MOTION 1"));
  } else if (command.type == EXTERNAL_COMMAND_INFO) {
    Serial.print(F(" BABOT_MOTION 1 VERSION " BABOT_FIRMWARE_VERSION
                   " BOARD ATMEGA32U4 OFFSETS "));
    Serial.print(servoOffsetA);
    Serial.print(' ');
    Serial.print(servoOffsetB);
    Serial.print(' ');
    Serial.print(servoOffsetC);
  }
  Serial.println();
}

void sendExternalNack(uint32_t sequence, const char *reason) {
  Serial.print(F("NACK "));
  Serial.print(sequence);
  Serial.print(' ');
  Serial.println(reason);
}

void resetBalanceState() {
  ballWasOnPlate = false;
  integralX = integralY = 0.0;
  lastErrorX = lastErrorY = 0.0;
  setpointX = setpointY = 0.0;
  plateRoll = platePitch = 0.0;
  smoothRoll = smoothPitch = 0.0;
}

void beginExternalReturn(ExternalExitReason reason) {
  if (mode != EXTERNAL_CONTROL || externalReturning) return;

  externalArmed = false;
  externalReturning = true;
  externalTargetRoll = 0.0;
  externalTargetPitch = 0.0;

  if (reason == EXTERNAL_EXIT_WATCHDOG) Serial.println(F("EVENT WATCHDOG"));
  if (reason == EXTERNAL_EXIT_BUTTON)   Serial.println(F("EVENT BUTTON_EXIT"));
  if (reason == EXTERNAL_EXIT_IK)       Serial.println(F("EVENT IK_FAULT"));
}

void enterExternalMode(const ExternalCommand &command) {
  if (mode == ASSEMBLY || mode == CALIBRATION ||
      mode == EXTERNAL_CONTROL) {
    sendExternalNack(command.sequence, "BUSY");
    return;
  }
  if (!platformPoseReachable(0.0, 0.0, PLATE_HEIGHT) ||
      !writePlatformPoseChecked(0.0, 0.0, PLATE_HEIGHT)) {
    sendExternalNack(command.sequence, "IK");
    return;
  }

  resetBalanceState();
  externalArmed = true;
  externalReturning = false;
  externalLastSequence = command.sequence;
  externalTargetRoll = externalTargetPitch = 0.0;
  externalCurrentRoll = externalCurrentPitch = 0.0;
  externalLastCommandMs = millis();
  mode = EXTERNAL_CONTROL;
  sendExternalAck(command);
}

void handleExternalCommand(const ExternalCommand &command) {
  // Identification is deliberately stateless: neither command arms, moves,
  // writes EEPROM, changes the session sequence, or refreshes the watchdog.
  if (command.type == EXTERNAL_COMMAND_PING ||
      command.type == EXTERNAL_COMMAND_INFO) {
    sendExternalAck(command);
    return;
  }

  if (command.type == EXTERNAL_COMMAND_ARM) {
    enterExternalMode(command);
    return;
  }

  if (mode != EXTERNAL_CONTROL || !externalArmed) {
    sendExternalNack(command.sequence, "NOT_ARMED");
    return;
  }
  if (!externalSequenceIsNewer(command.sequence, externalLastSequence)) {
    sendExternalNack(command.sequence, "STALE_SEQUENCE");
    return;
  }

  if (command.type == EXTERNAL_COMMAND_POSE) {
    if (!externalPoseWithinHardLimits(command.rollDeg, command.pitchDeg)) {
      sendExternalNack(command.sequence, "LIMIT");
      return;
    }
    if (!platformPoseReachable(command.rollDeg, command.pitchDeg,
                               PLATE_HEIGHT)) {
      sendExternalNack(command.sequence, "IK");
      return;
    }
    externalTargetRoll = command.rollDeg;
    externalTargetPitch = command.pitchDeg;
    externalLastSequence = command.sequence;
    externalLastCommandMs = millis();
    sendExternalAck(command);
    return;
  }

  if (command.type == EXTERNAL_COMMAND_LEVEL) {
    externalTargetRoll = externalTargetPitch = 0.0;
    externalLastSequence = command.sequence;
    externalLastCommandMs = millis();
    sendExternalAck(command);
    return;
  }

  if (command.type == EXTERNAL_COMMAND_STOP) {
    externalLastSequence = command.sequence;
    sendExternalAck(command);
    beginExternalReturn(EXTERNAL_EXIT_STOP);
    return;
  }

  sendExternalNack(command.sequence, "BAD_COMMAND");
}

void processExternalSerial() {
  uint8_t processed = 0;
  while (Serial.available() > 0 && processed < EXTERNAL_SERIAL_BUDGET) {
    char incoming = static_cast<char>(Serial.read());
    ++processed;

    ExternalCommand command = {EXTERNAL_COMMAND_NONE, 0, 0.0, 0.0};
    ExternalParseError error;
    ExternalFeedResult result = externalParser.push(incoming, command, error);
    if (result == EXTERNAL_FEED_COMMAND) {
      handleExternalCommand(command);
    } else if (result == EXTERNAL_FEED_ERROR) {
      sendExternalNack(command.sequence, externalParseErrorName(error));
    }
  }
}

void handleExternalMode() {
  if (externalArmed &&
      millis() - externalLastCommandMs >= EXTERNAL_WATCHDOG_MS) {
    beginExternalReturn(EXTERNAL_EXIT_WATCHDOG);
  }

  const float vectorSpeed = externalReturning
                                ? EXTERNAL_RETURN_SPEED_DEG_S
                                : EXTERNAL_TRACK_SPEED_DEG_S;
  const float maximumVectorStep = vectorSpeed / 50.0;
  float nextRoll, nextPitch;
  externalStepTowardVector(externalCurrentRoll, externalCurrentPitch,
                           externalTargetRoll, externalTargetPitch,
                           maximumVectorStep, nextRoll, nextPitch);

  if (!writePlatformPoseChecked(nextRoll, nextPitch, PLATE_HEIGHT)) {
    beginExternalReturn(EXTERNAL_EXIT_IK);
    return;
  }
  externalCurrentRoll = nextRoll;
  externalCurrentPitch = nextPitch;

  if (externalReturning &&
      fabs(externalCurrentRoll) <= EXTERNAL_LEVEL_EPSILON_DEG &&
      fabs(externalCurrentPitch) <= EXTERNAL_LEVEL_EPSILON_DEG) {
    if (!writePlatformPoseChecked(0.0, 0.0, PLATE_HEIGHT)) {
      Serial.println(F("EVENT IK_FAULT"));
      return;
    }
    externalCurrentRoll = externalCurrentPitch = 0.0;
    externalTargetRoll = externalTargetPitch = 0.0;
    externalReturning = false;
    externalArmed = false;
    resetBalanceState();
    mode = OFF;
    Serial.println(F("EVENT OFF"));
  }
}

// ============================================================================
// CALIBRATION
// ============================================================================

void runCalibration(ButtonPress press) {
  static CalibServo lastCalibServo = CALIB_DONE;

  // Init sequence when entering calibration fresh
  if (lastCalibServo == CALIB_DONE && calibServo == CALIB_A) {
    servoOffsetA = 100;
    servoOffsetB = 100;
    servoOffsetC = 100;
    moveServos(70, 70, 70);
    delay(2000);
  }
  lastCalibServo = calibServo;

  // Single press: increment current servo offset
  if (press == SINGLE_PRESS) {
    if (calibServo == CALIB_A) servoOffsetA++;
    if (calibServo == CALIB_B) servoOffsetB++;
    if (calibServo == CALIB_C) servoOffsetC++;
  }

  // Long press: advance to next servo
  if (press == LONG_PRESS) {
    if      (calibServo == CALIB_A) calibServo = CALIB_B;
    else if (calibServo == CALIB_B) calibServo = CALIB_C;
    else if (calibServo == CALIB_C) calibServo = CALIB_DONE;
  }

  // Calibration complete
  if (calibServo == CALIB_DONE) {
    servoOffsetA -= 25;
    servoOffsetB -= 25;
    servoOffsetC -= 25;
    EEPROM.put(EEPROM_ADDR_A, servoOffsetA);
    EEPROM.put(EEPROM_ADDR_B, servoOffsetB);
    EEPROM.put(EEPROM_ADDR_C, servoOffsetC);
    lastCalibServo = CALIB_DONE;
    mode = ON;
    return;
  }

  // Move active servo to calibration position
  if (calibServo == CALIB_A) moveServos(25, 70, 70);
  if (calibServo == CALIB_B) moveServos(70, 25, 70);
  if (calibServo == CALIB_C) moveServos(70, 70, 25);
}

// ============================================================================
// SERVO CONTROL
// ============================================================================

void moveServos(float a, float b, float c) {
  a = constrain(a, -10, 85);
  b = constrain(b, -10, 85);
  c = constrain(c, -10, 85);
  servoA.write(servoOffsetA - a);
  servoB.write(servoOffsetB - b);
  servoC.write(servoOffsetC - c);
}

void moveServosPrecise(float a, float b, float c) {
  // Keep the official logical-angle constraints, then preserve the fractional
  // external-motion IK result through the Servo library's microsecond API.
  // Normal balance, assembly, and calibration continue to use the untouched
  // moveServos()/Servo.write() path above.
  a = constrain(a, -10, 85);
  b = constrain(b, -10, 85);
  c = constrain(c, -10, 85);
  servoA.writeMicroseconds(
      babotServoDegreesToMicroseconds(servoOffsetA - a));
  servoB.writeMicroseconds(
      babotServoDegreesToMicroseconds(servoOffsetB - b));
  servoC.writeMicroseconds(
      babotServoDegreesToMicroseconds(servoOffsetC - c));
}

// ============================================================================
// INVERSE KINEMATICS
// ============================================================================

bool calculatePlatformServoAngles(float rollDeg, float pitchDeg, float height,
                                  bool strictReachability,
                                  float &servoAngleA, float &servoAngleB,
                                  float &servoAngleC) {
  if (!isfinite(rollDeg) || !isfinite(pitchDeg) || !isfinite(height)) {
    return false;
  }

  float roll  = -rollDeg  * DEG2RAD;
  float pitch = -pitchDeg * DEG2RAD;

  float baseAngle[3] = {0, 120 * DEG2RAD, 240 * DEG2RAD};
  float platX[3], platY[3], platZ[3], angles[3];

  for (int i = 0; i < 3; i++) {
    float a  = baseAngle[i];
    float px = PLAT_R * cos(a);
    float py = PLAT_R * sin(a);
    float pz = height;
    float x1 =  px * cos(pitch) + pz * sin(pitch);
    float z1 = -px * sin(pitch) + pz * cos(pitch);
    float y1 =  py * cos(roll)  - z1 * sin(roll);
    float z2 =  py * sin(roll)  + z1 * cos(roll);
    platX[i] = x1; platY[i] = y1; platZ[i] = z2;
  }

  for (int i = 0; i < 3; i++) {
    float a   = baseAngle[i];
    float bx  = BASE_R * cos(a);
    float by  = BASE_R * sin(a);
    float dx  = platX[i] - bx;
    float dy  = platY[i] - by;
    float dz  = platZ[i];
    float dxl = dx * cos(a) + dy * sin(a);
    float dyl = dz;
    float d   = sqrt(dxl * dxl + dyl * dyl);
    if (!isfinite(d) || d <= 0.0001) return false;
    float rawCosAngle = (R1*R1 + d*d - R2*R2) / (2*R1*d);
    if (strictReachability &&
        (rawCosAngle < -1.0001 || rawCosAngle > 1.0001)) {
      return false;
    }
    float cosAngle = constrain(rawCosAngle, -1, 1);
    angles[i] = (atan2(dyl, dxl) - acos(cosAngle)) * RAD2DEG;
    if (!isfinite(angles[i])) return false;
  }

  servoAngleA = angles[2];
  servoAngleB = angles[0];
  servoAngleC = angles[1];
  return true;
}

bool externalServoAnglesValid(float a, float b, float c) {
  if (a < -10.0 || a > 85.0 ||
      b < -10.0 || b > 85.0 ||
      c < -10.0 || c > 85.0) {
    return false;
  }

  float outputA = servoOffsetA - a;
  float outputB = servoOffsetB - b;
  float outputC = servoOffsetC - c;
  return outputA >= 0.0 && outputA <= 180.0 &&
         outputB >= 0.0 && outputB <= 180.0 &&
         outputC >= 0.0 && outputC <= 180.0;
}

bool platformPoseReachable(float rollDeg, float pitchDeg, float height) {
  float a, b, c;
  return calculatePlatformServoAngles(rollDeg, pitchDeg, height, true,
                                      a, b, c) &&
         externalServoAnglesValid(a, b, c);
}

bool writePlatformPoseChecked(float rollDeg, float pitchDeg, float height) {
  float a, b, c;
  if (!calculatePlatformServoAngles(rollDeg, pitchDeg, height, true,
                                    a, b, c) ||
      !externalServoAnglesValid(a, b, c)) {
    return false;
  }
  moveServosPrecise(a, b, c);
  return true;
}

void movePlatform(float rollDeg, float pitchDeg, float height) {
  float a, b, c;
  // Preserve the official normal-mode behavior, including its final actuator
  // constraints. Only EXTERNAL uses strict reachability checks above.
  if (calculatePlatformServoAngles(rollDeg, pitchDeg, height, false,
                                   a, b, c)) {
    moveServos(a, b, c);
  }
}

// ============================================================================
// LED CONTROL
// ============================================================================

void blinkLED(unsigned long interval) {
  static unsigned long lastToggle = 0;
  if (millis() - lastToggle >= interval) {
    digitalWrite(LED_PIN, !digitalRead(LED_PIN));
    lastToggle = millis();
  }
}

void blinkDoubleFlash() {
  static unsigned long lastChange = 0;
  static uint8_t step = 0;
  const unsigned long pattern[] = {100, 200, 100, 1000};
  const uint8_t      ledState[] = {HIGH, LOW, HIGH, LOW};
  unsigned long now = millis();
  if (now - lastChange >= pattern[step]) {
    lastChange = now;
    step = (step + 1) % 4;
    digitalWrite(LED_PIN, ledState[step]);
  }
}

// ============================================================================
// BUTTON INPUT
// ============================================================================

ButtonPress checkButton(bool calibrationMode) {
  bool current = digitalRead(BUTTON_PIN);
  unsigned long now = millis();
  ButtonPress result = NO_PRESS;

  if (current == HIGH && buttonLastState == LOW) buttonDownTime = now;

  if (current == LOW && buttonLastState == HIGH) {
    unsigned long duration = now - buttonDownTime;
    if (duration >= LONG_PRESS_TIME) {
      result = LONG_PRESS;
      pressCount = 0;
    } else {
      pressCount++;
      lastPressTime = now;
    }
  }

  if (pressCount > 0 && (calibrationMode || now - lastPressTime > DOUBLE_PRESS_GAP)) {
    if      (pressCount == 1) result = SINGLE_PRESS;
    else if (pressCount == 2) result = DOUBLE_PRESS;
    else if (pressCount == 3) result = TRIPLE_PRESS;
    else if (pressCount == 4) result = QUAD_PRESS;
    pressCount = 0;
  }

  buttonLastState = current;
  return result;
}

// ============================================================================
// IR SENSOR READING
// ============================================================================

void measureIR() {
  digitalWrite(IR_LED_PIN, LOW);
  for (int i = 0; i < 16; i++) {
    mux.channel(i);
    delayMicroseconds(600);
    ambientLight[i] = analogRead(IR_RECEIVER_PIN);
  }
  digitalWrite(IR_LED_PIN, HIGH);
  for (int i = 0; i < 16; i++) {
    mux.channel(i);
    delayMicroseconds(600);
    irLight[i] = analogRead(IR_RECEIVER_PIN);
  }
  for (int i = 0; i < 16; i++) irSignalRaw[i] = irLight[i] - ambientLight[i];
  for (int i = 0; i < 16; i++) irSignal[i] += IR_SMOOTH_ALPHA * (irSignalRaw[i] - irSignal[i]);
}

// ============================================================================
// BALL POSITION
// ============================================================================

bool ballOnPlate() {
  float minV = irSignal[0], maxV = irSignal[0];
  for (int i = 1; i < 16; i++) {
    minV = min(minV, irSignal[i]);
    maxV = max(maxV, irSignal[i]);
  }
  return (maxV - minV >= BALL_THRESHOLD);
}

void calculateWeightedCenter(const float arr[], float &x, float &y) {
  if (!ballOnPlate()) { x = y = 0; return; }

  float minV = arr[0], maxV = arr[0];
  for (int i = 1; i < 16; i++) {
    if (arr[i] < minV) minV = arr[i];
    if (arr[i] > maxV) maxV = arr[i];
  }
  float range = maxV - minV;
  if (range < 1e-6) { x = y = 0; return; }

  const int mirrorIdx[6] = {0, 0, 1, 2, 3, 3};
  float wx = 0, wy = 0, sumW = 0;

  for (int iy = -1; iy <= 4; iy++) {
    int my = mirrorIdx[iy + 1];
    for (int ix = -1; ix <= 4; ix++) {
      int mx = mirrorIdx[ix + 1];
      float v = (arr[my * 4 + mx] - minV) / range;
      if (v < 0) v = 0;
      float w = v * v * v;
      wx += ix * w; wy += iy * w; sumW += w;
    }
  }

  if (sumW < 1e-6) { x = y = 0; return; }
  x = wx / sumW - 1.5;
  y = wy / sumW - 1.5;
}

// ============================================================================
// DIGITAL POTENTIOMETER
// ============================================================================

void setDigitalPot(byte val) {
  digitalWrite(DIGIPOT_CS, LOW);
  for (int i = 7; i >= 0; --i) {
    digitalWrite(DIGIPOT_DIN, (val & (1 << i)) ? HIGH : LOW);
    digitalWrite(DIGIPOT_SCLK, LOW);  delayMicroseconds(20);
    digitalWrite(DIGIPOT_SCLK, HIGH); delayMicroseconds(20);
  }
  digitalWrite(DIGIPOT_CS, HIGH);
}

// ============================================================================
// PID CONTROLLER
// ============================================================================

void pidControl(float input, float target, float &lastErr, float &integ, float &out) {
  float error = target - input;
  integ += I_GAIN * error;
  float vel  = error - lastErr;
  float avel = vel >= 0 ? vel : -vel;
  float scale = avel / (avel + VEL_SCALE);
  out = P_GAIN * error + integ + D_GAIN * scale * vel;
  lastErr = error;
}

// ============================================================================
// SERIAL DEBUGGING
// ============================================================================

void sendSerialData() {
  for (int i = 0; i < 16; i++) { Serial.print(irSignal[i]); Serial.print(','); }
  Serial.print(centerX); Serial.print(',');
  Serial.print(centerY); Serial.print(',');
  Serial.print(setpointX); Serial.print(',');
  Serial.println(setpointY);
}

void sendGraphData() {
  Serial.print("smoothRoll:");  Serial.print(smoothRoll);  Serial.print(",");
  Serial.print("smoothPitch:"); Serial.print(smoothPitch); Serial.print(",");
  Serial.print("PlateRoll:");   Serial.print(plateRoll);   Serial.print(",");
  Serial.print("PlatePitch:");  Serial.print(platePitch);  Serial.print(",");
  Serial.print("MeasX:");       Serial.print(centerX);     Serial.print(",");
  Serial.print("MeasY:");       Serial.println(centerY);
}

// ============================================================================
// PLATFORM TEST MODE
// ============================================================================

const float TEST_ROLL_AMPL  = 25.0;
const float TEST_PITCH_AMPL = 20.0;
const float TEST_SPEED      = 0.001;
const float TEST_HEIGHT     = PLATE_HEIGHT;

void runPlatformTest() {
  if (testStartTime == 0) testStartTime = millis();
  unsigned long t = millis() - testStartTime;
  float roll  = TEST_ROLL_AMPL  * sin(t * TEST_SPEED * 2 * PI);
  float pitch = TEST_PITCH_AMPL * sin(t * TEST_SPEED * 2 * PI + PI/2);
  movePlatform(roll, pitch, TEST_HEIGHT);
  static unsigned long lastPrint = 0;
  if (millis() - lastPrint > 1000) {
    Serial.print("Roll: "); Serial.print(roll);
    Serial.print(" , Pitch: "); Serial.println(pitch);
    lastPrint = millis();
  }
}

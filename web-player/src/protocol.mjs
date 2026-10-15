/** BaBot Motion v1. Keep this contract aligned with ../../PROTOCOL.md. */
/** @typedef {{angleDegrees:number, invertRoll:boolean, invertPitch:boolean, verified:boolean}} MountingCalibration */
export const BABOT_PROTOCOL = Object.freeze({
  baudRate: 115200,
  commandIntervalMs: 20,
  maximumDegrees: 20,
  staleSampleMs: 180,
  responseTimeoutMs: 140,
  stopReturnTimeoutMs: 1000,
});

// Retain the established transform until an observed axis check replaces it.
export const DEFAULT_MOUNTING_CALIBRATION = Object.freeze({
  angleDegrees: 45,
  invertRoll: false,
  invertPitch: false,
  verified: false,
});

/** @param {MountingCalibration} [config] */
export function validateMountingCalibration(config = DEFAULT_MOUNTING_CALIBRATION) {
  if (!config || typeof config !== "object" || Array.isArray(config)
    || typeof config.angleDegrees !== "number" || !Number.isFinite(config.angleDegrees)
    || config.angleDegrees < -180 || config.angleDegrees > 180
    || typeof config.invertRoll !== "boolean" || typeof config.invertPitch !== "boolean"
    || typeof config.verified !== "boolean") {
    throw new Error("Invalid BaBot mounting calibration");
  }
  return Object.freeze({
    angleDegrees: config.angleDegrees,
    invertRoll: config.invertRoll,
    invertPitch: config.invertPitch,
    verified: config.verified,
  });
}

export function isApprovedControllerOrigin({ isSecureContext, isTopLevel } = {}) {
  return isSecureContext === true && isTopLevel === true;
}

export function limitPoseMagnitude(pose, maximumDegrees = BABOT_PROTOCOL.maximumDegrees) {
  const roll = Number(pose?.roll);
  const pitch = Number(pose?.pitch);
  if (!Number.isFinite(roll) || !Number.isFinite(pitch)) throw new Error("Invalid BaBot pose");
  const limit = Math.max(0, Math.min(BABOT_PROTOCOL.maximumDegrees, Number(maximumDegrees)));
  if (!Number.isFinite(limit)) throw new Error("Invalid BaBot amplitude");
  const magnitude = Math.hypot(roll, pitch);
  const scale = magnitude > limit ? limit / magnitude : 1;
  return { roll: roll * scale, pitch: pitch * scale };
}

export function commandedPoseDegrees(pose, amplitudes = {}, { invertRoll = false, invertPitch = false } = {}) {
  const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, Number(value)));
  const roll = clamp(pose?.roll, -1, 1) * clamp(amplitudes.roll ?? 1, 0, 20) * (invertRoll ? -1 : 1);
  const pitch = clamp(pose?.pitch, -1, 1) * clamp(amplitudes.pitch ?? 0.75, 0, 20) * (invertPitch ? -1 : 1);
  return limitPoseMagnitude({ roll, pitch });
}

/**
 * Invert car axes first, then rotate into firmware plate axes.
 * @param {{roll:number,pitch:number}} pose
 * @param {number} [maximumDegrees]
 * @param {MountingCalibration} [mounting]
 */
export function carPoseToFirmwarePose(pose, maximumDegrees = BABOT_PROTOCOL.maximumDegrees, mounting = DEFAULT_MOUNTING_CALIBRATION) {
  const config = validateMountingCalibration(mounting);
  const angle = config.angleDegrees * Math.PI / 180;
  const roll = Number(pose.roll) * (config.invertRoll ? -1 : 1);
  const pitch = Number(pose.pitch) * (config.invertPitch ? -1 : 1);
  return limitPoseMagnitude({
    roll: roll * Math.cos(angle) - pitch * Math.sin(angle),
    pitch: roll * Math.sin(angle) + pitch * Math.cos(angle),
  }, maximumDegrees);
}

function sequenceId(sequence) {
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 0xffffffff) {
    throw new Error("Invalid BaBot command sequence; reconnect");
  }
  return sequence;
}

export function formatPoseCommand(sequence, pose) {
  const limited = limitPoseMagnitude(pose);
  let roll = limited.roll.toFixed(3);
  let pitch = limited.pitch.toFixed(3);
  // Decimal rounding must never push the transmitted vector beyond the circle.
  if (Math.hypot(Number(roll), Number(pitch)) > BABOT_PROTOCOL.maximumDegrees) {
    roll = (Math.trunc(limited.roll * 1000) / 1000).toFixed(3);
    pitch = (Math.trunc(limited.pitch * 1000) / 1000).toFixed(3);
  }
  return `POSE ${sequenceId(sequence)} ${roll} ${pitch}\n`;
}
export const formatPingCommand = (sequence) => `PING ${sequenceId(sequence)}\n`;
export const formatArmCommand = (sequence) => `ARM ${sequenceId(sequence)}\n`;
export const formatStopCommand = (sequence) => `STOP ${sequenceId(sequence)}\n`;

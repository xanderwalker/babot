/** BaBot Motion v1. Keep this contract aligned with ../../PROTOCOL.md. */
export const BABOT_PROTOCOL = Object.freeze({
  baudRate: 115200,
  commandIntervalMs: 20,
  maximumDegrees: 20,
  staleSampleMs: 180,
  responseTimeoutMs: 140,
  stopReturnTimeoutMs: 1000,
});

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

/** Existing car mounting calibration: car axes are 45 degrees from plate axes. */
export function carPoseToFirmwarePose(pose, maximumDegrees = BABOT_PROTOCOL.maximumDegrees) {
  return limitPoseMagnitude({
    roll: (Number(pose.roll) - Number(pose.pitch)) * Math.SQRT1_2,
    pitch: (Number(pose.roll) + Number(pose.pitch)) * Math.SQRT1_2,
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
